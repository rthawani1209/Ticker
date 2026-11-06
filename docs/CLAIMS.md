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
| Self-trade prevention across one person's accounts (no wash trades between their league portfolios) | done | `stp_group` in `types.hpp`/`protocol.hpp`; `BookTest.SelfTradePreventionCoversAGroupOfAccounts`; `Differential.GroupedAccounts` (fuzz with grouped accounts); `backend/test/ledger.test.ts` (`self-trade prevention`) | `ctest --test-dir engine/build -R SelfTrade` and `cd backend && npm test` | |
| Trading halts and a circuit breaker | done | `BreakerTest.*` in `order_book_test.cpp`; `market-sim/tests/test_engine_integration.py::test_crash_trips_the_circuit_breaker` | `ctest --test-dir engine/build -R BreakerTest` | trips at 15% inside a 5-minute window, halts 5 minutes |
| Matching throughput | done | [`docs/results/engine-bench-2026-10-28.json`](results/engine-bench-2026-10-28.json) (`MixedFlow/fast`) | `scripts/bench.sh` | **7.6M commands/sec** on one core (mixed flow, one symbol, book only), 4 vCPU cloud VM, Xeon @ 2.80GHz |
| Matching latency | done | same file (`latency_ns.reported`) | `scripts/bench.sh` | **p50 143 ns, p99 1.6 µs** per command inside the book |
| O(1) best-price lookup with a 3-level bitmap | done | `engine/include/ticker/bit_tree.hpp`; `BitTree.MatchesStdSet` | `ctest --test-dir engine/build -R BitTree` | |
| O(1) cancel (hash map to an intrusive list node) | done | `order_map.hpp`, `order_book.hpp`; `AddCancel` in the bench file | `scripts/bench.sh` | add+cancel 258 ns with 100 resting orders vs 208 ns with 10,000 (reference book: 0.7 µs vs 42 µs) |
| No heap allocation on the matching path | done | `engine/tests/alloc_test.cpp` (`HotPathDoesNotAllocate`) | `engine/build/alloc_test` | 0 allocations over 300k commands |
| Differential fuzzing against a simple reference engine | done | `engine/tests/differential_test.cpp`, `reference_book.hpp`; CI job "differential fuzz (long)" | `TICKER_FUZZ_COMMANDS=1000000 engine/build/engine_tests --gtest_filter='Differential*'` | 20M random commands per CI run (4 suites x 5 seeds x 1M) plus 200k with grouped accounts, output must match exactly |
| ASan, UBSan and TSan in CI | done | `.github/workflows/engine.yml` | `scripts/check.sh` | |
| Lock-free single-producer/single-consumer ring buffers | done | `spsc_ring.hpp`; `SpscRing.TwoThreadsKeepOrder` under TSan | `ctest --test-dir engine/build -R SpscRing` | |
| epoll TCP server, one matching thread per shard | done | `engine/src/server/`; `ServerTest.*` | `ctest --test-dir engine/build -R ServerTest` | |
| Compact fixed-size binary protocol | done | `protocol.hpp` static_asserts; `docs/protocol.md`; matching size tests in Python and TypeScript | `ctest --test-dir engine/build -R Protocol` | **NewOrder = 48 bytes** (Replace is 40) |
| Journal with byte-identical replay | done | `JournalTest.ReplayIsByteIdentical`, `ServerTest.RestartRecoversBookFromJournal`, `ticker-replay` | `ctest --test-dir engine/build -R Journal` | |
| Replay of a recorded trading day | planned (day 12) | | | |
| Fuzz target for the message parser | partial | `Protocol.FuzzParser` (200k random buffers); libFuzzer target planned (day 12) | `ctest --test-dir engine/build -R Protocol` | |

## Market simulator (Python)

| Claim | Status | Proof | Re-check it | Measured |
|---|---|---|---|---|
| Market-maker, momentum, noise and news-trader bots | done | `market-sim/ticker_sim/bots/`; `market-sim/tests/test_bots.py` | `cd market-sim && python -m pytest` | |
| News engine with scheduled and surprise headlines | done | `news.py`; `tests/test_news.py` | same | |
| Scenario cases (earnings week, crash, meme rally, rate shock) | done | `market-sim/scenarios/*.toml`; `tests/test_scenarios.py` | `python -m ticker_sim --list` | 5 cases |
| Markets stay active with no users | done | `test_engine_integration.py::test_calm_market_trades` | `cd market-sim && python -m pytest tests/test_engine_integration.py` | |
| asyncio bots + NumPy price model | done | `market-sim/ticker_sim/fair_value.py` (one-factor model, all symbols stepped as one array); `tests/test_fair_value.py` checks the volatility and cross-stock correlation it produces | `cd market-sim && python -m pytest tests/test_fair_value.py` | measured volatility within 5% of the setting, correlation 0.3 ± 0.03 over 20k steps |
| Live news feed through Redis to the browser | done | `market-sim/ticker_sim/redis_news.py`; `backend/test/fanout.test.ts` (`relays news published by the simulator`); `tests/test_redis_news.py` | `python -m ticker_sim --redis-url redis://localhost:6379` | |

## Gateway (TypeScript)

