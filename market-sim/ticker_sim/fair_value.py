"""The hidden "true" value of each company. Prices chase it: market makers quote
around a lagged estimate of it, and news moves it in jumps."""

from __future__ import annotations

import math
import random

from .symbols import SYMBOLS


class FairValue:
    def __init__(self, rng: random.Random, vol_bps_per_min: float = 30.0) -> None:
        self.rng = rng
        self.values = {s.id: float(s.ref_price) for s in SYMBOLS}
        self.floor = {s.id: s.ref_price * 0.1 for s in SYMBOLS}
        self.cap = {s.id: min(s.ref_price * 10.0, 60_000.0) for s in SYMBOLS}
        self.vol_bps_per_min = vol_bps_per_min

    def __getitem__(self, symbol: int) -> float:
        return self.values[symbol]

    def step(self, dt: float) -> None:
        """Advances every value by a random walk step of dt seconds."""
        sigma = self.vol_bps_per_min / 10_000 * math.sqrt(dt / 60)
        for sym, v in self.values.items():
            v *= math.exp(self.rng.gauss(0.0, sigma) - 0.5 * sigma * sigma)
            self.values[sym] = self._clamp(sym, v)

    def jump(self, symbol: int, bps: float) -> None:
        self.values[symbol] = self._clamp(symbol, self.values[symbol] * (1 + bps / 10_000))

    def _clamp(self, symbol: int, v: float) -> float:
        return min(max(v, self.floor[symbol]), self.cap[symbol])
