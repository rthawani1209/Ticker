// Fair-play checks a professor can run over a league. They flag, they don't punish:
// each flag comes with the numbers behind it so a person can judge.
//
// Collusion: two people who mostly trade with each other, at prices away from the
// rest of the market. That's how one account hands its gains to another. Trading
// with a classmate now and then at the market price is normal and isn't flagged.
//
// Spoofing: big orders that are nearly always cancelled, while the same person's
// small orders on the other side get filled. The big orders make the book look
// heavy on one side to move the price for the real trade. A market-making bot
// cancels a lot too, but its cancelled and filled orders are the same size.
import type { Db } from "./db/pool.js";

export const COLLUSION = {
  minTrades: 5, // trades between the two of them
  minShare: 0.5, // of either one's traded shares
  minOffMarket: 0.02, // average distance of their prices from the book's middle
};

export const SPOOFING = {
  minOrders: 20,
  minCancelRate: 0.9,
  minSizeRatio: 5, // average cancelled order size / average filled order size
};

export interface Trade {
  tradeId: string;
  buyer: number;
  seller: number;
  qty: number;
  price: number;
  refPrice: number | null;
}

export interface PairReport {
  a: number;
  b: number;
  trades: number;
  shares: number;
  shareOfA: number;
  shareOfB: number;
  offMarket: number | null; // average |price - ref| / ref
  flagged: boolean;
}

// Pairs of people who traded with each other, most suspicious first.
export function collusion(trades: Trade[], volume: Map<number, number>): PairReport[] {
  const pairs = new Map<
    string,
    { a: number; b: number; trades: number; shares: number; off: number[] }
  >();
  for (const t of trades) {
    if (t.buyer === t.seller) continue;
    const [a, b] = t.buyer < t.seller ? [t.buyer, t.seller] : [t.seller, t.buyer];
    const key = `${a}:${b}`;
    const p = pairs.get(key) ?? { a, b, trades: 0, shares: 0, off: [] };
    p.trades++;
    p.shares += t.qty;
    if (t.refPrice) p.off.push(Math.abs(t.price - t.refPrice) / t.refPrice);
    pairs.set(key, p);
  }
  return [...pairs.values()]
    .map((p) => {
      const shareOfA = p.shares / (volume.get(p.a) || p.shares);
      const shareOfB = p.shares / (volume.get(p.b) || p.shares);
      const offMarket = p.off.length ? p.off.reduce((s, x) => s + x, 0) / p.off.length : null;
      return {
        a: p.a,
        b: p.b,
        trades: p.trades,
        shares: p.shares,
        shareOfA,
        shareOfB,
        offMarket,
        flagged:
          p.trades >= COLLUSION.minTrades &&
          Math.max(shareOfA, shareOfB) >= COLLUSION.minShare &&
          (offMarket ?? 0) >= COLLUSION.minOffMarket,
      };
    })
    .sort((x, y) => Number(y.flagged) - Number(x.flagged) || y.shares - x.shares);
}

export interface OrderRow {
  side: "buy" | "sell";
  qty: number;
  filledQty: number;
  cancelled: boolean;
}

export interface SpoofReport {
  orders: number;
  cancelRate: number;
  avgCancelledQty: number;
  avgFilledQty: number;
  sizeRatio: number | null;
  // Fills on the side opposite most of the cancelled shares.
  oppositeFills: number;
  flagged: boolean;
}

