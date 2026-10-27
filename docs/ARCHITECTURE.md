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
| `backend/` | TypeScript (Node, Fastify) | The gateway. Logins, the REST and WebSocket APIs, rate limits, and turning JSON orders into the engine's binary messages. Stores orders and fills in Postgres. |
| `market-sim/` | Python (asyncio) | Bots and news, so the market is alive even with nobody logged in. |
| `frontend/` | Next.js | The trading app (coming, days 7-8). |

## The engine

**One thread does all the matching for a shard.** Each order book is touched by exactly one thread, so there are no locks, and the same inputs always produce the same outputs. The network thread hands commands over through lock-free single-producer/single-consumer ring buffers. With one writer and one reader per ring, it only needs two atomic counters with acquire/release ordering.

**The order book** (`engine/include/ticker/order_book.hpp`):
- Prices are whole cents ("ticks"), so each side of the book is just an array indexed by price. A price level holds a total and a doubly linked list of orders, oldest first. That gives price-time priority.
- To find the next non-empty price quickly, a three-level bitmap (`bit_tree.hpp`) marks which prices have orders. Finding the next set bit is a few CPU instructions per level, so it's constant time however sparse the book is.
- Cancelling uses a hash map from order id to the order's list node (`order_map.hpp`). Unlinking from a doubly linked list is O(1), so cancelling one order among 10,000 costs the same as among 100.
- Orders come from a pool allocated up front (`pool.hpp`). The matching path never calls `new`, and a test fails if it ever does.

**Rules the engine enforces:** price bands (no order more than 10% away from the last trade), self-trade prevention (an incoming order that would trade with the same account is cancelled), FOK/IOC handling, stop orders that wait off the book until the last trade reaches them, manual halts, and a circuit breaker that halts a stock for 5 minutes if it moves 15% inside a 5-minute window.

**Time comes from the command, not the clock.** Every command carries a timestamp set by the gateway when it arrived. The breaker and halts use that, never the wall clock. That is what makes replay exact.

**Journal and replay.** Before a batch of commands is processed, it is appended to a journal file and flushed (group commit). Each record has a CRC32C checksum. On restart the engine replays the journal to rebuild every book, and a torn last record from a crash is detected and cut off. `ticker-replay` runs a journal and prints a hash of all output. Same journal, same hash, every time.

**Wire protocol.** Fixed-size little-endian structs with a 4-byte header, explicit padding and no pointers (`docs/protocol.md`). A NewOrder is 48 bytes. Encoding is a memcpy, the parser rejects a bad header immediately, and the same layout is mirrored in Python and TypeScript with size tests on both sides.

## The gateway

- **Accounts.** Passwords are hashed with argon2id. Logging in returns a 15-minute access token (a signed JWT) plus a refresh token in an httpOnly cookie. Refresh tokens are single-use: each refresh swaps it for a new one in the same "family". If an already-used token ever comes back, it was probably stolen, so the whole family is revoked. Two tabs refreshing in the same second are allowed (a 10-second grace window).
- **Orders.** `POST /v1/orders` is validated with Zod, saved as `pending`, sent to the engine, and the response waits for the engine's ack or reject. One background queue applies engine events (acks, fills, cancels) to Postgres in the order they arrive. Each fill is recorded at most once, keyed by trade id.
- **One connection to the engine.** The gateway logs on as a proxy with market data on, keeps its own copy of every book from the public events, and reconnects with backoff if the engine restarts.
- **Live data.** WebSocket channels for the book, trades, halts and your own orders.
- **Limits.** Per-IP login limits and per-user order limits, kept in Redis so they hold across several gateway instances.

## The market simulator

Each company has a hidden "true value" that drifts randomly and jumps when news comes out. Market makers quote around a lagged estimate of it. News traders react to headlines within a few seconds. Momentum traders chase trends and protect themselves with stop orders. Noise traders add random flow. Scenario files script events like a fraud allegation that triggers a crash and trips the circuit breaker.

## Data

Postgres tables so far: `users`, `refresh_tokens`, `symbols`, `orders`, `fills` (append-only), `audit_log`. A user's id is also their account number on the exchange; bots use 900001 and up.
