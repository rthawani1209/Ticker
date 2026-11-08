# Architecture

Ticker is a pretend stock exchange for student trading competitions. Unlike most practice apps, it runs its own exchange, so prices move because people and bots actually trade with each other.

## The pieces

```
 browsers ──┐
 student bots ─┼──> backend (gateway) ──TCP, binary──> engine (exchange)
 market-sim ───┘         │                                  │
                     Postgres, Redis                    journal files
```

Everything that trades goes through the same door. Browsers and student bots use the gateway's JSON API. The market simulator talks to the engine directly as a trusted "proxy" session, but it is held to the same matching rules. Nobody gets a shortcut.

| Part | Language | Job |
|---|---|---|
| `engine/` | C++20 | The exchange. Keeps the order books, matches orders, enforces price bands and halts, and writes every input to a journal. Knows nothing about users or money. |
| `backend/` | TypeScript (Node, Fastify) | The gateway and the ledger. Logins, the REST and WebSocket APIs, rate limits, and turning JSON orders into the engine's binary messages. Keeps orders, fills, cash, positions and leagues in Postgres, and live rankings in Redis. |
| `market-sim/` | Python (asyncio) | Bots and news, so the market is alive even with nobody logged in. |
| `frontend/` | Next.js | The web app: landing, trade, portfolio, leagues (with teacher tools) and bots screens. Pages render per request so each gets a fresh CSP nonce (`src/proxy.ts`). |

## The engine

**One thread does all the matching for a shard.** Each order book is touched by exactly one thread, so there are no locks, and the same inputs always produce the same outputs. The network thread hands commands over through lock-free single-producer/single-consumer ring buffers. With one writer and one reader per ring, it only needs two atomic counters with acquire/release ordering.

**The order book** (`engine/include/ticker/order_book.hpp`):
- Prices are whole cents ("ticks"), so each side of the book is just an array indexed by price. A price level holds a total and a doubly linked list of orders, oldest first. That gives price-time priority.
- To find the next non-empty price quickly, a three-level bitmap (`bit_tree.hpp`) marks which prices have orders. Finding the next set bit is a few CPU instructions per level, so it's constant time however sparse the book is.
- Cancelling uses a hash map from order id to the order's list node (`order_map.hpp`). Unlinking from a doubly linked list is O(1), so cancelling one order among 10,000 costs the same as among 100.
- Orders come from a pool allocated up front (`pool.hpp`). The matching path never calls `new`, and a test fails if it ever does.

