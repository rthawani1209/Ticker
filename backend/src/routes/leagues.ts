// Leagues: anyone can start one, share its invite code, and compete in it.
// Also the positions view, since a portfolio only makes sense inside a league.
import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { audit } from "../audit.js";
import { leagueFor } from "../auth/key-league.js";
import { ApiError } from "../errors.js";
import { downsample, maxDrawdown, winRate, type EquityPoint } from "../analytics.js";
import { sharpeRatio } from "../leaderboard.js";
import { LEAGUE_COLUMNS, toLeague } from "../ledger.js";

const ORDER_TYPES = ["limit", "market", "stop", "stop_limit"] as const;

const NewLeague = z
  .object({
    name: z.string().trim().min(3).max(60),
    startingCash: z.number().int().min(1_000_00).max(10_000_000_00).default(100_000_00), // cents
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
    commissionCents: z.number().int().min(0).max(10_000).default(0),
    commissionBps: z.number().int().min(0).max(1000).default(0),
    maxPosition: z.number().int().positive().max(10_000_000).nullable().default(null),
    allowShort: z.boolean().default(true),
    marginBps: z.number().int().min(10_000).max(50_000).default(15_000),
    allowedTypes: z
      .array(z.enum(ORDER_TYPES))
      .min(1)
      .default([...ORDER_TYPES]),
  })
  .refine((l) => !l.endsAt || new Date(l.endsAt) > new Date(l.startsAt ?? Date.now()), {
    path: ["endsAt"],
    message: "must be after the start",
  });

const Id = z.object({ id: z.coerce.number().int().positive() });
const LeagueQuery = z.object({ league: z.coerce.number().int().positive().optional() });

