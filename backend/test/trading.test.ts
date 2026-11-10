// Guest accounts, trading over the WebSocket, and bracket orders.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { OrderService } from "../src/orders.js";
import { auth, signUp, startBackend, type Backend } from "./harness.js";

let b: Backend;
let url: string;

beforeAll(async () => {
  b = await startBackend();
  await b.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = b.app.server.address() as { port: number };
  url = `ws://127.0.0.1:${addr.port}/ws`;
});
afterAll(() => b?.stop());

const place = (token: string, payload: object) =>
  b.app.inject({ method: "POST", url: "/v1/orders", headers: auth(token), payload });

async function openOrders(token: string) {
  const res = await b.app.inject({ url: "/v1/orders?open=true", headers: auth(token) });
  return res.json() as any[];
}

// Polls until check() returns something truthy (bracket exits go out just after the fill).
async function until<T>(check: () => Promise<T>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("guest accounts", () => {
  it("gets a practice portfolio and a session without signing up", async () => {
    const res = await b.app.inject({ method: "POST", url: "/v1/auth/guest" });
    expect(res.statusCode).toBe(201);
    const { accessToken, user } = res.json();
    expect(user.role).toBe("guest");
    expect(user.username).toMatch(/^guest_[0-9a-f]{10}$/);
    expect(res.cookies.some((c) => c.name === "ticker_rt")).toBe(true);

    const positions = await b.app.inject({ url: "/v1/positions", headers: auth(accessToken) });
    expect(positions.statusCode).toBe(200);
    expect(positions.json().cash).toBe(10_000_000);

    const order = await place(accessToken, { symbol: "KILN", side: "buy", price: 24_00, qty: 5 });
    expect(order.statusCode).toBe(201);
  });

  it("can't create or join a league", async () => {
    const { accessToken } = (await b.app.inject({ method: "POST", url: "/v1/auth/guest" })).json();
    const create = await b.app.inject({
      method: "POST",
      url: "/v1/leagues",
      headers: auth(accessToken),
      payload: { name: "Guest league", startingCash: 1_000_000 },
    });
    expect(create.statusCode).toBe(403);
    const join = await b.app.inject({
      method: "POST",
      url: "/v1/leagues/join",
      headers: auth(accessToken),
      payload: { code: "ABCDEFGH" },
    });
    expect(join.statusCode).toBe(403);
  });
});

describe("orders over the websocket", () => {
  function connect(token?: string) {
    const ws = new WebSocket(token ? `${url}?token=${token}` : url);
    const replies = new Map<string, (m: any) => void>();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const ref = msg.data?.ref;
      if (ref && replies.has(ref)) replies.get(ref)!(msg);
    });
    let n = 0;
    const request = (msg: object) =>
      new Promise<any>((resolve, reject) => {
        const ref = `r${++n}`;
        replies.set(ref, resolve);
        setTimeout(() => reject(new Error(`no reply to ${ref}`)), 3000);
        ws.send(JSON.stringify({ ...msg, ref }));
      });
    return new Promise<{ ws: WebSocket; request: typeof request }>((resolve) =>
      ws.on("open", () => resolve({ ws, request })),
    );
  }

  it("places and cancels with the same rules as REST", async () => {
    const alice = await signUp(b);
    const { ws, request } = await connect(alice.token);

    const placed = await request({
      op: "order",
      order: { symbol: "VYNE", side: "buy", price: 95_00, qty: 4 },
    });
    expect(placed.channel).toBe("order");
    expect(placed.data.order).toMatchObject({ symbol: "VYNE", status: "open", leaves: 4 });

    const cancelled = await request({ op: "cancel", id: placed.data.order.id });
    expect(cancelled.channel).toBe("cancel");
    expect(cancelled.data.order.status).toBe("cancelled");

    // the same checks as POST /v1/orders: bad input and buying power
    const bad = await request({ op: "order", order: { symbol: "VYNE", side: "buy", qty: 4 } });
    expect(bad).toMatchObject({ channel: "error", data: { error: "bad_request" } });
    const tooBig = await request({
      op: "order",
      order: { symbol: "VYNE", side: "buy", price: 95_00, qty: 2000 },
    });
    expect(tooBig).toMatchObject({ channel: "error", data: { error: "insufficient_funds" } });
    ws.close();
  });

  it("refuses to trade before auth", async () => {
    const { ws, request } = await connect();
    const res = await request({
      op: "order",
      order: { symbol: "VYNE", side: "buy", price: 95_00, qty: 1 },
    });
    expect(res).toMatchObject({ channel: "error", data: { error: "unauthorized" } });
    ws.close();
  });
});

