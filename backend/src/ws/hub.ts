// WebSocket fan-out. Clients send {"op":"subscribe","channel":"trades:NOVA"} and get
// JSON messages {"channel": ..., "data": ...}. Channels:
//   book:TICKER    full depth on subscribe, then one message per level change
//   trades:TICKER  each trade
//   status         halts and resumes
//   me:orders      your order updates and fills (needs a token)
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";

import * as p from "../engine/protocol.js";
import type { Order } from "../orders.js";

const MAX_SUBSCRIPTIONS = 50;
const MAX_BUFFERED = 1 << 20; // drop clients that stop reading

const ClientMsg = z.object({
  op: z.enum(["subscribe", "unsubscribe", "auth", "ping"]),
  channel: z.string().max(40).optional(),
  token: z.string().max(2000).optional(),
});

interface Client {
  ws: WebSocket;
  userId: number | null;
  channels: Set<string>;
}

export default async function wsRoutes(app: FastifyInstance) {
  const { bridge, orders, symbols, symbolsByTicker, tokens } = app.deps;
  const subscribers = new Map<string, Set<Client>>();

  const send = (c: Client, channel: string, data: unknown) => {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED) {
      c.ws.close(1013, "too slow");
      return;
    }
    c.ws.send(JSON.stringify({ channel, data }));
  };

  const publish = (channel: string, data: unknown) => {
    const subs = subscribers.get(channel);
    if (subs) for (const c of subs) send(c, channel, data);
  };

  const onMarket = (e: p.EngineEvent) => {
    const ticker = symbols[e.symbol]?.ticker;
    if (!ticker) return;
    if (e.type === p.EventType.Trade) {
      publish(`trades:${ticker}`, { price: e.price, qty: e.qty, side: e.side === p.Side.Buy ? "buy" : "sell", tradeId: e.tradeId, time: Date.now() });
    } else if (e.type === p.EventType.BookDelta) {
      publish(`book:${ticker}`, { side: e.side === p.Side.Buy ? "bid" : "ask", price: e.price, qty: e.levelQty });
    } else if (e.type === p.EventType.TradingStatus) {
      publish("status", { ticker, halted: e.reason === 1, resumesAt: e.reason === 1 ? e.levelQty / 1e6 : null });
    }
  };
  bridge.on("market", onMarket);
  app.addHook("onClose", async () => {
    bridge.off("market", onMarket);
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
    } else if (channel !== "status") {
      return "unknown channel";
    }
    c.channels.add(channel);
    let subs = subscribers.get(channel);
    if (!subs) subscribers.set(channel, (subs = new Set()));
    subs.add(c);
    return null;
  }

  app.get("/ws", { websocket: true }, (ws, req) => {
    const c: Client = { ws, userId: null, channels: new Set() };
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
      const channel = msg.channel ?? "";
      if (msg.op === "subscribe") {
        const err = subscribe(c, channel);
        return send(c, err ? "error" : "subscribed", err ? { message: err, channel } : { channel });
      }
      c.channels.delete(channel);
      subscribers.get(channel)?.delete(c);
      send(c, "unsubscribed", { channel });
    });

    ws.on("close", () => {
      detach();
      for (const ch of c.channels) subscribers.get(ch)?.delete(c);
    });
  });
}
