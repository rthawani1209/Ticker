# Claims

Every line of Ticker that goes on a resume, with the proof behind it. Open this before an interview: each row says where the evidence lives, how to re-check it yourself in one command, and the number we actually measured.

Numbers come from committed results files only. Benchmarks on a shared cloud VM move around by 20-40% between runs, so quote the file and its date, not a rounded-up best case.

Status: **done** = built and proven; **partial** = built, proof or number still coming; **planned** = not built yet (day in brackets). Don't put a planned row on a resume.

## Exchange (C++ engine)

| Claim | Status | Proof | Re-check it | Measured |
|---|---|---|---|---|
| C++20 limit order book with price-time priority | done | `engine/tests/order_book_test.cpp` (`PriceThenTimePriority`, `SweepsSeveralLevels`, `CancelFromMiddleOfQueue`) | `ctest --test-dir engine/build -R BookTest` | 30 order book tests + 6 circuit breaker tests |
| Market, limit, stop and stop-limit orders; GTC, IOC, FOK; cancel and cancel/replace | done | `order_book_test.cpp` (`IocNeverRests`, `FokKillsWhenNotFullyFillable`, `StopLimitRestsAfterTrigger`, `ReplaceDownKeepsPriority`...) | same as above | |
| Self-trade prevention and price bands | done | `SelfTradePreventionCancelsIncoming`, `PriceBandFollowsLastTrade`, `MarketOrderStopsAtPriceBand` | same as above | bands at 10% from the last trade |
| Trading halts and a circuit breaker | done | `BreakerTest.*` in `order_book_test.cpp`; `market-sim/tests/test_engine_integration.py::test_crash_trips_the_circuit_breaker` | `ctest --test-dir engine/build -R BreakerTest` | trips at 15% inside a 5-minute window, halts 5 minutes |
| Matching throughput | done | [`docs/results/engine-bench-2026-10-27.json`](results/engine-bench-2026-10-27.json) (`MixedFlow/fast`) | `scripts/bench.sh` | **5.2M commands/sec** on one core (mixed flow, one symbol, book only) |
| Matching latency | done | same file (`latency_ns.reported`) | `scripts/bench.sh` | **p50 205 ns, p99 1.8 µs** per command inside the book |
| O(1) best-price lookup with a 3-level bitmap | done | `engine/include/ticker/bit_tree.hpp`; `BitTree.MatchesStdSet` | `ctest --test-dir engine/build -R BitTree` | |
| O(1) cancel (hash map to an intrusive list node) | done | `order_map.hpp`, `order_book.hpp`; `AddCancel` in the bench file | `scripts/bench.sh` | add+cancel 330 ns with 100 resting orders vs 332 ns with 10,000 (reference book: 0.8 µs vs 47 µs) |
| No heap allocation on the matching path | done | `engine/tests/alloc_test.cpp` (`HotPathDoesNotAllocate`) | `engine/build/alloc_test` | 0 allocations over 300k commands |
| Differential fuzzing against a simple reference engine | done | `engine/tests/differential_test.cpp`, `reference_book.hpp`; CI job "differential fuzz (long)" | `TICKER_FUZZ_COMMANDS=1000000 engine/build/engine_tests --gtest_filter='Differential*'` | 20M random commands per CI run (4 suites x 5 seeds x 1M), output must match exactly |
| ASan, UBSan and TSan in CI | done | `.github/workflows/engine.yml` | `scripts/check.sh` | |
| Lock-free single-producer/single-consumer ring buffers | done | `spsc_ring.hpp`; `SpscRing.TwoThreadsKeepOrder` under TSan | `ctest --test-dir engine/build -R SpscRing` | |
| epoll TCP server, one matching thread per shard | done | `engine/src/server/`; `ServerTest.*` | `ctest --test-dir engine/build -R ServerTest` | |
| Compact fixed-size binary protocol | done | `protocol.hpp` static_asserts; `docs/protocol.md`; matching size tests in Python and TypeScript | `ctest --test-dir engine/build -R Protocol` | **NewOrder = 48 bytes** (Replace is 40) |
| Journal with byte-identical replay | done | `JournalTest.ReplayIsByteIdentical`, `ServerTest.RestartRecoversBookFromJournal`, `ticker-replay` | `ctest --test-dir engine/build -R Journal` | |
| Replay of a recorded trading day | planned (day 11) | | | |
| Fuzz target for the message parser | partial | `Protocol.FuzzParser` (200k random buffers); libFuzzer target planned (day 11) | `ctest --test-dir engine/build -R Protocol` | |

