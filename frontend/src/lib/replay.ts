import type { Depth, SymbolSummary, Trade } from "./api";

// A recorded stretch of the market, written by scripts/record-replay.mjs. Kept compact:
// one frame per second, levels as [price, qty], trades as [price, qty, +1 buy | -1 sell].
export interface Recording {
  recordedAt: string;
  intervalMs: number;
  symbols: { ticker: string; company: string; refPrice: number }[];
  frames: {
    q: Record<string, [last: number, volume: number, halted: 0 | 1]>;
    b: Record<string, [bids: [number, number][], asks: [number, number][]]>;
    t: Record<string, [number, number, 1 | -1][]>;
  }[];
}

export function replaySymbols(rec: Recording, frame: number): SymbolSummary[] {
  const f = rec.frames[frame]!;
  return rec.symbols.map((s) => {
    const [last, volume, halted] = f.q[s.ticker] ?? [s.refPrice, 0, 0];
    const [bids, asks] = f.b[s.ticker] ?? [[], []];
    return {
      ...s,
      sector: "",
      last,
      change: last - s.refPrice,
      bid: bids[0]?.[0] ?? null,
      ask: asks[0]?.[0] ?? null,
      volume,
      halted: halted === 1,
    };
  });
}

export function replayDepth(rec: Recording, frame: number, ticker: string): Depth {
  const [bids, asks] = rec.frames[frame]!.b[ticker] ?? [[], []];
  const levels = (side: [number, number][]) => side.map(([price, qty]) => ({ price, qty }));
  return { bids: levels(bids), asks: levels(asks) };
}

// Trades printed during this frame, oldest first, stamped with playback time.
export function replayTrades(rec: Recording, frame: number, ticker: string, now: number): Trade[] {
  return (rec.frames[frame]!.t[ticker] ?? []).map(([price, qty, side], i) => ({
    price,
    qty,
    side: side === 1 ? "buy" : "sell",
    tradeId: frame * 1000 + i,
    time: now,
  }));
}
