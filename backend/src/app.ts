import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";

import type { AccessClaims, Tokens } from "./auth/tokens.js";
import type { Config } from "./config.js";
import type { Db } from "./db/pool.js";
import type { EngineBridge } from "./engine/bridge.js";
import type { OrderService } from "./orders.js";
import authRoutes from "./routes/auth.js";
import marketRoutes from "./routes/market.js";
import orderRoutes, { fillRoutes } from "./routes/orders.js";
import type { SymbolInfo } from "./symbols.js";
import wsRoutes from "./ws/hub.js";

export interface Deps {
  config: Config;
  db: Db;
  redis?: Redis;
  bridge: EngineBridge;
  orders: OrderService;
  tokens: Tokens;
  symbols: SymbolInfo[];
  symbolsByTicker: Map<string, SymbolInfo>;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: AccessClaims;
  }
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: deps.config.TRUST_PROXY, bodyLimit: 16 * 1024 });
  app.decorate("deps", deps);

  await app.register(helmet);
  await app.register(cors, { origin: deps.config.CORS_ORIGIN.split(","), credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: 60_000,
    redis: deps.redis,
    nameSpace: "ticker-rl:",
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.decorateRequest("user", null as unknown as AccessClaims);
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const claims = header?.startsWith("Bearer ") ? await deps.tokens.verifyAccess(header.slice(7)) : null;
    if (!claims) {
      await reply.code(401).send({ error: "unauthorized", message: "missing or expired access token" });
      return;
    }
    req.user = claims;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "request failed validation",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({
      error: status === 429 ? "rate_limited" : status >= 500 ? "internal" : "bad_request",
      message: status >= 500 ? "something went wrong" : (err as Error).message,
    });
  });

  app.get("/health", async (_req, reply) => {
    let db = true;
    try {
      await deps.db.query("SELECT 1");
    } catch {
      db = false;
    }
    const ok = db && deps.bridge.connected;
    return reply.code(ok ? 200 : 503).send({ ok, db, engine: deps.bridge.connected });
  });

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(orderRoutes, { prefix: "/api/orders" });
  await app.register(fillRoutes, { prefix: "/api/fills" });
  await app.register(marketRoutes, { prefix: "/api" });
  await app.register(
    async (scope) => {
      scope.addHook("preHandler", scope.authenticate);
      scope.get("/", async (req) => {
        const { rows } = await deps.db.query("SELECT id, email, username, role, created_at FROM users WHERE id = $1", [req.user.userId]);
        const u = rows[0];
        return { id: u.id, email: u.email, username: u.username, role: u.role, createdAt: u.created_at.toISOString() };
      });
    },
    { prefix: "/api/me" },
  );
  await app.register(wsRoutes);
  return app;
}
