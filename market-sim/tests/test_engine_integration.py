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


def start_engine(journal: Path) -> tuple[subprocess.Popen, int]:
    proc = subprocess.Popen([str(ENGINE), "--host", "127.0.0.1", "--port", "0", "--token", str(TOKEN),
                             "--journal-dir", str(journal)], stdout=subprocess.PIPE, text=True)
    m = re.search(r":(\d+) ", proc.stdout.readline())
    assert m
    return proc, int(m.group(1))


def resting_vs_known(sim: Simulator) -> tuple[int, int]:
    resting = sum(sum(b.bids.values()) + sum(b.asks.values()) for b in sim.market.books.values())
    known = sum(o.leaves for bot in sim.bots for o in bot.orders.values() if not o.is_stop)
    return resting, known


def test_picks_up_after_an_engine_restart(tmp_path):
    """The engine restarts and replays its journal, quotes and all. The sim logs on
    again and carries on; a brand new sim process pulls the quotes the old one left."""
    async def go():
        proc, port = start_engine(tmp_path)
        sim = Simulator(load("calm"), seed=3)
        try:
            await sim.connect("127.0.0.1", port, TOKEN)
            await sim.run(3)
            proc.terminate()
            proc.wait(timeout=10)
            await asyncio.wait_for(sim.client.closed.wait(), 5)

            proc, port = start_engine(tmp_path)
            await sim.reconnect("127.0.0.1", port, TOKEN)
            await sim.run(6)  # the clock carries on from 3 s
            await asyncio.sleep(0.5)  # let the last replies land
            after_reconnect = (sim.trades, *resting_vs_known(sim))
            await sim.client.close()

            # A new process: its bots know nothing about the old quotes.
            sim = Simulator(load("calm"), seed=4)
            await sim.connect("127.0.0.1", port, TOKEN)
            await sim.run(2)
            await asyncio.sleep(0.5)
            return after_reconnect, resting_vs_known(sim)
        finally:
            await sim.client.close()
            proc.terminate()
            proc.wait(timeout=10)

    (trades, resting, known), (resting2, known2) = asyncio.run(go())
    assert trades > 10
    assert resting > 0 and resting == known
    assert resting2 > 0 and resting2 == known2
