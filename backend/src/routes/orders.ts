import type { FastifyInstance, FastifyRequest } from "fastify";
import { decodeJwt } from "jose";
import { z } from "zod";

import { audit } from "../audit.js";
import { NewOrder, toOrderInput } from "../order-schema.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const ListQuery = z.object({
  open: z.enum(["true", "false"]).optional(),
  league: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export default async function orderRoutes(app: FastifyInstance) {
  const { orders, symbolsByTicker, db } = app.deps;
  app.addHook("preHandler", app.authenticate);

  // Per-user limit on order entry. Rate limiting runs before authentication, so the key
  // comes from the token's unverified subject; a forged token is rejected right after anyway.
  const orderLimit = { rateLimit: { max: 20, timeWindow: 1000, keyGenerator: userKey } };

  app.post("/", { config: orderLimit }, async (req, reply) => {
    const body = NewOrder.parse(req.body);
    const { input, league } = toOrderInput(body, symbolsByTicker);
    const order = await orders.place(req.user.userId, input, league);
    await audit(
      db,
      req.user.userId,
      "order_new",
      {
        orderId: order.id,
        league: order.league,
        symbol: order.symbol,
        side: body.side,
        qty: body.qty,
      },
      req.ip,
    );
    return reply.code(order.status === "rejected" ? 422 : 201).send(order);
  });

  app.get("/", async (req) => {
    const q = ListQuery.parse(req.query);
    return orders.list(req.user.userId, {
      open: q.open === "true" ? true : undefined,
      league: q.league,
      limit: q.limit,
      before: q.before,
    });
  });

  app.get("/:id", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const order = await orders.get(req.user.userId, id);
    return order ?? reply.code(404).send({ error: "not_found", message: "no such order" });
  });

  app.delete("/:id", { config: orderLimit }, async (req) => {
    const { id } = Id.parse(req.params);
    const order = await orders.cancel(req.user.userId, id);
    await audit(db, req.user.userId, "order_cancel", { orderId: id }, req.ip);
    return order;
  });
}

export async function fillRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.get("/", async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        league: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    return app.deps.orders.fills(req.user.userId, q);
  });
}

function userKey(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const sub = decodeJwt(header.slice(7)).sub;
      if (sub) return `u${sub}`;
    } catch {
      // fall through to the IP
    }
  }
  return req.ip;
}
