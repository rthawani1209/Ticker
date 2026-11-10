# Deploying Ticker

The web app goes on **Vercel**. Everything else goes on **Railway**, in one project:

- engine
- backend
- market-sim
- Postgres
- Redis

Only the web app and the backend get public URLs. The engine is reachable only on Railway's private network.

```
browser ──► Vercel (Next.js) ──/v1/*──► backend (public) ──TCP──► engine (private)
   └──────────── WebSocket ────────────►    │                       ▲
                                         Postgres, Redis     market-sim (private)
```

REST calls go through the Vercel site, which forwards `/v1/*` to the backend. That keeps the login cookie first-party. Browsers drop `SameSite` cookies sent to a backend on a different domain, and Safari blocks third-party cookies outright. The live feed's WebSocket can't be forwarded by Vercel, so it goes straight to the backend. It signs in with a token, not the cookie, so that's fine.

## 1. Three secrets

Make three random values and keep them somewhere safe:

```sh
openssl rand -base64 48              # JWT_SECRET
openssl rand -base64 32              # EDGE_SECRET
python3 -c "import secrets; print(secrets.randbits(63))"   # TICKER_TOKEN, a number
```

## 2. Railway

1. Create a new project. Add **Postgres** and **Redis** from the "Database" menu.
2. Add a service from the GitHub repo `rthawani1209/Ticker`, three times, one per folder. In each service's Settings, set **Root Directory**. The `railway.json` in that folder makes Railway build its Dockerfile.

   | Service name | Root Directory | Variables |
   |---|---|---|
   | `engine` | `/engine` | `TICKER_TOKEN` |
   | `backend` | `/backend` | see below |
   | `market-sim` | `/market-sim` | `ENGINE_HOST=engine.railway.internal`, `TICKER_TOKEN`, `REDIS_URL=${{Redis.REDIS_URL}}`, `SCENARIO=calm` |

3. **engine:** add a **Volume** mounted at `/data`. The order journal lives there, so the books survive a redeploy. Don't generate a public domain for it.
4. **backend:** set these variables:

   ```
   NODE_ENV=production
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}?family=0
   ENGINE_HOST=engine.railway.internal
   ENGINE_TOKEN=<TICKER_TOKEN>
   JWT_SECRET=<JWT_SECRET>
   CORS_ORIGIN=https://<your-app>.vercel.app
   TRUST_PROXY=1
   EDGE_SECRET=<EDGE_SECRET>
   ```

   - `?family=0` lets the Redis client use IPv6. Railway's private network is IPv6, and without it the client only tries IPv4.
   - `TRUST_PROXY=1` says one proxy (Railway's edge) sits in front of the backend. Only the address that proxy adds to `X-Forwarded-For` is believed, so a caller can't pick their own IP by sending the header.
   - `EDGE_SECRET` must match the one on Vercel. The web app signs each visitor's IP with it when it forwards `/v1` calls, so per-IP limits (sign-ups, logins) count visitors, not Vercel.
   - Under Settings → Networking, **Generate Domain**. That gives you `https://<backend>.up.railway.app`.
   - The backend creates its tables on first start.
5. Deploy. The backend's health check (`/health`) passes once it can reach Postgres and the engine. If it stays red, check that `ENGINE_TOKEN` equals the engine's `TICKER_TOKEN`.

## 3. Vercel

1. Add a new project from the same repo and set **Root Directory** to `frontend`. Vercel detects Next.js.
2. Add these environment variables (Production and Preview):

   ```
   NEXT_PUBLIC_API_URL=/
   NEXT_PUBLIC_WS_URL=wss://<backend>.up.railway.app/ws
   BACKEND_URL=https://<backend>.up.railway.app
   EDGE_SECRET=<EDGE_SECRET>
   ```

3. Deploy. Then put the Vercel URL into the backend's `CORS_ORIGIN` on Railway and redeploy the backend. If you have more than one URL (a preview or a custom domain), separate them with commas.

## 4. Check it

- `https://<your-app>.vercel.app/health` returns `{"ok":true,...}`. That request went through the forwarding to the backend.
- The landing page shows a live market with prices moving. If prices don't move, check the market-sim logs.
- Sign up, reload the page, and you're still signed in. That's the cookie working.
- Trade from /trade, and the order shows up under "Open orders" and then "Fills".

## 5. Make the first admin

Roles can only be given by an admin, so the first one is made from a terminal. Copy the Postgres **public** URL from Railway (Postgres → Connect), then run:

```sh
cd backend
DATABASE_URL='<public postgres url>' npx tsx scripts/set-role.ts you@school.edu admin
```

After that, admins give the professor role from the app's API (`PATCH /v1/admin/users/:id`).

## Running it all on one machine

```sh
docker compose up --build
```

Then open http://localhost:3000. This is the same setup the "docker" CI job builds and smoke-tests on every push. Put `JWT_SECRET` and `TICKER_TOKEN` in a `.env` file next to `docker-compose.yml` for anything but a laptop.

## Known limits

- **One engine.** The engine is one process holding the books in memory, with a journal for restarts. A redeploy pauses trading for the few seconds the engine takes to start and replay its journal. The gateway reconnects and reconciles on its own.
- **Gateway restarts.** While no gateway is connected, the engine holds the fills and cancels meant for it (up to 65,536 events, about 4 MB) and sends them when it logs back on. A normal deploy needs a few hundred. If a gateway stays down long enough to overflow that, the orders whose events were dropped are flagged `out_of_sync` (a "check" mark in the blotter, an error in the backend log and an `order_out_of_sync` row in `audit_log`). Their cash and positions may be off and need a person to look. Restarting the engine also empties the hold. The gateway then can't book what it missed, but it asks the engine about every open order when it reconnects and flags the ones that don't match, so nothing is wrong silently. Still, restart the gateway and the engine one at a time. `ticker-engine --held-events N` changes the size of the hold.
- **IP limits are per address.** A whole class behind one campus network shares an IP, so the per-IP limits are set high (60 guest accounts an hour) and signed-in requests are counted per user instead.
