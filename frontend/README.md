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
