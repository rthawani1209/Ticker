# frontend

The Ticker web app: Next.js (App Router), TypeScript and CSS modules, styled with the "Signal" design tokens in `src/styles/tokens.css`. The screens are drawn first in the design canvas (https://claude.ai/artifact/XFh157qgGngTnCH5SNKfS8) and built from there.

```bash
cp .env.example .env.local   # point NEXT_PUBLIC_API_URL at the backend
npm install
npm run dev                  # http://localhost:3000
```

| Script                 |                                                    |
| ---------------------- | -------------------------------------------------- |
| `npm run lint`         | ESLint (Next's core-web-vitals + TypeScript rules) |
| `npm run format:check` | Prettier                                           |
| `npm run typecheck`    | `tsc --noEmit`                                     |
| `npm test`             | Vitest + Testing Library                           |
| `npm run build`        | production build                                   |

Layout: `src/app` (routes), `src/components/ui` (shared primitives: `Panel`, `Button`, `PriceCell`, `Logo`), `src/components/<screen>` (pieces of one screen), `src/lib` (API client, formatting), `test/`.

## Landing market

The hero board shows whatever `/health` says is true. When the exchange is up it streams the focused stock's book and trades over the WebSocket (`book:` and `trades:` channels) and polls `/v1/symbols` for the rows. When it's down it plays `public/replay/market.json`, a 90-second recording of a real `calm` session, and the status pill says "Replay". To record a new one with the engine, backend and market-sim running:

```bash
node scripts/record-replay.mjs 90
```

## Trade screen

`/trade` opens the trading screen if you have a session, or offers a guest account (`/trade?start=guest`, which the landing page's "Try it with $100k" uses). `/login` signs in or creates an account. The access token stays in memory and the API's httpOnly refresh cookie restores it after a reload.

Market data and order entry share one WebSocket: `book:`, `trades:` and `me:orders` channels plus the `order` and `cancel` ops. Your portfolio, open orders and fills reload over REST when one of your orders changes. The chart starts from `/v1/market/:ticker/candles` (15-second bars) and folds in live trades. Click the bid side of the ladder to buy at that price, the ask side to sell, for the ticket's quantity. B and S pick a side and jump to the quantity, Esc cancels your open orders in the stock on screen.