| Claim | Status | Proof | Re-check it | Measured |
|---|---|---|---|---|
| Converts JSON orders into the engine's binary protocol | done | `backend/src/engine/`; `backend/test/protocol.test.ts`, `orders.test.ts` | `cd backend && npm test` | |
| REST API (`/v1/...`) and WebSocket channels | done | `backend/src/routes/`, `backend/src/ws/hub.ts`; `ws.test.ts` | same | |
| Orders and cancels over the WebSocket, with the same checks as REST | done | `trade()` in `backend/src/ws/hub.ts`; `trading.test.ts` (`places and cancels with the same rules as REST`) | `cd backend && npx vitest run test/trading.test.ts` | 20 orders/s per socket |
| Bracket orders (take-profit + stop-loss, one cancels the other) | done | `syncExits()` in `backend/src/orders.ts`; `trading.test.ts` (`bracket orders`: partial exit fills, reconnect, no shorting through exits) | same | |
| Guest account with $100k, no sign-up | done | `POST /v1/auth/guest`; `trading.test.ts` (`guest accounts`) | same | |
| Argon2id passwords, short-lived JWTs, rotating refresh tokens with reuse detection | done | `backend/src/auth/`; `auth.test.ts` | same | access tokens last 15 min |
| Login and order rate limits in Redis | done | `auth.test.ts` (`rate limits login attempts`), `orders.test.ts` (`rate limits order entry per user`) | same | 10 logins/min per IP, 20 orders/s per user |
| Zod validation on every input, parameterized SQL only | done | `backend/src/routes/*.ts`; `validates input` tests | same | |
| Audit trail of logins, orders and cancels | done | `audit_log` table; `refresh_reuse` check in `auth.test.ts` | same | |
| Integration tests against real Postgres and Redis | done | `backend/test/harness.ts`; `.github/workflows/backend.yml` | same | 65 tests |
| Redis pub/sub fan-out to WebSocket servers | done | `backend/src/ws/fanout.ts`; `backend/test/fanout.test.ts` (two gateways, a client on each gets every trade exactly once) | `cd backend && npx vitest run test/fanout.test.ts` | |
| WebSocket delay with two gateways | done | [`docs/results/ws-delay-2026-11-06.json`](results/ws-delay-2026-11-06.json); `backend/scripts/ws-delay.ts` | `cd backend && npx tsx scripts/ws-delay.ts` | **p50 9 ms, p99 17 ms** (publishing gateway) and **p50 6 ms, p99 12 ms** (relay) to 500 clients, 250k messages each, no drops; one 4-vCPU VM with clients in the same process |
| [X] ms p99 end-to-end under load (500 users + 50 bots) | planned (day 12) | | | |

## Ledger and leagues (TypeScript)

| Claim | Status | Proof | Re-check it | Measured |
|---|---|---|---|---|
| Cash, positions and profit/loss per portfolio, updated in the same transaction as each fill | done | `backend/src/ledger.ts` (`applyFill`), `backend/src/orders.ts`; `ledger.test.ts` (`charges commission on fills...`) | `cd backend && npx vitest run test/ledger.test.ts` | |
| Every balance can be rebuilt from the append-only fill history | done | `rebuild()` in `ledger.ts`; `ledger.test.ts` (`rebuilds every balance from fills after a run of random trades`) | same | 60 random trades between 4 traders, cash and every position match the replay exactly |
| Pre-trade checks: buying power with open orders reserved | done | `checkOrder()` in `ledger.ts`; `buying power` tests | same | |
| Market orders can't overdraw cash | done | `estimatePrice()` in `ledger.ts` reserves market buys at the price-band ceiling; `market orders` test sweeps a thin book | same | |
| Short selling with margin | done | same; `holds margin against shorts` | same | 150% Reg T style by default (sale proceeds + 50%), set per league |
| Leagues with invite codes, custom dates and starting cash | done | `backend/src/routes/leagues.ts`; `leagues` tests | same | |
| League rules: commissions, position limits, allowed order types, shorting on/off | done | `002_ledger.sql`, `checkOrder()`; `enforces the league's rules`, `charges commission on fills` | same | |
| Live leaderboard by return, refreshed every second, in Redis sorted sets | done | `backend/src/leaderboard.ts`; `leaderboard` test | same | 1 s refresh |
| Sharpe ratio leaderboard | done | `sharpeRatio()` in `leaderboard.ts` (checked against a hand calculation); `ranks ... by Sharpe` test | same | annualized from 1-minute equity snapshots, risk-free rate 0 |
| Max drawdown, win rate, return chart | planned (day 10) | | | |
| Assignments and grading | planned (day 11) | | | |

## Web app (Next.js)

| Claim | Status | Proof | Re-check it | Measured |
|---|---|---|---|---|
| Landing page with a live read-only market (falls back to a recorded replay) | done | `frontend/src/components/landing/`; `depth.test.ts`, `replay.test.ts` | `cd frontend && npm test` | |
| Trade screen: TradingView Lightweight Charts, depth ladder with one-click trading, order ticket | done | `frontend/src/components/trade/`; `ladder.test.ts`, `ticket.test.ts` | same | |
| Keyboard shortcuts (B buy, S sell, Esc cancel) | done | `TradeScreen.tsx` | `npm run dev`, open /trade | |
| Light and dark themes | done | `frontend/src/styles/tokens.css`, `ThemeToggle.tsx` | same | |
| Component tests, ESLint + Prettier in CI | done | `frontend/test/`; `.github/workflows/frontend.yml` | `npm test && npm run lint` | 19 tests |

## Still to come

Portfolio and League screens (day 10); roles, professor tools, assignments, bot API keys, Python starter kit and fair-play detection (day 11); Docker Compose, load test, Playwright, libFuzzer, CodeQL and the replay test (day 12). Rows get added here as each one lands. Cut on 2026-11-03 and not claimed: Google sign-in, 2FA, the AI coach, admin console, badges, notifications, News and Bot console screens, practice reset, market sessions, ETF arbitrage scenario, device/IP clustering, data export/delete, engine drop-copy, Under-the-hood and overload pages, ZAP, and AWS.
