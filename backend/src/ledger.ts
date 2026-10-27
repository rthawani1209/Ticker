// The ledger: cash and positions per portfolio, kept in step with fills, plus the
// pre-trade checks that decide whether a portfolio can afford an order.
//
// Money is in cents. Positions use average cost: `cost` is what the open quantity
// cost in total (negative for shorts), and closing trades move the difference
// between price and average cost into `realized`.
import type { PoolClient } from "pg";

import { ApiError } from "./errors.js";
import type { OrderInput, SideName } from "./orders.js";

export interface Position {
  qty: number; // negative = short
  cost: number;
  realized: number;
}

export interface League {
  id: number;
  name: string;
  isPractice: boolean;
  startsAt: Date;
  endsAt: Date | null;
  startingCash: number;
  commissionCents: number;
  commissionBps: number;
  maxPosition: number | null;
  allowShort: boolean;
  marginBps: number;
  allowedTypes: string[];
}

export const LEAGUE_COLUMNS = `l.id, l.name, l.is_practice, l.starts_at, l.ends_at, l.starting_cash, l.commission_cents,
  l.commission_bps, l.max_position, l.allow_short, l.margin_bps, l.allowed_types::text[] AS allowed_types`;

export function toLeague(r: any): League {
  return {
    id: r.id, name: r.name, isPractice: r.is_practice, startsAt: r.starts_at, endsAt: r.ends_at,
    startingCash: r.starting_cash, commissionCents: r.commission_cents, commissionBps: r.commission_bps,
    maxPosition: r.max_position, allowShort: r.allow_short, marginBps: r.margin_bps, allowedTypes: r.allowed_types,
  };
}

export function commission(league: Pick<League, "commissionCents" | "commissionBps">, price: number, qty: number): number {
  return league.commissionCents + Math.round((price * qty * league.commissionBps) / 10_000);
}

// Applies one trade (dq > 0 bought, dq < 0 sold) to a position.
export function applyTrade(pos: Position, dq: number, price: number): Position {
  let { qty, cost, realized } = pos;
  if (qty !== 0 && Math.sign(qty) !== Math.sign(dq)) {
    // Closing some or all of the position. The closed part leaves at its average cost.
    const closeQty = Math.min(Math.abs(dq), Math.abs(qty));
    const remaining = Math.abs(qty) - closeQty;
    const keptCost = Math.round((cost * remaining) / Math.abs(qty));
    realized += Math.sign(qty) * closeQty * price - (cost - keptCost);
    qty = Math.sign(qty) * remaining;
    cost = keptCost;
    dq -= Math.sign(dq) * closeQty;
  }
  // Whatever is left opens or adds to a position in the direction of the trade.
  qty += dq;
  cost += dq * price;
  return { qty, cost, realized };
}

export interface LedgerFill {
  symbolId: number;
  side: SideName;
  price: number;
  qty: number;
  commission: number;
}

// Rebuilds a portfolio from nothing but its starting cash and its fills, oldest first.
// The live tables must always agree with this; a test checks it.
export function rebuild(startingCash: number, fills: LedgerFill[]) {
  let cash = startingCash;
  const positions = new Map<number, Position>();
  for (const f of fills) {
    const dq = f.side === "buy" ? f.qty : -f.qty;
    cash -= dq * f.price + f.commission;
    const before = positions.get(f.symbolId) ?? { qty: 0, cost: 0, realized: 0 };
    const after = applyTrade(before, dq, f.price);
    after.realized -= f.commission;
    positions.set(f.symbolId, after);
  }
  return { cash, positions };
}

// Records a fill against a portfolio's cash and position. Runs inside the same
// transaction that inserts the fill row, so the two can never disagree.
export async function applyFill(client: PoolClient, portfolioId: number, f: LedgerFill): Promise<void> {
  const dq = f.side === "buy" ? f.qty : -f.qty;
  await client.query("UPDATE portfolios SET cash = cash - $2 WHERE id = $1", [portfolioId, dq * f.price + f.commission]);
  const { rows } = await client.query(
    "SELECT qty, cost, realized FROM positions WHERE portfolio_id = $1 AND symbol_id = $2 FOR UPDATE",
    [portfolioId, f.symbolId],
  );
  const next = applyTrade(rows[0] ?? { qty: 0, cost: 0, realized: 0 }, dq, f.price);
  next.realized -= f.commission;
  await client.query(
    `INSERT INTO positions (portfolio_id, symbol_id, qty, cost, realized) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (portfolio_id, symbol_id) DO UPDATE SET qty = $3, cost = $4, realized = $5`,
    [portfolioId, f.symbolId, next.qty, next.cost, next.realized],
  );
}

export interface Marks {
  last(symbolId: number): number;
  bestAsk(symbolId: number): number | undefined;
}

