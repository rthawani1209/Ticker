import type { FastifyInstance, FastifyRequest } from "fastify";
import { decodeJwt } from "jose";
import { z } from "zod";

import { audit } from "../audit.js";

const Cents = z.number().int().positive().max(10_000_000);

const NewOrder = z
  .object({
    symbol: z.string().toUpperCase(),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["limit", "market", "stop", "stop_limit"]).default("limit"),
    tif: z.enum(["gtc", "ioc", "fok"]).optional(),
    qty: z.number().int().positive().max(100_000),
    price: Cents.optional(),
    stopPrice: Cents.optional(),
    league: z.number().int().positive().optional(), // defaults to the practice league
  })
  .superRefine((o, ctx) => {
    const needsPrice = o.type === "limit" || o.type === "stop_limit";
    const needsStop = o.type === "stop" || o.type === "stop_limit";
    if (needsPrice !== (o.price !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["price"], message: needsPrice ? "required" : `not allowed for ${o.type} orders` });
    }
    if (needsStop !== (o.stopPrice !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["stopPrice"], message: needsStop ? "required" : `not allowed for ${o.type} orders` });
    }
  });

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
    const sym = symbolsByTicker.get(body.symbol);
    if (!sym) return reply.code(422).send({ error: "unknown_symbol", message: `no symbol ${body.symbol}` });
    // Market orders can only be immediate; everything else rests until cancelled by default.
    const tif = body.tif ?? (body.type === "market" ? "ioc" : "gtc");
    const { league, ...input } = body;
    const order = await orders.place(req.user.userId, { ...input, symbolId: sym.id, tif }, league);
    await audit(db, req.user.userId, "order_new", { orderId: order.id, league: order.league, symbol: sym.ticker, side: body.side, qty: body.qty }, req.ip);
    return reply.code(order.status === "rejected" ? 422 : 201).send(order);
  });

  app.get("/", async (req) => {
    const q = ListQuery.parse(req.query);
    return orders.list(req.user.userId, { open: q.open === "true" ? true : undefined, league: q.league, limit: q.limit, before: q.before });
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
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100), league: z.coerce.number().int().positive().optional() })
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
