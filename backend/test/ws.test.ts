import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

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

function connect(query = ""): Promise<{ ws: WebSocket; next: (channel: string) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url + query);
    const queue: any[] = [];
    const waiting: { channel: string; resolve: (d: any) => void }[] = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiting.findIndex((w) => w.channel === msg.channel);
      if (i >= 0) waiting.splice(i, 1)[0]!.resolve(msg.data);
      else queue.push(msg);
    });
    const next = (channel: string) =>
      new Promise<any>((res, rej) => {
        const i = queue.findIndex((m) => m.channel === channel);
        if (i >= 0) return res(queue.splice(i, 1)[0].data);
        waiting.push({ channel, resolve: res });
        setTimeout(() => rej(new Error(`no message on ${channel}`)), 3000);
      });
    ws.on("open", () => resolve({ ws, next }));
    ws.on("error", reject);
  });
}

const send = (ws: WebSocket, msg: object) => ws.send(JSON.stringify(msg));
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
});
