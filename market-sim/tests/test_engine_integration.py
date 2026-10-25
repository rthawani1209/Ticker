"""Runs the bots against a real ticker-engine. Skipped if the engine isn't built."""

import asyncio
import os
import re
import subprocess
from pathlib import Path

import pytest

from ticker_sim.scenarios import load, parse
from ticker_sim.sim import Simulator
from ticker_sim.symbols import BY_NAME

ENGINE = Path(os.environ.get("TICKER_ENGINE", Path(__file__).resolve().parents[2] / "engine/build/ticker-engine"))
TOKEN = 4242

pytestmark = pytest.mark.skipif(not ENGINE.exists(), reason=f"engine not built at {ENGINE}")


@pytest.fixture
def engine_port():
    proc = subprocess.Popen([str(ENGINE), "--host", "127.0.0.1", "--port", "0", "--token", str(TOKEN)],
                            stdout=subprocess.PIPE, text=True)
    line = proc.stdout.readline()
    m = re.search(r":(\d+) ", line)
    assert m, f"unexpected engine output: {line!r}"
    yield int(m.group(1))
    proc.terminate()
    proc.wait(timeout=10)


def run(scenario, port, seconds):
    async def go():
        sim = Simulator(scenario, seed=7)
        await sim.connect("127.0.0.1", port, TOKEN)
        await sim.run(seconds)
        await sim.client.close()
        return sim

    return asyncio.run(go())


def test_calm_market_trades(engine_port):
    sim = run(load("calm"), engine_port, 6)
    assert sim.trades > 10
    sent = sum(b.sent for b in sim.bots)
    assert sum(sim.rejects().values()) < sent * 0.05
    # Market makers keep both sides of every book filled.
    for book in sim.market.books.values():
        assert book.best_bid() is not None and book.best_ask() is not None
        assert book.best_bid() < book.best_ask()


def test_crash_trips_the_circuit_breaker(engine_port):
    sc = parse({
        "name": "fast-crash",
        "news_per_minute": 0,
        "bots": {"momentum": 6, "noise": 8, "news_traders": 8},
        "events": [
            {"at": 1, "type": "news", "symbol": "ORBT", "kind": "fraud", "impact_bps": -2800},
            {"at": 1, "type": "liquidity_pull", "symbol": "ORBT", "seconds": 60, "factor": 8},
        ],
    })
    sim = run(sc, engine_port, 15)
    orbt = sim.market.books[BY_NAME["ORBT"].id]
    assert sim.halts >= 1 and orbt.halted
    # The breaker halts before any trade prints past the 15% limit, so the last price
    # sits somewhere between the open and that limit.
    assert BY_NAME["ORBT"].ref_price * 0.85 <= orbt.last < BY_NAME["ORBT"].ref_price * 0.95
