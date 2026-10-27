// Live league rankings. Every second each portfolio in a running league is valued
// at the last traded prices and its return goes into a Redis sorted set per league
// (or a map in memory without Redis). Every minute the values are also saved as
// equity snapshots, which is what the Sharpe ratio is computed from.
import type { Redis } from "ioredis";

import type { Db } from "./db/pool.js";
import type { Marks } from "./ledger.js";

export type RankBy = "return" | "sharpe";

export interface Standing {
  rank: number;
  portfolioId: number;
  username: string;
  equity: number;
  returnPct: number;
  sharpe: number | null;
}

const YEAR_S = 365 * 24 * 3600;

// Annualized Sharpe ratio of a series of equity values taken every intervalS seconds,
// with a risk-free rate of zero. Needs at least two returns and some variation.
export function sharpeRatio(equity: number[], intervalS: number): number | null {
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) returns.push(equity[i]! / equity[i - 1]! - 1);
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  if (variance === 0) return null;
  return (mean / Math.sqrt(variance)) * Math.sqrt(YEAR_S / intervalS);
}

export class Leaderboard {
  private memory = new Map<string, Map<number, number>>();
  private timer?: NodeJS.Timeout;

  constructor(
    private db: Db,
    private marks: Marks,
    private symbolIds: number[],
    private redis?: Redis,
    readonly snapshotEveryS = 60,
  ) {}

  start(everyMs = 1000): void {
    let ticks = 0;
    const snapshotEvery = Math.max(1, Math.round((this.snapshotEveryS * 1000) / everyMs));
    let running = false;
    this.timer = setInterval(() => {
      if (running) return; // skip a tick rather than pile up if the database is slow
      running = true;
      this.refresh({ snapshot: ++ticks % snapshotEvery === 0 })
        .catch((err) => console.error("leaderboard refresh failed", err))
        .finally(() => (running = false));
    }, everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // Values every portfolio in every running league and updates the rankings.
  async refresh(opts: { snapshot?: boolean } = {}): Promise<void> {
    const prices = this.symbolIds.map((id) => this.marks.last(id));
    const { rows } = await this.db.query(
      `SELECT pf.id, pf.league_id, l.starting_cash,
              pf.cash + coalesce(sum(p.qty::bigint * m.price), 0) AS equity
       FROM portfolios pf
       JOIN leagues l ON l.id = pf.league_id
       LEFT JOIN positions p ON p.portfolio_id = pf.id AND p.qty <> 0
       LEFT JOIN unnest($1::int[], $2::bigint[]) AS m(symbol_id, price) ON m.symbol_id = p.symbol_id
       WHERE l.starts_at <= now() AND (l.ends_at IS NULL OR l.ends_at > now())
       GROUP BY pf.id, l.starting_cash`,
      [this.symbolIds, prices],
    );
    if (rows.length === 0) return;

    const returns = new Map<number, Array<[number, number]>>();
    for (const r of rows) {
      const list = returns.get(r.league_id) ?? [];
      list.push([r.id, (r.equity - r.starting_cash) / r.starting_cash]);
      returns.set(r.league_id, list);
    }
    for (const [league, scores] of returns) await this.write(`lb:${league}:return`, scores);

    if (!opts.snapshot) return;
    await this.db.query(
      "INSERT INTO equity_snapshots (portfolio_id, at, equity) SELECT unnest($1::bigint[]), now(), unnest($2::bigint[])",
      [rows.map((r) => r.id), rows.map((r) => r.equity)],
    );
    // Sharpe over each portfolio's recent snapshots (up to a week's worth).
    const history = await this.db.query(
      `SELECT portfolio_id, array_agg(equity ORDER BY at) AS equity FROM (
         SELECT portfolio_id, at, equity, row_number() OVER (PARTITION BY portfolio_id ORDER BY at DESC) AS n
         FROM equity_snapshots WHERE portfolio_id = ANY($1)
       ) s WHERE n <= $2 GROUP BY portfolio_id`,
      [rows.map((r) => r.id), Math.ceil((7 * 24 * 3600) / this.snapshotEveryS)],
    );
    const leagueOf = new Map<number, number>(rows.map((r) => [r.id, r.league_id]));
    const sharpe = new Map<number, Array<[number, number]>>();
    for (const h of history.rows) {
      const s = sharpeRatio(h.equity.map(Number), this.snapshotEveryS);
      if (s === null) continue;
      const league = leagueOf.get(h.portfolio_id)!;
      const list = sharpe.get(league) ?? [];
      list.push([h.portfolio_id, s]);
      sharpe.set(league, list);
    }
    for (const [league, scores] of sharpe) await this.write(`lb:${league}:sharpe`, scores);
  }

  private async write(key: string, scores: Array<[number, number]>): Promise<void> {
    if (this.redis) {
      await this.redis.zadd(key, ...scores.flatMap(([id, score]) => [score, String(id)]));
      return;
    }
    let set = this.memory.get(key);
    if (!set) this.memory.set(key, (set = new Map()));
    for (const [id, score] of scores) set.set(id, score);
  }

  private async read(key: string, limit: number): Promise<Array<[number, number]>> {
    if (this.redis) {
      const flat = await this.redis.zrevrange(key, 0, limit - 1, "WITHSCORES");
      const out: Array<[number, number]> = [];
      for (let i = 0; i < flat.length; i += 2) out.push([Number(flat[i]), Number(flat[i + 1])]);
      return out;
    }
    return [...(this.memory.get(key) ?? new Map<number, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  private async scores(key: string, ids: number[]): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map();
    if (this.redis) {
      const values = await this.redis.zmscore(key, ...ids.map(String));
      return new Map(ids.flatMap((id, i) => (values[i] === null ? [] : [[id, Number(values[i])] as [number, number]])));
    }
    const set = this.memory.get(key);
    return new Map(ids.flatMap((id) => (set?.has(id) ? [[id, set.get(id)!] as [number, number]] : [])));
  }

  async top(leagueId: number, by: RankBy, limit = 50): Promise<Standing[]> {
    const ranked = await this.read(`lb:${leagueId}:${by}`, limit);
    const ids = ranked.map(([id]) => id);
    const other = await this.scores(`lb:${leagueId}:${by === "return" ? "sharpe" : "return"}`, ids);
    const { rows } = await this.db.query(
      `SELECT pf.id, u.username, l.starting_cash FROM portfolios pf
       JOIN users u ON u.id = pf.user_id JOIN leagues l ON l.id = pf.league_id WHERE pf.id = ANY($1)`,
      [ids],
    );
    const info = new Map<number, { username: string; starting_cash: number }>(rows.map((r) => [r.id, r]));
    return ranked.map(([id, score], i) => {
      const returnPct = by === "return" ? score : (other.get(id) ?? 0);
      const startingCash = info.get(id)?.starting_cash ?? 0;
      return {
        rank: i + 1,
        portfolioId: id,
        username: info.get(id)?.username ?? "?",
        equity: Math.round(startingCash * (1 + returnPct)),
        returnPct,
        sharpe: by === "sharpe" ? score : (other.get(id) ?? null),
      };
    });
  }
}
