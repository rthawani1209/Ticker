# backend

The API gateway between the web app (and student bots) and the exchange. Node 20+, TypeScript, Fastify, Postgres and Redis.

- Accounts with argon2id password hashes, 15-minute JWT access tokens and rotating refresh tokens in an httpOnly cookie. Reusing an old refresh token revokes the whole session family.
- Orders come in as JSON, are checked with Zod, saved to Postgres, and sent to `ticker-engine` in its binary protocol over one shared connection. Engine events update the orders and fills tables in order.
- Live data over WebSocket: order book, trades, halts, and your own order updates.
- A ledger: one portfolio per user per league, cash and positions updated with every fill, buying power and margin checks before an order goes out, and league rules (commissions, position limits, order types, shorting on/off).
- Live leaderboards by return and Sharpe ratio, in Redis sorted sets (memory without Redis).
- Rate limits per IP and per user (in Redis when `REDIS_URL` is set), security headers, CORS, and an audit log of logins and orders.

## API

All prices are in cents. Authenticated routes take `Authorization: Bearer <accessToken>`.

| Method     | Path                          |                                                                                                                                                             |
| ---------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST       | `/v1/auth/register`           | `{email, username, password}` → `{accessToken, user}` and the refresh cookie                                                                                |
| POST       | `/v1/auth/login`              | `{email, password}`                                                                                                                                         |
| POST       | `/v1/auth/refresh`            | swaps the refresh cookie for a new one and a new access token                                                                                               |
| POST       | `/v1/auth/logout`             |                                                                                                                                                             |
| POST       | `/v1/auth/guest`              | "Try it with $100k": a guest with a practice portfolio and a session, no sign-up (guests can't make or join leagues)                                        |
| GET        | `/v1/me`                      |                                                                                                                                                             |
| POST       | `/v1/orders`                  | `{symbol, side, type?, tif?, qty, price?, stopPrice?, takeProfit?, stopLoss?, league?}` (league defaults to practice; takeProfit + stopLoss make a bracket) |
| GET        | `/v1/orders`                  | `?open=true&league=<id>&limit=50&before=<id>`                                                                                                               |
| GET/DELETE | `/v1/orders/:id`              | DELETE cancels                                                                                                                                              |
| GET        | `/v1/fills`                   | `?league=<id>&limit=100`                                                                                                                                    |
| GET        | `/v1/positions`               | `?league=<id>`: cash, equity, positions with average price and P&L                                                                                          |
| POST       | `/v1/leagues`                 | `{name, startingCash?, startsAt?, endsAt?, commissionCents?, commissionBps?, maxPosition?, allowShort?, marginBps?, allowedTypes?}`                         |
| GET        | `/v1/leagues`                 | leagues you're in                                                                                                                                           |
| GET        | `/v1/leagues/:id`             | the owner also sees the invite code                                                                                                                         |
| POST       | `/v1/leagues/join`            | `{code}`                                                                                                                                                    |
| GET        | `/v1/leagues/:id/leaderboard` | `?by=return\|sharpe&limit=50`                                                                                                                               |
| GET        | `/v1/symbols`                 | every stock with last price, bid/ask and volume                                                                                                             |
| GET        | `/v1/market/:ticker`          | `?depth=10`                                                                                                                                                 |
| GET        | `/v1/market/:ticker/trades`   | last 100 trades                                                                                                                                             |
| GET        | `/v1/market/:ticker/candles`  | 15-second price bars (last two hours) for the chart                                                                                                         |
| GET        | `/v1/engine/stats`            | engine throughput and latency                                                                                                                               |
| GET        | `/health`                     |                                                                                                                                                             |

WebSocket at `/ws` (pass `?token=` or send `{"op":"auth","token":...}`), then `{"op":"subscribe","channel":...}` for `book:NOVA`, `trades:NOVA`, `status` or `me:orders`. Signed-in sockets can also trade: `{"op":"order","ref":"a1","order":{...same body as POST /v1/orders}}` and `{"op":"cancel","ref":"a2","id":123}`, answered on the `order`, `cancel` or `error` channel with the same `ref`. Same checks and the same 20 orders/second limit as REST.

Bracket orders: the gateway keeps both exits (a take-profit limit and a stop-loss stop) working for exactly what they protect, which is the entry's filled quantity minus what the exits have closed, capped at the shares you hold. They go out when the entry is done. A partial fill of one shrinks the other, and a full fill cancels it. If you sell the shares some other way, the exits shrink or cancel rather than open a short. If the exchange is down, the reconnect sweep catches up. The exits skip the buying-power check for that reason, and the check counts a bracket's two exits once.

## Known limits

- If the connection to the engine drops, replies sent while it was down are lost. On reconnect, orders still waiting for an acknowledgement are marked rejected (`exchange_unavailable`). If the engine did accept one, its next fill or cancel carries our order id and brings it back. Fills that happen while the backend is disconnected are not recovered yet. The fix is for the engine to number its output and replay from a sequence number when a session logs back on.
- Run the engine with `--journal-dir` in any real deployment so resting orders survive an engine restart.
- Set `TRUST_PROXY=true` only behind a load balancer that sets `X-Forwarded-For`. Otherwise clients could choose their own IP and dodge the per-IP limits.

## Running it

```bash
cp .env.example .env            # then edit
npm install
npm run migrate
npm run dev
```

It needs Postgres, and `ticker-engine` running with the same token (`engine/build/ticker-engine --token 1234`). Redis is optional locally.

## Tests

The tests run against real Postgres, Redis and a real engine, so build the engine first (`cmake --build engine/build --target ticker-engine`).

```bash
createdb ticker_test   # owned by a user that can log in as ticker/ticker, or set TEST_DATABASE_URL
REDIS_URL=redis://localhost:6379 npm test
```

Each test file wipes and re-migrates the test database.

`npm run lint` (ESLint with typescript-eslint) and `npm run format:check` (Prettier, same settings as the frontend) run in CI and in `scripts/check.sh`.
