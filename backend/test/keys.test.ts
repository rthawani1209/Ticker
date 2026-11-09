import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth, signUp, startBackend, type Backend } from "./harness.js";

let b: Backend;
beforeAll(async () => {
  b = await startBackend();
});
afterAll(() => b?.stop());

type User = Awaited<ReturnType<typeof signUp>>;
const call = (token: string | null, method: string, url: string, payload?: object) =>
  b.app.inject({
    method: method as "GET",
    url,
    headers: token ? auth(token) : {},
    ...(payload ? { payload } : {}),
  });
const newKey = async (u: User, body: object = {}) => {
  const res = await call(u.token, "POST", "/v1/keys", { name: "bot", ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const openOrders = async (u: User) =>
  (await call(u.token, "GET", "/v1/orders?open=true")).json().map((o: any) => o.id);

describe("API keys", () => {
  it("lets the browser send DELETE, PATCH and PUT across origins", async () => {
    for (const method of ["DELETE", "PATCH", "PUT"]) {
      const res = await b.app.inject({
        method: "OPTIONS",
        url: "/v1/keys/1",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": method,
          "access-control-request-headers": "authorization",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(String(res.headers["access-control-allow-methods"])).toContain(method);
    }
  });

  it("shows the secret once and trades in the key's league", async () => {
    const u = await signUp(b);
    const league = (await call(u.token, "POST", "/v1/leagues", { name: "Bot league" })).json();
    const k = await newKey(u, { league: league.id });
    expect(k.key).toMatch(/^tk_[a-z0-9]{10}_/);
    expect(k.key.startsWith(k.prefix + "_")).toBe(true);

    const list = (await call(u.token, "GET", "/v1/keys")).json();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(k.key);

    const order = await call(k.key, "POST", "/v1/orders", {
      symbol: "KILN",
      side: "buy",
      price: 24_00,
      qty: 5,
    });
    expect(order.statusCode, order.body).toBe(201);
    expect(order.json().league).toBe(league.id);
    expect((await call(k.key, "GET", "/v1/positions?league=" + league.id)).statusCode).toBe(200);

    // A key can't reach anything but trading and its own account.
    for (const [m, url] of [
      ["GET", "/v1/leagues"],
      ["GET", "/v1/keys"],
      ["POST", "/v1/keys"],
    ] as const)
      expect((await call(k.key, m, url, m === "POST" ? { name: "x" } : undefined)).statusCode).toBe(
        403,
      );
    // Nor send to another league.
    const other = await call(k.key, "POST", "/v1/orders", {
      symbol: "KILN",
      side: "buy",
      price: 24_00,
      qty: 1,
      league: 1,
    });
    expect(other.statusCode).toBe(403);
  });

  it("keeps a key out of the owner's other leagues when cancelling and reading", async () => {
    const u = await signUp(b);
    const league = (await call(u.token, "POST", "/v1/leagues", { name: "Human league" })).json();
    // The owner's own order in their class league, placed from the browser.
    const human = (
      await call(u.token, "POST", "/v1/orders", {
        symbol: "KILN",
        side: "buy",
        price: 23_00,
        qty: 3,
        league: league.id,
      })
    ).json();
    expect(human.status).toBe("open");
    const k = await newKey(u); // a practice-league key

    expect((await call(k.key, "DELETE", `/v1/orders/${human.id}`)).statusCode).toBe(404);
    expect((await call(k.key, "GET", `/v1/orders/${human.id}`)).statusCode).toBe(404);
    expect((await call(u.token, "GET", `/v1/orders/${human.id}`)).json().status).toBe("open");

    // Lists only show the key's league, and asking for another one is refused.
    expect(await (await call(k.key, "GET", "/v1/orders")).json()).toEqual([]);
    for (const url of ["/v1/orders", "/v1/fills", "/v1/positions", "/v1/positions/analytics"])
      expect((await call(k.key, "GET", `${url}?league=${league.id}`)).statusCode, url).toBe(403);
    const pos = (await call(k.key, "GET", "/v1/positions")).json();
    expect(pos.league).not.toBe(league.id);

    // Its own practice orders it can still read and cancel.
    const own = (
      await call(k.key, "POST", "/v1/orders", { symbol: "KILN", side: "buy", price: 23_00, qty: 1 })
    ).json();
    expect((await call(k.key, "GET", "/v1/orders")).json().map((o: any) => o.id)).toEqual([own.id]);
    expect((await call(k.key, "DELETE", `/v1/orders/${own.id}`)).json().status).toBe("cancelled");
    await call(u.token, "DELETE", `/v1/orders/${human.id}`);
  });

  it("enforces the size cap and the per-key rate", async () => {
    const u = await signUp(b);
    const k = await newKey(u, { maxOrderQty: 50, ordersPerSecond: 2 });
    const send = (qty: number) =>
      call(k.key, "POST", "/v1/orders", { symbol: "KILN", side: "buy", price: 23_00, qty });
    const big = await send(51);
    expect(big.statusCode).toBe(422);
    expect(big.json().error).toBe("size_cap");
    await new Promise((r) => setTimeout(r, 1100)); // refused orders still count toward the rate
    const codes = [
      (await send(1)).statusCode,
      (await send(1)).statusCode,
      (await send(1)).statusCode,
    ];
    expect(codes).toEqual([201, 201, 429]);
  });

  it("rejects bad keys, guests and a sixth key", async () => {
    const u = await signUp(b);
    const k = await newKey(u);
    const tampered = k.key.slice(0, -2) + (k.key.endsWith("AA") ? "BB" : "AA");
    expect((await call(tampered, "GET", "/v1/me")).statusCode).toBe(401);
    expect((await call("tk_nonsense", "GET", "/v1/me")).statusCode).toBe(401);
    expect((await call(k.key, "GET", "/v1/me")).json().id).toBe(u.id);

    for (let i = 0; i < 4; i++) await newKey(u);
    expect((await call(u.token, "POST", "/v1/keys", { name: "six" })).statusCode).toBe(409);

    const g = await b.app.inject({
      method: "POST",
      url: "/v1/auth/guest",
      remoteAddress: "10.4.4.4",
    });
    expect((await call(g.json().accessToken, "POST", "/v1/keys", { name: "g" })).statusCode).toBe(
      403,
    );
  });

  it("revoking a key cancels its orders and locks it out", async () => {
    const u = await signUp(b);
    const k = await newKey(u);
    const placed = await call(k.key, "POST", "/v1/orders", {
      symbol: "KILN",
      side: "buy",
      price: 23_50,
      qty: 3,
    });
    const mine = await call(u.token, "POST", "/v1/orders", {
      symbol: "KILN",
      side: "buy",
      price: 23_50,
      qty: 3,
    });
    expect(await openOrders(u)).toEqual(expect.arrayContaining([placed.json().id, mine.json().id]));

    const res = await call(u.token, "DELETE", `/v1/keys/${k.id}`);
    expect(res.json()).toEqual({ revoked: k.id, cancelled: 1 });
    await b.orders.settled();
    expect(await openOrders(u)).toEqual([mine.json().id]); // the hand-placed order stays
    expect((await call(k.key, "GET", "/v1/me")).statusCode).toBe(401);
    expect((await call(u.token, "DELETE", `/v1/keys/${k.id}`)).statusCode).toBe(404);
  });

  it("the admin kill switch stops every bot and pulls their orders", async () => {
    const admin = await signUp(b);
    await b.db.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);
    const u = await signUp(b);
    const k = await newKey(u);
    const placed = await call(k.key, "POST", "/v1/orders", {
      symbol: "KILN",
      side: "sell",
      price: 26_50,
      qty: 2,
    });
    expect(placed.statusCode).toBe(201);

    const off = await call(admin.token, "PUT", "/v1/admin/bots", { enabled: false });
    expect(off.json()).toMatchObject({ enabled: false });
    expect(off.json().cancelled).toBeGreaterThanOrEqual(1);
    const blocked = await call(k.key, "POST", "/v1/orders", {
      symbol: "KILN",
      side: "sell",
      price: 26_50,
      qty: 2,
    });
    expect(blocked.statusCode).toBe(503);
    // People still trade.
    expect(
      (
        await call(u.token, "POST", "/v1/orders", {
          symbol: "KILN",
          side: "buy",
          price: 23_50,
          qty: 1,
        })
      ).statusCode,
    ).toBe(201);

    await call(admin.token, "PUT", "/v1/admin/bots", { enabled: true });
    expect((await call(k.key, "GET", "/v1/me")).statusCode).toBe(200);
  });
});
