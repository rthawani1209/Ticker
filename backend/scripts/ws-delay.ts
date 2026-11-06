// Measures how long a trade takes to reach WebSocket clients, with two gateways
// sharing Redis like a scaled-out deployment. Starts its own engine and test
// database (same setup as the tests), opens CLIENTS sockets per gateway, trades
// for SECONDS and writes the delay percentiles to docs/results.
//
//   TICKER_ENGINE=../engine/build-check/g++-release/ticker-engine REDIS_URL=redis://localhost:6379 \
//     npx tsx scripts/ws-delay.ts
//
// Delay = when the client got the message minus the "time" stamped on the trade
// when the publishing gateway read it from the engine. Both are Date.now() on the
// same machine, so there's no clock skew, but the resolution is 1 ms.
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Redis } from "ioredis";
import WebSocket from "ws";

import { buildApp } from "../src/app.js";
import { RedisFanout } from "../src/ws/fanout.js";
import { signUp, startBackend } from "../test/harness.js";

const CLIENTS = Number(process.env.CLIENTS ?? 250); // per gateway
const SECONDS = Number(process.env.SECONDS ?? 20);
const TRADES_PER_SECOND = Number(process.env.TRADES_PER_SECOND ?? 50);
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error("set REDIS_URL: the point is to go through Redis");

const b = await startBackend();
await b.app.listen({ host: "127.0.0.1", port: 0 });
const relayRedis = new Redis(REDIS_URL);
const relayFanout = new RedisFanout(relayRedis);
await relayFanout.ready;
const relay = await buildApp({
  ...b.deps,
  config: { ...b.deps.config, MARKET_PUBLISHER: false },
  redis: relayRedis,
  fanout: relayFanout,
});
await relay.listen({ host: "127.0.0.1", port: 0 });

const gateways = [
  { name: "publisher", app: b.app, delays: [] as number[] },
  { name: "relay", app: relay, delays: [] as number[] },
];

// Each client connects from its own loopback address so the per-IP rate limit
// (300 requests a minute) sees separate users, as it would in production.
let nextAddress = 0;
const loopback = () => {
  const n = ++nextAddress;
  return `127.10.${n >> 8}.${n & 255}`;
};

const sockets: WebSocket[] = [];
for (const g of gateways) {
  const { port } = g.app.server.address() as { port: number };
  await Promise.all(
    Array.from(
      { length: CLIENTS },
      () =>
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { localAddress: loopback() });
          sockets.push(ws);
          ws.on("error", reject);
          ws.on("open", () => ws.send(JSON.stringify({ op: "subscribe", channel: "trades:NOVA" })));
          ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.channel === "subscribed") resolve();
            else if (msg.channel === "trades:NOVA") g.delays.push(Date.now() - msg.data.time);
          });
        }),
    ),
  );
}

// Two traders take turns crossing one share at a fixed price, so the book stays
// empty between trades and nobody runs out of cash.
const traders = [await signUp(b), await signUp(b)];
const price = 14_000;
const total = SECONDS * TRADES_PER_SECOND;
const started = Date.now();
for (let i = 0; i < total; i++) {
  const [maker, taker] = i % 2 ? [traders[0]!, traders[1]!] : [traders[1]!, traders[0]!];
  const side = i % 4 < 2 ? "sell" : "buy";
  const other = side === "sell" ? "buy" : "sell";
  await b.orders.place(maker.id, { symbolId: 0, side, type: "limit", price, qty: 1, tif: "gtc" });
  await b.orders.place(taker.id, {
    symbolId: 0,
    side: other,
    type: "limit",
    price,
    qty: 1,
    tif: "ioc",
  });
  const due = started + ((i + 1) * 1000) / TRADES_PER_SECOND;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
const elapsed = (Date.now() - started) / 1000;
await new Promise((r) => setTimeout(r, 500)); // let the last messages land

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
const summary = (delays: number[]) => {
  const s = [...delays].sort((x, y) => x - y);
  return {
    messages: s.length,
    p50_ms: pct(s, 50),
    p95_ms: pct(s, 95),
    p99_ms: pct(s, 99),
    max_ms: s[s.length - 1],
  };
};

const result = {
  date: new Date().toISOString(),
  what: "trade print -> WebSocket client delay, two gateways sharing Redis pub/sub",
  setup: {
    gateways: 2,
    clients_per_gateway: CLIENTS,
    trades_requested: total,
    trades_per_second_target: TRADES_PER_SECOND,
    trades_per_second_actual: Number((total / elapsed).toFixed(1)),
    seconds: Number(elapsed.toFixed(1)),
    expected_messages_per_gateway: total * CLIENTS,
    same_process:
      "both gateways, the order sender and all clients share one Node process, so delays include the clients' own JSON parsing on the same event loop",
  },
  machine: {
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
  },
  gateways: Object.fromEntries(gateways.map((g) => [g.name, summary(g.delays)])),
};
const out = path.resolve(
  import.meta.dirname,
  `../../docs/results/ws-delay-${result.date.slice(0, 10)}.json`,
);
writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
console.log(`wrote ${out}`);

for (const ws of sockets) ws.close();
await relay.close();
await relayFanout.close();
relayRedis.disconnect();
await b.stop();
