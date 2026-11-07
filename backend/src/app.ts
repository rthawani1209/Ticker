import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";

import { isApiKey, keyPrefix, type ApiKeys } from "./auth/api-keys.js";
import type { AccessClaims, Tokens } from "./auth/tokens.js";
import type { Config } from "./config.js";
import type { Db } from "./db/pool.js";
import type { EngineBridge } from "./engine/bridge.js";
import { ApiError } from "./errors.js";
import type { Leaderboard } from "./leaderboard.js";
import type { OrderService } from "./orders.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import classroomRoutes, { studentAssignmentRoutes } from "./routes/classroom.js";
import keyRoutes from "./routes/keys.js";
import leagueRoutes, { positionRoutes } from "./routes/leagues.js";
import marketRoutes from "./routes/market.js";
import orderRoutes, { fillRoutes } from "./routes/orders.js";
import type { SymbolInfo } from "./symbols.js";
import type { Fanout } from "./ws/fanout.js";
import wsRoutes from "./ws/hub.js";

export interface Deps {
  config: Config;
  db: Db;
  redis?: Redis;
  fanout: Fanout;
  apiKeys: ApiKeys;
  bridge: EngineBridge;
  orders: OrderService;
  leaderboard: Leaderboard;
  tokens: Tokens;
  symbols: SymbolInfo[];
  symbolsByTicker: Map<string, SymbolInfo>;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
    routeList: { method: string; url: string }[];
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: AccessClaims;
  }
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: deps.config.TRUST_PROXY,
    bodyLimit: 16 * 1024,
  });
  app.decorate("deps", deps);
  // Every route, so the role test can check that none is left out of it.
  const routeList: { method: string; url: string }[] = [];
  app.decorate("routeList", routeList);
  app.addHook("onRoute", (r) => {
    for (const method of [r.method].flat())
      if (method !== "HEAD") routeList.push({ method, url: r.url });
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: deps.config.CORS_ORIGIN.split(","),
    credentials: true,
    // The default is GET, HEAD and POST only, which quietly breaks every DELETE, PATCH and PUT
    // from the browser (the frontend lives on another origin).
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    exposedHeaders: ["content-disposition"], // so CSV downloads keep their file name
  });
  await app.register(cookie);
  // Signed-in requests are counted per user, everything else per IP. A whole class
  // behind one campus NAT shares an IP, so a per-IP limit alone would lock them out.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: 60_000,
    redis: deps.redis,
    nameSpace: "ticker-rl:",
    keyGenerator: async (req) => {
      const header = req.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
      if (token && isApiKey(token)) return `k${keyPrefix(token) ?? req.ip}`;
      const claims = token ? await deps.tokens.verifyAccess(token) : null;
      return claims ? `u${claims.userId}` : req.ip;
    },
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.decorateRequest("user", null as unknown as AccessClaims);
  // Bots may only trade and read their own account with an API key; everything else
  // (making keys, leagues, classes, admin) needs a person's login.
  const BOT_ROUTES = ["/v1/orders", "/v1/fills", "/v1/positions", "/v1/me"];
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (token && isApiKey(token)) {
      const found = await deps.apiKeys.verify(token);
      if (!found)
        return void (await reply
          .code(401)
          .send({ error: "unauthorized", message: "bad or revoked API key" }));
      if (!(await deps.apiKeys.enabled()))
        return void (await reply
          .code(503)
          .send({ error: "bots_paused", message: "bot trading is paused" }));
      const url = req.routeOptions.url ?? "";
      if (!BOT_ROUTES.some((p) => url === p || url.startsWith(p + "/")))
        return void (await reply
          .code(403)
          .send({ error: "forbidden", message: "API keys can't use this route" }));
      req.user = { userId: found.userId, role: found.role, apiKey: found.key };
      return;
    }
    const claims = token ? await deps.tokens.verifyAccess(token) : null;
    if (!claims) {
      await reply
        .code(401)
        .send({ error: "unauthorized", message: "missing or expired access token" });
      return;
    }
    req.user = claims;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError)
      return reply.code(err.status).send({ error: err.code, message: err.message });
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

  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(orderRoutes, { prefix: "/v1/orders" });
  await app.register(fillRoutes, { prefix: "/v1/fills" });
  await app.register(leagueRoutes, { prefix: "/v1/leagues" });
  await app.register(positionRoutes, { prefix: "/v1/positions" });
  await app.register(classroomRoutes, { prefix: "/v1/classes" });
  await app.register(studentAssignmentRoutes, { prefix: "/v1/leagues" });
  await app.register(adminRoutes, { prefix: "/v1/admin" });
  await app.register(keyRoutes, { prefix: "/v1/keys" });
  await app.register(marketRoutes, { prefix: "/v1" });
  await app.register(
    async (scope) => {
      scope.addHook("preHandler", scope.authenticate);
      scope.get("/", async (req) => {
        const { rows } = await deps.db.query(
          "SELECT id, email, username, role, created_at FROM users WHERE id = $1",
          [req.user.userId],
        );
        const u = rows[0];
        return {
          id: u.id,
          email: u.email,
          username: u.username,
          role: u.role,
          createdAt: u.created_at.toISOString(),
        };
      });
    },
    { prefix: "/v1/me" },
  );
  await app.register(wsRoutes);
  return app;
}
