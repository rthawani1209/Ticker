// Fair-play checks a professor can run over a league. They flag, they don't punish:
// each flag comes with the numbers behind it so a person can judge.
//
// Collusion: two people who trade with each other at prices away from the rest of
// the market. That's how one account hands its gains to another. The distance is
// weighted by shares, so a few big off-market trades can't hide among many one-share
// trades at the market price. Trading with a classmate at the market price is normal
// and isn't flagged, however often it happens. Separately, the money the off-market
// prices moved from one of them to the other is added up with its direction; past a
// set amount that's flagged however few trades it took, and wash trades at the market
// price between the same two don't water it down.
//
// Spoofing: big orders that are nearly always pulled before they trade, while the same
// person's small orders on the other side get filled. The big orders make the book look
// heavy on one side to move the price for the real trade. An order counts as pulled if
// it was cancelled before half of it filled, so letting a little trade first doesn't
// hide it. Sizes are compared by their median, so one big real order can't make the
// pulled ones look normal. A market-making bot cancels a lot too, but its pulled and
// its filled orders are the same size.
import type { Db } from "./db/pool.js";

export const COLLUSION = {
  minTrades: 3, // trades between the two of them
  minOffMarket: 0.01, // share-weighted distance of their prices from the book's middle
  minShare: 0.25, // of either one's traded shares...
  farOffMarket: 0.05, // ...unless their prices are this far off, when any share counts
  minMoved: 2_500_00, // cents handed one way through off-market prices, flagged on its own
};

export const SPOOFING = {
  minOrders: 20,
  minCancelRate: 0.9, // of their orders, pulled before half filled
  minSizeRatio: 5, // median size of pulled orders / of orders at least half filled
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
  offMarket: number | null; // share-weighted average |price - ref| / ref
  moved: number; // cents the off-market prices handed from one to the other, net
  flagged: boolean;
}

// Pairs of people who traded with each other, most suspicious first.
export function collusion(trades: Trade[], volume: Map<number, number>): PairReport[] {
  const pairs = new Map<
    string,
    {
      a: number;
      b: number;
      trades: number;
      shares: number;
      offShares: number;
      offSum: number;
      toA: number; // cents a got over the market price, minus what b got
    }
  >();
  for (const t of trades) {
    if (t.buyer === t.seller) continue;
    const [a, b] = t.buyer < t.seller ? [t.buyer, t.seller] : [t.seller, t.buyer];
    const key = `${a}:${b}`;
    const p = pairs.get(key) ?? { a, b, trades: 0, shares: 0, offShares: 0, offSum: 0, toA: 0 };
    p.trades++;
    p.shares += t.qty;
    if (t.refPrice) {
      p.offShares += t.qty;
      p.offSum += (t.qty * Math.abs(t.price - t.refPrice)) / t.refPrice;
      // Selling above the market or buying below it is money from the other side.
      const gain = t.qty * (t.price - t.refPrice);
      p.toA += t.seller === a ? gain : -gain;
    }
    pairs.set(key, p);
  }
  return [...pairs.values()]
    .map((p) => {
      const shareOfA = p.shares / (volume.get(p.a) || p.shares);
      const shareOfB = p.shares / (volume.get(p.b) || p.shares);
      const offMarket = p.offShares ? p.offSum / p.offShares : null;
      const off = offMarket ?? 0;
      const moved = Math.abs(p.toA);
      return {
        a: p.a,
        b: p.b,
        trades: p.trades,
        shares: p.shares,
        shareOfA,
        shareOfB,
        offMarket,
        moved,
        flagged:
          moved >= COLLUSION.minMoved ||
          (p.trades >= COLLUSION.minTrades &&
            off >= COLLUSION.minOffMarket &&
            (Math.max(shareOfA, shareOfB) >= COLLUSION.minShare || off >= COLLUSION.farOffMarket)),
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
  cancelRate: number; // share of orders pulled before half filled
  pulledQty: number; // median size of those orders
  filledQty: number; // median size of orders at least half filled
  sizeRatio: number | null;
  // Fills on the side opposite most of the cancelled shares.
  oppositeFills: number;
  flagged: boolean;
}

export function spoofing(orders: OrderRow[]): SpoofReport {
  // Order sizes are compared, not filled amounts: a market maker whose 500-share
  // quotes sometimes fill 50 isn't sending small real orders.
  const cancelled = orders.filter((o) => o.cancelled && o.filledQty * 2 < o.qty);
  const filled = orders.filter((o) => o.filledQty * 2 >= o.qty);
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const pulledQty = median(cancelled.map((o) => o.qty));
  const filledQty = median(filled.map((o) => o.qty));
  const pulled = (o: OrderRow) => o.qty - o.filledQty;
  const cancelledBuys = cancelled
    .filter((o) => o.side === "buy")
    .reduce((s, o) => s + pulled(o), 0);
  const cancelledSells = cancelled
    .filter((o) => o.side === "sell")
    .reduce((s, o) => s + pulled(o), 0);
  const heavySide = cancelledBuys >= cancelledSells ? "buy" : "sell";
  const oppositeFills = filled.filter((o) => o.side !== heavySide).length;
  const cancelRate = orders.length ? cancelled.length / orders.length : 0;
  const sizeRatio = filledQty ? pulledQty / filledQty : null;
  return {
    orders: orders.length,
    cancelRate,
    pulledQty,
    filledQty,
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
  // out, and so are orders the exchange rejected and flagged ones a teacher closed.
  const { rows: orders } = await db.query(
    `SELECT portfolio_id, side::text AS side, qty, filled_qty, status::text AS status
     FROM orders WHERE portfolio_id = ANY($1) AND parent_id IS NULL AND status <> 'rejected'
       AND reject_reason IS DISTINCT FROM 'out_of_sync'`,
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
