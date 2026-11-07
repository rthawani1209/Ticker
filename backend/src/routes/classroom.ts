// Classroom tools. A professor (or an admin) who owns a league can see its roster and
// every trade, export both as CSV, and set assignments that grade themselves.
// Students see the assignments in their leagues and only their own grade.
//
//   GET    /v1/classes/:id/roster            students (everyone but the owner) with equity, return, trades
//   GET    /v1/classes/:id/trades            every fill in the league, newest first
//   GET    /v1/classes/:id/trades.csv
//   GET    /v1/classes/:id/assignments       with every student's grade
//   POST   /v1/classes/:id/assignments
//   DELETE /v1/classes/:id/assignments/:aid
//   GET    /v1/classes/:id/grades.csv        one row per student, one column per assignment
//   GET    /v1/leagues/:id/assignments       (students) assignments with your own grade
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { audit } from "../audit.js";
import { requireRole } from "../auth/roles.js";
import { toCsv } from "../csv.js";
import { ApiError } from "../errors.js";
import { gradeAssignment, toAssignment, type Assignment } from "../grading.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const AssignmentId = Id.extend({ aid: z.coerce.number().int().positive() });

const NewAssignment = z
  .object({
    title: z.string().trim().min(3).max(120),
    kind: z.enum(["return_at_least", "trades_at_least", "drawdown_at_most", "use_order_type"]),
    target: z.number().int().min(0).max(1_000_000).default(0),
    orderType: z.enum(["limit", "market", "stop", "stop_limit", "bracket"]).optional(),
    dueAt: z.iso.datetime({ offset: true }),
  })
  .refine((a) => (a.kind === "use_order_type") === (a.orderType !== undefined), {
    path: ["orderType"],
    message: "orderType goes with use_order_type, and only with it",
  })
  .refine((a) => new Date(a.dueAt) > new Date(), {
    path: ["dueAt"],
    message: "must be in the future",
  });

const TradesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  before: z.coerce.number().int().positive().optional(), // fill id, for paging
});

const ASSIGNMENT_COLUMNS = "id, league_id, title, kind::text AS kind, target, order_type, due_at";

const assignmentView = (a: Assignment) => ({ ...a, dueAt: a.dueAt.toISOString() });

