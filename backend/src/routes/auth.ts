import { createHash, randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { audit } from "../audit.js";
import { dummyHash, hashPassword, verifyPassword } from "../auth/passwords.js";
import { REFRESH_TTL_S } from "../auth/tokens.js";

const Register = z.object({
  email: z.email().max(254),
  username: z.string().regex(/^[A-Za-z0-9_]{3,24}$/, "3-24 letters, numbers or underscores"),
  password: z.string().min(10).max(200),
});

const Login = z.object({ email: z.email(), password: z.string().min(1).max(200) });

const COOKIE = "ticker_rt";

export default async function authRoutes(app: FastifyInstance) {
  const { db, tokens, config } = app.deps;
  // Limits are sized for a classroom on one shared IP: 30 sign-ups or 60 logins a
  // minute per IP, 10 password guesses a minute per account from any one IP (so a
  // stranger can't lock someone out of their own account), and refreshes are counted
  // per session rather than per IP.
  const perIp = (max: number) => ({
    rateLimit: { max, timeWindow: 60_000, keyGenerator: (req: FastifyRequest) => req.ip },
  });
  const guessesPerAccount = app.createRateLimit({
    max: 10,
    timeWindow: 60_000,
    keyGenerator: (req) =>
      `login:${String((req.body as { email?: unknown })?.email).toLowerCase()}:${req.ip}`,
  });
  const perSession = {
    rateLimit: {
      max: 10,
      timeWindow: 60_000,
      keyGenerator: (req: FastifyRequest) => {
        const token = req.cookies[COOKIE];
        return token ? `rt:${createHash("sha256").update(token).digest("hex")}` : req.ip;
      },
    },
  };

  const setRefreshCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "strict",
      path: "/v1/auth",
      maxAge: REFRESH_TTL_S,
    });

  const meta = (req: FastifyRequest) => ({ userAgent: req.headers["user-agent"], ip: req.ip });

  async function session(
    reply: FastifyReply,
    user: { id: number; role: any; username: string },
    refresh: string,
  ) {
    setRefreshCookie(reply, refresh);
    return {
      accessToken: await tokens.accessToken({ userId: user.id, role: user.role }),
      user: { id: user.id, username: user.username, role: user.role },
    };
  }

  app.post("/register", { config: perIp(30) }, async (req, reply) => {
    const body = Register.parse(req.body);
    const hash = await hashPassword(body.password);

    // A guest saving their account keeps their portfolio: the guest row becomes the
    // new account instead of a fresh user being made.
    const caller = await app.identify(req);
    if (caller?.kind === "user" && caller.claims.role === "guest") {
      const { rows } = await db.query(
        `UPDATE users SET email = $2, username = $3, password_hash = $4, role = 'student'
         WHERE id = $1 AND role = 'guest'
           AND NOT EXISTS (SELECT 1 FROM users WHERE id <> $1 AND (lower(email) = lower($2) OR lower(username) = lower($3)))
         RETURNING id, username, role`,
        [caller.claims.userId, body.email, body.username, hash],
      );
      const user = rows[0];
      if (!user)
        return reply
          .code(409)
          .send({ error: "taken", message: "email or username already in use" });
      await audit(db, user.id, "register", { fromGuest: true }, req.ip);
      reply.code(201);
      return session(reply, user, await tokens.issueRefresh(user.id, meta(req)));
    }

    // New users start with a portfolio in the practice league.
    const { rows } = await db.query(
      `WITH u AS (
         INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING id, username, role
       ), p AS (
         INSERT INTO portfolios (league_id, user_id, cash)
         SELECT l.id, u.id, l.starting_cash FROM leagues l, u WHERE l.is_practice
       )
       SELECT * FROM u`,
      [body.email, body.username, hash],
    );
    const user = rows[0];
    if (!user)
      return reply.code(409).send({ error: "taken", message: "email or username already in use" });
    await audit(db, user.id, "register", {}, req.ip);
    reply.code(201);
    return session(reply, user, await tokens.issueRefresh(user.id, meta(req)));
  });

  // "Try it with $100k": a guest gets a practice portfolio and a session cookie, no
  // email or password. Guests can trade in the practice league but can't join leagues.
  app.post(
    "/guest",
    // 60 an hour per IP: enough for a class behind one school NAT to all click it.
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 3_600_000,
          keyGenerator: (req: FastifyRequest) => `guest:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const { rows } = await db.query(
        `WITH u AS (
           INSERT INTO users (username, role) VALUES ($1, 'guest') RETURNING id, username, role
         ), p AS (
           INSERT INTO portfolios (league_id, user_id, cash)
           SELECT l.id, u.id, l.starting_cash FROM leagues l, u WHERE l.is_practice
         )
         SELECT * FROM u`,
        [`guest_${randomBytes(5).toString("hex")}`],
      );
      const user = rows[0];
      await audit(db, user.id, "guest", {}, req.ip);
      reply.code(201);
      return session(reply, user, await tokens.issueRefresh(user.id, meta(req)));
    },
  );

  app.post("/login", { config: perIp(60) }, async (req, reply) => {
    const body = Login.parse(req.body);
    // isAllowed only means "on the allow list"; isExceeded is the real answer.
    const limit = await guessesPerAccount(req);
    if (!limit.isAllowed && limit.isExceeded)
      return reply
        .code(429)
        .send({ error: "rate_limited", message: "too many attempts, wait a minute" });
    const { rows } = await db.query(
      "SELECT id, username, role, password_hash FROM users WHERE email = $1",
      [body.email],
    );
    const user = rows[0];
    const ok = await verifyPassword(user?.password_hash ?? (await dummyHash()), body.password);
    if (!user || !ok) {
      await audit(db, user?.id ?? null, "login_failed", { email: body.email }, req.ip);
      return reply.code(401).send({ error: "bad_credentials", message: "wrong email or password" });
    }
    await audit(db, user.id, "login", {}, req.ip);
    return session(reply, user, await tokens.issueRefresh(user.id, meta(req)));
  });

  app.post("/refresh", { config: perSession }, async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (!token) return reply.code(401).send({ error: "no_session", message: "not logged in" });
    const result = await tokens.rotate(token, meta(req));
    if ("error" in result) {
      reply.clearCookie(COOKIE, { path: "/v1/auth" });
      if (result.error === "reused") await audit(db, null, "refresh_reuse", {}, req.ip);
      return reply
        .code(401)
        .send({ error: "no_session", message: "session expired, log in again" });
    }
    const { rows } = await db.query("SELECT id, username, role FROM users WHERE id = $1", [
      result.userId,
    ]);
    return session(reply, rows[0], result.token);
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) {
      const userId = await tokens.revokeFamilyOf(token);
      if (userId) await audit(db, userId, "logout", {}, req.ip);
    }
    reply.clearCookie(COOKIE, { path: "/v1/auth" });
    return reply.code(204).send();
  });
}