// Invite codes avoid letters that are easy to mix up when read aloud (0/O, 1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function inviteCode(): string {
  return [...randomBytes(8)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export default async function leagueRoutes(app: FastifyInstance) {
  const { db, leaderboard } = app.deps;
  app.addHook("preHandler", app.authenticate);
  // Guests only have the practice league; making or joining a league needs an account.
  const noGuests = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user.role === "guest") {
      await reply.code(403).send({ error: "guest", message: "sign up to create or join a league" });
    }
  };

  const view = (r: any) => {
    const l = toLeague(r);
    return {
      ...l,
      startsAt: l.startsAt.toISOString(),
      endsAt: l.endsAt?.toISOString() ?? null,
      members: r.members,
      isOwner: r.is_owner,
      // Only the owner sees the code; members invite people through them.
      inviteCode: r.is_owner ? r.invite_code : undefined,
    };
  };

  const fetchLeague = async (leagueId: number, userId: number) => {
    const { rows } = await db.query(
      `SELECT ${LEAGUE_COLUMNS}, l.invite_code, l.owner_id = $2 AS is_owner,
              (SELECT count(*)::int FROM portfolios WHERE league_id = l.id) AS members
       FROM leagues l WHERE l.id = $1 AND EXISTS (SELECT 1 FROM portfolios WHERE league_id = l.id AND user_id = $2)`,
      [leagueId, userId],
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "no such league, or you're not in it");
    return view(rows[0]);
  };

  app.post(
    "/",
    { preHandler: noGuests, config: { rateLimit: { max: 10, timeWindow: 3_600_000 } } },
    async (req, reply) => {
      const body = NewLeague.parse(req.body);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `INSERT INTO leagues (name, owner_id, invite_code, starts_at, ends_at, starting_cash, commission_cents,
           commission_bps, max_position, allow_short, margin_bps, allowed_types)
         VALUES ($1, $2, $3, coalesce($4::timestamptz, now()), $5, $6, $7, $8, $9, $10, $11, $12::order_type[])
         RETURNING id`,
          [
            body.name,
            req.user.userId,
            inviteCode(),
            body.startsAt ?? null,
            body.endsAt ?? null,
            body.startingCash,
            body.commissionCents,
            body.commissionBps,
            body.maxPosition,
            body.allowShort,
            body.marginBps,
            body.allowedTypes,
          ],
        );
        await client.query(
          "INSERT INTO portfolios (league_id, user_id, cash) VALUES ($1, $2, $3)",
          [rows[0].id, req.user.userId, body.startingCash],
        );
        await client.query("COMMIT");
        await audit(db, req.user.userId, "league_create", { leagueId: rows[0].id }, req.ip);
        return reply.code(201).send(await fetchLeague(rows[0].id, req.user.userId));
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  );

  app.get("/", async (req) => {
    const { rows } = await db.query(
      `SELECT ${LEAGUE_COLUMNS}, l.invite_code, l.owner_id = $1 AS is_owner,
              (SELECT count(*)::int FROM portfolios WHERE league_id = l.id) AS members
       FROM leagues l JOIN portfolios pf ON pf.league_id = l.id AND pf.user_id = $1
       ORDER BY l.is_practice DESC, l.id DESC`,
      [req.user.userId],
    );
    return rows.map(view);
  });

  app.get("/:id", async (req) => fetchLeague(Id.parse(req.params).id, req.user.userId));

  app.post(
    "/join",
    { preHandler: noGuests, config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
    async (req, reply) => {
      const { code } = z
        .object({ code: z.string().trim().toUpperCase().length(8) })
        .parse(req.body);
      const { rows } = await db.query(
        "SELECT id, starting_cash, ends_at FROM leagues WHERE invite_code = $1",
        [code],
      );
      const league = rows[0];
      if (!league) throw new ApiError(404, "bad_code", "no league with that code");
      if (league.ends_at && league.ends_at <= new Date())
        throw new ApiError(403, "league_closed", "that league has ended");
      const joined = await db.query(
        "INSERT INTO portfolios (league_id, user_id, cash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id",
        [league.id, req.user.userId, league.starting_cash],
      );
      if (joined.rows[0])
        await audit(db, req.user.userId, "league_join", { leagueId: league.id }, req.ip);
      return reply
        .code(joined.rows[0] ? 201 : 200)
        .send(await fetchLeague(league.id, req.user.userId));
    },
  );

  app.get("/:id/leaderboard", async (req) => {
    const { id } = Id.parse(req.params);
    const q = z
      .object({
        by: z.enum(["return", "sharpe"]).default("return"),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    await fetchLeague(id, req.user.userId); // members only
    return leaderboard.top(id, q.by, q.limit);
  });
}

// GET /v1/positions?league=ID: cash, holdings valued at the last price, and profit
// and loss, for one of your portfolios (the practice one by default).
// GET /v1/positions/analytics?league=ID: the equity curve and its statistics.
export async function positionRoutes(app: FastifyInstance) {
  const { db, leaderboard, orders, symbols } = app.deps;
  app.addHook("preHandler", app.authenticate);

  async function portfolioFor(userId: number, league: number | undefined) {
    const { rows } = await db.query(
      `SELECT pf.id, pf.cash, pf.league_id, l.starting_cash FROM portfolios pf JOIN leagues l ON l.id = pf.league_id
       WHERE pf.user_id = $1 AND ${league === undefined ? "l.is_practice" : "l.id = $2"}`,
      league === undefined ? [userId] : [userId, league],
    );
    if (!rows[0]) throw new ApiError(404, "not_a_member", "you're not in that league");
    return rows[0] as { id: number; cash: number; league_id: number; starting_cash: number };
  }

  async function valued(pf: { id: number; cash: number }) {
    const held = await db.query(
      "SELECT symbol_id, qty, cost, realized FROM positions WHERE portfolio_id = $1 ORDER BY symbol_id",
      [pf.id],
    );
    let equity = pf.cash;
    const positions = held.rows.map((p) => {
      const mark = orders.marks.last(p.symbol_id);
      const value = p.qty * mark;
      equity += value;
      return {
        symbol: symbols[p.symbol_id]!.ticker,
        qty: p.qty,
        avgPrice: p.qty === 0 ? null : Math.round(p.cost / p.qty),
        mark,
        marketValue: value,
        unrealized: value - p.cost,
        realized: p.realized,
      };
    });
    return { equity, positions };
  }

  app.get("/", async (req) => {
    const { league } = LeagueQuery.parse(req.query);
    const pf = await portfolioFor(req.user.userId, await leagueFor(db, req.user, league));
    const { equity, positions } = await valued(pf);
    return {
      league: pf.league_id,
      cash: pf.cash,
      equity,
      startingCash: pf.starting_cash,
      returnPct: (equity - pf.starting_cash) / pf.starting_cash,
      positions,
    };
  });

  app.get("/analytics", async (req) => {
    const { league } = LeagueQuery.parse(req.query);
    const pf = await portfolioFor(req.user.userId, await leagueFor(db, req.user, league));
    const { equity } = await valued(pf);
    const [snaps, fills] = await Promise.all([
      db.query("SELECT at, equity FROM equity_snapshots WHERE portfolio_id = $1 ORDER BY at", [
        pf.id,
      ]),
      db.query(
        "SELECT symbol_id, side, price, qty, commission FROM fills WHERE portfolio_id = $1 ORDER BY id",
        [pf.id],
      ),
    ]);
    // The curve starts at the starting cash and ends at the live value.
    const curve: EquityPoint[] = snaps.rows.map((r) => ({
      at: new Date(r.at).getTime(),
      equity: Number(r.equity),
    }));
    curve.push({ at: Date.now(), equity });
    const values = [pf.starting_cash, ...curve.map((p) => p.equity)];
    const trades = winRate(
      fills.rows.map((f) => ({
        symbolId: f.symbol_id,
        side: f.side,
        price: Number(f.price),
        qty: f.qty,
        commission: Number(f.commission),
      })),
    );
    return {
      league: pf.league_id,
      startingCash: pf.starting_cash,
      equity,
      returnPct: (equity - pf.starting_cash) / pf.starting_cash,
      maxDrawdown: maxDrawdown(values),
      // Same definition as the Sharpe leaderboard: snapshot returns, annualized.
      sharpe: sharpeRatio(
        snaps.rows.map((r) => Number(r.equity)),
        leaderboard.snapshotEveryS,
        leaderboard.minSharpeReturns,
      ),
      winRate: trades.rate,
      roundTrips: trades.closed,
      wins: trades.wins,
      history: downsample(curve, 500),
    };
  });
}
