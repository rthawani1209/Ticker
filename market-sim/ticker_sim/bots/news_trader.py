"""News trader: reads each headline, waits a human-ish reaction time, trades in the
direction of the news, then takes profit a while later."""

from __future__ import annotations

from dataclasses import dataclass

from ..news import NewsItem, impacts
from ..protocol import Side
from .base import Bot


@dataclass
class Plan:
    at: float
    symbol: int
    side: Side
    qty: int


class NewsTrader(Bot):
    kind = "news_trader"

    def __init__(self, *args, reaction_s: tuple[float, float] = (0.3, 3.0), size_per_100bps: int = 40,
                 hold_s: tuple[float, float] = (20.0, 90.0), contrarian: float = 0.1,
                 max_position: int = 800, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.reaction_s = reaction_s
        self.size_per_100bps = size_per_100bps
        self.hold_s = hold_s
        self.contrarian = contrarian
        self.max_position = max_position
        self.plans: list[Plan] = []

    def on_news(self, item: NewsItem) -> None:
        now = self.ctx.now
        for sym, bps in impacts(item).items():
            if sym not in self.symbols or abs(bps) < 50:
                continue
            side = Side.BUY if bps > 0 else Side.SELL
            if self.rng.random() < self.contrarian:
                side = Side.SELL if side == Side.BUY else Side.BUY  # "priced in"
            qty = max(1, int(abs(bps) / 100 * self.size_per_100bps * self.rng.uniform(0.5, 1.5)))
            delay = self.rng.uniform(*self.reaction_s)
            self.plans.append(Plan(now + delay, sym, side, qty))

    def on_tick(self, now: float, dt: float) -> None:
        self.expire_pending()
        due = [pl for pl in self.plans if pl.at <= now]
        if not due:
            return
        self.plans = [pl for pl in self.plans if pl.at > now]
        for pl in due:
            if self.book(pl.symbol).halted:
                pl.at = now + 5  # try again after the halt
                self.plans.append(pl)
                continue
            pos = self.position[pl.symbol]
            room = self.max_position - pos * pl.side.sign
            qty = min(pl.qty, room)
            if qty <= 0:
                continue
            self.take(pl.symbol, pl.side, qty, through_ticks=self.rng.randint(2, 8))

    def on_fill(self, symbol: int, side: Side, price: int, qty: int) -> None:
        # Book the exit for whatever was just bought or sold, unless this fill was itself an exit.
        pos = self.position[symbol]
        if pos * side.sign <= 0:
            return
        exit_side = Side.SELL if side == Side.BUY else Side.BUY
        self.plans.append(Plan(self.ctx.now + self.rng.uniform(*self.hold_s), symbol, exit_side, qty))
