# backend

The API gateway between the web app (and student bots) and the exchange. Node 20+, TypeScript, Fastify, Postgres and Redis.

- Accounts with argon2id password hashes, 15-minute JWT access tokens and rotating refresh tokens in an httpOnly cookie. Reusing an old refresh token revokes the whole session family.
- Orders come in as JSON, are checked with Zod, saved to Postgres, and sent to `ticker-engine` in its binary protocol over one shared connection. Engine events update the orders and fills tables in order.
- Live data over WebSocket: order book, trades, halts, and your own order updates.
- Rate limits per IP and per user (in Redis when `REDIS_URL` is set), security headers, CORS, and an audit log of logins and orders.

## API

All prices are in cents. Authenticated routes take `Authorization: Bearer <accessToken>`.

| Method | Path | |
|--------|------|---|
| POST | `/api/auth/register` | `{email, username, password}` → `{accessToken, user}` and the refresh cookie |
| POST | `/api/auth/login` | `{email, password}` |
| POST | `/api/auth/refresh` | swaps the refresh cookie for a new one and a new access token |
| POST | `/api/auth/logout` | |
| GET | `/api/me` | |
| POST | `/api/orders` | `{symbol, side, type?, tif?, qty, price?, stopPrice?}` |
| GET | `/api/orders` | `?open=true&limit=50&before=<id>` |
| GET/DELETE | `/api/orders/:id` | DELETE cancels |
| GET | `/api/fills` | |
| GET | `/api/symbols` | every stock with last price, bid/ask and volume |
| GET | `/api/market/:ticker` | `?depth=10` |
| GET | `/api/market/:ticker/trades` | last 100 trades |
| GET | `/api/engine/stats` | engine throughput and latency |
| GET | `/health` | |

WebSocket at `/ws` (pass `?token=` or send `{"op":"auth","token":...}`), then `{"op":"subscribe","channel":...}` for `book:NOVA`, `trades:NOVA`, `status` or `me:orders`.

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
