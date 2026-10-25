"""Shared bookkeeping for all bots: live orders, positions and order helpers."""

from __future__ import annotations

import itertools
import random
from collections import Counter
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable

from .. import protocol as p
from ..protocol import Event, EventType, OrdType, Side, TIF

if TYPE_CHECKING:
    from ..fair_value import FairValue
    from ..market import Book, Market
    from ..news import NewsItem

# The engine rejects prices more than 10% from the last trade. Stay a bit inside that.
BAND = 0.09

_cl_ids = itertools.count(1)


@dataclass
class Context:
    """Everything a bot can see and do. The simulator owns it; tests fake it."""

    market: Market
    fair: FairValue
    submit: Callable[[bytes], None]
    now: float = 0.0


@dataclass
class LiveOrder:
    order_id: int
    symbol: int
    side: Side
    price: int
    leaves: int
    placed_at: float
    is_stop: bool = False


@dataclass
class Pending:
    symbol: int
    side: Side
    price: int
    qty: int
    sent_at: float
    is_stop: bool = False


class Bot:
    kind = "bot"

    def __init__(self, account: int, symbols: list[int], ctx: Context, rng: random.Random) -> None:
        self.account = account
        self.symbols = symbols
        self.ctx = ctx
        self.rng = rng
        self.orders: dict[int, LiveOrder] = {}
        self.pending: dict[int, Pending] = {}
        self.position: Counter[int] = Counter()
        self.cash = 0  # cents, relative to the start
        self.rejects: Counter[str] = Counter()
        self.sent = 0
        self.filled_qty = 0

    # ---- hooks for subclasses ------------------------------------------------------

    def on_tick(self, now: float, dt: float) -> None:
        pass

    def on_news(self, item: NewsItem) -> None:
        pass

    def on_fill(self, symbol: int, side: Side, price: int, qty: int) -> None:
        pass

    # ---- engine events ---------------------------------------------------------

    def on_event(self, e: Event) -> None:
        if e.type == EventType.ACK:
            pend = self.pending.pop(e.cl_ord_id, None)
            if pend is not None:
                self.orders[e.order_id] = LiveOrder(e.order_id, e.symbol, e.side, e.price, e.qty, self.ctx.now,
                                                    pend.is_stop)
        elif e.type == EventType.REJECT:
            self.pending.pop(e.cl_ord_id, None)
            try:
                self.rejects[p.RejectReason(e.reason).name] += 1
            except ValueError:
                self.rejects[str(e.reason)] += 1
        elif e.type == EventType.FILL:
            signed = e.qty * e.side.sign
            self.position[e.symbol] += signed
            self.cash -= signed * e.price
            self.filled_qty += e.qty
            o = self.orders.get(e.order_id)
            if o is not None:
                o.leaves = e.leaves
                if e.leaves == 0:
                    del self.orders[e.order_id]
            self.on_fill(e.symbol, e.side, e.price, e.qty)
        elif e.type == EventType.CANCELLED:
            self.orders.pop(e.order_id, None)
        elif e.type == EventType.REPLACED:
            o = self.orders.get(e.order_id)
            if o is not None:
                o.price, o.leaves = e.price, e.qty

    # ---- helpers ----------------------------------------------------------------

    def book(self, symbol: int) -> Book:
        return self.ctx.market.books[symbol]

    def band(self, symbol: int) -> tuple[int, int]:
        last = self.book(symbol).last
        return max(1, int(last * (1 - BAND)) + 1), int(last * (1 + BAND))

    def clip(self, symbol: int, price: float) -> int:
        lo, hi = self.band(symbol)
        return min(max(int(round(price)), lo), hi)

    def limit(self, symbol: int, side: Side, price: int, qty: int, tif: TIF = TIF.GTC) -> int:
        cl = next(_cl_ids)
        self.pending[cl] = Pending(symbol, side, price, qty, self.ctx.now)
        self.ctx.submit(p.new_order(symbol, side, qty, price, cl_ord_id=cl, account=self.account, tif=tif))
        self.sent += 1
        return cl

    def take(self, symbol: int, side: Side, qty: int, through_ticks: int = 0) -> int | None:
        """Marketable IOC limit order: crosses the spread by `through_ticks` past the best price."""
        book = self.book(symbol)
        best = book.best_ask() if side == Side.BUY else book.best_bid()
        if best is None:
            return None
        price = self.clip(symbol, best + side.sign * through_ticks)
        return self.limit(symbol, side, price, qty, TIF.IOC)

    def stop(self, symbol: int, side: Side, stop_price: int, qty: int) -> int:
        cl = next(_cl_ids)
        self.pending[cl] = Pending(symbol, side, 0, qty, self.ctx.now, is_stop=True)
        self.ctx.submit(p.new_order(symbol, side, qty, cl_ord_id=cl, account=self.account,
                                    ord_type=OrdType.STOP, stop_price=stop_price))
        self.sent += 1
        return cl

    def cancel(self, order_id: int) -> None:
        o = self.orders.get(order_id)
        if o is None:
            return
        self.ctx.submit(p.cancel(o.symbol, order_id, account=self.account))
        self.sent += 1

    def cancel_all(self, symbol: int | None = None) -> None:
        for o in list(self.orders.values()):
            if symbol is None or o.symbol == symbol:
                self.cancel(o.order_id)

    def open_orders(self, symbol: int, side: Side | None = None) -> list[LiveOrder]:
        return [o for o in self.orders.values() if o.symbol == symbol and (side is None or o.side == side)]

    def pending_count(self, symbol: int) -> int:
        return sum(1 for pd in self.pending.values() if pd.symbol == symbol)

    def expire_pending(self, max_age: float = 5.0) -> None:
        # Pending entries whose ack never matched (e.g. sent during a reconnect) shouldn't pile up.
        now = self.ctx.now
        for cl in [cl for cl, pd in self.pending.items() if now - pd.sent_at > max_age]:
            del self.pending[cl]

    def pnl(self) -> float:
        """Mark-to-market profit in dollars."""
        value = sum(qty * self.book(sym).last for sym, qty in self.position.items())
        return (self.cash + value) / 100
