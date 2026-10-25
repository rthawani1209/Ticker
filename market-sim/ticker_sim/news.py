"""News engine: random company and market headlines, plus scripted ones from scenarios."""

from __future__ import annotations

import itertools
import random
from dataclasses import asdict, dataclass

from .symbols import SYMBOLS, Symbol


@dataclass(frozen=True)
class Template:
    kind: str
    headline: str
    impact_bps: tuple[int, int]  # range; negative is bad news
    sectors: tuple[str, ...] = ()  # empty = any sector
    weight: float = 1.0


TEMPLATES = [
    Template("earnings_beat", "{company} beats earnings estimates and raises full-year guidance", (300, 900), weight=2),
    Template("earnings_miss", "{company} misses on revenue; guidance cut", (-1000, -300), weight=2),
    Template("upgrade", "Analyst upgrades {name} to Buy, citing strong demand", (100, 300), weight=2),
    Template("downgrade", "Analyst downgrades {name} to Sell over valuation concerns", (-300, -100), weight=2),
    Template("product_launch", "{company} unveils its next-generation product line", (100, 500)),
    Template("ceo_exit", "{company} CEO steps down unexpectedly", (-700, -200), weight=0.5),
    Template("lawsuit", "{company} hit with class-action lawsuit", (-600, -200), weight=0.7),
    Template("buyback", "{company} announces $500M share buyback", (150, 400), weight=0.7),
    Template("fda_approval", "FDA approves {company}'s lead drug candidate", (800, 2000), ("biotech",), 1.5),
    Template("fda_rejection", "FDA rejects {company}'s drug application", (-2500, -1000), ("biotech",), 1.5),
    Template("contract_win", "{company} wins $2B government launch contract", (400, 1200), ("aerospace",), 1.5),
    Template("launch_failure", "{company} rocket lost shortly after liftoff", (-1500, -500), ("aerospace",), 1),
    Template("oil_spike", "Oil jumps 8% on supply cuts; {company} rallies", (300, 800), ("energy",), 1),
    Template("data_breach", "{company} discloses breach affecting millions of customers", (-800, -300), ("tech", "telecom", "finance")),
    Template("recall", "{company} recalls products over safety issue", (-600, -200), ("consumer", "materials")),
    # Scripted only (weight 0): big events that scenarios place on purpose.
    Template("fraud", "Short seller alleges accounting fraud at {company}", (-3000, -2000), weight=0),
    Template("takeover", "{company} agrees to be acquired at a 30% premium", (2500, 3000), weight=0),
]

BY_KIND = {t.kind: t for t in TEMPLATES}

# Market-wide headlines move every stock, scaled per sector.
MACRO = [
    ("rate_hike", "Fed raises rates by 50 basis points", -150, {"finance": -0.5, "tech": 1.5}),
    ("rate_cut", "Fed cuts rates in a surprise move", 150, {"finance": -0.5, "tech": 1.5}),
    ("jobs_strong", "Jobs report comes in far above expectations", 80, {}),
    ("recession_fears", "Recession fears grow as factory orders slump", -120, {"consumer": 1.5}),
]


@dataclass(frozen=True)
class NewsItem:
    id: int
    time: float  # seconds since the simulation started
    kind: str
    headline: str
    symbol: int | None  # None = market-wide
    impact_bps: int  # for market-wide news, the base impact before sector scaling
    scripted: bool = False

    def to_json(self) -> dict:
        d = asdict(self)
        d["ticker"] = SYMBOLS[self.symbol].name if self.symbol is not None else None
        return d


class NewsEngine:
    def __init__(self, rng: random.Random, per_minute: float = 1.0, macro_share: float = 0.1,
                 kind_weights: dict[str, float] | None = None) -> None:
        self.rng = rng
        self.per_minute = per_minute
        self.macro_share = macro_share
        self.kind_weights = kind_weights or {}
        self._ids = itertools.count(1)

    def tick(self, now: float, dt: float) -> list[NewsItem]:
        """Random news: on average per_minute items a minute."""
        if self.rng.random() >= self.per_minute * dt / 60:
            return []
        if self.rng.random() < self.macro_share:
            kind, headline, impact, _ = self.rng.choice(MACRO)
            return [NewsItem(next(self._ids), now, kind, headline, None, impact)]
        sym = self.rng.choice(SYMBOLS)
        return [self.company_news(now, sym, self._pick_template(sym))]

    def company_news(self, now: float, sym: Symbol, t: Template, impact_bps: int | None = None,
                     headline: str | None = None, scripted: bool = False) -> NewsItem:
        lo, hi = t.impact_bps
        impact = impact_bps if impact_bps is not None else self.rng.randint(lo, hi)
        text = headline or t.headline.format(company=sym.company, name=sym.name)
        return NewsItem(next(self._ids), now, t.kind, text, sym.id, impact, scripted)

    def macro_news(self, now: float, kind: str) -> NewsItem:
        for k, headline, impact, _ in MACRO:
            if k == kind:
                return NewsItem(next(self._ids), now, k, headline, None, impact, True)
        raise KeyError(kind)

    def _pick_template(self, sym: Symbol) -> Template:
        choices = [t for t in TEMPLATES if not t.sectors or sym.sector in t.sectors]
        weights = [t.weight * self.kind_weights.get(t.kind, 1.0) for t in choices]
        return self.rng.choices(choices, weights)[0]


def impacts(item: NewsItem) -> dict[int, float]:
    """How much each symbol's fair value moves, in bps."""
    if item.symbol is not None:
        return {item.symbol: float(item.impact_bps)}
    scale = next((s for k, _, _, s in MACRO if k == item.kind), {})
    return {sym.id: item.impact_bps * scale.get(sym.sector, 1.0) for sym in SYMBOLS}