## Market simulator (Python)

| Claim | Status | Proof | Re-check it | Measured |
|---|---|---|---|---|
| Market-maker, momentum, noise and news-trader bots | done | `market-sim/ticker_sim/bots/`; `market-sim/tests/test_bots.py` | `cd market-sim && python -m pytest` | |
| News engine with scheduled and surprise headlines | done | `news.py`; `tests/test_news.py` | same | |
| Scenario cases (earnings week, crash, meme rally, rate shock) | done | `market-sim/scenarios/*.toml`; `tests/test_scenarios.py` | `python -m ticker_sim --list` | 5 cases |
| ETF arbitrage scenario | planned (day 8) | | | |
| Markets stay active with no users | done | `test_engine_integration.py::test_calm_market_trades` | `cd market-sim && python -m pytest tests/test_engine_integration.py` | |
| asyncio + NumPy price models | partial | asyncio done; NumPy models planned (day 6-7) | | |

## Gateway (TypeScript)

| Claim | Status | Proof | Re-check it | Measured |
|---|---|---|---|---|
| Converts JSON orders into the engine's binary protocol | done | `backend/src/engine/`; `backend/test/protocol.test.ts`, `orders.test.ts` | `cd backend && npm test` | |
| REST API (`/v1/...`) and WebSocket channels | done | `backend/src/routes/`, `backend/src/ws/hub.ts`; `ws.test.ts` | same | |
| Argon2id passwords, short-lived JWTs, rotating refresh tokens with reuse detection | done | `backend/src/auth/`; `auth.test.ts` | same | access tokens last 15 min |
| Login and order rate limits in Redis | done | `auth.test.ts` (`rate limits login attempts`), `orders.test.ts` (`rate limits order entry per user`) | same | 10 logins/min per IP, 20 orders/s per user |
| Zod validation on every input, parameterized SQL only | done | `backend/src/routes/*.ts`; `validates input` tests | same | |
| Audit trail of logins, orders and cancels | done | `audit_log` table; `refresh_reuse` check in `auth.test.ts` | same | |
| Integration tests against real Postgres and Redis | done | `backend/test/harness.ts`; `.github/workflows/backend.yml` | same | 50 tests |
| Redis pub/sub fan-out to WebSocket servers | planned (day 6-7) | | | |
| [X] ms WebSocket delay | planned (day 6-7) | | | |
| [X] ms p99 end-to-end under load (500 users + 50 bots) | planned (day 11) | | | |

## Ledger and leagues (TypeScript)

| Claim | Status | Proof | Re-check it | Measured |
|---|---|---|---|---|
| Cash, positions and profit/loss per portfolio, updated in the same transaction as each fill | done | `backend/src/ledger.ts` (`applyFill`), `backend/src/orders.ts`; `ledger.test.ts` (`charges commission on fills...`) | `cd backend && npx vitest run test/ledger.test.ts` | |
| Every balance can be rebuilt from the append-only fill history | done | `rebuild()` in `ledger.ts`; `ledger.test.ts` (`rebuilds every balance from fills after a run of random trades`) | same | 60 random trades between 4 traders, cash and every position match the replay exactly |
| Pre-trade checks: buying power with open orders reserved | done | `checkOrder()` in `ledger.ts`; `buying power` tests | same | |
| Short selling with margin | done | same; `holds margin against shorts` | same | 150% Reg T style by default (sale proceeds + 50%), set per league |
| Leagues with invite codes, custom dates and starting cash | done | `backend/src/routes/leagues.ts`; `leagues` tests | same | |
| League rules: commissions, position limits, allowed order types, shorting on/off | done | `002_ledger.sql`, `checkOrder()`; `enforces the league's rules`, `charges commission on fills` | same | |
| Live leaderboard by return, refreshed every second, in Redis sorted sets | done | `backend/src/leaderboard.ts`; `leaderboard` test | same | 1 s refresh |
| Sharpe ratio leaderboard | done | `sharpeRatio()` in `leaderboard.ts` (checked against a hand calculation); `ranks ... by Sharpe` test | same | annualized from 1-minute equity snapshots, risk-free rate 0 |
| Max drawdown, win rate, return chart | planned (day 8) | | | |
| Assignments and grading | planned (day 9) | | | |

## Still to come

Trading UI (days 7-8); classroom tools, badges and the bot API (day 9); fair-play detection and the AI coach (day 10); load tests and security scans (day 11); AWS deploy (day 12). Rows get added here as each one lands.
