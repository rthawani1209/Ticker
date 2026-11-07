// API keys for trading bots, made and revoked by a signed-in person (never by a key).
//   POST   /v1/keys       {"name", "league"?, "maxOrderQty"?, "ordersPerSecond"?}  -> the key, shown once
//   GET    /v1/keys       your keys, without secrets
//   DELETE /v1/keys/:id   revokes it and cancels its working orders
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { audit } from "../audit.js";
import { ApiKeys } from "../auth/api-keys.js";
import { ApiError } from "../errors.js";

const MAX_KEYS = 5;

const NewKey = z.object({
  name: z.string().trim().min(1).max(40),
  league: z.number().int().positive().optional(),
  maxOrderQty: z.number().int().min(1).max(100_000).default(1000),
  ordersPerSecond: z.number().int().min(1).max(20).default(5),
});

const view = (r: any) => ({
  id: r.id,
  name: r.name,
  prefix: `tk_${r.prefix}`,
  league: r.league_id,
  maxOrderQty: r.max_order_qty,
  ordersPerSecond: r.orders_per_second,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
});

export default async function keyRoutes(app: FastifyInstance) {
  const { db, orders } = app.deps;
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (req, reply) => {
    if (req.user.role === "guest")
      await reply.code(403).send({ error: "guest", message: "sign up to make API keys" });
  });

  app.get("/", async (req) => {
    const { rows } = await db.query(
      "SELECT * FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id",
      [req.user.userId],
    );
    return rows.map(view);
  });

  app.post(
    "/",
    { config: { rateLimit: { max: 10, timeWindow: 3_600_000 } } },
    async (req, reply) => {
      const body = NewKey.parse(req.body);
      if (body.league !== undefined) {
        const member = await db.query(
          "SELECT l.is_practice FROM portfolios pf JOIN leagues l ON l.id = pf.league_id WHERE pf.user_id = $1 AND l.id = $2",
          [req.user.userId, body.league],
        );
        if (!member.rows[0]) throw new ApiError(404, "not_a_member", "you're not in that league");
        if (member.rows[0].is_practice) body.league = undefined;
      }
      const { key, prefix, secret } = ApiKeys.generate();
      // The count check and insert share a transaction-free race window of one request;
      // the hourly limit above keeps that harmless.
      const { rows: count } = await db.query(
        "SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL",
        [req.user.userId],
      );
      if (count[0].n >= MAX_KEYS)
        throw new ApiError(409, "too_many_keys", `at most ${MAX_KEYS} keys; revoke one first`);
      const { rows } = await db.query(
        `INSERT INTO api_keys (user_id, league_id, name, prefix, secret_hash, max_order_qty, orders_per_second)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          req.user.userId,
          body.league ?? null,
          body.name,
          prefix,
          ApiKeys.secretHash(secret),
          body.maxOrderQty,
          body.ordersPerSecond,
        ],
      );
      await audit(db, req.user.userId, "api_key_create", { keyId: rows[0].id }, req.ip);
      return reply.code(201).send({ ...view(rows[0]), key });
    },
  );

  app.delete("/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { rows } = await db.query(
      "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
      [id, req.user.userId],
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "no such key");
    const cancelled = await orders.cancelBotOrders(id);
    await audit(db, req.user.userId, "api_key_revoke", { keyId: id, cancelled }, req.ip);
    return { revoked: id, cancelled };
  });
}
