import type { Depth, Level } from "./api";

export interface DepthPoint {
  price: number;
  total: number; // shares available from the best price out to here
}

// Running totals out from the best price on each side, for a depth chart.
export function cumulative(levels: Level[]): DepthPoint[] {
  let total = 0;
  return levels.map((l) => ({ price: l.price, total: (total += l.qty) }));
}

export interface DepthGeometry {
  bid: string; // SVG path for the filled bid area
  ask: string;
  bidX: number | null; // x of the best bid, for the glow line
  askX: number | null;
}

// Lays both sides out on one price axis, bids left of the spread and asks right of it,
// as stepped areas whose height is the cumulative size.
export function depthGeometry(book: Depth, width: number, height: number): DepthGeometry {
  const bids = cumulative(book.bids);
  const asks = cumulative(book.asks);
  const prices = [...bids, ...asks].map((p) => p.price);
  if (prices.length === 0) return { bid: "", ask: "", bidX: null, askX: null };

  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = Math.max(hi - lo, 1);
  const pad = span * 0.04;
  const x = (price: number) => ((price - lo + pad) / (span + 2 * pad)) * width;
  const maxTotal = Math.max(bids.at(-1)?.total ?? 0, asks.at(-1)?.total ?? 0, 1);
  const y = (total: number) => height - (total / maxTotal) * height * 0.92;

  // Walk away from the spread: each level holds its height until the next price.
  const area = (side: DepthPoint[], edge: number) => {
    if (side.length === 0) return "";
    let d = `M${x(side[0]!.price).toFixed(1)},${height}`;
    side.forEach((p, i) => {
      const next = side[i + 1];
      d += ` V${y(p.total).toFixed(1)} H${(next ? x(next.price) : edge).toFixed(1)}`;
    });
    return d + ` V${height} Z`;
  };

  return {
    bid: area(bids, 0),
    ask: area(asks, width),
    bidX: bids[0] ? x(bids[0].price) : null,
    askX: asks[0] ? x(asks[0].price) : null,
  };
}

// Applies one book:TICKER update from the WebSocket (qty 0 removes the level).
export function applyLevel(book: Depth, side: "bid" | "ask", price: number, qty: number): Depth {
  const key = side === "bid" ? "bids" : "asks";
  const levels = book[key].filter((l) => l.price !== price);
  if (qty > 0) levels.push({ price, qty });
  levels.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return { ...book, [key]: levels };
}
