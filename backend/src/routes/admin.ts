// Admin tools: find users and change their role (the only way to make a professor).
//   GET   /v1/admin/users?q=name
//   PATCH /v1/admin/users/:id  {"role": "professor"}
//   PUT   /v1/admin/bots       {"enabled": false}  the kill switch: every API key stops
//                                                 working and their orders are cancelled
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { audit } from "../audit.js";
import { requireRole } from "../auth/roles.js";
import { ApiError } from "../errors.js";

export default async function adminRoutes(app: FastifyInstance) {
  const { db, apiKeys, orders } = app.deps;
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole(db, "admin"));

  app.get("/users", async (req) => {
    const { q } = z.object({ q: z.string().trim().max(60).default("") }).parse(req.query);
    const { rows } = await db.query(
      `SELECT id, username, email, role::text AS role, created_at FROM users
       WHERE role::text <> 'guest' AND (username ILIKE $1 OR email ILIKE $1)
       ORDER BY created_at DESC LIMIT 50`,
      [`%${q.replace(/[%_\\]/g, "\\$&")}%`],
    );
    return rows.map((r) => ({
      ...r,
      createdAt: r.created_at.toISOString(),
      created_at: undefined,
    }));
  });

  app.patch("/users/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { role } = z.object({ role: z.enum(["student", "professor", "admin"]) }).parse(req.body);
    if (id === req.user.userId && role !== "admin")
      throw new ApiError(409, "self_demote", "ask another admin to change your own role");
    const { rows } = await db.query(
      `UPDATE users SET role = $2 WHERE id = $1 AND role::text <> 'guest'
       RETURNING id, username, role::text AS role`,
      [id, role],
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "no such user (guests can't get roles)");
    await audit(db, req.user.userId, "role_change", { userId: id, role }, req.ip);
    return rows[0];
  });

  app.put("/bots", async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await db.query("UPDATE settings SET value = $1 WHERE key = 'bots_enabled'", [
      JSON.stringify(enabled),
    ]);
    apiKeys.forgetEnabled();
    const cancelled = enabled ? 0 : await orders.cancelBotOrders();
    await audit(db, req.user.userId, "bots_switch", { enabled, cancelled }, req.ip);
    return { enabled, cancelled };
  });
}
