"""Scenario cases: how many bots of each kind, how noisy the market is, and any
scripted events. Stored as TOML files in market-sim/scenarios/."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .news import BY_KIND, MACRO
from .symbols import BY_NAME

SCENARIO_DIR = Path(__file__).resolve().parent.parent / "scenarios"
EVENT_TYPES = ("news", "macro", "liquidity_pull")
_MACRO_KINDS = {k for k, *_ in MACRO}


@dataclass
class BotCounts:
    market_makers_per_symbol: int = 2
    momentum: int = 4
    noise: int = 12
    news_traders: int = 4


@dataclass
class ScriptedEvent:
    at: float  # seconds after start
    type: str
    symbol: str | None = None
    kind: str | None = None
    impact_bps: int | None = None
    headline: str | None = None
    seconds: float = 30.0  # liquidity_pull: how long
    factor: float = 5.0  # liquidity_pull: how much wider market makers quote


@dataclass
class Scenario:
    name: str
    description: str = ""
    duration_s: float = 0.0  # 0 = run until stopped
    vol_bps_per_min: float = 30.0
    news_per_minute: float = 1.0
    news_weights: dict[str, float] = field(default_factory=dict)
    bots: BotCounts = field(default_factory=BotCounts)
    bot_params: dict[str, dict] = field(default_factory=dict)  # per kind, passed to the bot constructor
    events: list[ScriptedEvent] = field(default_factory=list)


class ScenarioError(ValueError):
    pass


def parse(data: dict, name: str = "scenario") -> Scenario:
    data = dict(data)
    bots = BotCounts(**data.pop("bots", {}))
    events = [ScriptedEvent(**e) for e in data.pop("events", [])]
    sc = Scenario(name=data.pop("name", name), bots=bots, events=events, **data)
    validate(sc)
    return sc


def validate(sc: Scenario) -> None:
    for e in sc.events:
        if e.type not in EVENT_TYPES:
            raise ScenarioError(f"{sc.name}: unknown event type {e.type!r}")
        if e.type in ("news", "liquidity_pull") and e.symbol not in BY_NAME:
            raise ScenarioError(f"{sc.name}: unknown symbol {e.symbol!r}")
        if e.type == "news" and e.kind not in BY_KIND:
            raise ScenarioError(f"{sc.name}: unknown news kind {e.kind!r}")
        if e.type == "macro" and e.kind not in _MACRO_KINDS:
            raise ScenarioError(f"{sc.name}: unknown macro kind {e.kind!r}")
    for kind in sc.news_weights:
        if kind not in BY_KIND:
            raise ScenarioError(f"{sc.name}: unknown news kind {kind!r} in news_weights")
    sc.events.sort(key=lambda e: e.at)


def load(name_or_path: str) -> Scenario:
    path = Path(name_or_path)
    if not path.suffix:
        path = SCENARIO_DIR / f"{name_or_path}.toml"
    if not path.exists():
        raise ScenarioError(f"no scenario {name_or_path!r} (have: {', '.join(available())})")
    with path.open("rb") as f:
        return parse(tomllib.load(f), path.stem)


def available() -> list[str]:
    return sorted(p.stem for p in SCENARIO_DIR.glob("*.toml"))
