"""Momentum trader: buys when the short-term average climbs above the long-term one,
sells when it drops below, and protects each position with a stop."""

from __future__ import annotations

from ..protocol import Side
from .base import Bot


class Momentum(Bot):
    kind = "momentum"

    def __init__(self, *args, fast_s: float = 8.0, slow_s: float = 40.0, threshold_bps: float = 25.0,
                 size: int = 60, max_position: int = 300, stop_bps: float = 250.0, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.fast_s = fast_s * self.rng.uniform(0.7, 1.3)
        self.slow_s = slow_s * self.rng.uniform(0.7, 1.3)
        self.threshold = threshold_bps / 10_000
        self.size = size
        self.max_position = max_position
        self.stop_bps = stop_bps
        self.fast = {s: float(self.book(s).last) for s in self.symbols}
        self.slow = dict(self.fast)
        self.cooldown = {s: 0.0 for s in self.symbols}
        self.warmup_until = self.slow_s

    def signal(self, symbol: int) -> float:
        return self.fast[symbol] / self.slow[symbol] - 1

    def on_tick(self, now: float, dt: float) -> None:
        for s in self.symbols:
            last = self.book(s).last
            self.fast[s] += (last - self.fast[s]) * min(1.0, dt / self.fast_s)
            self.slow[s] += (last - self.slow[s]) * min(1.0, dt / self.slow_s)

        if now < self.warmup_until:
            return
        self.expire_pending()
        for s in self.symbols:
            if now < self.cooldown[s] or self.book(s).halted or self.pending_count(s):
                continue
            sig = self.signal(s)
            pos = self.position[s]
            if sig > self.threshold and pos < self.max_position:
                self.enter(s, Side.BUY, min(self.size, self.max_position - pos))
            elif sig < -self.threshold and pos > -self.max_position:
                self.enter(s, Side.SELL, min(self.size, self.max_position + pos))
            elif abs(sig) < self.threshold / 3 and pos != 0:
                # Trend faded: get flat.
                self.cancel_all(s)  # the stop
                self.take(s, Side.SELL if pos > 0 else Side.BUY, abs(pos), through_ticks=2)
                self.cooldown[s] = now + 5

    def enter(self, symbol: int, side: Side, qty: int) -> None:
        if qty <= 0:
            return
        if self.take(symbol, side, qty, through_ticks=3) is not None:
            self.cooldown[symbol] = self.ctx.now + self.rng.uniform(4, 10)

    def on_fill(self, symbol: int, side: Side, price: int, qty: int) -> None:
        pos = self.position[symbol]
        if pos == 0:
            self.cancel_all(symbol)
            return
        # Keep one protective stop sized to the whole position.
        for o in self.open_orders(symbol):
            if o.is_stop:
                self.cancel(o.order_id)
        exit_side = Side.SELL if pos > 0 else Side.BUY
        stop_px = int(price * (1 + exit_side.sign * self.stop_bps / 10_000))
        lo, hi = self.band(symbol)
        if lo < stop_px < hi:
            self.stop(symbol, exit_side, stop_px, abs(pos))