export default async function classroomRoutes(app: FastifyInstance) {
  const { db, orders, symbols } = app.deps;
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole(db, "professor", "admin"));

  // Professors only see leagues they own; admins see any league.
  async function ownedLeague(req: FastifyRequest) {
    const { id } = Id.parse(req.params);
    const { rows } = await db.query(
      "SELECT id, name, owner_id, is_practice FROM leagues WHERE id = $1",
      [id],
    );
    const league = rows[0];
    if (!league || (req.user.role !== "admin" && league.owner_id !== req.user.userId))
      throw new ApiError(404, "not_found", "no such league, or it isn't yours");
    return league as { id: number; name: string };
  }

  async function roster(leagueId: number) {
    const { rows } = await db.query(
      `SELECT u.id AS user_id, u.username, u.email, pf.id AS portfolio_id, pf.cash, l.starting_cash,
              (SELECT count(*)::int FROM fills f WHERE f.portfolio_id = pf.id) AS trades,
              (SELECT max(f.created_at) FROM fills f WHERE f.portfolio_id = pf.id) AS last_trade
       FROM portfolios pf JOIN users u ON u.id = pf.user_id JOIN leagues l ON l.id = pf.league_id
       WHERE pf.league_id = $1 AND pf.user_id IS DISTINCT FROM l.owner_id ORDER BY u.username`,
      [leagueId],
    );
    const held = await db.query(
      `SELECT portfolio_id, symbol_id, qty FROM positions
       WHERE portfolio_id = ANY($1) AND qty <> 0`,
      [rows.map((r) => r.portfolio_id)],
    );
    const value = new Map<number, number>();
    for (const p of held.rows)
      value.set(
        p.portfolio_id,
        (value.get(p.portfolio_id) ?? 0) + p.qty * orders.marks.last(p.symbol_id),
      );
    return rows.map((r) => {
      const equity = Number(r.cash) + (value.get(r.portfolio_id) ?? 0);
      return {
        userId: r.user_id,
        username: r.username,
        email: r.email,
        equity,
        returnPct: (equity - r.starting_cash) / r.starting_cash,
        trades: r.trades,
        lastTrade: r.last_trade?.toISOString() ?? null,
      };
    });
  }

  async function trades(leagueId: number, limit: number, before?: number) {
    const { rows } = await db.query(
      `SELECT f.id, f.created_at, u.username, f.symbol_id, f.side, f.qty, f.price, f.commission, f.order_id
       FROM fills f JOIN portfolios pf ON pf.id = f.portfolio_id JOIN users u ON u.id = pf.user_id
       WHERE pf.league_id = $1 AND ($3::bigint IS NULL OR f.id < $3)
       ORDER BY f.id DESC LIMIT $2`,
      [leagueId, limit, before ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      time: r.created_at.toISOString(),
      username: r.username,
      symbol: symbols[r.symbol_id]!.ticker,
      side: r.side,
      qty: r.qty,
      price: Number(r.price),
      commission: Number(r.commission),
      orderId: r.order_id,
    }));
  }

  async function assignmentsOf(leagueId: number) {
    const { rows } = await db.query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE league_id = $1 ORDER BY due_at, id`,
      [leagueId],
    );
    return rows.map(toAssignment);
  }

  const cents = (c: number) => (c / 100).toFixed(2);
  const filename = (name: string, what: string) =>
    `${name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "league"}-${what}.csv`;
  const sendCsv = (reply: any, name: string, body: string) =>
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`)
      .send(body);

  app.get("/:id/roster", async (req) => roster((await ownedLeague(req)).id));

  app.get("/:id/trades", async (req) => {
    const league = await ownedLeague(req);
    const q = TradesQuery.parse(req.query);
    return trades(league.id, q.limit, q.before);
  });

  app.get("/:id/trades.csv", async (req, reply) => {
    const league = await ownedLeague(req);
    const rows = await trades(league.id, 100_000);
    await audit(db, req.user.userId, "export_trades", { leagueId: league.id }, req.ip);
    return sendCsv(
      reply,
      filename(league.name, "trades"),
      toCsv(
        ["time", "student", "symbol", "side", "qty", "price", "commission", "order_id"],
        rows.map((t) => [
          t.time,
          t.username,
          t.symbol,
          t.side,
          t.qty,
          cents(t.price),
          cents(t.commission),
          t.orderId,
        ]),
      ),
    );
  });

  app.get("/:id/assignments", async (req) => {
    const league = await ownedLeague(req);
    const list = await assignmentsOf(league.id);
    return Promise.all(
      list.map(async (a) => ({
        ...assignmentView(a),
        grades: await gradeAssignment(db, orders.marks, a),
      })),
    );
  });

  app.post("/:id/assignments", async (req, reply) => {
    const league = await ownedLeague(req);
    const body = NewAssignment.parse(req.body);
    const { rows } = await db.query(
      `INSERT INTO assignments (league_id, title, kind, target, order_type, due_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${ASSIGNMENT_COLUMNS}`,
      [
        league.id,
        body.title,
        body.kind,
        body.target,
        body.orderType ?? null,
        body.dueAt,
        req.user.userId,
      ],
    );
    await audit(
      db,
      req.user.userId,
      "assignment_create",
      { leagueId: league.id, id: rows[0].id },
      req.ip,
    );
    return reply.code(201).send(assignmentView(toAssignment(rows[0])));
  });

  app.delete("/:id/assignments/:aid", async (req, reply) => {
    const league = await ownedLeague(req);
    const { aid } = AssignmentId.parse(req.params);
    const { rowCount } = await db.query(
      "DELETE FROM assignments WHERE id = $1 AND league_id = $2",
      [aid, league.id],
    );
    if (!rowCount) throw new ApiError(404, "not_found", "no such assignment");
    await audit(db, req.user.userId, "assignment_delete", { leagueId: league.id, id: aid }, req.ip);
    return reply.code(204).send();
  });

  app.get("/:id/grades.csv", async (req, reply) => {
    const league = await ownedLeague(req);
    const [people, list] = await Promise.all([roster(league.id), assignmentsOf(league.id)]);
    const graded = await Promise.all(list.map((a) => gradeAssignment(db, orders.marks, a)));
    const byUser = graded.map((g) => new Map(g.map((x) => [x.userId, x])));
    await audit(db, req.user.userId, "export_grades", { leagueId: league.id }, req.ip);
    return sendCsv(
      reply,
      filename(league.name, "grades"),
      toCsv(
        ["student", "email", "equity", "return_pct", "trades", ...list.map((a) => a.title)],
        people.map((p) => [
          p.username,
          p.email,
          cents(p.equity),
          (p.returnPct * 100).toFixed(2),
          p.trades,
          ...byUser.map((m) => (m.get(p.userId)?.passed ? "pass" : "fail")),
        ]),
      ),
    );
  });
}

// Students: the assignments in a league they're in, each with their own grade only.
export async function studentAssignmentRoutes(app: FastifyInstance) {
  const { db, orders } = app.deps;
  app.addHook("preHandler", app.authenticate);
  app.get("/:id/assignments", async (req) => {
    const { id } = Id.parse(req.params);
    const member = await db.query(
      "SELECT 1 FROM portfolios WHERE league_id = $1 AND user_id = $2",
      [id, req.user.userId],
    );
    if (!member.rowCount)
      throw new ApiError(404, "not_found", "no such league, or you're not in it");
    const { rows } = await db.query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE league_id = $1 ORDER BY due_at, id`,
      [id],
    );
    return Promise.all(
      rows.map(toAssignment).map(async (a) => {
        const [mine] = await gradeAssignment(db, orders.marks, a, req.user.userId);
        return { ...assignmentView(a), value: mine?.value ?? null, passed: mine?.passed ?? false };
      }),
    );
  });
}
