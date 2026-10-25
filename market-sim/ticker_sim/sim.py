"""Runs a scenario against a live engine: one proxy session trades for every bot."""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections import Counter
from typing import IO

from . import protocol as p
from .bots import KINDS, Bot, Context, MarketMaker
from .client import EngineClient
from .fair_value import FairValue
from .market import Market
from .news import BY_KIND, NewsEngine, NewsItem, impacts
from .scenarios import Scenario, ScriptedEvent
from .symbols import BY_NAME, SYMBOLS

log = logging.getLogger(__name__)

TICK_S = 0.05
FIRST_BOT_ACCOUNT = 900_001  # well away from real user accounts
PRIVATE = {p.EventType.ACK, p.EventType.REJECT, p.EventType.FILL, p.EventType.CANCELLED,
           p.EventType.REPLACED, p.EventType.TRIGGERED}


class Simulator:
    def __init__(self, scenario: Scenario, seed: int = 1, news_out: IO[str] | None = None) -> None:
        self.scenario = scenario
        self.rng = random.Random(seed)
        self.market = Market()
        self.fair = FairValue(random.Random(self.rng.random()), scenario.vol_bps_per_min)
        self.news = NewsEngine(random.Random(self.rng.random()), scenario.news_per_minute,
                               kind_weights=scenario.news_weights)
        self.news_out = news_out
        self.client = EngineClient(self.on_message)
        self.ctx = Context(self.market, self.fair, self.client.send)
        self.bots: list[Bot] = []
        self.by_account: dict[int, Bot] = {}
        self.headlines: list[NewsItem] = []
        self.trades = 0
        self.halts = 0
        self.engine_stats: dict[int, p.Stats] = {}
        self._script = list(scenario.events)
        self._start = 0.0

    # ---- setup ------------------------------------------------------------------

    def make_bots(self) -> None:
        counts = self.scenario.bots
        account = FIRST_BOT_ACCOUNT
        ids = [s.id for s in SYMBOLS]

        def add(kind: str, symbols: list[int]) -> None:
            nonlocal account
            params = self.scenario.bot_params.get(kind, {})
            bot = KINDS[kind](account, symbols, self.ctx, random.Random(self.rng.random()), **params)
            self.bots.append(bot)
            self.by_account[account] = bot
            account += 1

        for sym in ids:
            for _ in range(counts.market_makers_per_symbol):
                add("market_maker", [sym])
        for _ in range(counts.momentum):
            add("momentum", self.rng.sample(ids, 3))
        for _ in range(counts.noise):
            add("noise", self.rng.sample(ids, 4))
        for _ in range(counts.news_traders):
            add("news_trader", ids)

    async def connect(self, host: str, port: int, token: int) -> None:
        ack = await self.client.connect(host, port, flags=p.PROXY | p.MARKET_DATA, token=token)
        log.info("connected as session %d, engine lists %d symbols", ack.session, ack.symbols)
        for s in SYMBOLS[: ack.symbols]:
            self.client.send(p.symbol_msg(p.MsgType.SUBSCRIBE, s.id))
        await self.client.drain()
        await asyncio.sleep(0.2)  # let the snapshots arrive
        # Start each company's true value at its current price, not the listing price.
        for s in SYMBOLS:
            self.fair.values[s.id] = float(self.market.books[s.id].last)

    # ---- main loop ----------------------------------------------------------------

    async def run(self, duration_s: float | None = None) -> None:
        duration = self.scenario.duration_s if duration_s is None else duration_s
        if not self.bots:
            self.make_bots()
        self._start = time.monotonic()
        last = 0.0
        next_report = 10.0
        while not self.client.closed.is_set():
            now = time.monotonic() - self._start
            dt = now - last
            last = now
            self.ctx.now = now

            self.fair.step(dt)
            for item in self.scripted(now) + self.news.tick(now, dt):
                self.publish(item)
            for bot in self.bots:
                bot.on_tick(now, dt)
            await self.client.drain()

            if now >= next_report:
                log.info(self.report())
                next_report += 10
            if duration and now >= duration:
                break
            await asyncio.sleep(max(0.0, TICK_S - (time.monotonic() - self._start - now)))

    def scripted(self, now: float) -> list[NewsItem]:
        out = []
        while self._script and self._script[0].at <= now:
            e = self._script.pop(0)
            item = self.run_event(e, now)
            if item is not None:
                out.append(item)
        return out

    def run_event(self, e: ScriptedEvent, now: float) -> NewsItem | None:
        if e.type == "news":
            sym = BY_NAME[e.symbol]
            return self.news.company_news(now, sym, BY_KIND[e.kind], e.impact_bps, e.headline, scripted=True)
        if e.type == "macro":
            return self.news.macro_news(now, e.kind)
        if e.type == "liquidity_pull":
            sym = BY_NAME[e.symbol].id
            for bot in self.bots:
                if isinstance(bot, MarketMaker):
                    bot.pull(sym, now + e.seconds, e.factor)
        return None

    def publish(self, item: NewsItem) -> None:
        for sym, bps in impacts(item).items():
            self.fair.jump(sym, bps)
        self.headlines.append(item)
        log.info("NEWS %s (%+d bps)", item.headline, item.impact_bps)
        if self.news_out is not None:
            self.news_out.write(json.dumps(item.to_json()) + "\n")
            self.news_out.flush()
        for bot in self.bots:
            bot.on_news(item)

    # ---- engine messages ------------------------------------------------------------

    def on_message(self, msg: p.Event | p.Stats) -> None:
        if isinstance(msg, p.Stats):
            self.engine_stats[msg.shard] = msg
            return
        if msg.type in PRIVATE:
            bot = self.by_account.get(msg.account)
            if bot is not None:
                bot.on_event(msg)
            return
        self.market.on_event(msg, self.ctx.now)
        if msg.type == p.EventType.TRADE:
            self.trades += 1
        elif msg.type == p.EventType.TRADING_STATUS and msg.reason == 1:
            self.halts += 1
            log.warning("%s halted", SYMBOLS[msg.symbol].name)

    # ---- reporting ------------------------------------------------------------------

    def rejects(self) -> Counter[str]:
        total: Counter[str] = Counter()
        for b in self.bots:
            total.update(b.rejects)
        return total

    def report(self) -> str:
        sent = sum(b.sent for b in self.bots)
        prices = " ".join(f"{s.name} {self.market.books[s.id].last / 100:.2f}" for s in SYMBOLS)
        rej = self.rejects()
        top = ", ".join(f"{k.lower()} {v}" for k, v in rej.most_common(3))
        rej_text = f"{sum(rej.values())} ({top})" if rej else "0"
        return f"orders {sent}  trades {self.trades}  rejects {rej_text}  halts {self.halts} | {prices}"
