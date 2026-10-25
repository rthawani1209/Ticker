"""What the simulator knows about the market, rebuilt from the engine's public events."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from .protocol import Event, EventType, Side
from .symbols import SYMBOLS


@dataclass
class Book:
    symbol: int
    last: int  # last trade price, starts at the reference price
    bids: dict[int, int] = field(default_factory=dict)  # price -> total qty
    asks: dict[int, int] = field(default_factory=dict)
    trades: deque[tuple[float, int, int]] = field(default_factory=lambda: deque(maxlen=500))  # (time, price, qty)
    halted: bool = False
    volume: int = 0

    def best_bid(self) -> int | None:
        return max(self.bids) if self.bids else None

    def best_ask(self) -> int | None:
        return min(self.asks) if self.asks else None

    def mid(self) -> float:
        bid, ask = self.best_bid(), self.best_ask()
        if bid is not None and ask is not None:
            return (bid + ask) / 2
        return float(self.last)

    def spread(self) -> int | None:
        bid, ask = self.best_bid(), self.best_ask()
        return ask - bid if bid is not None and ask is not None else None


class Market:
    def __init__(self) -> None:
        self.books = {s.id: Book(s.id, s.ref_price) for s in SYMBOLS}

    def on_event(self, e: Event, now: float) -> None:
        book = self.books.get(e.symbol)
        if book is None:
            return
        if e.type in (EventType.BOOK_DELTA, EventType.SNAPSHOT_LEVEL):
            levels = book.bids if e.side == Side.BUY else book.asks
            if e.level_qty:
                levels[e.price] = e.level_qty
            else:
                levels.pop(e.price, None)
        elif e.type == EventType.TRADE:
            book.last = e.price
            book.volume += e.qty
            book.trades.append((now, e.price, e.qty))
        elif e.type == EventType.SNAPSHOT_END:
            if e.price:
                book.last = e.price
        elif e.type == EventType.TRADING_STATUS:
            book.halted = e.reason == 1
