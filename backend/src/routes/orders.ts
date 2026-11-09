import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { audit } from "../audit.js";
import { callerKey } from "../auth/caller.js";
import { leagueFor } from "../auth/key-league.js";
import { ApiError } from "../errors.js";
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

  // Per-user limit on order entry, keyed by the verified caller (see identify in app.ts).
  const orderLimit = {
    rateLimit: {
      max: 20,
      timeWindow: 1000,
      keyGenerator: async (req: FastifyRequest) => callerKey(req, await app.identify(req)),
    },
  };
  // Each API key has its own, lower orders-per-second limit set when it was made.
  const perKey = app.createRateLimit({
    timeWindow: 1000,
    max: (req) => req.user.apiKey?.ordersPerSecond ?? 20,
    keyGenerator: (req) => `apikey:${req.user.apiKey?.id}`,
  });

  app.post("/", { config: orderLimit }, async (req, reply) => {
    const body = NewOrder.parse(req.body);
    const { input, league } = toOrderInput(body, symbolsByTicker);
    const key = req.user.apiKey;
    let leagueId = league;
    if (key) {
      const limit = await perKey(req);
      if (!limit.isAllowed && limit.isExceeded)
        throw new ApiError(
          429,
          "rate_limited",
          `this key allows ${key.ordersPerSecond} orders a second`,
        );
      if (body.qty > key.maxOrderQty)
        throw new ApiError(
          422,
          "size_cap",
          `this key can send at most ${key.maxOrderQty} shares an order`,
        );
      leagueId = await leagueFor(db, req.user, league);
    }
    const order = await orders.place(req.user.userId, input, leagueId, key?.id);
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
        ...(key ? { apiKey: key.id } : {}),
      },
      req.ip,
    );
    return reply.code(order.status === "rejected" ? 422 : 201).send(order);
  });

  app.get("/", async (req) => {
    const q = ListQuery.parse(req.query);
    return orders.list(req.user.userId, {
      open: q.open === "true" ? true : undefined,
      league: await leagueFor(db, req.user, q.league),
      limit: q.limit,
      before: q.before,
    });
  });

  // An API key only sees orders in its own league; anything else looks like it isn't there.
  async function ownOrder(req: FastifyRequest) {
    const { id } = Id.parse(req.params);
    const order = await orders.get(req.user.userId, id);
    if (order && req.user.apiKey && order.league !== (await leagueFor(db, req.user, undefined)))
      return null;
    return order;
  }

  app.get("/:id", async (req, reply) => {
    const order = await ownOrder(req);
    return order ?? reply.code(404).send({ error: "not_found", message: "no such order" });
  });

  app.delete("/:id", { config: orderLimit }, async (req) => {
    const { id } = Id.parse(req.params);
    if (!(await ownOrder(req))) throw new ApiError(404, "not_found", "no such order");
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
    return app.deps.orders.fills(req.user.userId, {
      ...q,
      league: await leagueFor(app.deps.db, req.user, q.league),
    });
  });
}
