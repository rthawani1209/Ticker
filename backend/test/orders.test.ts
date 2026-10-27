import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as p from "../src/engine/protocol.js";
import { auth, signUp, startBackend, type Backend } from "./harness.js";

let b: Backend;
let alice: Awaited<ReturnType<typeof signUp>>;
let bob: Awaited<ReturnType<typeof signUp>>;

beforeAll(async () => {
  b = await startBackend();
  alice = await signUp(b, "alice");
  bob = await signUp(b, "bob");
});
afterAll(() => b?.stop());

const place = (token: string, payload: object) =>
  b.app.inject({ method: "POST", url: "/v1/orders", headers: auth(token), payload });

describe("orders", () => {
  it("rests a limit order on the book", async () => {
    const res = await place(alice.token, { symbol: "nova", side: "buy", price: 13_900, qty: 10 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ symbol: "NOVA", side: "buy", type: "limit", tif: "gtc", status: "open", leaves: 10 });

    const book = (await b.app.inject({ url: "/v1/market/NOVA" })).json().book;
    expect(book.bids).toContainEqual({ price: 13_900, qty: 10 });
  });

  it("fills two users against each other and records the fills", async () => {
    const sell = await place(alice.token, { symbol: "HELX", side: "sell", price: 5_810, qty: 30 });
    expect(sell.json().status).toBe("open");

    const buy = await place(bob.token, { symbol: "HELX", side: "buy", price: 5_820, qty: 12 });
    expect(buy.statusCode).toBe(201);
    expect(buy.json()).toMatchObject({ status: "filled", filledQty: 12, leaves: 0 });

    await b.orders.settled();
    const aliceOrder = (await b.app.inject({ url: `/v1/orders/${sell.json().id}`, headers: auth(alice.token) })).json();
    expect(aliceOrder).toMatchObject({ status: "partially_filled", filledQty: 12, leaves: 18 });

    const fills = (await b.app.inject({ url: "/v1/fills", headers: auth(bob.token) })).json();
    expect(fills[0]).toMatchObject({ symbol: "HELX", side: "buy", price: 5_810, qty: 12 });

    const trades = (await b.app.inject({ url: "/v1/market/HELX/trades" })).json();
    expect(trades[0]).toMatchObject({ price: 5_810, qty: 12 });
  });

  it("cancels an open order", async () => {
    const o = (await place(alice.token, { symbol: "KILN", side: "sell", price: 2_600, qty: 5 })).json();
    const res = await b.app.inject({ method: "DELETE", url: `/v1/orders/${o.id}`, headers: auth(alice.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "cancelled", leaves: 0 });
    const again = await b.app.inject({ method: "DELETE", url: `/v1/orders/${o.id}`, headers: auth(alice.token) });
    expect(again.statusCode).toBe(409);
  });

  it("does not let users see or cancel each other's orders", async () => {
    const o = (await place(alice.token, { symbol: "KILN", side: "buy", price: 2_400, qty: 5 })).json();
    expect((await b.app.inject({ url: `/v1/orders/${o.id}`, headers: auth(bob.token) })).statusCode).toBe(404);
    expect((await b.app.inject({ method: "DELETE", url: `/v1/orders/${o.id}`, headers: auth(bob.token) })).statusCode).toBe(404);
  });

  it("returns the exchange's reject reason", async () => {
    const res = await place(alice.token, { symbol: "VYNE", side: "buy", price: 20_000, qty: 5 }); // way outside the band
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ status: "rejected", rejectReason: "price_band" });
  });

  it("market orders default to IOC and cancel what doesn't fill", async () => {
    await place(bob.token, { symbol: "MESA", side: "sell", price: 18_810, qty: 4 });
    const res = await place(alice.token, { symbol: "MESA", side: "buy", type: "market", qty: 10 });
    expect(res.json()).toMatchObject({ tif: "ioc", status: "cancelled", filledQty: 4, rejectReason: "unfilled" });
  });

  it("validates input", async () => {
    const cases = [
      { symbol: "NOVA", side: "buy", qty: 10 }, // limit without a price
      { symbol: "NOVA", side: "buy", type: "market", price: 100, qty: 10 }, // market with a price
      { symbol: "NOVA", side: "hold", price: 100, qty: 10 },
      { symbol: "NOVA", side: "buy", price: 100, qty: -1 },
      { symbol: "NOVA", side: "buy", price: 1.5, qty: 1 },
    ];
    for (const payload of cases) expect((await place(alice.token, payload)).statusCode).toBe(400);
    expect((await place(alice.token, { symbol: "ZZZZ", side: "buy", price: 100, qty: 1 })).statusCode).toBe(422);
  });

  it("needs a login", async () => {
    const res = await b.app.inject({ method: "POST", url: "/v1/orders", payload: { symbol: "NOVA", side: "buy", price: 1, qty: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it("lists open orders newest first", async () => {
    const open = (await b.app.inject({ url: "/v1/orders?open=true", headers: auth(alice.token) })).json();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((o: any) => ["open", "partially_filled"].includes(o.status))).toBe(true);
    expect(open.map((o: any) => o.id)).toEqual([...open.map((o: any) => o.id)].sort((x: number, y: number) => y - x));
  });

  it("rate limits order entry per user", async () => {
    const carol = await signUp(b, "carol");
    // One after another: the in-memory store (used when there's no Redis) hands every
    // concurrent request the same counter object, so a parallel burst all reads as over.
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await place(carol.token, { symbol: "QSTR", side: "buy", price: 1_150, qty: 1 })).statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(20);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
  });

  it("reports health", async () => {
    const res = await b.app.inject({ url: "/health" });
    expect(res.json()).toEqual({ ok: true, db: true, engine: true });
  });
});

describe("engine events", () => {
  const fillEvent = (o: { engineOrderId: number; id: number; account: number }, tradeId: number, qty: number, leaves: number) => ({
    kind: "event", type: p.EventType.Fill, side: p.Side.Sell, reason: 0, symbol: 4, session: 1, account: o.account,
    orderId: o.engineOrderId, clOrdId: o.id, price: 9_750, qty, leaves, tradeId, levelQty: 0,
  });

  it("records a repeated fill only once", async () => {
    const order = (await place(alice.token, { symbol: "VYNE", side: "sell", price: 9_750, qty: 10 })).json();
    const { rows } = await b.db.query("SELECT engine_order_id FROM orders WHERE id = $1", [order.id]);
    const ev = fillEvent({ engineOrderId: rows[0].engine_order_id, id: order.id, account: alice.portfolio }, 990_001, 4, 6);
    b.bridge.emit("private", ev);
    b.bridge.emit("private", ev); // the same event again
    await b.orders.settled();

    const after = (await b.app.inject({ url: `/v1/orders/${order.id}`, headers: auth(alice.token) })).json();
    expect(after).toMatchObject({ filledQty: 4, leaves: 6, status: "partially_filled" });
    const fills = await b.db.query("SELECT count(*)::int AS n FROM fills WHERE order_id = $1", [order.id]);
    expect(fills.rows[0].n).toBe(1);
  });

  it("gives up on pending orders after a reconnect, and picks them up again if they trade", async () => {
    // An order the engine never acknowledged (as if the connection dropped right after sending).
    const { rows } = await b.db.query(
      `INSERT INTO orders (user_id, portfolio_id, symbol_id, side, type, tif, price, qty, leaves, created_at)
       VALUES ($1, $2, 4, 'sell', 'limit', 'gtc', 9750, 10, 10, now() - interval '1 minute') RETURNING id`,
      [alice.id, alice.portfolio],
    );
    const id = rows[0].id;

    const reconnected = new Promise((resolve) => b.bridge.once("up", resolve));
    (b.bridge as any).socket.destroy();
    await reconnected;
    await b.orders.settled();
    const lost = (await b.app.inject({ url: `/v1/orders/${id}`, headers: auth(alice.token) })).json();
    expect(lost).toMatchObject({ status: "rejected", rejectReason: "exchange_unavailable" });

    // Turns out the engine did take it: its first fill finds the order by cl_ord_id.
    b.bridge.emit("private", fillEvent({ engineOrderId: 5 * 2 ** 40 + 777, id, account: alice.portfolio }, 990_002, 3, 7));
    await b.orders.settled();
    const back = (await b.app.inject({ url: `/v1/orders/${id}`, headers: auth(alice.token) })).json();
    expect(back).toMatchObject({ status: "partially_filled", filledQty: 3, leaves: 7, rejectReason: null });
  });
});
