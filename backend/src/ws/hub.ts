// WebSocket fan-out. Clients send {"op":"subscribe","channel":"trades:NOVA"} and get
// JSON messages {"channel": ..., "data": ...}. Channels:
//   book:TICKER    full depth on subscribe, then one message per level change
//   trades:TICKER  each trade
//   status         halts and resumes
//   news           headlines from the market simulator
//   me:orders      your order updates and fills (needs a token)
// Every socket also gets {"channel":"exchange","data":{"up":true|false}} on connect and
// whenever this gateway loses or regains the engine, so the app can say when trading is down.
//
// Signed-in clients can also trade over the socket, with the same rules as REST:
//   {"op":"order","ref":"a1","order":{...same body as POST /v1/orders}}  -> {"channel":"order","data":{"ref","order"}}
//   {"op":"cancel","ref":"a2","id":123}                                  -> {"channel":"cancel","data":{"ref","order"}}
// Failures come back on the "error" channel with the same ref.
//
// Sign in by sending {"op":"auth","token":...} first (a ?token= query param works too,
// but ends up in access logs). Access tokens are short-lived: trading stops when the
// token expires, and the client sends a fresh one with another "auth" message.
//
// Public market data goes through the fan-out (see fanout.ts), so any number of
// gateways can serve the same feed. Private order updates come straight from this
// process's OrderService.
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";

import { audit } from "../audit.js";
import * as p from "../engine/protocol.js";
import { ApiError } from "../errors.js";
import { NewOrder, toOrderInput } from "../order-schema.js";
import type { Order } from "../orders.js";

const MAX_SUBSCRIPTIONS = 50;
const MAX_BUFFERED = 1 << 20; // drop clients that stop reading
// Flood limits. A browser tab sends a handful of messages a minute, so these only bite
// scripts. Going over the message rate closes the socket.
const MESSAGES_PER_SECOND = 20;
const MESSAGE_BURST = 60;
const SNAPSHOTS_PER_10S = 10; // full book snapshots, the expensive reply
const SOCKETS_PER_USER = 8;
const SOCKETS_PER_IP = 100; // a whole class can sit behind one campus IP

const ClientMsg = z.object({
  op: z.enum(["subscribe", "unsubscribe", "auth", "ping", "order", "cancel"]),
  channel: z.string().max(40).optional(),
  token: z.string().max(2000).optional(),
  ref: z.string().max(40).optional(),
  order: z.unknown().optional(),
  id: z.number().int().positive().optional(),
});

const ORDERS_PER_SECOND = 20; // same as the REST order limit

interface Client {
  ws: WebSocket;
  userId: number | null;
  expiresAt: number; // ms; the access token's expiry
  channels: Set<string>;
  tokens: number; // message budget, refilled at MESSAGES_PER_SECOND
  refilledAt: number;
  snapshots: number[]; // times of recent book snapshots
}

// Times of recent order/cancel messages per user, across all their sockets.
function withinRate(recent: Map<number, number[]>, userId: number, now: number): boolean {
  const times = (recent.get(userId) ?? []).filter((t) => now - t < 1000);
  if (times.length >= ORDERS_PER_SECOND) {
    recent.set(userId, times);
    return false;
  }
  times.push(now);
  recent.set(userId, times);
  return true;
}

