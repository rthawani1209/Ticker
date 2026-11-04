import type { Depth, Order } from "./api";

export interface LadderRow {
  price: number;
  bid: number; // resting buy size at this price
  ask: number;
  mineBuy: number; // your own open size, so you can see where you are in the book
  mineSell: number;
}

// One row per price that has anything on it, best asks above the spread and best bids
// below, `levels` deep on each side. Asks come first (highest at the top).
export function ladderRows(book: Depth, mine: Order[], symbol: string, levels = 12): LadderRow[] {
  const rows = new Map<number, LadderRow>();
  const row = (price: number) => {
    let r = rows.get(price);
    if (!r) rows.set(price, (r = { price, bid: 0, ask: 0, mineBuy: 0, mineSell: 0 }));
    return r;
  };
  for (const l of book.asks.slice(0, levels)) row(l.price).ask = l.qty;
  for (const l of book.bids.slice(0, levels)) row(l.price).bid = l.qty;
  const lo = book.bids[Math.min(levels, book.bids.length) - 1]?.price ?? -Infinity;
  const hi = book.asks[Math.min(levels, book.asks.length) - 1]?.price ?? Infinity;
  for (const o of mine) {
    if (o.symbol !== symbol || o.price === null || o.leaves === 0) continue;
    if (o.price < lo || o.price > hi) continue;
    const r = row(o.price);
    if (o.side === "buy") r.mineBuy += o.leaves;
    else r.mineSell += o.leaves;
  }
  return [...rows.values()].sort((a, b) => b.price - a.price);
}
