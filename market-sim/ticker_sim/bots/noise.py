"""Noise trader: random small orders, mostly passive, some crossing the spread.
Stands in for the crowd of casual traders and keeps the tape moving."""

from __future__ import annotations

import math

from ..protocol import Side, TIF
from .base import Bot


class Noise(Bot):
    kind = "noise"

    def __init__(self, *args, orders_per_min: float = 40.0, aggressive: float = 0.35,
                 max_position: int = 400, order_ttl_s: float = 20.0, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.rate = orders_per_min * self.rng.uniform(0.5, 1.5)
        self.aggressive = aggressive
        self.max_position = max_position
        self.order_ttl_s = order_ttl_s

    def on_tick(self, now: float, dt: float) -> None:
        for o in list(self.orders.values()):
            if now - o.placed_at > self.order_ttl_s:
                self.cancel(o.order_id)
        self.expire_pending()

        if self.rng.random() >= self.rate * dt / 60:
            return
        s = self.rng.choice(self.symbols)
        book = self.book(s)
        if book.halted:
            return

        pos = self.position[s]
        # Lean toward reducing big positions so noise traders don't drift off to infinity.
        p_buy = 0.5 - 0.4 * max(-1.0, min(1.0, pos / self.max_position))
        side = Side.BUY if self.rng.random() < p_buy else Side.SELL
        qty = max(1, int(self.rng.lognormvariate(math.log(15), 0.8)))

        if self.rng.random() < self.aggressive:
            self.take(s, side, qty, through_ticks=self.rng.randint(0, 3))
            return
        mid = book.mid()
        tick = max(1.0, mid * 0.0005)
        offset = self.rng.expovariate(1 / 4) * tick
        price = mid - offset if side == Side.BUY else mid + offset
        self.limit(s, side, self.clip(s, price), qty, TIF.GTC)
