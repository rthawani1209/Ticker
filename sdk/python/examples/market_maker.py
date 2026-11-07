"""A simple market maker: keeps one bid and one ask around the mid price, and leans
its quotes against its inventory so it doesn't pile up a big position.

    TICKER_URL=http://localhost:8080 TICKER_KEY=tk_... python examples/market_maker.py NOVA

Ctrl-C cancels its quotes before it exits.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ticker_sdk import RateLimited, Ticker, TickerError  # noqa: E402

log = logging.getLogger("mm")


def quotes(mid: float, inventory: int, spread_bps: float, skew_bps: float, max_inv: int):
    """Bid and ask prices in dollars. Long inventory lowers both (to sell more easily),
    short raises them. Rounded away from the mid so the spread never crosses."""
    lean = -(inventory / max_inv) * skew_bps / 10_000 * mid
    half = spread_bps / 20_000 * mid
    bid = int((mid + lean - half) * 100) / 100
    ask = -int(-(mid + lean + half) * 100) / 100
    if ask <= bid:
        ask = round(bid + 0.01, 2)
    return bid, ask


def run(t: Ticker, symbol: str, size: int, spread_bps: float, skew_bps: float, max_inv: int,
        every: float, rounds: int | None = None) -> None:
    working: list[int] = []
    n = 0
    while rounds is None or n < rounds:
        n += 1
        try:
            q = t.quote(symbol)
            inv = t.position(symbol)
            for oid in working:
                try:
                    t.cancel(oid)
                except TickerError:
                    pass  # it filled or was already gone
            working = []
            if q.halted:
                log.info("%s is halted, waiting", symbol)
            else:
                bid, ask = quotes(q.mid, inv, spread_bps, skew_bps, max_inv)
                # Stop adding to a side once inventory hits the limit.
                if inv < max_inv:
                    working.append(t.buy(symbol, size, price=bid).id)
                if inv > -max_inv:
                    working.append(t.sell(symbol, size, price=ask).id)
                log.info("mid %.2f inv %+d -> bid %.2f ask %.2f", q.mid, inv, bid, ask)
        except RateLimited as err:
            time.sleep(err.retry_after)
        except TickerError as err:
            log.warning("%s", err)
            if err.status in (401, 503):  # key revoked, or bots paused by an admin
                break
        time.sleep(every)


def stop(*_: object) -> None:
    raise KeyboardInterrupt


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("symbol")
    ap.add_argument("--size", type=int, default=10)
    ap.add_argument("--spread-bps", type=float, default=20)
    ap.add_argument("--skew-bps", type=float, default=15)
    ap.add_argument("--max-inventory", type=int, default=200)
    ap.add_argument("--every", type=float, default=1.0, help="seconds between requotes")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")

    t = Ticker(os.environ.get("TICKER_URL", "http://localhost:8080"), os.environ["TICKER_KEY"])
    # Ctrl-C and `kill` both end with the quotes cancelled. Set SIGINT explicitly: a
    # process started in the background can inherit it as ignored.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGTERM, stop)
    try:
        run(t, args.symbol.upper(), args.size, args.spread_bps, args.skew_bps, args.max_inventory, args.every)
    except KeyboardInterrupt:
        pass
    finally:
        log.info("cancelled %d orders on the way out", t.cancel_all(args.symbol.upper()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
