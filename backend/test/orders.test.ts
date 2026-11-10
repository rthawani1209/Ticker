import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EngineBridge } from "../src/engine/bridge.js";
import * as p from "../src/engine/protocol.js";
import { auth, signUp, startBackend, TOKEN, type Backend } from "./harness.js";

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
  it("turns orders away with 503 while the event queue is backed up", async () => {
    const orders = b.orders as unknown as {
      maxBacklog: number;
      enqueue(task: () => Promise<void>): void;
    };
    const saved = orders.maxBacklog;
    orders.maxBacklog = 2;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    for (let i = 0; i < 3; i++) orders.enqueue(() => held);
    try {
      const res = await place(alice.token, { symbol: "NOVA", side: "buy", price: 13_000, qty: 1 });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("busy");
    } finally {
      release();
      orders.maxBacklog = saved;
      await b.orders.settled();
    }
    const ok = await place(alice.token, { symbol: "NOVA", side: "buy", price: 13_000, qty: 1 });
    expect(ok.statusCode).toBe(201);
  });

  it("rests a limit order on the book", async () => {
    const res = await place(alice.token, { symbol: "nova", side: "buy", price: 13_900, qty: 10 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      symbol: "NOVA",
      side: "buy",
      type: "limit",
      tif: "gtc",
      status: "open",
      leaves: 10,
    });

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
    const aliceOrder = (
      await b.app.inject({ url: `/v1/orders/${sell.json().id}`, headers: auth(alice.token) })
    ).json();
    expect(aliceOrder).toMatchObject({ status: "partially_filled", filledQty: 12, leaves: 18 });

    const fills = (await b.app.inject({ url: "/v1/fills", headers: auth(bob.token) })).json();
    expect(fills[0]).toMatchObject({ symbol: "HELX", side: "buy", price: 5_810, qty: 12 });

    const trades = (await b.app.inject({ url: "/v1/market/HELX/trades" })).json();
    expect(trades[0]).toMatchObject({ price: 5_810, qty: 12 });

    const { seconds, candles } = (await b.app.inject({ url: "/v1/market/HELX/candles" })).json();
    expect(seconds).toBe(15);
    expect(candles.at(-1)).toMatchObject({ close: 5_810, low: 5_810 });
    expect(candles.at(-1).volume).toBeGreaterThanOrEqual(12);
  });

  it("cancels an open order", async () => {
    const o = (
      await place(alice.token, { symbol: "KILN", side: "sell", price: 2_600, qty: 5 })
    ).json();
    const res = await b.app.inject({
      method: "DELETE",
      url: `/v1/orders/${o.id}`,
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "cancelled", leaves: 0 });
    const again = await b.app.inject({
      method: "DELETE",
      url: `/v1/orders/${o.id}`,
      headers: auth(alice.token),
    });
    expect(again.statusCode).toBe(409);
  });

  it("does not let users see or cancel each other's orders", async () => {
    const o = (
      await place(alice.token, { symbol: "KILN", side: "buy", price: 2_400, qty: 5 })
    ).json();
    expect(
      (await b.app.inject({ url: `/v1/orders/${o.id}`, headers: auth(bob.token) })).statusCode,
    ).toBe(404);
    expect(
      (
        await b.app.inject({
          method: "DELETE",
          url: `/v1/orders/${o.id}`,
          headers: auth(bob.token),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("returns the exchange's reject reason", async () => {
    const res = await place(alice.token, { symbol: "VYNE", side: "buy", price: 20_000, qty: 5 }); // way outside the band
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ status: "rejected", rejectReason: "price_band" });
  });

  it("lets prices rally well past $655 and says where the ceiling is", async () => {
    // $700 for ORBT is a band reject now, not an engine "invalid price".
    const high = await place(alice.token, { symbol: "ORBT", side: "buy", price: 70_000, qty: 1 });
    expect(high.json()).toMatchObject({ rejectReason: "price_band" });
    const over = await place(alice.token, { symbol: "ORBT", side: "buy", price: 250_000, qty: 1 });
    expect(over.statusCode).toBe(422);
    expect(over.json()).toEqual({
      error: "invalid_price",
      message: "ORBT prices must be below $2480.00",
    });
  });

  it("holds a stop-limit until the stop trades, then works it as a limit", async () => {
    const dave = await signUp(b, "dave");
    const sl = (
      await place(alice.token, {
        symbol: "VYNE",
        side: "buy",
        type: "stop_limit",
        stopPrice: 98_00,
        price: 98_50,
        qty: 5,
      })
    ).json();
    expect(sl).toMatchObject({
      type: "stop_limit",
      status: "open",
      stopPrice: 98_00,
      price: 98_50,
    });

    // An ask below the limit doesn't fill it while the stop is waiting.
    await place(bob.token, { symbol: "VYNE", side: "sell", price: 98_40, qty: 5 });
    await b.orders.settled();
    const get = async () =>
      (await b.app.inject({ url: `/v1/orders/${sl.id}`, headers: auth(alice.token) })).json();
    expect((await get()).filledQty).toBe(0);

    // A trade at 98.00 sets it off; it then buys the 98.40 ask.
    await place(bob.token, { symbol: "VYNE", side: "sell", price: 98_00, qty: 1 });
    await place(dave.token, { symbol: "VYNE", side: "buy", price: 98_00, qty: 1, tif: "ioc" });
    await b.orders.settled();
    expect(await get()).toMatchObject({ status: "filled", filledQty: 5 });
  });

  it("amends a resting order's price and size", async () => {
    const patch = (id: number, payload: object, token = alice.token) =>
      b.app.inject({ method: "PATCH", url: `/v1/orders/${id}`, headers: auth(token), payload });
    const bid = (
      await place(alice.token, { symbol: "HELX", side: "buy", price: 56_00, qty: 10 })
    ).json();

    // Smaller at the same price: the engine shrinks it in place.
    const smaller = await patch(bid.id, { qty: 6 });
    expect(smaller.statusCode, smaller.body).toBe(200);
    expect(smaller.json()).toMatchObject({ status: "open", qty: 6, leaves: 6, price: 56_00 });

    // A new price that crosses an ask trades straight away.
    await place(bob.token, { symbol: "HELX", side: "sell", price: 57_00, qty: 4 });
    const up = await patch(bid.id, { price: 57_00 });
    expect(up.json()).toMatchObject({ status: "partially_filled", filledQty: 4, leaves: 2 });

    // Bigger: the size counts what's filled plus the new open amount.
    const bigger = await patch(bid.id, { qty: 8 });
    expect(bigger.json()).toMatchObject({ qty: 12, filledQty: 4, leaves: 8 });

    // Same checks as a new order, and not someone else's.
    expect((await patch(bid.id, { qty: 90_000 })).json().error).toBe("insufficient_funds");
    expect((await patch(bid.id, { qty: 1 }, bob.token)).statusCode).toBe(404);
    expect((await patch(bid.id, {})).statusCode).toBe(400);
    expect((await patch(bid.id, { price: 20_00 })).json()).toMatchObject({
      error: "replace_rejected",
      message: "price band",
    });

    await b.app.inject({
      method: "DELETE",
      url: `/v1/orders/${bid.id}`,
      headers: auth(alice.token),
    });
    expect((await patch(bid.id, { qty: 1 })).json().error).toBe("not_open");
  });

  it("won't let an amend that races a fill go past a position limit", async () => {
    const league = (
      await b.app.inject({
        method: "POST",
        url: "/v1/leagues",
        headers: auth(alice.token),
        payload: { name: "Max 100", maxPosition: 100 },
      })
    ).json();
    const bid = (
      await place(alice.token, {
        symbol: "ORBT",
        side: "buy",
        price: 309_00,
        qty: 100,
        league: league.id,
      })
    ).json();
    expect(bid.status).toBe("open");
    const { rows } = await b.db.query("SELECT symbol_id FROM orders WHERE id = $1", [bid.id]);

    // The gateway has checked the amend against 100 open; 60 fill before the engine sees it.
    const sim = new EngineBridge({
      host: "127.0.0.1",
      port: b.engine.port,
      token: TOKEN,
      refPrices: b.bridge.books.map(() => 100),
      replay: false,
    });
    await sim.start();
    const bridge = b.bridge as any;
    const replace = bridge.replace.bind(bridge);
    bridge.replace = async (...args: unknown[]) => {
      await sim.submit({
        account: 899_005,
        clOrdId: 1,
        symbol: rows[0].symbol_id,
        side: p.Side.Sell,
        ordType: p.OrdType.Limit,
        tif: p.TIF.IOC,
        price: 309_00,
        stopPrice: 0,
        qty: 60,
      });
      return replace(...args);
    };
    const res = await b.app.inject({
      method: "PATCH",
      url: `/v1/orders/${bid.id}`,
      headers: auth(alice.token),
      payload: { qty: 100 },
    });
    bridge.replace = replace;
    sim.stop();
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("order_changed");

    await b.orders.settled();
    const after = (
      await b.app.inject({
        url: `/v1/orders/${bid.id}?league=${league.id}`,
        headers: auth(alice.token),
      })
    ).json();
    expect(after).toMatchObject({ qty: 100, filledQty: 60, leaves: 40 });
    await b.app.inject({
      method: "DELETE",
      url: `/v1/orders/${bid.id}`,
      headers: auth(alice.token),
    });
  });

  it("doesn't flag an order that two cancels race on, or that fills while being amended", async () => {
    const flag = async (id: number) =>
      (await b.db.query("SELECT reject_reason FROM orders WHERE id = $1", [id])).rows[0]
        .reject_reason;
    const bid = (
      await place(bob.token, { symbol: "KILN", side: "buy", price: 23_10, qty: 4 })
    ).json();
    const del = () =>
      b.app.inject({ method: "DELETE", url: `/v1/orders/${bid.id}`, headers: auth(bob.token) });
    const both = await Promise.all([del(), del()]);
    for (const r of both) expect(r.json().status, r.body).toBe("cancelled");
    expect(await flag(bid.id)).toBeNull();

    // An amend whose order fills completely just before the engine sees it.
    const bid2 = (
      await place(bob.token, { symbol: "KILN", side: "buy", price: 25_90, qty: 4 })
    ).json();
    expect(bid2.status, JSON.stringify(bid2)).toBe("open");
    const bridge = b.bridge as any;
    const replace = bridge.replace.bind(bridge);
    bridge.replace = async (...args: unknown[]) => {
      await place(alice.token, { symbol: "KILN", side: "sell", price: 25_90, qty: 4, tif: "ioc" });
      return replace(...args);
    };
    const res = await b.app.inject({
      method: "PATCH",
      url: `/v1/orders/${bid2.id}`,
      headers: auth(bob.token),
      payload: { qty: 2 },
    });
    bridge.replace = replace;
    expect(res.json().error, res.body).toBe("not_open");
    expect(await flag(bid2.id)).toBeNull();
    await new Promise((r) => setTimeout(r, 1100)); // let the orders-per-second limits reset
  });

  it("market orders default to IOC and cancel what doesn't fill", async () => {
    await place(bob.token, { symbol: "MESA", side: "sell", price: 18_810, qty: 4 });
    const res = await place(alice.token, { symbol: "MESA", side: "buy", type: "market", qty: 10 });
    expect(res.json()).toMatchObject({
      tif: "ioc",
      status: "cancelled",
      filledQty: 4,
      rejectReason: "unfilled",
    });
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
    expect(
      (await place(alice.token, { symbol: "ZZZZ", side: "buy", price: 100, qty: 1 })).statusCode,
    ).toBe(422);
  });

  it("needs a login", async () => {
    const res = await b.app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: { symbol: "NOVA", side: "buy", price: 1, qty: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("lists open orders newest first", async () => {
    const open = (
      await b.app.inject({ url: "/v1/orders?open=true", headers: auth(alice.token) })
    ).json();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((o: any) => ["open", "partially_filled"].includes(o.status))).toBe(true);
    expect(open.map((o: any) => o.id)).toEqual(
      [...open.map((o: any) => o.id)].sort((x: number, y: number) => y - x),
    );
  });

  it("rate limits order entry per user", async () => {
    const carol = await signUp(b, "carol");
    // One after another: the in-memory store (used when there's no Redis) hands every
    // concurrent request the same counter object, so a parallel burst all reads as over.
    const codes: number[] = [];
    for (let i = 0; i < 25; i++)
      codes.push(
        (await place(carol.token, { symbol: "QSTR", side: "buy", price: 1_150, qty: 1 }))
          .statusCode,
      );
    expect(codes.filter((c) => c === 201)).toHaveLength(20);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
  });

  it("reports health", async () => {
    const res = await b.app.inject({ url: "/health" });
    expect(res.json()).toEqual({ ok: true, db: true, engine: true });
  });
});

describe("engine events", () => {
  const fillEvent = (
    o: { engineOrderId: number; id: number; account: number },
    tradeId: number,
    qty: number,
    leaves: number,
  ) => ({
    kind: "event",
    type: p.EventType.Fill,
    side: p.Side.Sell,
    reason: 0,
    symbol: 4,
    session: 1,
    account: o.account,
    orderId: o.engineOrderId,
    clOrdId: o.id,
    price: 9_750,
    qty,
    leaves,
    tradeId,
    levelQty: 0,
  });

  it("flags an order the exchange says it lost events for, and keeps the flag", async () => {
    const engineOrderId = 7 * 2 ** 40 + 888_888;
    const { rows } = await b.db.query(
      `INSERT INTO orders (user_id, portfolio_id, symbol_id, side, type, tif, price, qty, leaves, status, engine_order_id)
       VALUES ($1, $2, 7, 'buy', 'limit', 'gtc', 18000, 5, 5, 'open', $3) RETURNING id`,
      [alice.id, alice.portfolio, engineOrderId],
    );
    const id = rows[0].id;
    const o = { engineOrderId, id, account: alice.portfolio };
    b.bridge.emit("private", { ...fillEvent(o, 0, 0, 0), type: p.EventType.Lost, symbol: 7 });
    await b.orders.settled();
    const get = async () =>
      (await b.app.inject({ url: `/v1/orders/${id}`, headers: auth(alice.token) })).json();
    expect(await get()).toMatchObject({ status: "open", rejectReason: "out_of_sync" });

    // A later fill still books, and the order stays flagged for a person to check.
    b.bridge.emit("private", { ...fillEvent(o, 990_777, 2, 3), symbol: 7, price: 18_000 });
    await b.orders.settled();
    expect(await get()).toMatchObject({
      status: "partially_filled",
      filledQty: 2,
      rejectReason: "out_of_sync",
    });
    const audit = await b.db.query(
      "SELECT 1 FROM audit_log WHERE action = 'order_out_of_sync' AND detail->>'orderId' = $1",
      [String(id)],
    );
    expect(audit.rows).toHaveLength(1);

    // Cancelling doesn't clear it either.
    b.bridge.emit("private", { ...fillEvent(o, 0, 0, 0), type: p.EventType.Cancelled, symbol: 7 });
    await b.orders.settled();
    expect(await get()).toMatchObject({ status: "cancelled", rejectReason: "out_of_sync" });
  });

  it("flags a finished order the exchange says it lost events for", async () => {
    const engineOrderId = 7 * 2 ** 40 + 888_889;
    const { rows } = await b.db.query(
      `INSERT INTO orders (user_id, portfolio_id, symbol_id, side, type, tif, price, qty, leaves, filled_qty, status, engine_order_id)
       VALUES ($1, $2, 7, 'buy', 'limit', 'gtc', 18000, 5, 0, 3, 'filled', $3) RETURNING id`,
      [alice.id, alice.portfolio, engineOrderId],
    );
    const o = { engineOrderId, id: rows[0].id, account: alice.portfolio };
    b.bridge.emit("private", { ...fillEvent(o, 0, 0, 0), type: p.EventType.Lost, symbol: 7 });
    await b.orders.settled();
    const r = await b.db.query("SELECT status, reject_reason FROM orders WHERE id = $1", [o.id]);
    expect(r.rows[0]).toEqual({ status: "filled", reject_reason: "out_of_sync" });
  });

  it("flags open orders the exchange no longer has, or has less of, after a reconnect", async () => {
    const real = (
      await place(alice.token, { symbol: "HELX", side: "buy", price: 56_10, qty: 3 })
    ).json();
    const { rows } = await b.db.query(
      `INSERT INTO orders (user_id, portfolio_id, symbol_id, side, type, tif, price, qty, leaves, status, engine_order_id)
       VALUES ($1, $2, 7, 'buy', 'limit', 'gtc', 18000, 5, 5, 'open', $3) RETURNING id`,
      [alice.id, alice.portfolio, 7 * 2 ** 40 + 777_777],
    );
    const ghost = rows[0].id;
    // The ledger missed 2 shares of the real order filling.
    await b.db.query("UPDATE orders SET leaves = 5, qty = 5 WHERE id = $1", [real.id]);

    expect(await b.orders.checkOpenOrders(10)).toBe(2);
    const flags = await b.db.query(
      "SELECT id, status, reject_reason FROM orders WHERE id = ANY($1) ORDER BY id",
      [[real.id, ghost]],
    );
    expect(flags.rows.map((r) => r.reject_reason)).toEqual(["out_of_sync", "out_of_sync"]);
    expect(flags.rows.map((r) => r.status)).toEqual(["open", "open"]);
    // An order that matches is left alone.
    const fine = (
      await place(alice.token, { symbol: "HELX", side: "buy", price: 56_10, qty: 2 })
    ).json();
    expect(await b.orders.checkOpenOrders(10)).toBe(0);
    for (const id of [real.id, fine.id])
      await b.app.inject({ method: "DELETE", url: `/v1/orders/${id}`, headers: auth(alice.token) });
    await b.db.query("UPDATE orders SET status = 'cancelled', leaves = 0 WHERE id = $1", [ghost]);
    await new Promise((r) => setTimeout(r, 1100)); // let alice's orders-per-second limit reset
  });

  it("records a repeated fill only once", async () => {
    const order = (
      await place(alice.token, { symbol: "VYNE", side: "sell", price: 9_750, qty: 10 })
    ).json();
    const { rows } = await b.db.query("SELECT engine_order_id FROM orders WHERE id = $1", [
      order.id,
    ]);
    const ev = fillEvent(
      { engineOrderId: rows[0].engine_order_id, id: order.id, account: alice.portfolio },
      990_001,
      4,
      6,
    );
    b.bridge.emit("private", ev);
    b.bridge.emit("private", ev); // the same event again
    await b.orders.settled();

    const after = (
      await b.app.inject({ url: `/v1/orders/${order.id}`, headers: auth(alice.token) })
    ).json();
    expect(after).toMatchObject({ filledQty: 4, leaves: 6, status: "partially_filled" });
    const fills = await b.db.query("SELECT count(*)::int AS n FROM fills WHERE order_id = $1", [
      order.id,
    ]);
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
    const lost = (
      await b.app.inject({ url: `/v1/orders/${id}`, headers: auth(alice.token) })
    ).json();
    expect(lost).toMatchObject({ status: "rejected", rejectReason: "exchange_unavailable" });

    // Turns out the engine did take it: its first fill finds the order by cl_ord_id.
    b.bridge.emit(
      "private",
      fillEvent({ engineOrderId: 5 * 2 ** 40 + 777, id, account: alice.portfolio }, 990_002, 3, 7),
    );
    await b.orders.settled();
    const back = (
      await b.app.inject({ url: `/v1/orders/${id}`, headers: auth(alice.token) })
    ).json();
    expect(back).toMatchObject({
      status: "partially_filled",
      filledQty: 3,
      leaves: 7,
      rejectReason: null,
    });
  });

  it("keeps resting orders working after the gateway reconnects", async () => {
    const bid = (
      await place(alice.token, { symbol: "MESA", side: "buy", price: 18_700, qty: 7 })
    ).json();
    expect(bid.status, JSON.stringify(bid)).toBe("open");

    // A new engine session: the bid was placed by the old one.
    const reconnected = new Promise((resolve) => b.bridge.once("up", resolve));
    (b.bridge as any).socket.destroy();
    await reconnected;
    await b.orders.settled();

    const sold = await place(bob.token, {
      symbol: "MESA",
      side: "sell",
      price: 18_700,
      qty: 7,
      tif: "ioc",
    });
    expect(sold.json().status).toBe("filled");
    await b.orders.settled();
    const after = (
      await b.app.inject({ url: `/v1/orders/${bid.id}`, headers: auth(alice.token) })
    ).json();
    expect(after).toMatchObject({ status: "filled", filledQty: 7 });
    const positions = (
      await b.app.inject({ url: "/v1/positions", headers: auth(alice.token) })
    ).json();
    expect(JSON.stringify(positions)).toContain("MESA");
  });

  it("lists only practice orders and fills unless a league is asked for", async () => {
    const league = (
      await b.app.inject({
        method: "POST",
        url: "/v1/leagues",
        headers: auth(bob.token),
        payload: { name: "Lists" },
      })
    ).json();
    const inLeague = (
      await place(bob.token, {
        symbol: "QSTR",
        side: "buy",
        price: 11_00,
        qty: 3,
        league: league.id,
      })
    ).json();
    const inPractice = (
      await place(bob.token, { symbol: "QSTR", side: "buy", price: 11_00, qty: 2 })
    ).json();
    const ids = async (url: string) =>
      ((await b.app.inject({ url, headers: auth(bob.token) })).json() as any[]).map((o) => o.id);
    expect(await ids("/v1/orders?open=true")).toContain(inPractice.id);
    expect(await ids("/v1/orders?open=true")).not.toContain(inLeague.id);
    expect(await ids(`/v1/orders?open=true&league=${league.id}`)).toEqual([inLeague.id]);
    expect(await ids(`/v1/fills?league=${league.id}`)).toEqual([]);
    for (const id of [inLeague.id, inPractice.id])
      await b.app.inject({ method: "DELETE", url: `/v1/orders/${id}`, headers: auth(bob.token) });
  });

  it("books a fill that happened while the only gateway was down", async () => {
    const bid = (
      await place(alice.token, { symbol: "MESA", side: "buy", price: 18_650, qty: 7 })
    ).json();
    expect(bid.status).toBe("open");
    const { rows } = await b.db.query("SELECT symbol_id FROM orders WHERE id = $1", [bid.id]);
    const cashBefore = (
      await b.db.query("SELECT cash FROM portfolios WHERE id = $1", [alice.portfolio])
    ).rows[0].cash;

    // The gateway goes away for a deploy. The simulator is still connected and sells.
    const down = new Promise((resolve) => b.bridge.once("down", resolve));
    b.bridge.stop();
    await down;
    await new Promise((r) => setTimeout(r, 50));
    const sim = new EngineBridge({
      host: "127.0.0.1",
      port: b.engine.port,
      token: TOKEN,
      refPrices: b.bridge.books.map(() => 100),
      replay: false, // like the Python simulator
    });
    await sim.start();
    const sold = await sim.submit({
      account: 899_001,
      clOrdId: 1,
      symbol: rows[0].symbol_id,
      side: p.Side.Sell,
      ordType: p.OrdType.Limit,
      tif: p.TIF.IOC,
      price: 18_650,
      stopPrice: 0,
      qty: 7,
    });
    expect(sold?.type).toBe(p.EventType.Ack);
    await new Promise((r) => setTimeout(r, 50));
    sim.stop();

    // Back up: the exchange sends the fill it couldn't deliver.
    const up = new Promise((resolve) => b.bridge.once("up", resolve));
    await b.bridge.start();
    await up;
    for (let i = 0; i < 20; i++) {
      await b.orders.settled();
      const o = (
        await b.app.inject({ url: `/v1/orders/${bid.id}`, headers: auth(alice.token) })
      ).json();
      if (o.status === "filled") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const after = (
      await b.app.inject({ url: `/v1/orders/${bid.id}`, headers: auth(alice.token) })
    ).json();
    expect(after).toMatchObject({ status: "filled", filledQty: 7, leaves: 0 });
    const cashAfter = (
      await b.db.query("SELECT cash FROM portfolios WHERE id = $1", [alice.portfolio])
    ).rows[0].cash;
    expect(Number(cashBefore) - Number(cashAfter)).toBeGreaterThanOrEqual(7 * 18_650);
    const fills = await b.db.query("SELECT count(*)::int AS n FROM fills WHERE order_id = $1", [
      bid.id,
    ]);
    expect(fills.rows[0].n).toBe(1);
  });

  it("won't call an order cancelled when the exchange doesn't know it", async () => {
    const { rows } = await b.db.query(
      `INSERT INTO orders (user_id, portfolio_id, symbol_id, side, type, tif, price, qty, leaves, status, engine_order_id)
       VALUES ($1, $2, 7, 'buy', 'limit', 'gtc', 18000, 5, 5, 'open', $3) RETURNING id`,
      [alice.id, alice.portfolio, 7 * 2 ** 40 + 999_999],
    );
    const res = await b.app.inject({
      method: "DELETE",
      url: `/v1/orders/${rows[0].id}`,
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("out_of_sync");
    const still = await b.db.query("SELECT status, reject_reason FROM orders WHERE id = $1", [
      rows[0].id,
    ]);
    expect(still.rows[0]).toEqual({ status: "open", reject_reason: "out_of_sync" });
    const audited = await b.db.query(
      "SELECT detail->>'why' AS why FROM audit_log WHERE action = 'order_out_of_sync' AND detail->>'orderId' = $1",
      [String(rows[0].id)],
    );
    expect(audited.rows).toEqual([{ why: "cancel" }]);
    await b.db.query("UPDATE orders SET status = 'cancelled', leaves = 0 WHERE id = $1", [
      rows[0].id,
    ]);
  });
});
