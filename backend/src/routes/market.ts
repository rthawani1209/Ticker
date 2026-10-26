import type { FastifyInstance } from "fastify";
import { z } from "zod";

export default async function marketRoutes(app: FastifyInstance) {
  const { bridge, symbols, symbolsByTicker } = app.deps;

  const summary = (id: number) => {
    const s = symbols[id]!;
    const book = bridge.books[id]!;
    const bid = Math.max(...book.bids.keys());
    const ask = Math.min(...book.asks.keys());
    return {
      ticker: s.ticker, company: s.company, sector: s.sector, refPrice: s.refPrice, last: book.last,
      change: book.last - s.refPrice, bid: Number.isFinite(bid) ? bid : null, ask: Number.isFinite(ask) ? ask : null,
      volume: book.volume, halted: book.halted,
    };
  };

  app.get("/symbols", async () => symbols.map((s) => summary(s.id)));

  const Ticker = z.object({ ticker: z.string().toUpperCase() });

  app.get("/market/:ticker", async (req, reply) => {
    const { depth } = z.object({ depth: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
    const sym = symbolsByTicker.get(Ticker.parse(req.params).ticker);
    if (!sym) return reply.code(404).send({ error: "not_found", message: "no such symbol" });
    return { ...summary(sym.id), book: bridge.books[sym.id]!.depth(depth) };
  });

  app.get("/market/:ticker/trades", async (req, reply) => {
    const sym = symbolsByTicker.get(Ticker.parse(req.params).ticker);
    if (!sym) return reply.code(404).send({ error: "not_found", message: "no such symbol" });
    return bridge.books[sym.id]!.trades.slice(-100).reverse();
  });

  // Live engine numbers for the "under the hood" page.
  app.get("/engine/stats", async () => ({
    connected: bridge.connected,
    shards: [...bridge.stats.values()].map((s) => ({
      shard: s.shard, commandsPerSec: s.commands, p50Ns: s.p50, p99Ns: s.p99, p999Ns: s.p999, maxNs: s.max,
    })),
  }));
}
