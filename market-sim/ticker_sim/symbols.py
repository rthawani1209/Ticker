"""The exchange's listed symbols. Keep in sync with default_symbols() in engine/src/types.cpp."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Symbol:
    id: int
    name: str
    company: str
    sector: str
    ref_price: int  # cents


SYMBOLS = [
    Symbol(0, "NOVA", "Nova Robotics", "tech", 14_000),
    Symbol(1, "HELX", "Helix Therapeutics", "biotech", 5_800),
    Symbol(2, "ORBT", "Orbit Launch Systems", "aerospace", 31_000),
    Symbol(3, "KILN", "Kiln Ceramics", "materials", 2_500),
    Symbol(4, "VYNE", "Vyne Foods", "consumer", 9_700),
    Symbol(5, "QSTR", "Quasar Mobile", "telecom", 1_200),
    Symbol(6, "BRKL", "Brookline Bank", "finance", 7_450),
    Symbol(7, "MESA", "Mesa Energy", "energy", 18_800),
]

BY_NAME = {s.name: s for s in SYMBOLS}
