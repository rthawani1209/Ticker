// Portfolio statistics for the Portfolio screen. Pure functions over equity
// snapshots and fills, so the route only loads rows and the tests need no database.
import { applyTrade, type LedgerFill, type Position } from "./ledger.js";

export interface EquityPoint {
  at: number; // ms since epoch
  equity: number; // cents
}

// Largest fall from a running peak, as a fraction of that peak (0.25 = down 25%).
export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    else if (peak > 0) worst = Math.max(worst, (peak - e) / peak);
  }
  return worst;
}

// A "round trip" ends each time a fill reduces a position. It's a win if the part
// it closed made money after commission. Returns null before the first close.
export function winRate(fills: LedgerFill[]): {
  wins: number;
  closed: number;
  rate: number | null;
} {
  const positions = new Map<number, Position>();
  let wins = 0;
  let closed = 0;
  for (const f of fills) {
    const dq = f.side === "buy" ? f.qty : -f.qty;
    const before = positions.get(f.symbolId) ?? { qty: 0, cost: 0, realized: 0 };
    const after = applyTrade(before, dq, f.price);
    if (before.qty !== 0 && Math.sign(before.qty) !== Math.sign(dq)) {
      closed++;
      if (after.realized - before.realized - f.commission > 0) wins++;
    }
    after.realized -= f.commission;
    positions.set(f.symbolId, after);
  }
  return { wins, closed, rate: closed === 0 ? null : wins / closed };
}

// Keeps at most `max` points, evenly spaced, always including the first and last,
// so a month of minute snapshots still draws as one light chart.
export function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}