describe("bracket orders", () => {
  it("rejects exits on the wrong side of each other", async () => {
    const alice = await signUp(b);
    const res = await place(alice.token, {
      symbol: "MESA",
      side: "buy",
      price: 188_00,
      qty: 10,
      takeProfit: 185_00,
      stopLoss: 190_00,
    });
    expect(res.statusCode).toBe(400);
  });

  it("sends both exits after the entry fills, and the first exit to fill cancels the other", async () => {
    const [alice, seller, buyer] = [await signUp(b), await signUp(b), await signUp(b)];
    await place(seller.token, { symbol: "MESA", side: "sell", price: 188_00, qty: 10 });

    const entry = await place(alice.token, {
      symbol: "MESA",
      side: "buy",
      price: 188_00,
      qty: 10,
      takeProfit: 190_00,
      stopLoss: 186_00,
    });
    expect(entry.json()).toMatchObject({ status: "filled", takeProfit: 190_00, stopLoss: 186_00 });

    const exits = await until(async () => {
      const open = (await openOrders(alice.token)).filter((o) => o.parentId === entry.json().id);
      return open.length === 2 ? open : null;
    });
    expect(exits).not.toBeNull();
    const tp = exits!.find((o) => o.type === "limit")!;
    const sl = exits!.find((o) => o.type === "stop")!;
    expect(tp).toMatchObject({ side: "sell", price: 190_00, qty: 10 });
    expect(sl).toMatchObject({ side: "sell", stopPrice: 186_00, qty: 10 });

    // Someone lifts the take-profit: the stop-loss goes away.
    const lift = await place(buyer.token, { symbol: "MESA", side: "buy", price: 190_00, qty: 10 });
    expect(lift.json().status).toBe("filled");
    const slAfter = await until(async () => {
      const o = (
        await b.app.inject({ url: `/v1/orders/${sl.id}`, headers: auth(alice.token) })
      ).json();
      return o.status === "cancelled" ? o : null;
    });
    expect(slAfter?.status).toBe("cancelled");
    const tpAfter = (
      await b.app.inject({ url: `/v1/orders/${tp.id}`, headers: auth(alice.token) })
    ).json();
    expect(tpAfter.status).toBe("filled");
  });

  it("counts a bracket's two exits once when checking a new sell", async () => {
    const [alice, seller] = [await signUp(b), await signUp(b)];
    await place(seller.token, { symbol: "HELX", side: "sell", price: 58_00, qty: 100 });
    const entry = await place(alice.token, {
      symbol: "HELX",
      side: "buy",
      price: 58_00,
      qty: 100,
      takeProfit: 62_00,
      stopLoss: 55_00,
    });
    await until(async () => {
      const open = (await openOrders(alice.token)).filter((o) => o.parentId === entry.json().id);
      return open.length === 2;
    });
    // 100 shares held, 100 promised to the exits (once, not twice), so selling 1 more is a
    // 1-share short. That's allowed in practice; 2x counting would have made it a 101 short.
    const { rows } = await b.db.query(
      "SELECT count(*)::int AS n FROM orders WHERE parent_id = $1",
      [entry.json().id],
    );
    expect(rows[0].n).toBe(2);
    const extra = await place(alice.token, { symbol: "HELX", side: "sell", price: 63_00, qty: 1 });
    expect(extra.statusCode).toBe(201);
  });

  async function exitsOf(token: string, entryId: number, league?: number) {
    const url = `/v1/orders?limit=200${league ? `&league=${league}` : ""}`;
    const res = await b.app.inject({ url, headers: auth(token) });
    return (res.json() as any[]).filter((o) => o.parentId === entryId);
  }
  const working = (o: any) => ["pending", "open", "partially_filled"].includes(o.status);

  it("sends the exits after a reconnect if the entry filled while the exchange was away", async () => {
    const [alice, seller] = [await signUp(b), await signUp(b)];
    await place(seller.token, { symbol: "BRKL", side: "sell", price: 74_50, qty: 10 });

    // Drop the connection right after the entry is acknowledged, before its fill is handled.
    const bridge = b.bridge as any;
    const submit = bridge.submit.bind(bridge);
    bridge.submit = async (...args: unknown[]) => {
      const reply = await submit(...args);
      bridge.connected = false;
      return reply;
    };
    const entry = (
      await place(alice.token, {
        symbol: "BRKL",
        side: "buy",
        price: 74_50,
        qty: 10,
        takeProfit: 76_00,
        stopLoss: 73_00,
      })
    ).json();
    bridge.submit = submit;
    expect(entry.status).toBe("filled");
    await new Promise((r) => setTimeout(r, 200));
    expect(await exitsOf(alice.token, entry.id)).toHaveLength(0);

    // Back up: the reconnect sweep sends both.
    bridge.connected = true;
    await b.orders.reconcile();
    const exits = await until(async () => {
      const e = (await exitsOf(alice.token, entry.id)).filter((o) => o.status === "open");
      return e.length === 2 ? e : null;
    });
    expect(exits?.map((o) => o.type).sort()).toEqual(["limit", "stop"]);
  });

  it("gives a second bracket on the same stock its own exits", async () => {
    const [alice, seller] = [await signUp(b), await signUp(b)];
    await place(seller.token, { symbol: "VYNE", side: "sell", price: 97_00, qty: 20 });
    const bracket = { symbol: "VYNE", side: "buy", price: 97_00, qty: 10, takeProfit: 99_00 };
    const first = (await place(alice.token, { ...bracket, stopLoss: 95_00 })).json();
    await until(async () => (await exitsOf(alice.token, first.id)).filter(working).length === 2);
    const second = (await place(alice.token, { ...bracket, stopLoss: 94_00 })).json();
    expect(second.status).toBe("filled");

    // 20 held, 10 already covered by the first bracket's exits (counted once): 10 left.
    const exits = await until(async () => {
      const live = (await exitsOf(alice.token, second.id)).filter(working);
      return live.length === 2 ? live : null;
    });
    expect(exits?.map((o) => o.qty)).toEqual([10, 10]);
  });

  it("sends a bracket's exits once when two gateways sync it at the same time", async () => {
    const [alice, seller] = [await signUp(b), await signUp(b)];
    // Above the guest's 24.00 bid from earlier in this file, so only alice buys it.
    await place(seller.token, { symbol: "KILN", side: "sell", price: 24_40, qty: 10 });
    // The entry fills while this gateway thinks the exchange is away, so nothing is sent yet.
    const bridge = b.bridge as any;
    const submit = bridge.submit.bind(bridge);
    bridge.submit = async (...args: unknown[]) => {
      const reply = await submit(...args);
      bridge.connected = false;
      return reply;
    };
    const entry = (
      await place(alice.token, {
        symbol: "KILN",
        side: "buy",
        price: 24_40,
        qty: 10,
        takeProfit: 25_00,
        stopLoss: 23_00,
      })
    ).json();
    bridge.submit = submit;
    await new Promise((r) => setTimeout(r, 200));
    bridge.connected = true;

    // A second gateway: its own OrderService, sharing only the database.
    const other = new OrderService(b.db, b.bridge) as any;
    other.on("error", (err: unknown) => console.error("second gateway", err));
    await Promise.all([
      (b.orders as any).syncExits(entry.id),
      other.syncExits(entry.id),
      (b.orders as any).syncExits(entry.id),
      other.syncExits(entry.id),
    ]);
    const exits = await until(async () => {
      const live = (await exitsOf(alice.token, entry.id)).filter(working);
      return live.length >= 2 ? live : null;
    });
    await new Promise((r) => setTimeout(r, 200));
    const all = await exitsOf(alice.token, entry.id);
    expect(exits).not.toBeNull();
    expect(all.map((o) => `${o.type}:${o.qty}`).sort()).toEqual(["limit:10", "stop:10"]);
    other.apply = async () => {}; // retire it so it stops hearing events
    other.reconcile = async () => 0;
  });

  it("shrinks the other exit when one fills partway", async () => {
    const [alice, seller, buyer] = [await signUp(b), await signUp(b), await signUp(b)];
    await place(seller.token, { symbol: "QSTR", side: "sell", price: 12_00, qty: 100 });
    const entry = (
      await place(alice.token, {
        symbol: "QSTR",
        side: "buy",
        price: 12_00,
        qty: 100,
        takeProfit: 12_50,
        stopLoss: 11_50,
      })
    ).json();
    await until(async () => (await exitsOf(alice.token, entry.id)).filter(working).length === 2);

    // 40 of 100 go at the take-profit: 60 shares are left, so the stop should cover 60.
    await place(buyer.token, { symbol: "QSTR", side: "buy", price: 12_50, qty: 40 });
    const exits = await until(async () => {
      const live = (await exitsOf(alice.token, entry.id)).filter(working);
      const stop = live.find((o) => o.type === "stop");
      return stop?.leaves === 60 && stop.status === "open" && live.length === 2 ? live : null;
    });
    expect(exits).not.toBeNull();
    expect(exits!.find((o) => o.type === "limit")).toMatchObject({ leaves: 60, filledQty: 40 });
  });

  it("never lets exits sell more than you hold, so they can't open a short", async () => {
    const [alice, seller, buyer] = [await signUp(b), await signUp(b), await signUp(b)];
    const league = (
      await b.app.inject({
        method: "POST",
        url: "/v1/leagues",
        headers: auth(alice.token),
        payload: { name: "No shorts", allowShort: false },
      })
    ).json();

    // The entry buys 10 of 20, and alice sells those 10 before the rest fills.
    await place(seller.token, { symbol: "ORBT", side: "sell", price: 310_00, qty: 10 });
    const entry = (
      await place(alice.token, {
        symbol: "ORBT",
        side: "buy",
        price: 310_00,
        qty: 20,
        takeProfit: 315_00,
        stopLoss: 305_00,
        league: league.id,
      })
    ).json();
    expect(entry.status).toBe("partially_filled");
    await place(buyer.token, { symbol: "ORBT", side: "buy", price: 311_00, qty: 10 });
    const sold = await place(alice.token, {
      symbol: "ORBT",
      side: "sell",
      price: 311_00,
      qty: 10,
      league: league.id,
    });
    expect(sold.json().status).toBe("filled");
    await place(seller.token, { symbol: "ORBT", side: "sell", price: 310_00, qty: 10 });

    // The entry filled 20 in total but alice only holds 10, so each exit is for 10.
    const exits = await until(async () => {
      const live = (await exitsOf(alice.token, entry.id, league.id)).filter(working);
      return live.length === 2 ? live : null;
    });
    expect(exits?.map((o) => o.qty)).toEqual([10, 10]);
  });

  it("leaves out shares another open sell is already closing", async () => {
    const [alice, seller] = [await signUp(b), await signUp(b)];
    const league = (
      await b.app.inject({
        method: "POST",
        url: "/v1/leagues",
        headers: auth(alice.token),
        payload: { name: "No shorts either", allowShort: false },
      })
    ).json();

    // The entry buys 30 of 50, and alice puts those 30 up for sale by hand.
    await place(seller.token, { symbol: "HELX", side: "sell", price: 58_00, qty: 30 });
    const entry = (
      await place(alice.token, {
        symbol: "HELX",
        side: "buy",
        price: 58_00,
        qty: 50,
        takeProfit: 61_00,
        stopLoss: 55_00,
        league: league.id,
      })
    ).json();
    expect(entry.status).toBe("partially_filled");
    const manual = await place(alice.token, {
      symbol: "HELX",
      side: "sell",
      price: 62_00,
      qty: 30,
      league: league.id,
    });
    expect(manual.json().status).toBe("open");
    await place(seller.token, { symbol: "HELX", side: "sell", price: 58_00, qty: 20 });

    // 50 held, 30 already promised to the manual sell: the exits cover the other 20.
    const exits = await until(async () => {
      const live = (await exitsOf(alice.token, entry.id, league.id)).filter(working);
      return live.length === 2 ? live : null;
    });
    expect(exits?.map((o) => o.qty)).toEqual([20, 20]);

    // So everything alice has offered (one exit fills, the other is then cancelled, plus
    // the manual sell) adds up to the 50 she holds, and buying it all leaves her flat.
    expect(exits![0]!.qty + manual.json().qty).toBe(50);
  });
});
