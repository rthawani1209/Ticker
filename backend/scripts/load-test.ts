// Load test: many people trading at once through the gateway, over WebSockets, for
// DURATION_S seconds (10 minutes by default). Starts its own engine and test database, like the
// tests. Each user sends ORDERS_PER_USER orders a second: half rest near the last price
// and are cancelled a couple of seconds later, half cross the spread straight away,
// so the run exercises order entry, matching, fills, the ledger and cancels.
//
//   TICKER_ENGINE=../engine/build-check/g++-release/ticker-engine REDIS_URL=redis://localhost:6379 \
//     npx tsx scripts/load-test.ts
//
// Latency is from sending the order on the socket to getting the gateway's reply,
// which comes after the engine acked it and the order was saved. Writes
// docs/results/load-<date>.json and a chart, load-<date>.svg.
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { signUp, startBackend } from "../test/harness.js";

const USERS = Number(process.env.USERS ?? 200);
const SECONDS = Number(process.env.DURATION_S ?? 600);
const NAME = process.env.OUT_NAME ?? "load";
const ORDERS_PER_USER = Number(process.env.ORDERS_PER_USER ?? 2); // a second
const TICKERS = ["NOVA", "HELX", "ORBT", "KILN", "VYNE", "QSTR", "BRKL", "MESA"];

const b = await startBackend();
await b.app.listen({ host: "127.0.0.1", port: 0 });
const { port } = b.app.server.address() as { port: number };

// Each user connects from its own loopback address, as separate people would.
let nextAddress = 0;
const loopback = () => {
  const n = ++nextAddress;
  return `127.20.${n >> 8}.${n & 255}`;
};

interface Bucket {
  sent: number;
  ok: number;
  rejected: number;
  tooLate: number;
  errors: number;
  latencies: number[];
}
const buckets: Bucket[] = [];
const bucket = (t: number) => {
  const i = Math.floor((t - started) / 10_000); // 10 s buckets
  while (buckets.length <= i)
    buckets.push({ sent: 0, ok: 0, rejected: 0, tooLate: 0, errors: 0, latencies: [] });
  return buckets[i]!;
};
const errorCodes = new Map<string, number>();

interface Client {
  ws: WebSocket;
  pending: Map<string, { at: number; cancel: boolean }>;
  resting: { id: number; at: number }[];
  n: number;
}

