"""python -m ticker_sim --scenario calm"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from .scenarios import available, load
from .sim import Simulator


def main() -> int:
    ap = argparse.ArgumentParser(prog="ticker_sim", description="Run trading bots against ticker-engine.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9100)
    ap.add_argument("--token", type=int, default=int(os.environ.get("TICKER_TOKEN", "0")),
                    help="engine proxy token (default: $TICKER_TOKEN)")
    ap.add_argument("--scenario", default="calm", help="scenario name or path to a .toml file")
    ap.add_argument("--duration", type=float, help="seconds to run (default: the scenario's, or forever)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--news-out", help="append headlines as JSON lines to this file ('-' for stdout)")
    ap.add_argument("--list", action="store_true", help="list scenarios and exit")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    if args.list:
        for name in available():
            sc = load(name)
            first = " ".join(sc.description.split()).split(". ")[0].rstrip(".")
            print(f"{name:18} {first}")
        return 0

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    scenario = load(args.scenario)
    news_out = None
    if args.news_out == "-":
        news_out = sys.stdout
    elif args.news_out:
        news_out = open(args.news_out, "a", encoding="utf-8")

    async def go() -> None:
        sim = Simulator(scenario, seed=args.seed, news_out=news_out)
        await sim.connect(args.host, args.port, args.token)
        try:
            await sim.run(args.duration)
        finally:
            logging.info("final: %s", sim.report())
            await sim.client.close()

    try:
        asyncio.run(go())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
