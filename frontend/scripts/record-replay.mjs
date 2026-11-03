// Records a stretch of the live market into public/replay/market.json. The landing page
// plays it back (labelled "replay") when the exchange is offline, so the hero is never empty.
//
//   node scripts/record-replay.mjs [seconds=90] [api=http://localhost:8080]
//
// Needs ticker-engine, the backend and market-sim running (see the root README). It listens
// on the same WebSocket channels the site uses and keeps one frame per second.
import { writeFile } from "node:fs/promises";

const seconds = Number(process.argv[2] ?? 90);
const api = process.argv[3] ?? "http://localhost:8080";
const DEPTH = 10;

const health = await (await fetch(`${api}/health`)).json();
if (!health.ok) throw new Error("the exchange isn't connected, nothing to record");
const symbols = await (await fetch(`${api}/v1/symbols`)).json();

const state = new Map(
  symbols.map((s) => [
    s.ticker,
    {
      last: s.last,
      volume: s.volume,
      halted: s.halted,
      bids: new Map(),
      asks: new Map(),
      trades: [],
    },
  ]),
);

const ws = new WebSocket(api.replace(/^http/, "ws") + "/ws");
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
ws.onmessage = (msg) => {
  const { channel, data } = JSON.parse(msg.data);
  const [kind, ticker] = channel.split(":");
  const s = state.get(ticker ?? data.ticker);
  if (!s) return;
  if (kind === "book") {
    if (data.snapshot) {
      s.bids = new Map(data.bids.map((l) => [l.price, l.qty]));
      s.asks = new Map(data.asks.map((l) => [l.price, l.qty]));
    } else {
      const side = data.side === "bid" ? s.bids : s.asks;
      if (data.qty > 0) side.set(data.price, data.qty);
      else side.delete(data.price);
    }
  } else if (kind === "trades") {
    s.last = data.price;
    s.volume += data.qty;
    s.trades.push([data.price, data.qty, data.side === "buy" ? 1 : -1]);
  } else if (kind === "status") {
    s.halted = data.halted;
  }
};
ws.send(JSON.stringify({ op: "subscribe", channel: "status" }));
for (const { ticker } of symbols) {
  ws.send(JSON.stringify({ op: "subscribe", channel: `book:${ticker}` }));
  ws.send(JSON.stringify({ op: "subscribe", channel: `trades:${ticker}` }));
}

const top = (side, desc) =>
  [...side.entries()].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).slice(0, DEPTH);

const frames = [];
for (let i = 0; i < seconds; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const frame = { q: {}, b: {}, t: {} };
  for (const [ticker, s] of state) {
    frame.q[ticker] = [s.last, s.volume, s.halted ? 1 : 0];
    frame.b[ticker] = [top(s.bids, true), top(s.asks, false)];
    if (s.trades.length) frame.t[ticker] = s.trades.splice(0);
  }
  frames.push(frame);
}
ws.close();

const out = {
  recordedAt: new Date().toISOString(),
  intervalMs: 1000,
  symbols: symbols.map((s) => ({ ticker: s.ticker, company: s.company, refPrice: s.refPrice })),
  frames,
};
await writeFile(new URL("../public/replay/market.json", import.meta.url), JSON.stringify(out));
console.log(`recorded ${frames.length} frames`);
