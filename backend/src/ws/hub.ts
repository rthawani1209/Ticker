// WebSocket fan-out. Clients send {"op":"subscribe","channel":"trades:NOVA"} and get
// JSON messages {"channel": ..., "data": ...}. Channels:
//   book:TICKER    full depth on subscribe, then one message per level change
//   trades:TICKER  each trade
//   status         halts and resumes
//   news           headlines from the market simulator
//   me:orders      your order updates and fills (needs a token)
//
// Signed-in clients can also trade over the socket, with the same rules as REST:
//   {"op":"order","ref":"a1","order":{...same body as POST /v1/orders}}  -> {"channel":"order","data":{"ref","order"}}
//   {"op":"cancel","ref":"a2","id":123}                                  -> {"channel":"cancel","data":{"ref","order"}}
// Failures come back on the "error" channel with the same ref.
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
  channels: Set<string>;
  sent: number[]; // times of recent order/cancel messages, for the rate limit
}

export default async function wsRoutes(app: FastifyInstance) {
  const { bridge, config, db, fanout, orders, symbols, symbolsByTicker, tokens } = app.deps;
  const subscribers = new Map<string, Set<Client>>();

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
  app.addHook("onClose", async () => {
    bridge.off("market", onMarket);
    unsubscribe();
  });

  function subscribe(c: Client, channel: string): string | null {
    if (c.channels.has(channel)) return null;
    if (c.channels.size >= MAX_SUBSCRIPTIONS) return "too many subscriptions";
    const [kind, arg] = channel.split(":");
    if (kind === "book" || kind === "trades") {
      const sym = symbolsByTicker.get(arg ?? "");
      if (!sym) return "unknown symbol";
      if (kind === "book") send(c, channel, { snapshot: true, ...bridge.books[sym.id]!.depth(50) });
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
    const c: Client = { ws, userId: null, channels: new Set(), sent: [] };
    let detach = () => {};

    const authenticate = async (token: string) => {
      const claims = await tokens.verifyAccess(token);
      if (!claims) return false;
      c.userId = claims.userId;
      const onOrder = (o: Order) => send(c, "me:orders", { order: o });
      const onFill = (f: unknown) => send(c, "me:orders", { fill: f });
      orders.on(`user:${claims.userId}`, onOrder);
      orders.on(`fill:${claims.userId}`, onFill);
      detach = () => {
        orders.off(`user:${claims.userId}`, onOrder);
        orders.off(`fill:${claims.userId}`, onFill);
      };
      return true;
    };

    // The browser can't set headers on a WebSocket, so the token comes as a query param or an auth message.
    const queryToken = (req.query as Record<string, string | undefined>).token;
    const ready = queryToken ? authenticate(queryToken) : Promise.resolve(true);

    ws.on("message", async (raw) => {
      await ready;
      let msg: z.infer<typeof ClientMsg>;
      try {
        msg = ClientMsg.parse(JSON.parse(raw.toString()));
      } catch {
        return send(c, "error", { message: "bad message" });
      }
      if (msg.op === "ping") return send(c, "pong", {});
      if (msg.op === "auth") {
        const ok = c.userId === null && (await authenticate(msg.token ?? ""));
        return send(c, ok ? "auth" : "error", ok ? { userId: c.userId } : { message: "bad token" });
      }
      if (msg.op === "order" || msg.op === "cancel") return trade(msg, req.ip);
      const channel = msg.channel ?? "";
      if (msg.op === "subscribe") {
        const err = subscribe(c, channel);
        return send(c, err ? "error" : "subscribed", err ? { message: err, channel } : { channel });
      }
      c.channels.delete(channel);
      subscribers.get(channel)?.delete(c);
      send(c, "unsubscribed", { channel });
    });

    async function trade(msg: z.infer<typeof ClientMsg>, ip: string) {
      const ref = msg.ref;
      const fail = (code: string, message: string) =>
        send(c, "error", { ref, error: code, message });
      if (c.userId === null) return fail("unauthorized", "auth first");
      const now = Date.now();
      c.sent = c.sent.filter((t) => now - t < 1000);
      if (c.sent.length >= ORDERS_PER_SECOND) return fail("rate_limited", "slow down");
      c.sent.push(now);
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
      detach();
      for (const ch of c.channels) subscribers.get(ch)?.delete(c);
    });
  });
}
