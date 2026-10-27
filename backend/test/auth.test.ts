import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth, signUp, startBackend, type Backend } from "./harness.js";

let b: Backend;
beforeAll(async () => {
  b = await startBackend();
});
afterAll(() => b?.stop());

const post = (url: string, payload?: object, cookie?: string) =>
  b.app.inject({ method: "POST", url, payload, cookies: cookie ? { ticker_rt: cookie } : undefined });

describe("auth", () => {
  it("registers, then logs in with the same password", async () => {
    const u = await signUp(b, "alice");
    const me = await b.app.inject({ url: "/v1/me", headers: auth(u.token) });
    expect(me.json()).toMatchObject({ username: "alice", email: "alice@example.com", role: "student" });

    const login = await post("/v1/auth/login", { email: "ALICE@example.com", password: "correct horse battery" });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.username).toBe("alice");
  });

  it("stores an argon2id hash, not the password", async () => {
    const { rows } = await b.db.query("SELECT password_hash FROM users WHERE username = 'alice'");
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it("rejects a wrong password and an unknown email the same way", async () => {
    const wrong = await post("/v1/auth/login", { email: "alice@example.com", password: "nope nope nope" });
    const unknown = await post("/v1/auth/login", { email: "nobody@example.com", password: "nope nope nope" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("refuses duplicate emails and weak input", async () => {
    expect((await post("/v1/auth/register", { email: "alice@example.com", username: "alice2", password: "long enough pw" })).statusCode).toBe(409);
    const bad = await post("/v1/auth/register", { email: "not-an-email", username: "x", password: "short" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.map((i: any) => i.path).sort()).toEqual(["email", "password", "username"]);
  });

  it("rotates refresh tokens and revokes the family when an old one is reused", async () => {
    const u = await signUp(b);
    const first = await post("/v1/auth/refresh", undefined, u.cookie);
    expect(first.statusCode).toBe(200);
    const second = first.cookies.find((c) => c.name === "ticker_rt")!.value;
    expect(second).not.toBe(u.cookie);
    expect(first.json().accessToken).toBeTruthy();

    // Pretend the first token was used a minute ago, past the grace window.
    await b.db.query("UPDATE refresh_tokens SET used_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NOT NULL", [u.id]);

    // Replaying it now looks like theft: everything in the family dies.
    expect((await post("/v1/auth/refresh", undefined, u.cookie)).statusCode).toBe(401);
    expect((await post("/v1/auth/refresh", undefined, second)).statusCode).toBe(401);
    const { rows } = await b.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'refresh_reuse'");
    expect(rows[0].n).toBe(1);
  });

  it("lets two tabs refresh with the same token at once", async () => {
    const u = await signUp(b);
    const [a, c] = await Promise.all([
      post("/v1/auth/refresh", undefined, u.cookie),
      post("/v1/auth/refresh", undefined, u.cookie),
    ]);
    expect([a.statusCode, c.statusCode]).toEqual([200, 200]);
    const tokenA = a.cookies.find((x) => x.name === "ticker_rt")!.value;
    const tokenC = c.cookies.find((x) => x.name === "ticker_rt")!.value;
    // Both new sessions keep working; nothing was revoked.
    expect((await post("/v1/auth/refresh", undefined, tokenA)).statusCode).toBe(200);
    expect((await post("/v1/auth/refresh", undefined, tokenC)).statusCode).toBe(200);
    const { rows } = await b.db.query("SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NOT NULL", [u.id]);
    expect(rows[0].n).toBe(0);
  });

  it("logout ends the session", async () => {
    const u = await signUp(b);
    expect((await post("/v1/auth/logout", undefined, u.cookie)).statusCode).toBe(204);
    expect((await post("/v1/auth/refresh", undefined, u.cookie)).statusCode).toBe(401);
  });

  it("sets the refresh cookie httpOnly and scoped to the auth routes", async () => {
    const res = await post("/v1/auth/register", { email: "c@example.com", username: "carol", password: "correct horse battery" });
    const c = res.cookies.find((x) => x.name === "ticker_rt")!;
    expect(c.httpOnly).toBe(true);
    expect(c.path).toBe("/v1/auth");
    expect(c.sameSite).toBe("Strict");
  });

  it("requires a valid access token", async () => {
    expect((await b.app.inject({ url: "/v1/me" })).statusCode).toBe(401);
    expect((await b.app.inject({ url: "/v1/me", headers: auth("garbage") })).statusCode).toBe(401);
  });

  it("ignores X-Forwarded-For unless TRUST_PROXY is on", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await b.app.inject({
        method: "POST", url: "/v1/auth/login", remoteAddress: "10.7.7.7",
        headers: { "x-forwarded-for": `203.0.113.${i}` }, // a new "IP" every time
        payload: { email: "alice@example.com", password: "guessing guess" },
      });
      codes.push(res.statusCode);
    }
    expect(codes.at(-1)).toBe(429);
    const { rows } = await b.db.query("SELECT DISTINCT host(ip) AS ip FROM audit_log WHERE action = 'login_failed' AND ip = '10.7.7.7'");
    expect(rows).toEqual([{ ip: "10.7.7.7" }]);
  });

  it("rate limits login attempts", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await b.app.inject({
        method: "POST", url: "/v1/auth/login", remoteAddress: "10.9.9.9",
        payload: { email: "alice@example.com", password: "guessing guess" },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});
