import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import WebSocket from "ws";

import { auth, connectWs, signUp, startBackend, type Backend } from "./harness.js";

let b: Backend;
let url: string;

beforeAll(async () => {
  b = await startBackend();
  await b.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = b.app.server.address() as { port: number };
  url = `ws://127.0.0.1:${addr.port}/ws`;
});
afterAll(() => b?.stop());

const connect = (query = "") => connectWs(url + query);

const send = (ws: WebSocket, msg: object) => ws.send(JSON.stringify(msg));
// Collects every message on these channels from now on.
const collect = (ws: WebSocket, channels: string[]) => {
  const got: { channel: string; data: any }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (channels.includes(m.channel)) got.push(m);
  });
  return got;
};
const waitFor = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};
const place = (token: string, payload: object) =>
  b.app.inject({ method: "POST", url: "/v1/orders", headers: auth(token), payload });

describe("websocket", () => {
  it("streams the book and trades", async () => {
    const alice = await signUp(b);
    const bob = await signUp(b);
    await place(alice.token, { symbol: "ORBT", side: "sell", price: 31_050, qty: 8 });

    const { ws, next } = await connect();
    send(ws, { op: "subscribe", channel: "book:ORBT" });
    const snap = await next("book:ORBT");
    expect(snap.snapshot).toBe(true);
    expect(snap.asks).toContainEqual({ price: 31_050, qty: 8 });

    send(ws, { op: "subscribe", channel: "trades:ORBT" });
    await next("subscribed");
    await next("subscribed");
    await place(bob.token, { symbol: "ORBT", side: "buy", price: 31_050, qty: 3 });
    expect(await next("trades:ORBT")).toMatchObject({ price: 31_050, qty: 3, side: "buy" });
    expect(await next("book:ORBT")).toEqual({ side: "ask", price: 31_050, qty: 5 });
    ws.close();
  });

  it("sends a user their own order updates only after auth", async () => {
    const alice = await signUp(b);
    const { ws, next } = await connect();
    send(ws, { op: "subscribe", channel: "me:orders" });
    expect((await next("error")).message).toBe("auth first");

    send(ws, { op: "auth", token: alice.token });
    expect((await next("auth")).userId).toBe(alice.id);
    send(ws, { op: "subscribe", channel: "me:orders" });
    await next("subscribed");

    await place(alice.token, { symbol: "BRKL", side: "buy", price: 7_400, qty: 2 });
    const update = await next("me:orders");
    expect(update.order).toMatchObject({ symbol: "BRKL", status: "open" });
    ws.close();
  });

  it("accepts the token as a query parameter", async () => {
    const alice = await signUp(b);
    const { ws, next } = await connect(`?token=${alice.token}`);
    send(ws, { op: "subscribe", channel: "me:orders" });
    expect(await next("subscribed")).toEqual({ channel: "me:orders" });
    ws.close();
  });

  it("rejects unknown channels and junk", async () => {
    const { ws, next } = await connect();
    send(ws, { op: "subscribe", channel: "book:NOPE" });
    expect((await next("error")).message).toBe("unknown symbol");
    ws.send("not json");
    expect((await next("error")).message).toBe("bad message");
    ws.close();
  });

  it("stops trading when the token expires, until a fresh one is sent", async () => {
    const alice = await signUp(b);
    const short = await new SignJWT({ role: "student" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(alice.id))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 1)
      .sign(new TextEncoder().encode(b.deps.config.JWT_SECRET));
    const { ws, next } = await connect();
    send(ws, { op: "auth", token: short });
    await next("auth");
    await new Promise((r) => setTimeout(r, 1100));
    const order = { symbol: "KILN", side: "buy", price: 24_00, qty: 1 };
    send(ws, { op: "order", ref: "late", order });
    expect(await next("error")).toMatchObject({ ref: "late", error: "unauthorized" });

    // Renewing on the same socket works; switching to someone else's token doesn't.
    send(ws, { op: "auth", token: (await signUp(b)).token });
    expect((await next("error")).message).toBe("already signed in as someone else");
    send(ws, { op: "auth", token: alice.token });
    await next("auth");
    send(ws, { op: "order", ref: "ok", order });
    expect((await next("order")).order.status).toBe("open");
    ws.close();
  });

  it("limits orders per user across all of their sockets", async () => {
    const alice = await signUp(b);
    const sockets = await Promise.all([1, 2, 3, 4].map(() => connect(`?token=${alice.token}`)));
    const order = { symbol: "QSTR", side: "buy", price: 11_00, qty: 1 };
    const got = sockets.map((x) => collect(x.ws, ["order", "error"]));
    for (const [i, s] of sockets.entries())
      for (let j = 0; j < 8; j++) send(s.ws, { op: "order", ref: `${i}-${j}`, order });
    await waitFor(() => got.flat().length === 32);
    const all = got.flat();
    expect(all.filter((m) => m.channel === "order")).toHaveLength(20);
    expect(all.filter((m) => m.data.error === "rate_limited")).toHaveLength(12);
    for (const s of sockets) s.ws.close();
  });

  it("closes a socket that floods it and throttles book snapshots", async () => {
    const { ws, next } = await connect();
    for (let i = 0; i < 12; i++) {
      send(ws, { op: "subscribe", channel: "book:NOVA" });
      send(ws, { op: "unsubscribe", channel: "book:NOVA" });
    }
    let snapshots = 0;
    for (let i = 0; i < 10; i++) if ((await next("book:NOVA")).snapshot) snapshots++;
    expect(snapshots).toBe(10);
    expect(await next("error")).toEqual({ message: "slow down", channel: "book:NOVA" });

    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    for (let i = 0; i < 200; i++) send(ws, { op: "ping" });
    expect(await closed).toBe(1008);
  });

  it("caps sockets per account", async () => {
    const alice = await signUp(b);
    const sockets = await Promise.all(Array.from({ length: 9 }, () => connect()));
    const got = sockets.map((x) => collect(x.ws, ["auth", "error"]));
    for (const s of sockets) send(s.ws, { op: "auth", token: alice.token });
    await waitFor(() => got.flat().length === 9);
    const all = got.flat();
    expect(all.filter((m) => m.data.userId === alice.id)).toHaveLength(8);
    expect(
      all.filter((m) => m.data.message === "too many connections for this account"),
    ).toHaveLength(1);
    for (const s of sockets) s.ws.close();
  });

  it("says when the exchange drops and comes back, with a fresh book", async () => {
    const { ws, next } = await connect();
    expect(await next("exchange")).toEqual({ up: true });
    send(ws, { op: "subscribe", channel: "book:VYNE" });
    expect((await next("book:VYNE")).snapshot).toBe(true);

    (b.bridge as any).socket.destroy();
    expect(await next("exchange")).toEqual({ up: false });
    expect(await next("exchange")).toEqual({ up: true });
    expect((await next("book:VYNE", 3000)).snapshot).toBe(true);
    ws.close();
  });
});