export default async function wsRoutes(app: FastifyInstance) {
  const { bridge, config, db, fanout, orders, symbols, symbolsByTicker, tokens } = app.deps;
  const subscribers = new Map<string, Set<Client>>();
  const clients = new Set<Client>();
  const recentOrders = new Map<number, number[]>();
  const socketsByUser = new Map<number, number>();
  const socketsByIp = new Map<string, number>();
  const bump = <K>(m: Map<K, number>, k: K, by: number) => {
    const n = (m.get(k) ?? 0) + by;
    if (n > 0) m.set(k, n);
    else m.delete(k);
  };

  const send = (c: Client, channel: string, data: unknown) => {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED) {
      c.ws.close(1013, "too slow");
      return;
    }
    c.ws.send(JSON.stringify({ channel, data }));
  };

  const deliver = (channel: string, data: unknown) => {
    const subs = subscribers.get(channel);
    if (subs) for (const c of subs) send(c, channel, data);
  };
  const unsubscribe = fanout.subscribe(deliver);
  const publish = (channel: string, data: unknown) => fanout.publish(channel, data);

  const onMarket = (e: p.EngineEvent) => {
    const ticker = symbols[e.symbol]?.ticker;
    if (!ticker) return;
    if (e.type === p.EventType.Trade) {
      publish(`trades:${ticker}`, {
        price: e.price,
        qty: e.qty,
        side: e.side === p.Side.Buy ? "buy" : "sell",
        tradeId: e.tradeId,
        time: Date.now(),
      });
    } else if (e.type === p.EventType.BookDelta) {
      publish(`book:${ticker}`, {
        side: e.side === p.Side.Buy ? "bid" : "ask",
        price: e.price,
        qty: e.levelQty,
      });
    } else if (e.type === p.EventType.TradingStatus) {
      publish("status", {
        ticker,
        halted: e.reason === 1,
        resumesAt: e.reason === 1 ? e.levelQty / 1e6 : null,
      });
    }
  };
  if (config.MARKET_PUBLISHER) bridge.on("market", onMarket);

  // The engine restarting wipes nothing (it replays its journal), but books may have
  // moved while it was away, so book subscribers get a fresh snapshot once it's back.
  let resnap: ReturnType<typeof setTimeout> | undefined;
  const onUp = () => {
    for (const c of clients) send(c, "exchange", { up: true });
    clearTimeout(resnap);
    resnap = setTimeout(() => {
      for (const [channel, subs] of subscribers) {
        const sym = channel.startsWith("book:") && symbolsByTicker.get(channel.slice(5));
        if (!sym) continue;
        const snap = { snapshot: true, ...bridge.books[sym.id]!.depth(50) };
        for (const c of subs) send(c, channel, snap);
      }
    }, 500);
  };
  const onDown = () => {
    for (const c of clients) send(c, "exchange", { up: false });
  };
  bridge.on("up", onUp);
  bridge.on("down", onDown);
  app.addHook("onClose", async () => {
    bridge.off("market", onMarket);
    bridge.off("up", onUp);
    bridge.off("down", onDown);
    clearTimeout(resnap);
    unsubscribe();
  });

  function subscribe(c: Client, channel: string): string | null {
    if (c.channels.has(channel)) return null;
    if (c.channels.size >= MAX_SUBSCRIPTIONS) return "too many subscriptions";
    const [kind, arg] = channel.split(":");
    if (kind === "book" || kind === "trades") {
      const sym = symbolsByTicker.get(arg ?? "");
      if (!sym) return "unknown symbol";
      if (kind === "book") {
        const now = Date.now();
        c.snapshots = c.snapshots.filter((t) => now - t < 10_000);
        if (c.snapshots.length >= SNAPSHOTS_PER_10S) return "slow down";
        c.snapshots.push(now);
        send(c, channel, { snapshot: true, ...bridge.books[sym.id]!.depth(50) });
      }
    } else if (channel === "me:orders") {
      if (c.userId === null) return "auth first";
    } else if (channel !== "status" && channel !== "news") {
      return "unknown channel";
    }
    c.channels.add(channel);
    let subs = subscribers.get(channel);
    if (!subs) subscribers.set(channel, (subs = new Set()));
    subs.add(c);
    return null;
  }

  app.get("/ws", { websocket: true }, (ws, req) => {
    const ip = req.ip;
    if ((socketsByIp.get(ip) ?? 0) >= SOCKETS_PER_IP) {
      ws.close(1013, "too many connections");
      return;
    }
    bump(socketsByIp, ip, 1);
    const c: Client = {
      ws,
      userId: null,
      expiresAt: 0,
      channels: new Set(),
      tokens: MESSAGE_BURST,
      refilledAt: Date.now(),
      snapshots: [],
    };
    clients.add(c);
    send(c, "exchange", { up: bridge.connected });
    let detach = () => {};

    // Signs the socket in, or renews it with a fresh token for the same user.
    const authenticate = async (token: string): Promise<string | null> => {
      const claims = await tokens.verifyAccess(token);
      if (!claims) return "bad token";
      if (c.userId !== null) {
        if (claims.userId !== c.userId) return "already signed in as someone else";
        c.expiresAt = (claims.exp ?? 0) * 1000;
        return null;
      }
      if ((socketsByUser.get(claims.userId) ?? 0) >= SOCKETS_PER_USER)
        return "too many connections for this account";
      bump(socketsByUser, claims.userId, 1);
      c.userId = claims.userId;
      c.expiresAt = (claims.exp ?? 0) * 1000;
      const onOrder = (o: Order) => send(c, "me:orders", { order: o });
      const onFill = (f: unknown) => send(c, "me:orders", { fill: f });
      orders.on(`user:${claims.userId}`, onOrder);
      orders.on(`fill:${claims.userId}`, onFill);
      detach = () => {
        orders.off(`user:${claims.userId}`, onOrder);
        orders.off(`fill:${claims.userId}`, onFill);
        bump(socketsByUser, claims.userId, -1);
      };
      return null;
    };

    const queryToken = (req.query as Record<string, string | undefined>).token;
    // Messages are handled one at a time, in order, so a subscribe sent right after an
    // auth sees the signed-in socket.
    let queue: Promise<unknown> = queryToken ? authenticate(queryToken) : Promise.resolve();

    ws.on("message", (raw) => {
      const now = Date.now();
      c.tokens = Math.min(
        MESSAGE_BURST,
        c.tokens + ((now - c.refilledAt) / 1000) * MESSAGES_PER_SECOND,
      );
      c.refilledAt = now;
      if (c.tokens < 1) {
        ws.close(1008, "too many messages");
        return;
      }
      c.tokens -= 1;
      queue = queue.then(() => handle(raw.toString())).catch((err) => app.log.error(err));
    });

    async function handle(raw: string) {
      let msg: z.infer<typeof ClientMsg>;
      try {
        msg = ClientMsg.parse(JSON.parse(raw));
      } catch {
        return send(c, "error", { message: "bad message" });
      }
      if (msg.op === "ping") return send(c, "pong", {});
      if (msg.op === "auth") {
        const err = await authenticate(msg.token ?? "");
        return send(c, err ? "error" : "auth", err ? { message: err } : { userId: c.userId });
      }
      if (msg.op === "order" || msg.op === "cancel") return trade(msg, ip);
      const channel = msg.channel ?? "";
      if (msg.op === "subscribe") {
        const err = subscribe(c, channel);
        return send(c, err ? "error" : "subscribed", err ? { message: err, channel } : { channel });
      }
      c.channels.delete(channel);
      subscribers.get(channel)?.delete(c);
      send(c, "unsubscribed", { channel });
    }

    async function trade(msg: z.infer<typeof ClientMsg>, ip: string) {
      const ref = msg.ref;
      const fail = (code: string, message: string) =>
        send(c, "error", { ref, error: code, message });
      if (c.userId === null) return fail("unauthorized", "auth first");
      const now = Date.now();
      if (now >= c.expiresAt) return fail("unauthorized", "session expired, send a fresh token");
      if (!withinRate(recentOrders, c.userId, now)) return fail("rate_limited", "slow down");
      try {
        if (msg.op === "order") {
          const parsed = NewOrder.safeParse(msg.order);
          if (!parsed.success) return fail("bad_request", z.prettifyError(parsed.error));
          const { input, league } = toOrderInput(parsed.data, symbolsByTicker);
          const order = await orders.place(c.userId, input, league);
          await audit(
            db,
            c.userId,
            "order_new",
            {
              orderId: order.id,
              league: order.league,
              symbol: order.symbol,
              side: order.side,
              qty: order.qty,
              via: "ws",
            },
            ip,
          );
          return send(c, "order", { ref, order });
        }
        if (msg.id === undefined) return fail("bad_request", "id is required");
        const order = await orders.cancel(c.userId, msg.id);
        await audit(db, c.userId, "order_cancel", { orderId: msg.id, via: "ws" }, ip);
        return send(c, "cancel", { ref, order });
      } catch (err) {
        if (err instanceof ApiError) return fail(err.code, err.message);
        app.log.error(err);
        return fail("internal", "something went wrong");
      }
    }

    ws.on("close", () => {
      clients.delete(c);
      detach();
      bump(socketsByIp, ip, -1);
      for (const ch of c.channels) subscribers.get(ch)?.delete(c);
    });
  });
}