export function spoofing(orders: OrderRow[]): SpoofReport {
  const cancelled = orders.filter((o) => o.cancelled && o.filledQty === 0);
  const filled = orders.filter((o) => o.filledQty > 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const avgCancelledQty = avg(cancelled.map((o) => o.qty));
  const avgFilledQty = avg(filled.map((o) => o.filledQty));
  const cancelledBuys = cancelled.filter((o) => o.side === "buy").reduce((s, o) => s + o.qty, 0);
  const cancelledSells = cancelled.filter((o) => o.side === "sell").reduce((s, o) => s + o.qty, 0);
  const heavySide = cancelledBuys >= cancelledSells ? "buy" : "sell";
  const oppositeFills = filled.filter((o) => o.side !== heavySide).length;
  const cancelRate = orders.length ? cancelled.length / orders.length : 0;
  const sizeRatio = avgFilledQty ? avgCancelledQty / avgFilledQty : null;
  return {
    orders: orders.length,
    cancelRate,
    avgCancelledQty,
    avgFilledQty,
    sizeRatio,
    oppositeFills,
    flagged:
      orders.length >= SPOOFING.minOrders &&
      cancelRate >= SPOOFING.minCancelRate &&
      sizeRatio !== null &&
      sizeRatio >= SPOOFING.minSizeRatio &&
      oppositeFills > 0,
  };
}

// Runs both checks over one league. Portfolio ids come back with usernames.
export async function fairPlay(db: Db, leagueId: number) {
  const people = await db.query(
    `SELECT pf.id, u.username FROM portfolios pf JOIN users u ON u.id = pf.user_id
     WHERE pf.league_id = $1`,
    [leagueId],
  );
  const name = new Map<number, string>(people.rows.map((r) => [Number(r.id), r.username]));
  const ids = [...name.keys()];

  // Both sides of a trade inside this league. The time check guards against trade ids
  // reused by a test engine started fresh against an old database.
  const { rows: trades } = await db.query(
    `SELECT b.trade_id, b.portfolio_id AS buyer, s.portfolio_id AS seller, b.qty, b.price,
            coalesce(b.ref_price, s.ref_price) AS ref_price
     FROM fills b JOIN fills s ON s.trade_id = b.trade_id AND s.side = 'sell'
     WHERE b.side = 'buy' AND b.portfolio_id = ANY($1) AND s.portfolio_id = ANY($1)
       AND abs(extract(epoch FROM b.created_at - s.created_at)) < 60`,
    [ids],
  );
  const { rows: vol } = await db.query(
    "SELECT portfolio_id, sum(qty)::bigint AS shares FROM fills WHERE portfolio_id = ANY($1) GROUP BY portfolio_id",
    [ids],
  );
  const volume = new Map<number, number>(
    vol.map((r) => [Number(r.portfolio_id), Number(r.shares)]),
  );
  const pairs = collusion(
    trades.map((t) => ({
      tradeId: String(t.trade_id),
      buyer: Number(t.buyer),
      seller: Number(t.seller),
      qty: t.qty,
      price: Number(t.price),
      refPrice: t.ref_price === null ? null : Number(t.ref_price),
    })),
    volume,
  );

  // Bracket exits are placed and cancelled by the server, not the person, so they're left
  // out, and so are orders the exchange rejected.
  const { rows: orders } = await db.query(
    `SELECT portfolio_id, side::text AS side, qty, filled_qty, status::text AS status
     FROM orders WHERE portfolio_id = ANY($1) AND parent_id IS NULL AND status <> 'rejected'`,
    [ids],
  );
  const byPortfolio = new Map<number, OrderRow[]>();
  for (const o of orders) {
    const list = byPortfolio.get(Number(o.portfolio_id)) ?? [];
    list.push({
      side: o.side,
      qty: o.qty,
      filledQty: o.filled_qty,
      cancelled: o.status === "cancelled",
    });
    byPortfolio.set(Number(o.portfolio_id), list);
  }
  const spoofers = [...byPortfolio.entries()]
    .map(([id, list]) => ({ username: name.get(id)!, ...spoofing(list) }))
    .filter((s) => s.orders > 0)
    .sort((x, y) => Number(y.flagged) - Number(x.flagged) || y.cancelRate - x.cancelRate);

  return {
    thresholds: { collusion: COLLUSION, spoofing: SPOOFING },
    collusion: pairs.map(({ a, b, ...p }) => ({ a: name.get(a)!, b: name.get(b)!, ...p })),
    spoofing: spoofers,
  };
}
