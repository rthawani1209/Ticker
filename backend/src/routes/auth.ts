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
  const authLimit = { rateLimit: { max: 10, timeWindow: 60_000 } };

  const setRefreshCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/auth",
      maxAge: REFRESH_TTL_S,
    });

  const meta = (req: FastifyRequest) => ({ userAgent: req.headers["user-agent"], ip: req.ip });

  async function session(reply: FastifyReply, user: { id: number; role: any; username: string }, refresh: string) {
    setRefreshCookie(reply, refresh);
    return {
      accessToken: await tokens.accessToken({ userId: user.id, role: user.role }),
      user: { id: user.id, username: user.username, role: user.role },
    };
  }

  app.post("/register", { config: authLimit }, async (req, reply) => {
    const body = Register.parse(req.body);
    const hash = await hashPassword(body.password);
    const { rows } = await db.query(
      `INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id, username, role`,
      [body.email, body.username, hash],
    );
    const user = rows[0];
    if (!user) return reply.code(409).send({ error: "taken", message: "email or username already in use" });
    await audit(db, user.id, "register", {}, req.ip);
    reply.code(201);
    return session(reply, user, await tokens.issueRefresh(user.id, meta(req)));
  });

  app.post("/login", { config: authLimit }, async (req, reply) => {
    const body = Login.parse(req.body);
    const { rows } = await db.query("SELECT id, username, role, password_hash FROM users WHERE email = $1", [body.email]);
    const user = rows[0];
    const ok = await verifyPassword(user?.password_hash ?? (await dummyHash()), body.password);
    if (!user || !ok) {
      await audit(db, user?.id ?? null, "login_failed", { email: body.email }, req.ip);
      return reply.code(401).send({ error: "bad_credentials", message: "wrong email or password" });
    }
    await audit(db, user.id, "login", {}, req.ip);
    return session(reply, user, await tokens.issueRefresh(user.id, meta(req)));
  });

  app.post("/refresh", { config: authLimit }, async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (!token) return reply.code(401).send({ error: "no_session", message: "not logged in" });
    const result = await tokens.rotate(token, meta(req));
    if ("error" in result) {
      reply.clearCookie(COOKIE, { path: "/api/auth" });
      if (result.error === "reused") await audit(db, null, "refresh_reuse", {}, req.ip);
      return reply.code(401).send({ error: "no_session", message: "session expired, log in again" });
    }
    const { rows } = await db.query("SELECT id, username, role FROM users WHERE id = $1", [result.userId]);
    return session(reply, rows[0], result.token);
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) {
      const userId = await tokens.revokeFamilyOf(token);
      if (userId) await audit(db, userId, "logout", {}, req.ip);
    }
    reply.clearCookie(COOKIE, { path: "/api/auth" });
    return reply.code(204).send();
  });
}
