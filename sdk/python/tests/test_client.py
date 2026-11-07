"""Runs the client and the sample market maker against a small fake of the API."""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
from market_maker import quotes, run  # noqa: E402
from ticker_sdk import RateLimited, Ticker, TickerError  # noqa: E402

KEY = "tk_abcdef1234_" + "x" * 43


class FakeApi:
    def __init__(self) -> None:
        self.orders: dict[int, dict] = {}
        self.requests: list[tuple[str, str, dict | None, str]] = []
        self.position = 0
        self.next_status: list[tuple[int, dict]] = []  # forced replies, used first
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _reply(self, status: int, body, headers: dict | None = None):
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

            def _handle(self):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                api.requests.append((self.command, self.path, body, self.headers["authorization"]))
                if api.next_status:
                    status, reply = api.next_status.pop(0)
                    return self._reply(status, reply, {"retry-after": "0"} if status == 429 else None)
                if self.path.startswith("/v1/market/NOVA"):
                    return self._reply(200, {
                        "ticker": "NOVA", "last": 14000, "bid": 13990, "ask": 14010, "halted": False,
                        "book": {"bids": [{"price": 13990, "qty": 5}], "asks": [{"price": 14010, "qty": 7}]},
                    })
                if self.path == "/v1/positions":
                    return self._reply(200, {"positions": [{"symbol": "NOVA", "qty": api.position}]})
                if self.path.startswith("/v1/orders?open"):
                    return self._reply(200, [o for o in api.orders.values() if o["status"] == "open"])
                if self.command == "POST" and self.path == "/v1/orders":
                    oid = len(api.orders) + 1
                    o = {"id": oid, "symbol": body["symbol"], "side": body["side"], "type": body["type"],
                         "qty": body["qty"], "filledQty": 0, "price": body.get("price"), "status": "open",
                         "rejectReason": None}
                    api.orders[oid] = o
                    return self._reply(201, o)
                if self.command == "DELETE" and self.path.startswith("/v1/orders/"):
                    o = api.orders[int(self.path.rsplit("/", 1)[1])]
                    o["status"] = "cancelled"
                    return self._reply(200, o)
                return self._reply(404, {"error": "not_found", "message": "no route"})

            do_GET = do_POST = do_DELETE = _handle

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"


@pytest.fixture
def api():
    a = FakeApi()
    yield a
    a.server.shutdown()


def test_quotes_and_orders_in_dollars(api):
    t = Ticker(api.url + "/", KEY)
    q = t.quote("NOVA")
    assert (q.bid, q.ask, q.mid) == (139.9, 140.1, 140.0)
    assert q.asks == [(140.1, 7)]
    o = t.buy("NOVA", 5, price=139.95)
    assert api.requests[-1][2] == {"symbol": "NOVA", "side": "buy", "qty": 5, "type": "limit", "price": 13995}
    assert api.requests[-1][3] == f"Bearer {KEY}"
    assert (o.price, o.working) == (139.95, True)
    t.sell("NOVA", 1)
    assert api.requests[-1][2]["type"] == "market" and "price" not in api.requests[-1][2]


def test_errors(api):
    t = Ticker(api.url, KEY)
    api.next_status = [(429, {"error": "rate_limited", "message": "slow down"})]
    with pytest.raises(RateLimited) as err:
        t.buy("NOVA", 1, price=140)
    assert err.value.retry_after == 0
    api.next_status = [(422, {"error": "size_cap", "message": "at most 50"})]
    with pytest.raises(TickerError) as err:
        t.buy("NOVA", 51, price=140)
    assert err.value.code == "size_cap"
    # An exchange reject is returned as an order, not raised.
    api.next_status = [(422, {"id": 9, "symbol": "NOVA", "side": "buy", "type": "limit", "qty": 1,
                              "filledQty": 0, "price": 99999, "status": "rejected", "rejectReason": "price_band"})]
    o = t.buy("NOVA", 1, price=999.99)
    assert (o.status, o.reject_reason) == ("rejected", "price_band")
    with pytest.raises(ValueError):
        Ticker(api.url, "not-a-key")
    with pytest.raises(ValueError):
        t.buy("NOVA", 1, price=0)


def test_quotes_lean_against_inventory():
    flat = quotes(100.0, 0, spread_bps=20, skew_bps=10, max_inv=100)
    assert flat == (99.9, 100.1)
    long = quotes(100.0, 100, spread_bps=20, skew_bps=10, max_inv=100)
    assert long[0] < flat[0] and long[1] < flat[1]  # long: quote lower to sell
    short = quotes(100.0, -100, spread_bps=20, skew_bps=10, max_inv=100)
    assert short[0] > flat[0] and short[1] > flat[1]
    tight = quotes(1.0, 0, spread_bps=1, skew_bps=0, max_inv=100)
    assert tight[1] > tight[0]  # never crossed, even when the spread rounds to nothing


def test_market_maker_requotes_and_respects_inventory(api):
    t = Ticker(api.url, KEY)
    run(t, "NOVA", size=10, spread_bps=20, skew_bps=10, max_inv=50, every=0, rounds=2)
    sent = [r[2] for r in api.requests if r[0] == "POST"]
    assert [s["side"] for s in sent] == ["buy", "sell", "buy", "sell"]
    assert sum(1 for r in api.requests if r[0] == "DELETE") == 2  # first round's quotes pulled
    api.requests.clear()
    api.position = 50  # at the long limit: only an ask
    run(t, "NOVA", size=10, spread_bps=20, skew_bps=10, max_inv=50, every=0, rounds=1)
    assert [r[2]["side"] for r in api.requests if r[0] == "POST"] == ["sell"]
    assert t.cancel_all("NOVA") == 3  # the open quotes from both runs
