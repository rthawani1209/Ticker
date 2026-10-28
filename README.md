# Ticker

[![engine](https://github.com/rthawani1209/Ticker/actions/workflows/engine.yml/badge.svg)](https://github.com/rthawani1209/Ticker/actions/workflows/engine.yml)
[![backend](https://github.com/rthawani1209/Ticker/actions/workflows/backend.yml/badge.svg)](https://github.com/rthawani1209/Ticker/actions/workflows/backend.yml)
[![market-sim](https://github.com/rthawani1209/Ticker/actions/workflows/market-sim.yml/badge.svg)](https://github.com/rthawani1209/Ticker/actions/workflows/market-sim.yml)
[![frontend](https://github.com/rthawani1209/Ticker/actions/workflows/frontend.yml/badge.svg)](https://github.com/rthawani1209/Ticker/actions/workflows/frontend.yml)

Stock market simulator for student trading competitions, powered by a C++ matching engine.

Students get fake money and trade against each other and against bots on a real order book, so their orders actually move prices. Clubs and classes can run leagues with live leaderboards.

> Work in progress. The matching engine, trading bots and API gateway are done; the web app and league features follow.

## Repo layout

```
Ticker/
├── engine/        C++20 matching engine (the exchange): order book, matching, risk checks
│   ├── include/   public headers
│   ├── src/       implementation (src/server/ is the TCP server)
│   ├── tests/     unit tests and the differential fuzz test
│   └── bench/     benchmarks and the latency tool
├── backend/       Node.js API gateway: accounts, orders, live market data (leagues and ledger coming)
├── market-sim/    Python trading bots, news engine and scenario cases
├── frontend/      Next.js web app
├── sdk/python/    starter kit for writing your own trading bot (coming)
├── infra/         Docker Compose and AWS deploy (coming)
├── scripts/       check.sh (runs everything CI runs), bench.sh (writes docs/results/)
└── docs/          architecture, interview notes, claims with proof, benchmark results
```

## Engine

The exchange core is in [`engine/`](engine). It is a C++20 limit order book with price-time priority:

- limit, market, stop and stop-limit orders, GTC / IOC / FOK
- cancel and cancel/replace (shrinking an order keeps its place in line)
- self-trade prevention, price bands around the last trade
- trading halts and a circuit breaker that pauses a stock moving too far too fast
- O(1) cancel via an open-addressing id map, O(1) best-price lookup via a 3-level bitmap
- no heap allocation while matching (orders come from a pre-allocated pool)
- a TCP server (`ticker-engine`) with a compact binary protocol, one matching thread per shard fed by lock-free queues
- a write-ahead journal: every order is on disk before it is acknowledged, and a restart replays it to rebuild the books

Every change is checked against a small, obviously-correct reference book: the tests feed both the same random order flow and require identical output.

```bash
cmake -S engine -B engine/build
cmake --build engine/build -j
ctest --test-dir engine/build --output-on-failure
```

Matching takes 143 ns at the median and 1.6 µs at p99, at 7.6M commands/sec on one core of a 4 vCPU cloud VM (Xeon @ 2.80GHz), from [docs/results/engine-bench-2026-10-28.json](docs/results/engine-bench-2026-10-28.json). See [docs/benchmarks.md](docs/benchmarks.md) for how it's measured.

Start the server with `engine/build/ticker-engine --port 9100 --journal-dir data/`. The protocol is described in [docs/protocol.md](docs/protocol.md).

Run the differential test longer with `TICKER_FUZZ_COMMANDS=1000000 engine/build/engine_tests --gtest_filter='Differential*'`.

## Market simulator

Bots in [`market-sim/`](market-sim) keep the market alive: market makers, momentum traders, noise traders and news traders, driven by a news engine and scenario cases like a flash crash or a meme-stock rally.

```bash
engine/build/ticker-engine --token 1234 &
cd market-sim && python -m ticker_sim --token 1234 --scenario flash-crash
```

## Backend

The API in [`backend/`](backend) is how people and student bots reach the exchange: sign-up and login with rotating refresh tokens, a JSON order API that speaks the engine's binary protocol, and WebSocket channels for the order book, trades and your own orders. Orders and fills are stored in Postgres. See [backend/README.md](backend/README.md) for the full API.

## Frontend

The web app in [`frontend/`](frontend) is Next.js with TypeScript and CSS modules, built on "Signal", Ticker's own design tokens (dark instrument-panel look, fixed-width numbers, green and red only for price direction, amber for your own orders). So far it has the landing page with a live read-only market; the trading screen is next. See [frontend/README.md](frontend/README.md).

