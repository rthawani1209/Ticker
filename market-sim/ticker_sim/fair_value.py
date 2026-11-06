"""The hidden "true" value of each company. Prices chase it: market makers quote
around a lagged estimate of it, and news moves it in jumps.

Values follow a one-factor log-normal walk: every step, each stock moves with a
shared market shock plus its own. `market_corr` is the correlation between any two
stocks' returns, so a bad tape drags everything a little instead of each name
wandering on its own. All symbols step at once with NumPy."""

from __future__ import annotations

import random

import numpy as np

from .symbols import SYMBOLS


class FairValue:
    def __init__(self, rng: random.Random, vol_bps_per_min: float = 30.0,
                 market_corr: float = 0.3) -> None:
        if not 0.0 <= market_corr < 1.0:
            raise ValueError("market_corr must be in [0, 1)")
        # Seeded from the caller's rng so a scenario seed still fixes the whole run.
        self.gen = np.random.default_rng(rng.getrandbits(64))
        ref = np.array([s.ref_price for s in SYMBOLS], dtype=np.float64)
        self.values = ref.copy()
        self.floor = ref * 0.1
        self.cap = np.minimum(ref * 10.0, 60_000.0)
        self.vol_bps_per_min = vol_bps_per_min
        self.market_corr = market_corr

    def __getitem__(self, symbol: int) -> float:
        return float(self.values[symbol])

    def step(self, dt: float) -> None:
        """Advances every value by dt seconds."""
        sigma = self.vol_bps_per_min / 10_000 * np.sqrt(dt / 60)
        market = self.gen.standard_normal()
        own = self.gen.standard_normal(self.values.size)
        z = np.sqrt(self.market_corr) * market + np.sqrt(1 - self.market_corr) * own
        # The -sigma^2/2 drift keeps the expected value flat (no built-in trend).
        self.values *= np.exp(sigma * z - 0.5 * sigma * sigma)
        np.clip(self.values, self.floor, self.cap, out=self.values)

    def jump(self, symbol: int, bps: float) -> None:
        v = self.values[symbol] * (1 + bps / 10_000)
        self.values[symbol] = min(max(v, self.floor[symbol]), self.cap[symbol])
