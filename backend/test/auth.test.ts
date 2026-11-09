import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth, signUp, startBackend, type Backend } from "./harness.js";

let b: Backend;
beforeAll(async () => {
  b = await startBackend();
});
afterAll(() => b?.stop());

const post = (url: string, payload?: object, cookie?: string) =>
  b.app.inject({
    method: "POST",
    url,
    payload,
    cookies: cookie ? { ticker_rt: cookie } : undefined,
  });

describe("auth", () => {
  it("registers, then logs in with the same password", async () => {
    const u = await signUp(b, "alice");
    const me = await b.app.inject({ url: "/v1/me", headers: auth(u.token) });
    expect(me.json()).toMatchObject({
      username: "alice",
      email: "alice@example.com",
      role: "student",
    });

    const login = await post("/v1/auth/login", {
      email: "ALICE@example.com",
      password: "correct horse battery",
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.username).toBe("alice");
  });

  it("stores an argon2id hash, not the password", async () => {
    const { rows } = await b.db.query("SELECT password_hash FROM users WHERE username = 'alice'");
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it("rejects a wrong password and an unknown email the same way", async () => {
    const wrong = await post("/v1/auth/login", {
      email: "alice@example.com",
      password: "nope nope nope",
    });
    const unknown = await post("/v1/auth/login", {
      email: "nobody@example.com",
      password: "nope nope nope",
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("refuses duplicate emails and weak input", async () => {
    expect(
      (
        await post("/v1/auth/register", {
          email: "alice@example.com",
          username: "alice2",
          password: "long enough pw",
        })
      ).statusCode,
    ).toBe(409);
    const bad = await post("/v1/auth/register", {
      email: "not-an-email",
      username: "x",
      password: "short",
    });
    expect(bad.statusCode).toBe(400);
    expect(
      bad
        .json()
        .issues.map((i: any) => i.path)
        .sort(),
    ).toEqual(["email", "password", "username"]);
  });

  it("rotates refresh tokens and revokes the family when an old one is reused", async () => {
    const u = await signUp(b);
    const first = await post("/v1/auth/refresh", undefined, u.cookie);
    expect(first.statusCode).toBe(200);
    const second = first.cookies.find((c) => c.name === "ticker_rt")!.value;
    expect(second).not.toBe(u.cookie);
    expect(first.json().accessToken).toBeTruthy();

    // Pretend the first token was used a minute ago, past the grace window.
    await b.db.query(
      "UPDATE refresh_tokens SET used_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NOT NULL",
      [u.id],
    );

    // Replaying it now looks like theft: everything in the family dies.
    expect((await post("/v1/auth/refresh", undefined, u.cookie)).statusCode).toBe(401);
    expect((await post("/v1/auth/refresh", undefined, second)).statusCode).toBe(401);
    const { rows } = await b.db.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'refresh_reuse'",
    );
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
    const { rows } = await b.db.query(
      "SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NOT NULL",
      [u.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("logout ends the session", async () => {
    const u = await signUp(b);
    expect((await post("/v1/auth/logout", undefined, u.cookie)).statusCode).toBe(204);
    expect((await post("/v1/auth/refresh", undefined, u.cookie)).statusCode).toBe(401);
  });

  it("sets the refresh cookie httpOnly and scoped to the auth routes", async () => {
    const res = await post("/v1/auth/register", {
      email: "c@example.com",
      username: "carol",
      password: "correct horse battery",
    });
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
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress: "10.7.7.7",
        headers: { "x-forwarded-for": `203.0.113.${i}` }, // a new "IP" every time
        payload: { email: "alice@example.com", password: "guessing guess" },
      });
      codes.push(res.statusCode);
    }
    expect(codes.at(-1)).toBe(429);
    const { rows } = await b.db.query(
      "SELECT DISTINCT host(ip) AS ip FROM audit_log WHERE action = 'login_failed' AND ip = '10.7.7.7'",
    );
    expect(rows).toEqual([{ ip: "10.7.7.7" }]);
  });

  it("rate limits password guesses per account and IP, without locking out the owner", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await b.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress: "10.9.9.9",
        payload: { email: "Victim@example.com", password: "guessing guess" },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);

    // The guesser's IP is blocked for this account, but the owner on their own network is not.
    const owner = await b.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "10.9.8.1",
      payload: { email: "victim@example.com", password: "guessing guess" },
    });
    expect(owner.statusCode).toBe(401);
  });

  it("does not give a made-up API key its own rate limit bucket", async () => {
    // Before, any "Bearer tk_..." header got a fresh bucket, so rotating fake keys dodged the IP limit.
    const remaining: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await b.app.inject({
        method: "GET",
        url: "/v1/me",
        remoteAddress: "10.9.7.7",
        headers: { authorization: `Bearer tk_${i}_${"x".repeat(32)}` },
      });
      expect(res.statusCode).toBe(401);
      remaining.push(Number(res.headers["x-ratelimit-remaining"]));
    }
    // All five count against the same per-IP bucket.
    expect(remaining).toEqual([0, 1, 2, 3, 4].map((n) => remaining[0]! - n));
  });

  it("lets a whole class log in and refresh from one shared IP", async () => {
    // 40 different accounts behind one campus NAT: none of them hit the per-account limit.
    const codes = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const res = await b.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress: "10.7.7.7",
        payload: { email: `student${i}@example.com`, password: "wrong password" },
      });
      codes.add(res.statusCode);
    }
    expect([...codes]).toEqual([401]);

    // Refreshes are counted per session, so 15 students refreshing at once all succeed.
    const sessions = [];
    for (let i = 0; i < 15; i++) sessions.push(await signUp(b));
    for (const s of sessions) {
      const res = await b.app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        remoteAddress: "10.7.7.8",
        cookies: { ticker_rt: s.cookie },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("counts signed-in API calls per user, not per IP", async () => {
    const [a, c] = [await signUp(b), await signUp(b)];
    const codes = new Set<number>();
    for (let i = 0; i < 200; i++) {
      for (const u of [a, c]) {
        const res = await b.app.inject({
          url: "/v1/positions",
          remoteAddress: "10.7.7.9",
          headers: auth(u.token),
        });
        codes.add(res.statusCode);
      }
    }
    expect([...codes]).toEqual([200]); // 400 calls from one IP, but 200 per user
  });

  it("turns a guest into the new account, portfolio and all", async () => {
    const g = (
      await b.app.inject({ method: "POST", url: "/v1/auth/guest", remoteAddress: "10.6.6.6" })
    ).json();
    const bought = await b.app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: auth(g.accessToken),
      payload: { symbol: "KILN", side: "buy", price: 24_00, qty: 3 },
    });
    expect(bought.statusCode).toBe(201);
    const name = `saved${process.pid}`;
    const res = await b.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: auth(g.accessToken),
      payload: { email: `${name}@example.com`, username: name, password: "correct horse battery" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().user).toMatchObject({ id: g.user.id, username: name, role: "student" });
    const orders = await b.app.inject({ url: "/v1/orders", headers: auth(res.json().accessToken) });
    expect(orders.json().map((o: any) => o.id)).toEqual([bought.json().id]);
    await b.app.inject({
      method: "DELETE",
      url: `/v1/orders/${bought.json().id}`,
      headers: auth(res.json().accessToken),
    });

    // Signing in works with the new details, and a second save is a normal sign-up.
    const login = await b.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "10.6.6.7",
      payload: { email: `${name}@example.com`, password: "correct horse battery" },
    });
    expect(login.json().user.id).toBe(g.user.id);
  });
});
