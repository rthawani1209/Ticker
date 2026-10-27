// Orders as the API sees them: stored in Postgres, sent to the engine through the
// bridge, and kept up to date from the engine's private events.
import { EventEmitter } from "node:events";

import type { PoolClient } from "pg";

import type { Db } from "./db/pool.js";
import type { EngineBridge } from "./engine/bridge.js";
import * as p from "./engine/protocol.js";

export const FIRST_BOT_ACCOUNT = 900_001;

export type SideName = "buy" | "sell";
export type TypeName = "limit" | "market" | "stop" | "stop_limit";
export type TifName = "gtc" | "ioc" | "fok";

export interface OrderInput {
  symbolId: number;
  side: SideName;
  type: TypeName;
  tif: TifName;
  qty: number;
  price?: number; // cents; limit and stop_limit
  stopPrice?: number; // cents; stop and stop_limit
}

export interface Order {
  id: number;
  symbol: string;
  side: SideName;
  type: TypeName;
  tif: TifName;
  price: number | null;
  stopPrice: number | null;
  qty: number;
  leaves: number;
  filledQty: number;
  status: "pending" | "open" | "partially_filled" | "filled" | "cancelled" | "rejected";
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Fill {
  id: number;
  orderId: number;
  symbol: string;
  side: SideName;
  price: number;
  qty: number;
  createdAt: string;
}

const SIDES: Record<SideName, p.Side> = { buy: p.Side.Buy, sell: p.Side.Sell };
const TYPES: Record<TypeName, p.OrdType> = {
  limit: p.OrdType.Limit, market: p.OrdType.Market, stop: p.OrdType.Stop, stop_limit: p.OrdType.StopLimit,
};
const TIFS: Record<TifName, p.TIF> = { gtc: p.TIF.GTC, ioc: p.TIF.IOC, fok: p.TIF.FOK };

const ORDER_COLUMNS = `o.id, s.ticker AS symbol, o.side, o.type, o.tif, o.price, o.stop_price, o.qty, o.leaves,
  o.filled_qty, o.status, o.reject_reason, o.created_at, o.updated_at`;

function toOrder(r: any): Order {
  return {
    id: r.id, symbol: r.symbol, side: r.side, type: r.type, tif: r.tif, price: r.price, stopPrice: r.stop_price,
    qty: r.qty, leaves: r.leaves, filledQty: r.filled_qty, status: r.status, rejectReason: r.reject_reason,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

export class OrderError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class OrderService extends EventEmitter {
  // Engine events are applied to the database one at a time, in arrival order.
  private queue: Promise<void> = Promise.resolve();

  constructor(private db: Db, private bridge: EngineBridge) {
    super();
    bridge.on("private", (e: p.EngineEvent) => {
      if (e.account === 0 || e.account >= FIRST_BOT_ACCOUNT) return;
      this.enqueue(() => this.apply(e));
    });
    bridge.on("up", () => this.enqueue(() => this.reconcile().then(() => {})));
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err) => {
      this.emit("error", err);
    });
  }

  // Resolves once every event received so far has been written.
  settled(): Promise<void> {
    return this.queue;
  }

  async place(userId: number, input: OrderInput): Promise<Order> {
    if (!this.bridge.connected) throw new OrderError(503, "exchange_down", "the exchange is not connected");
    const { rows } = await this.db.query(
      `INSERT INTO orders (user_id, symbol_id, side, type, tif, price, stop_price, qty, leaves)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
      [userId, input.symbolId, input.side, input.type, input.tif, input.price ?? null, input.stopPrice ?? null, input.qty],
    );
    const id: number = rows[0].id;

    const reply = await this.bridge.submit({
      account: userId,
      clOrdId: id,
      symbol: input.symbolId,
      side: SIDES[input.side],
      ordType: TYPES[input.type],
      tif: TIFS[input.tif],
      price: input.price ?? 0,
      stopPrice: input.stopPrice ?? 0,
      qty: input.qty,
    });
    // The ack/reject is applied through the event queue; wait for it so the
    // response shows the order as the engine left it (including any instant fills).
    if (reply) await this.settled();
    return (await this.get(userId, id))!;
  }

  async cancel(userId: number, orderId: number): Promise<Order> {
    const order = await this.db.query(
      "SELECT id, symbol_id, engine_order_id, status FROM orders WHERE id = $1 AND user_id = $2",
      [orderId, userId],
    );
    const row = order.rows[0];
    if (!row) throw new OrderError(404, "not_found", "no such order");
    if (!["open", "partially_filled"].includes(row.status) || !row.engine_order_id) {
      throw new OrderError(409, "not_open", `order is ${row.status}`);
    }
    if (!this.bridge.connected) throw new OrderError(503, "exchange_down", "the exchange is not connected");

    const done = new Promise<void>((resolve) => {
      const onUpdate = (o: Order) => {
        if (o.id === orderId && ["cancelled", "filled"].includes(o.status)) {
          this.off(`user:${userId}`, onUpdate);
          resolve();
        }
      };
      this.on(`user:${userId}`, onUpdate);
      setTimeout(() => {
        this.off(`user:${userId}`, onUpdate);
        resolve();
      }, 2000).unref();
    });
    const reject = await Promise.race([this.bridge.cancel(userId, row.engine_order_id, row.symbol_id), done.then(() => null)]);
    if (reject && reject.type === p.EventType.Reject) {
      await this.settled();
      const current = (await this.get(userId, orderId))!;
      if (current.status === "filled") throw new OrderError(409, "not_open", "order already filled");
      throw new OrderError(409, "cancel_rejected", p.REJECT_REASONS[reject.reason] ?? "rejected");
    }
    await done;
    await this.settled();
    return (await this.get(userId, orderId))!;
  }

  async get(userId: number, id: number): Promise<Order | null> {
    const { rows } = await this.db.query(
      `SELECT ${ORDER_COLUMNS} FROM orders o JOIN symbols s ON s.id = o.symbol_id WHERE o.id = $1 AND o.user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async list(userId: number, opts: { open?: boolean; limit: number; before?: number }): Promise<Order[]> {
    const { rows } = await this.db.query(
      `SELECT ${ORDER_COLUMNS} FROM orders o JOIN symbols s ON s.id = o.symbol_id
       WHERE o.user_id = $1 AND ($2::boolean IS NOT TRUE OR o.status IN ('pending', 'open', 'partially_filled'))
         AND ($3::bigint IS NULL OR o.id < $3)
       ORDER BY o.id DESC LIMIT $4`,
      [userId, opts.open ?? null, opts.before ?? null, opts.limit],
    );
    return rows.map(toOrder);
  }

  async fills(userId: number, limit: number): Promise<Fill[]> {
    const { rows } = await this.db.query(
      `SELECT f.id, f.order_id, s.ticker AS symbol, f.side, f.price, f.qty, f.created_at
       FROM fills f JOIN symbols s ON s.id = f.symbol_id WHERE f.user_id = $1 ORDER BY f.id DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({
      id: r.id, orderId: r.order_id, symbol: r.symbol, side: r.side, price: r.price, qty: r.qty,
      createdAt: r.created_at.toISOString(),
    }));
  }

  // Called when the bridge (re)connects. Replies for anything sent before the drop
  // are gone, so orders still pending past the submit timeout are given up on.
  // If the engine did accept one, its next fill or cancel finds it again by
  // cl_ord_id (see orderForEvent) and brings it back.
  async reconcile(timeoutMs = 2000): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE orders SET status = 'rejected', leaves = 0, reject_reason = 'exchange_unavailable', updated_at = now()
       WHERE status = 'pending' AND created_at < now() - make_interval(secs => $1)
       RETURNING id, user_id`,
      [timeoutMs / 1000],
    );
    for (const r of rows) {
      const order = await this.get(r.user_id, r.id);
      if (order) this.emit(`user:${r.user_id}`, order);
    }
    return rows.length;
  }

  // Finds the order an engine event is about: normally by the engine's order id,
  // or by cl_ord_id (our order id) when the ack never reached us.
  private async orderForEvent(client: PoolClient, e: p.EngineEvent) {
    const byEngineId = await client.query(
      "SELECT id, user_id, symbol_id, side, qty FROM orders WHERE engine_order_id = $1 FOR UPDATE",
      [e.orderId],
    );
    if (byEngineId.rows[0]) return byEngineId.rows[0];
    const byClId = await client.query(
      `UPDATE orders SET engine_order_id = $1 WHERE id = $2 AND user_id = $3 AND engine_order_id IS NULL
       RETURNING id, user_id, symbol_id, side, qty`,
      [e.orderId, e.clOrdId, e.account],
    );
    return byClId.rows[0];
  }

  private async apply(e: p.EngineEvent): Promise<void> {
    let id: number | undefined;
    switch (e.type) {
      case p.EventType.Ack: {
        const r = await this.db.query(
          `UPDATE orders SET engine_order_id = $2, status = 'open', updated_at = now()
           WHERE id = $1 AND user_id = $3 AND status = 'pending' RETURNING id`,
          [e.clOrdId, e.orderId, e.account],
        );
        id = r.rows[0]?.id;
        break;
      }
      case p.EventType.Reject: {
        // Rejects for cancel requests carry the cancel's own id, which matches no order.
        const r = await this.db.query(
          `UPDATE orders SET status = 'rejected', leaves = 0, reject_reason = $2, updated_at = now()
           WHERE id = $1 AND user_id = $3 AND status = 'pending' RETURNING id`,
          [e.clOrdId, p.REJECT_REASONS[e.reason] ?? String(e.reason), e.account],
        );
        id = r.rows[0]?.id;
        break;
      }
      case p.EventType.Fill: {
        let fill: { orderId: number } | undefined;
        await this.tx(async (client) => {
          const o = await this.orderForEvent(client, e);
          if (!o) return;
          id = o.id;
          // The fill row goes in first: if this exact fill was already recorded
          // (a replayed or duplicated event), nothing below runs.
          const inserted = await client.query(
            `INSERT INTO fills (order_id, user_id, symbol_id, side, price, qty, trade_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
            [o.id, o.user_id, o.symbol_id, o.side, e.price, e.qty, e.tradeId],
          );
          if (!inserted.rows[0]) return;
          await client.query(
            `UPDATE orders SET leaves = $2, filled_qty = filled_qty + $3,
               status = CASE WHEN $2 = 0 THEN 'filled'::order_status ELSE 'partially_filled'::order_status END,
               reject_reason = NULL, updated_at = now()
             WHERE id = $1`,
            [o.id, e.leaves, e.qty],
          );
          fill = { orderId: o.id };
        });
        if (fill) {
          this.emit(`fill:${e.account}`, {
            orderId: fill.orderId, symbol: e.symbol, side: e.side === p.Side.Buy ? "buy" : "sell", price: e.price, qty: e.qty,
          });
        }
        break;
      }
      case p.EventType.Cancelled: {
        await this.tx(async (client) => {
          const o = await this.orderForEvent(client, e);
          if (!o) return;
          const reason = p.CANCEL_REASONS[e.reason] ?? String(e.reason);
          await client.query(
            `UPDATE orders SET status = 'cancelled', leaves = 0, updated_at = now(),
               reject_reason = CASE WHEN $2 = 'user' THEN NULL ELSE $2 END
             WHERE id = $1`,
            [o.id, reason],
          );
          id = o.id;
        });
        break;
      }
      case p.EventType.Replaced: {
        const r = await this.db.query(
          `UPDATE orders SET price = $2, leaves = $3, updated_at = now() WHERE engine_order_id = $1 RETURNING id`,
          [e.orderId, e.price, e.qty],
        );
        id = r.rows[0]?.id;
        break;
      }
    }
    if (id !== undefined) {
      const order = await this.get(e.account, id);
      if (order) this.emit(`user:${e.account}`, order);
    }
  }

  private async tx(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await fn(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