// What an order is assumed to trade at for buying-power purposes. Limit orders can't
// do worse than their limit; market and stop orders use the higher of the stop, the
// last trade and the best ask, which is conservative for buys and for shorts alike.
export function estimatePrice(o: { type: string; price?: number | null; stopPrice?: number | null; symbolId: number }, marks: Marks) {
  if (o.type === "limit" || o.type === "stop_limit") return o.price!;
  return Math.max(o.stopPrice ?? 0, marks.last(o.symbolId), marks.bestAsk(o.symbolId) ?? 0);
}

// Pre-trade checks for a new order. The caller holds the portfolio row locked
// (SELECT ... FOR UPDATE), so two orders from the same portfolio can't both spend
// the same cash. Open orders reserve buying power until they fill or cancel.
//
// Buying power is cash minus what open buy orders could spend minus the margin
// held against short positions. Shorting credits the sale to cash, so a short of
// value V needs (margin - 100%) of V on top of that: 50% with the default 150%.
export async function checkOrder(
  client: PoolClient, league: League, portfolio: { id: number; cash: number }, o: OrderInput, marks: Marks, now = new Date(),
): Promise<void> {
  if (now < league.startsAt) throw new ApiError(403, "league_closed", "the league hasn't started yet");
  if (league.endsAt && now >= league.endsAt) throw new ApiError(403, "league_closed", "the league has ended");
  if (!league.allowedTypes.includes(o.type)) {
    throw new ApiError(422, "order_type_not_allowed", `${o.type} orders aren't allowed in this league`);
  }

  const [positions, open] = await Promise.all([
    client.query("SELECT symbol_id, qty FROM positions WHERE portfolio_id = $1 AND qty <> 0", [portfolio.id]),
    client.query(
      `SELECT symbol_id, side, type, price, stop_price, leaves FROM orders
       WHERE portfolio_id = $1 AND status IN ('pending', 'open', 'partially_filled')`,
      [portfolio.id],
    ),
  ]);
  const held = new Map<number, number>(positions.rows.map((r) => [r.symbol_id, r.qty]));
  const margin = league.marginBps / 10_000;

  // Shares already promised to open sell orders, per symbol, and what open orders reserve.
  let reserved = 0;
  const openBuys = new Map<number, number>();
  const openSells = new Map<number, number>();
  for (const r of open.rows) {
    const px = estimatePrice({ type: r.type, price: r.price, stopPrice: r.stop_price, symbolId: r.symbol_id }, marks);
    if (r.side === "buy") {
      reserved += r.leaves * px;
      openBuys.set(r.symbol_id, (openBuys.get(r.symbol_id) ?? 0) + r.leaves);
    } else {
      // Only the part of a sell beyond the shares still held is a short.
      const sold = openSells.get(r.symbol_id) ?? 0;
      const stillHeld = Math.max(0, (held.get(r.symbol_id) ?? 0) - sold);
      const opening = Math.max(0, r.leaves - stillHeld);
      reserved += opening * px * (margin - 1);
      openSells.set(r.symbol_id, sold + r.leaves);
    }
  }
  let shortValue = 0;
  for (const [sym, qty] of held) if (qty < 0) shortValue += -qty * marks.last(sym);
  const buyingPower = portfolio.cash - reserved - shortValue * margin;

  const qty = held.get(o.symbolId) ?? 0;
  const px = estimatePrice(o, marks);
  let needed: number;
  if (o.side === "buy") {
    needed = o.qty * px;
    const after = qty + (openBuys.get(o.symbolId) ?? 0) + o.qty;
    if (league.maxPosition !== null && after > league.maxPosition) {
      throw new ApiError(422, "position_limit", `that would take you past ${league.maxPosition} shares`);
    }
  } else {
    // Selling shares you hold needs nothing; anything beyond that is a short.
    const sellable = Math.max(0, qty - (openSells.get(o.symbolId) ?? 0));
    const opening = Math.max(0, o.qty - sellable);
    if (opening > 0 && !league.allowShort) {
      throw new ApiError(422, "short_not_allowed", "short selling is off in this league");
    }
    const after = qty - (openSells.get(o.symbolId) ?? 0) - o.qty;
    if (league.maxPosition !== null && -after > league.maxPosition) {
      throw new ApiError(422, "position_limit", `that would take you past ${league.maxPosition} shares short`);
    }
    needed = opening * px * (margin - 1);
  }
  needed += commission(league, px, o.qty);
  if (needed > buyingPower) {
    throw new ApiError(422, "insufficient_funds", `needs $${(needed / 100).toFixed(2)}, you have $${(Math.max(0, buyingPower) / 100).toFixed(2)} available`);
  }
}
