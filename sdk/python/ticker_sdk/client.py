"""A small client for the Ticker REST API, for bots that use an API key.

Prices go in and come out in dollars (the API itself uses integer cents).

    from ticker_sdk import Ticker
    t = Ticker("https://api.example.com", "tk_...")
    q = t.quote("NOVA")
    t.buy("NOVA", 10, price=q.bid)
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


class TickerError(Exception):
    def __init__(self, status: int, code: str, message: str, body: Any = None) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message, self.body = status, code, message, body


class RateLimited(TickerError):
    """Too many orders for this key. Slow down; `retry_after` is in seconds."""

    def __init__(self, status: int, code: str, message: str, retry_after: float) -> None:
        super().__init__(status, code, message)
        self.retry_after = retry_after


@dataclass(frozen=True)
class Quote:
    ticker: str
    last: float
    bid: float | None
    ask: float | None
    halted: bool
    bids: list[tuple[float, int]]  # (price, shares), best first
    asks: list[tuple[float, int]]

    @property
    def mid(self) -> float:
        if self.bid is not None and self.ask is not None:
            return (self.bid + self.ask) / 2
        return self.last


@dataclass(frozen=True)
class Order:
    id: int
    symbol: str
    side: str
    type: str
    qty: int
    filled: int
    price: float | None
    status: str
    reject_reason: str | None

    @property
    def working(self) -> bool:
        return self.status in ("pending", "open", "partially_filled")


def to_cents(dollars: float) -> int:
    cents = round(dollars * 100)
    if cents <= 0:
        raise ValueError(f"price must be positive, got {dollars}")
    return cents


def _dollars(cents: int | None) -> float | None:
    return None if cents is None else cents / 100


def _order(d: dict[str, Any]) -> Order:
    return Order(
        id=d["id"], symbol=d["symbol"], side=d["side"], type=d["type"], qty=d["qty"],
        filled=d["filledQty"], price=_dollars(d.get("price")), status=d["status"],
        reject_reason=d.get("rejectReason"),
    )


class Ticker:
    def __init__(self, base_url: str, api_key: str, timeout: float = 5.0) -> None:
        if not api_key.startswith("tk_"):
            raise ValueError("that doesn't look like a Ticker API key (they start with tk_)")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    # ---- plumbing ----

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("authorization", f"Bearer {self.api_key}")
        req.add_header("user-agent", "ticker-sdk/0.1")
        if data is not None:
            req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            try:
                info = json.loads(err.read() or b"{}")
            except ValueError:
                info = {}
            code, message = info.get("error", "error"), info.get("message", err.reason)
            if err.code == 429:
                retry = float(err.headers.get("retry-after") or 1)
                raise RateLimited(err.code, code, message, retry) from None
            raise TickerError(err.code, code, message, info) from None

    # ---- market data ----

    def symbols(self) -> list[dict[str, Any]]:
        return self._call("GET", "/v1/symbols")

    def quote(self, ticker: str, depth: int = 10) -> Quote:
        d = self._call("GET", f"/v1/market/{ticker}?depth={depth}")
        return Quote(
            ticker=d["ticker"], last=d["last"] / 100, bid=_dollars(d["bid"]), ask=_dollars(d["ask"]),
            halted=d["halted"],
            bids=[(lv["price"] / 100, lv["qty"]) for lv in d["book"]["bids"]],
            asks=[(lv["price"] / 100, lv["qty"]) for lv in d["book"]["asks"]],
        )

    # ---- your account ----

    def positions(self) -> dict[str, Any]:
        return self._call("GET", "/v1/positions")

    def position(self, ticker: str) -> int:
        for p in self.positions()["positions"]:
            if p["symbol"] == ticker:
                return p["qty"]
        return 0

    def open_orders(self) -> list[Order]:
        return [_order(o) for o in self._call("GET", "/v1/orders?open=true&limit=200")]

    def fills(self, limit: int = 100) -> list[dict[str, Any]]:
        return self._call("GET", f"/v1/fills?limit={limit}")

    # ---- trading ----

    def place(self, symbol: str, side: str, qty: int, price: float | None = None,
              type: str | None = None, tif: str | None = None, stop: float | None = None) -> Order:
        """Sends one order. With a price it's a limit order, without one a market order."""
        body: dict[str, Any] = {"symbol": symbol, "side": side, "qty": int(qty),
                                "type": type or ("limit" if price is not None else "market")}
        if price is not None:
            body["price"] = to_cents(price)
        if stop is not None:
            body["stopPrice"] = to_cents(stop)
        if tif:
            body["tif"] = tif
        # An order the exchange rejected (outside the price band, say) comes back as 422
        # with the order itself; return it so the bot can read reject_reason.
        try:
            return _order(self._call("POST", "/v1/orders", body))
        except TickerError as err:
            if err.status == 422 and isinstance(err.body, dict) and "status" in err.body:
                return _order(err.body)
            raise

    def buy(self, symbol: str, qty: int, price: float | None = None, **kw: Any) -> Order:
        return self.place(symbol, "buy", qty, price, **kw)

    def sell(self, symbol: str, qty: int, price: float | None = None, **kw: Any) -> Order:
        return self.place(symbol, "sell", qty, price, **kw)

    def cancel(self, order_id: int) -> Order:
        return _order(self._call("DELETE", f"/v1/orders/{order_id}"))

    def cancel_all(self, symbol: str | None = None) -> int:
        """Cancels your working orders (in one symbol, or all). Returns how many."""
        n = 0
        for o in self.open_orders():
            if symbol is None or o.symbol == symbol:
                try:
                    self.cancel(o.id)
                    n += 1
                except RateLimited as err:
                    time.sleep(err.retry_after)
                    self.cancel(o.id)
                    n += 1
                except TickerError as err:
                    if err.status != 409:  # already filled or cancelled
                        raise
        return n