**Rules the engine enforces:** price bands (no order more than 10% away from the last trade), self-trade prevention (an incoming order that would trade with the same account, or the same self-trade group, is cancelled; the gateway puts all of one person's portfolios in one group), FOK/IOC handling, stop orders that wait off the book until the last trade reaches them, manual halts, and a circuit breaker that halts a stock for 5 minutes if it moves 15% inside a 5-minute window.

**Time comes from the command, not the clock.** Every command carries a timestamp set by the gateway when it arrived. The breaker and halts use that, never the wall clock. That is what makes replay exact.

**Journal and replay.** Before a batch of commands is processed, it is appended to a journal file and flushed (group commit). Each record has a CRC32C checksum. On restart the engine replays the journal to rebuild every book, and a torn last record from a crash is detected and cut off. `ticker-replay` runs a journal and prints a hash of all output. Same journal, same hash, every time.

**Wire protocol.** Fixed-size little-endian structs with a 4-byte header, explicit padding and no pointers (`docs/protocol.md`). A NewOrder is 48 bytes. Encoding is a memcpy, the parser rejects a bad header immediately, and the same layout is mirrored in Python and TypeScript with size tests on both sides.

## The gateway

- **Accounts.** Passwords are hashed with argon2id. Logging in returns a 15-minute access token (a signed JWT) plus a refresh token in an httpOnly cookie. Refresh tokens are single-use: each refresh swaps it for a new one in the same "family". If an already-used token ever comes back, it was probably stolen, so the whole family is revoked. Two tabs refreshing in the same second are allowed (a 10-second grace window).
- **Orders.** `POST /v1/orders` is validated with Zod, saved as `pending`, sent to the engine, and the response waits for the engine's ack or reject. One background queue applies engine events (acks, fills, cancels) to Postgres in the order they arrive. Each fill is recorded at most once, keyed by trade id.
- **One connection to the engine.** The gateway logs on as a proxy with market data on, keeps its own copy of every book from the public events, and reconnects with backoff if the engine restarts.
- **Live data and trading on one socket.** WebSocket channels for the book, trades, halts and your own orders. A signed-in socket can also send `order` and `cancel` messages; they go through the same validation, buying-power check and rate limit as REST, and the reply carries the client's `ref` so the browser can match it up.
- **Bracket orders.** An entry order can carry a take-profit and a stop-loss. The gateway keeps both exits working for exactly the quantity they protect: what the entry filled, minus what the exits have already closed, capped at the shares actually held. So the exits go out when the entry is done; a partial fill of one shrinks the other (a limit is amended in place, and a stop, which the engine can't amend, is cancelled and re-sent smaller); a full fill cancels the other; and if the shares were sold some other way, the exits shrink or cancel instead of turning into a short. This runs one bracket at a time after every relevant fill, ack or cancel. If the exchange is down at that moment, the reconnect sweep runs it again. The buying-power check counts a bracket's two exits once.
- **Guests.** `POST /v1/auth/guest` makes an account with no email or password and a $100k practice portfolio, so the landing page's "Try it with $100k" needs no sign-up. Guests can't create or join leagues.
- **Several gateways, one feed.** Public market data goes through a fan-out (`backend/src/ws/fanout.ts`). One gateway (`MARKET_PUBLISHER=true`) turns engine events into channel messages and publishes them to the Redis channel `ticker:md`; every gateway, that one included, subscribes and pushes them to its own sockets. So you can add gateways behind a load balancer and each client still gets every trade once. A new book subscriber gets its snapshot from the local gateway's copy of the book and then the deltas from Redis. That can briefly overlap, but deltas carry the absolute size at a price level, so the next change at that level corrects it. Without Redis, a single gateway uses an in-process fan-out. Private order updates don't go through Redis: they come from the gateway that holds the user's socket.
- **Limits.** Kept in Redis so they hold across several gateway instances, and keyed so a whole class behind one campus IP still works: signed-in API calls are counted per user (300 a minute), password guesses per account (10 a minute), token refreshes per session, and only sign-ups and logins have a per-IP cap (30 and 60 a minute). Orders are limited to 20 a second per user.

- **Capacity.** One gateway applies engine events (acks, fills, cancels) through a single queue, so each order's database writes happen in order. On a 4-core cloud VM that tops out a little over 300 orders a second (`docs/results/load-2026-11-08.json` runs 150/s with p99 48 ms). Past that, once 600 events are waiting, new orders get a 503 "busy" rather than a reply that takes longer and longer. To go further, the queue could be split per portfolio, since orders from different portfolios don't depend on each other.

## The ledger

The engine only knows accounts and orders. Money lives in the ledger (`backend/src/ledger.ts`).

- **Leagues and portfolios.** Each user gets one portfolio per league they're in, and everyone is in the "Practice" league. A portfolio's id is the account the engine sees. So the same student in two leagues is two separate accounts on the exchange, with separate cash and positions, and all leagues still trade in the same market.
- **Every fill moves money in the same transaction that records it.** The fill row is inserted first (and skipped if it's a duplicate), then cash and the position are updated. Positions use average cost: buying adds to the cost basis, and selling moves the difference between the sale price and the average cost into realized profit. Commission comes off cash and off realized profit.
- **Fills are the source of truth.** `rebuild()` replays a portfolio's fills from its starting cash, and a test runs 60 random trades and checks that the live tables match the replay to the cent.
- **Pre-trade checks** run with the portfolio row locked (`SELECT ... FOR UPDATE`), so two orders sent at once can't both spend the same cash. The order is saved as `pending` in that same transaction, so the next order sees it as reserved. Checks, in order: the league is running, the order type is allowed, the position limit, shorting allowed, then buying power.
- **Buying power** = cash - what open buy orders could spend - margin held against shorts. Shorting puts the sale proceeds into cash, so a short worth V needs the proceeds plus 50% more (150% total, set per league). Market buys (and stops, which become market orders) are reserved at the price-band ceiling, the worst price the engine lets them reach, so sweeping a thin book can't overdraw cash.
- **Leaderboard.** Every second, each portfolio in a running league is valued at the last traded prices in one SQL query, and its return goes into a Redis sorted set (`lb:<league>:return`). Every minute those values are also saved as equity snapshots, and the Sharpe ratio (mean over standard deviation of the snapshot-to-snapshot returns, annualized) goes into `lb:<league>:sharpe` once a portfolio has 30 returns (before that, a few minutes of data annualizes to nonsense like -800). Without Redis it falls back to memory. Reading the board skips any id that isn't a portfolio in that league, in case Redis outlived a database reset.
- **Portfolio analytics.** `GET /v1/positions/analytics` returns the equity curve (snapshots plus the live value, thinned to 500 points), max drawdown (largest fall from a running peak), win rate (each fill that reduces a position is one round trip, a win if it made money after commission) and the same Sharpe as the board. The maths is pure functions in `analytics.ts`.

## Classroom

- **Roles.** Student (default), professor and admin, plus guest. Routes that need professor or admin read the role from the database on each request, so taking a role away works straight away rather than when the 15-minute token expires. The first admin is made with `backend/scripts/set-role.ts`; after that admins use `PATCH /v1/admin/users/:id`. A test lists every route with who may call it and fails if a route is missing from the list.
- **Professor tools** (`/v1/classes/:id/...`) work on leagues the professor owns (admins: any league): roster, every fill with paging, trades and grades as CSV. The owner is the teacher, so they're left out of the roster and grades.
- **Assignments** have a goal (return at least X%, at least N trades, max drawdown under X%, or fill a given order type) and a due date. Grades are computed when asked, from fills and equity snapshots up to the due date, so they update live and freeze once it passes. No grade table to keep in sync.

- **Fair play** (`fairplay.ts`, the Fair play tab). Two checks over a league, run when the teacher opens the tab. They flag; nothing happens to a student automatically.
  - *Collusion.* Two fills with the same engine trade id are the two sides of one trade, so the server can see who traded with whom. Each fill also stores the middle of the book when it was recorded. A pair is flagged at 5+ trades together, 50%+ of one person's shares, and prices on average 2%+ from the middle. Price-time priority already stops most of this (a colluder's high offer can't trade while a cheaper one rests), so in practice it catches trades placed inside a wide spread.
  - *Spoofing.* Per person: 20+ orders, 90%+ cancelled unfilled, cancelled orders 5x+ the size of the filled ones, and fills on the other side. The size test is what separates it from a market-making bot, which cancels just as often but at the size it trades. Bracket exits and rejected orders aren't counted.

## Bots

- **API keys** look like `tk_<10 hex>_<secret>`. Only the SHA-256 of the secret is stored, compared in constant time, so a database leak doesn't leak keys. The prefix is shown in the app so people can tell keys apart.
- A key acts as its owner but only on `/v1/orders`, `/v1/fills`, `/v1/positions` and `/v1/me`, only in the league it was made for, with its own order size cap and orders-per-second limit (counted in Redis by key, separate from the owner's own limit). Orders record which key placed them.
- Revoking a key cancels its working orders. Admins have a kill switch (`PUT /v1/admin/bots`) that refuses every key with a 503 and cancels all bot orders; the switch is cached for one second.
- Bots use REST only; the WebSocket feed still needs a signed-in session. The starter kit in `sdk/python` polls quotes, which is plenty at 1-20 orders a second.

## The market simulator

Each company has a hidden "true value" that drifts randomly and jumps when news comes out. Market makers quote around a lagged estimate of it. News traders react to headlines within a few seconds. Momentum traders chase trends and protect themselves with stop orders. Noise traders add random flow. Scenario files script events like a fraud allegation that triggers a crash and trips the circuit breaker.

The true values move as a one-factor model in NumPy: each step, every stock gets a shared market shock plus its own, so stocks drift together a little (correlation 0.3 by default) instead of independently. With `--redis-url`, each headline is also published to `ticker:md` on the `news` channel, and the gateways push it to the browser like any other market data.

## Data

Postgres tables so far: `users`, `refresh_tokens`, `symbols`, `leagues`, `portfolios`, `positions`, `orders`, `fills` (append-only), `equity_snapshots`, `audit_log`. A portfolio's id is its account number on the exchange; bots use 900001 and up. Redis holds rate-limit counters and the live leaderboards.