const clients: Client[] = [];
for (let i = 0; i < USERS; i++) {
  const u = await signUp(b, `load${i}_${process.pid}`);
  const c: Client = {
    ws: new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(u.token)}`, {
      localAddress: loopback(),
    }),
    pending: new Map(),
    resting: [],
    n: 0,
  };
  await new Promise<void>((resolve, reject) => {
    c.ws.on("open", () => resolve());
    c.ws.on("error", reject);
  });
  c.ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const ref = msg.data?.ref;
    const sent = ref && c.pending.get(ref);
    if (!sent) return;
    c.pending.delete(ref);
    const sentAt = sent.at;
    const now = Date.now();
    const bk = bucket(sentAt);
    if (msg.channel === "error" && sent.cancel && msg.data.error === "not_open") {
      // Someone else's order filled it before the cancel got there. That's trading, not a fault.
      bk.latencies.push(now - sentAt);
      bk.tooLate++;
      return;
    }
    if (msg.channel === "error") {
      bk.errors++;
      errorCodes.set(msg.data.error, (errorCodes.get(msg.data.error) ?? 0) + 1);
      return;
    }
    bk.latencies.push(now - sentAt);
    const order = msg.data.order;
    if (order?.status === "rejected") {
      bk.rejected++;
      errorCodes.set(order.rejectReason, (errorCodes.get(order.rejectReason) ?? 0) + 1);
    } else bk.ok++;
    if (msg.channel === "order" && order?.status === "open")
      c.resting.push({ id: order.id, at: now });
  });
  clients.push(c);
}

const send = (c: Client, body: object) => {
  const ref = String(++c.n);
  const now = Date.now();
  c.pending.set(ref, { at: now, cancel: (body as { op: string }).op === "cancel" });
  bucket(now).sent++;
  c.ws.send(JSON.stringify({ ref, ...body }));
};

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

function tick(c: Client) {
  const now = Date.now();
  // Pull resting orders after two seconds; that's the other half of each user's traffic.
  const stale = c.resting.findIndex((r) => now - r.at > 2000);
  if (stale >= 0 && Math.random() < 0.5) {
    const [r] = c.resting.splice(stale, 1);
    return send(c, { op: "cancel", id: r!.id });
  }
  const ticker = pick(TICKERS);
  const sym = b.deps.symbolsByTicker.get(ticker)!;
  const last = b.deps.bridge.books[sym.id]!.last;
  const side = Math.random() < 0.5 ? "buy" : "sell";
  const passive = Math.random() < 0.5;
  // Within 0.5% of the last price, well inside the 10% band.
  const offset = Math.max(1, Math.round(last * 0.005 * Math.random()));
  const price = passive === (side === "buy") ? last - offset : last + offset;
  send(c, {
    op: "order",
    order: {
      symbol: ticker,
      side,
      price,
      qty: 1 + Math.floor(Math.random() * 5),
      tif: passive ? "gtc" : "ioc",
    },
  });
}

console.log(`${USERS} users, ${ORDERS_PER_USER} orders/s each, ${SECONDS} s`);
const started = Date.now();
const timers = clients.map((c, i) => {
  // Spread the users out over the first second so they don't all fire together.
  const every = 1000 / ORDERS_PER_USER;
  let timer: NodeJS.Timeout | undefined;
  const first = setTimeout(
    () => {
      timer = setInterval(() => tick(c), every);
    },
    (i / USERS) * every,
  );
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
});
const progress = setInterval(() => {
  const last = buckets.at(-2);
  if (last)
    console.log(
      `${Math.round((Date.now() - started) / 1000)} s: ${last.ok + last.rejected + last.tooLate} replies, ${last.errors} errors, ${last.sent} sent /10 s ${JSON.stringify(Object.fromEntries(errorCodes))}`,
    );
}, 10_000);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
for (const stop of timers) stop();
clearInterval(progress);
await new Promise((r) => setTimeout(r, 3000)); // let the last replies land
const elapsed = (Date.now() - started) / 1000;
const lost = clients.reduce((s, c) => s + c.pending.size, 0);

const { rows } = await b.deps.db.query("SELECT count(*)::int AS n FROM fills");
const fills: number = rows[0].n;

const pct = (sorted: number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
    : null;
const all = buckets.flatMap((x) => x.latencies).sort((x, y) => x - y);
const sum = (f: (x: Bucket) => number) => buckets.reduce((s, x) => s + f(x), 0);
const result = {
  date: new Date().toISOString(),
  what: "orders and cancels over WebSockets from many users at once, send -> gateway reply",
  setup: {
    users: USERS,
    orders_per_user_per_second: ORDERS_PER_USER,
    seconds: Number(elapsed.toFixed(1)),
    mix: "half resting limit orders (cancelled after ~2 s), half crossing IOC orders; 1-5 shares; 8 symbols",
    same_process:
      "the gateway and all clients share one Node process; the engine, Postgres and Redis run on the same machine",
  },
  machine: {
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
  },
  totals: {
    sent: sum((x) => x.sent),
    accepted: sum((x) => x.ok),
    rejected_by_rules: sum((x) => x.rejected),
    cancels_after_fill: sum((x) => x.tooLate),
    errors: sum((x) => x.errors),
    no_reply: lost,
    fills,
    replies_per_second: Number(
      ((sum((x) => x.ok) + sum((x) => x.rejected) + sum((x) => x.tooLate)) / elapsed).toFixed(1),
    ),
    reasons: Object.fromEntries(errorCodes),
  },
  latency_ms: {
    p50: pct(all, 50),
    p90: pct(all, 90),
    p99: pct(all, 99),
    p999: pct(all, 99.9),
    max: all.at(-1) ?? null,
  },
  per_10s: buckets.map((x, i) => {
    const s = [...x.latencies].sort((p, q) => p - q);
    return {
      t: i * 10,
      replies: x.ok + x.rejected + x.tooLate,
      errors: x.errors,
      p50: pct(s, 50),
      p99: pct(s, 99),
    };
  }),
};

const day = result.date.slice(0, 10);
const dir = path.resolve(import.meta.dirname, "../../docs/results");
writeFileSync(path.join(dir, `${NAME}-${day}.json`), JSON.stringify(result, null, 2) + "\n");
writeFileSync(path.join(dir, `${NAME}-${day}.svg`), chart(result.per_10s, result.setup));
console.log(JSON.stringify({ totals: result.totals, latency_ms: result.latency_ms }, null, 2));
for (const c of clients) c.ws.close();
await b.stop();
process.exit(0);

// Two stacked panels: replies a second, then p50 and p99 latency, per 10 s.
function chart(
  points: { t: number; replies: number; p50: number | null; p99: number | null }[],
  setup: typeof result.setup,
) {
  const W = 760,
    H = 420,
    L = 56,
    R = 16,
    top1 = 40,
    h1 = 140,
    top2 = 230,
    h2 = 150;
  const tMax = Math.max(10, ...points.map((p) => p.t + 10));
  const x = (t: number) => L + ((W - L - R) * t) / tMax;
  const rate = points.map((p) => p.replies / 10);
  const rMax = Math.max(1, ...rate) * 1.15;
  const lMax = Math.max(1, ...points.map((p) => p.p99 ?? 0)) * 1.15;
  const line = (vals: (number | null)[], top: number, h: number, max: number) =>
    vals
      .map((v, i) =>
        v === null
          ? ""
          : `${i ? "L" : "M"}${x(points[i]!.t + 5).toFixed(1)},${(top + h - (h * v) / max).toFixed(1)}`,
      )
      .join("");
  const axis = (top: number, h: number, max: number, unit: string) =>
    [0, 0.5, 1]
      .map((f) => {
        const y = top + h - h * f;
        return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="#2a2f3a"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${Math.round(max * f)}${unit}</text>`;
      })
      .join("");
  const minutes = Array.from(
    { length: Math.floor(tMax / 60) + 1 },
    (_, m) => `<text x="${x(m * 60)}" y="${H - 8}" text-anchor="middle">${m}m</text>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, monospace" font-size="11" fill="#9aa3b2">
<rect width="${W}" height="${H}" fill="#0b0e14"/>
<text x="${L}" y="20" fill="#e6e9ef" font-size="13">Load test: ${setup.users} users, ${setup.orders_per_user_per_second} orders/s each, ${Math.round(setup.seconds)} s</text>
<text x="${L}" y="${top1 - 6}">replies a second</text>
${axis(top1, h1, rMax, "")}
<path d="${line(rate, top1, h1, rMax)}" fill="none" stroke="#ffb21f" stroke-width="1.5"/>
<text x="${L}" y="${top2 - 6}">latency per 10 s: <tspan fill="#3ddc97">p50</tspan>, <tspan fill="#ff5c6c">p99</tspan></text>
${axis(top2, h2, lMax, " ms")}
<path d="${line(
    points.map((p) => p.p50),
    top2,
    h2,
    lMax,
  )}" fill="none" stroke="#3ddc97" stroke-width="1.5"/>
<path d="${line(
    points.map((p) => p.p99),
    top2,
    h2,
    lMax,
  )}" fill="none" stroke="#ff5c6c" stroke-width="1.5"/>
${minutes}
</svg>
`;
}
