"""Market maker: keeps a ladder of bids and asks around its estimate of fair value."""

from __future__ import annotations

from ..protocol import Side
from .base import Bot


class MarketMaker(Bot):
    kind = "market_maker"

    def __init__(self, *args, levels: int = 3, size: int = 40, max_inventory: int = 600,
                 lag_s: float = 4.0, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.levels = levels
        self.size = size
        self.max_inventory = max_inventory
        self.lag_s = lag_s  # how quickly the estimate catches up with the true value
        self.requote_every = self.rng.uniform(0.3, 0.8)
        self.next_quote = 0.0
        self.estimate = {s: float(self.book(s).last) for s in self.symbols}
        self.widen = {s: 1.0 for s in self.symbols}  # >1 right after news or during a liquidity pull
        self.pulled_until = {s: 0.0 for s in self.symbols}

    def on_news(self, item) -> None:
        targets = [item.symbol] if item.symbol is not None else self.symbols
        for s in targets:
            if s in self.widen:
                self.widen[s] = max(self.widen[s], 1 + abs(item.impact_bps) / 200)

    def pull(self, symbol: int, until: float, factor: float) -> None:
        """Scenario hook: quote much wider (or not at all) for a while."""
        if symbol in self.widen:
            self.pulled_until[symbol] = until
            self.widen[symbol] = max(self.widen[symbol], factor)

    def on_tick(self, now: float, dt: float) -> None:
        alpha = min(1.0, dt / self.lag_s)
        for s in self.symbols:
            # Mostly follow the true value with a lag, but also lean on where the market trades.
            target = 0.8 * self.ctx.fair[s] + 0.2 * self.book(s).last
            self.estimate[s] += (target - self.estimate[s]) * alpha
            if now >= self.pulled_until[s]:
                self.widen[s] = max(1.0, self.widen[s] * (1 - 0.1 * dt))

        if now < self.next_quote:
            return
        self.next_quote = now + self.requote_every
        self.expire_pending()
        for s in self.symbols:
            if not self.book(s).halted:
                self.quote(s)

    def desired_quotes(self, symbol: int) -> dict[tuple[Side, int], int]:
        """(side, price) -> qty for the ladder this bot wants resting right now."""
        est = self.estimate[symbol]
        inv = self.position[symbol]
        tick_half = max(1.0, est * 0.0006) * self.widen[symbol]
        step = max(1, round(est * 0.0004))
        # Lean the ladder against inventory so fills pull us back toward flat.
        center = est - inv / self.max_inventory * tick_half * 2
        # Snap to the ladder step so small wiggles in the estimate don't cancel and resend everything.
        center = round(center / step) * step

        want: dict[tuple[Side, int], int] = {}
        for i in range(self.levels):
            size = self.size * (i + 1)
            if inv < self.max_inventory:
                bid = self.clip(symbol, int(center - tick_half) - i * step)
                want[(Side.BUY, bid)] = want.get((Side.BUY, bid), 0) + size
            if inv > -self.max_inventory:
                ask = self.clip(symbol, -int(-(center + tick_half)) + i * step)  # round up
                want[(Side.SELL, ask)] = want.get((Side.SELL, ask), 0) + size

        # Never cross ourselves: if clipping pushed the sides together, drop the worse ones.
        bids = [px for (sd, px) in want if sd == Side.BUY]
        asks = [px for (sd, px) in want if sd == Side.SELL]
        if bids and asks and max(bids) >= min(asks):
            mid = (max(bids) + min(asks)) / 2
            want = {(sd, px): q for (sd, px), q in want.items()
                    if (sd == Side.BUY and px < mid) or (sd == Side.SELL and px > mid)}
        return want

    def quote(self, symbol: int) -> None:
        if self.pending_count(symbol) > 0:
            return  # wait for acks before changing the ladder again
        want = self.desired_quotes(symbol)
        for o in self.open_orders(symbol):
            if want.pop((o.side, o.price), None) is None:
                self.cancel(o.order_id)
        for (side, price), qty in want.items():
            self.limit(symbol, side, price, qty)
