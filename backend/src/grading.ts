// Auto-graded assignments. Each student's numbers are taken as of the due date (or
// now, before it), from the same fills and equity snapshots the rest of the app uses.
import { maxDrawdown } from "./analytics.js";
import type { Db } from "./db/pool.js";
import type { Marks } from "./ledger.js";

export type AssignmentKind =
  "return_at_least" | "trades_at_least" | "drawdown_at_most" | "use_order_type";

export interface Assignment {
  id: number;
  leagueId: number;
  title: string;
  kind: AssignmentKind;
  target: number;
  orderType: string | null;
  dueAt: Date;
}

export interface Stats {
  returnBps: number;
  trades: number;
  drawdownBps: number;
  typesUsed: Set<string>; // order types with at least one fill, plus "bracket"
}

export interface Grade {
  userId: number;
  username: string;
  value: number; // the measured number, in the assignment's units (1/0 for order types)
  passed: boolean;
}

export function grade(a: Pick<Assignment, "kind" | "target" | "orderType">, s: Stats) {
  switch (a.kind) {
    case "return_at_least":
      return { value: s.returnBps, passed: s.returnBps >= a.target };
    case "trades_at_least":
      return { value: s.trades, passed: s.trades >= a.target };
    case "drawdown_at_most":
      return { value: s.drawdownBps, passed: s.drawdownBps <= a.target };
    case "use_order_type": {
      const used = s.typesUsed.has(a.orderType ?? "");
      return { value: used ? 1 : 0, passed: used };
    }
  }
}

// Grades every student in the assignment's league (or just `userId`). The league's
// owner is the teacher, so they're left out.
export async function gradeAssignment(
  db: Db,
  marks: Marks,
  a: Assignment,
  userId?: number,
  now = new Date(),
): Promise<Grade[]> {
  const live = now < a.dueAt;
  const cutoff = live ? now : a.dueAt;
  const members = await db.query(
    `SELECT pf.id, pf.user_id, pf.cash, u.username, l.starting_cash FROM portfolios pf
     JOIN users u ON u.id = pf.user_id JOIN leagues l ON l.id = pf.league_id
     WHERE pf.league_id = $1 AND pf.user_id IS DISTINCT FROM l.owner_id
       AND ($2::bigint IS NULL OR pf.user_id = $2) ORDER BY u.username`,
    [a.leagueId, userId ?? null],
  );
  const ids = members.rows.map((m) => m.id);
  if (ids.length === 0) return [];

  const [trades, types, snaps, held] = await Promise.all([
    db.query(
      `SELECT portfolio_id, count(*)::int AS n FROM fills
       WHERE portfolio_id = ANY($1) AND created_at <= $2 GROUP BY portfolio_id`,
      [ids, cutoff],
    ),
    db.query(
      `SELECT DISTINCT f.portfolio_id, o.type::text AS type,
              (o.take_profit IS NOT NULL OR o.stop_loss IS NOT NULL OR o.parent_id IS NOT NULL) AS bracket
       FROM fills f JOIN orders o ON o.id = f.order_id
       WHERE f.portfolio_id = ANY($1) AND f.created_at <= $2`,
      [ids, cutoff],
    ),
    db.query(
      `SELECT portfolio_id, array_agg(equity ORDER BY at) AS equity FROM equity_snapshots
       WHERE portfolio_id = ANY($1) AND at <= $2 GROUP BY portfolio_id`,
      [ids, cutoff],
    ),
    live
      ? db.query(
          "SELECT portfolio_id, symbol_id, qty FROM positions WHERE portfolio_id = ANY($1) AND qty <> 0",
          [ids],
        )
      : Promise.resolve({ rows: [] as { portfolio_id: number; symbol_id: number; qty: number }[] }),
  ]);

  const tradeCount = new Map<number, number>(trades.rows.map((r) => [r.portfolio_id, r.n]));
  const used = new Map<number, Set<string>>();
  for (const r of types.rows) {
    const set = used.get(r.portfolio_id) ?? new Set<string>();
    set.add(r.type);
    if (r.bracket) set.add("bracket");
    used.set(r.portfolio_id, set);
  }
  const history = new Map<number, number[]>(
    snaps.rows.map((r) => [r.portfolio_id, r.equity.map(Number)]),
  );
  const liveEquity = new Map<number, number>();
  for (const m of members.rows) liveEquity.set(m.id, Number(m.cash));
  for (const p of held.rows)
    liveEquity.set(
      p.portfolio_id,
      liveEquity.get(p.portfolio_id)! + p.qty * marks.last(p.symbol_id),
    );

  return members.rows.map((m) => {
    const start = Number(m.starting_cash);
    const curve = [start, ...(history.get(m.id) ?? [])];
    if (live) curve.push(liveEquity.get(m.id)!);
    const equity = curve.at(-1)!;
    const stats: Stats = {
      returnBps: Math.round(((equity - start) / start) * 10_000),
      trades: tradeCount.get(m.id) ?? 0,
      drawdownBps: Math.round(maxDrawdown(curve) * 10_000),
      typesUsed: used.get(m.id) ?? new Set(),
    };
    return { userId: m.user_id, username: m.username, ...grade(a, stats) };
  });
}

export function toAssignment(r: any): Assignment {
  return {
    id: r.id,
    leagueId: r.league_id,
    title: r.title,
    kind: r.kind,
    target: Number(r.target),
    orderType: r.order_type,
    dueAt: r.due_at,
  };
}
