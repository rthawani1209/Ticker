// Orders as the API sees them: stored in Postgres, sent to the engine through the
// bridge, and kept up to date from the engine's private events.
//
// Every order belongs to a portfolio (one per user per league), and the portfolio id
// is the account the engine sees. Fills update the ledger in the same transaction.
import { EventEmitter } from "node:events";

import type { PoolClient } from "pg";

import type { Db } from "./db/pool.js";
import type { EngineBridge } from "./engine/bridge.js";
import * as p from "./engine/protocol.js";
import { ApiError } from "./errors.js";
import { applyFill, checkOrder, commission, LEAGUE_COLUMNS, toLeague, type Marks } from "./ledger.js";

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
  league: number;
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
  league: number;
  symbol: string;
  side: SideName;
  price: number;
  qty: number;
  commission: number;
  createdAt: string;
}

const SIDES: Record<SideName, p.Side> = { buy: p.Side.Buy, sell: p.Side.Sell };
const TYPES: Record<TypeName, p.OrdType> = {
  limit: p.OrdType.Limit, market: p.OrdType.Market, stop: p.OrdType.Stop, stop_limit: p.OrdType.StopLimit,
};
const TIFS: Record<TifName, p.TIF> = { gtc: p.TIF.GTC, ioc: p.TIF.IOC, fok: p.TIF.FOK };

const ORDER_COLUMNS = `o.id, pf.league_id, s.ticker AS symbol, o.side, o.type, o.tif, o.price, o.stop_price, o.qty, o.leaves,
  o.filled_qty, o.status, o.reject_reason, o.created_at, o.updated_at`;

function toOrder(r: any): Order {
  return {
    id: r.id, league: r.league_id, symbol: r.symbol, side: r.side, type: r.type, tif: r.tif, price: r.price, stopPrice: r.stop_price,
    qty: r.qty, leaves: r.leaves, filledQty: r.filled_qty, status: r.status, rejectReason: r.reject_reason,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

const ORDER_FROM = "orders o JOIN symbols s ON s.id = o.symbol_id JOIN portfolios pf ON pf.id = o.portfolio_id";

export class OrderService extends EventEmitter {
  // Engine events are applied to the database one at a time, in arrival order.
  private queue: Promise<void> = Promise.resolve();

  readonly marks: Marks;

  constructor(private db: Db, private bridge: EngineBridge) {
    super();
    this.marks = {
      last: (symbolId) => bridge.books[symbolId]!.last,
      bestAsk: (symbolId) => bridge.books[symbolId]!.bestAsk(),
    };
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

  // Places an order in one of the user's leagues (the practice league by default).
  async place(userId: number, input: OrderInput, leagueId?: number): Promise<Order> {
    if (!this.bridge.connected) throw new ApiError(503, "exchange_down", "the exchange is not connected");
    let id = 0;
    let account = 0;
    await this.tx(async (client) => {
      // Locking the portfolio row serializes orders per portfolio, so the buying
      // power check below can't race with another order spending the same cash.
      const { rows } = await client.query(
        `SELECT pf.id AS portfolio_id, pf.cash, ${LEAGUE_COLUMNS}
         FROM portfolios pf JOIN leagues l ON l.id = pf.league_id
         WHERE pf.user_id = $1 AND ${leagueId === undefined ? "l.is_practice" : "l.id = $2"}
         FOR UPDATE OF pf`,
        leagueId === undefined ? [userId] : [userId, leagueId],
      );
      const row = rows[0];
      if (!row) throw new ApiError(404, "not_a_member", "you're not in that league");
      await checkOrder(client, toLeague(row), { id: row.portfolio_id, cash: row.cash }, input, this.marks);
      const inserted = await client.query(
        `INSERT INTO orders (user_id, portfolio_id, symbol_id, side, type, tif, price, stop_price, qty, leaves)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
        [userId, row.portfolio_id, input.symbolId, input.side, input.type, input.tif, input.price ?? null, input.stopPrice ?? null, input.qty],
      );
      id = inserted.rows[0].id;
      account = row.portfolio_id;
    });

    const reply = await this.bridge.submit({
      account,
      clOrdId: id,
      symbol: input.symbolId,
      side: SIDES[input.side],
      ordType: TYPES[input.type],
      tif: TIFS[input.tif],
      price: input.price ?? 0,
      stopPrice: input.stopPrice ?? 0,
      qty: input.qty,
      // All of one user's portfolios share a self-trade group, so nobody can move
      // money from one league to another by trading with themselves.
      stpGroup: userId,
    });
    // The ack/reject is applied through the event queue; wait for it so the
    // response shows the order as the engine left it (including any instant fills).
    if (reply) await this.settled();
    return (await this.get(userId, id))!;
  }

  async cancel(userId: number, orderId: number): Promise<Order> {
    const order = await this.db.query(
      "SELECT id, portfolio_id, symbol_id, engine_order_id, status FROM orders WHERE id = $1 AND user_id = $2",
      [orderId, userId],
    );
    const row = order.rows[0];
    if (!row) throw new ApiError(404, "not_found", "no such order");
    if (!["open", "partially_filled"].includes(row.status) || !row.engine_order_id) {
      throw new ApiError(409, "not_open", `order is ${row.status}`);
    }
    if (!this.bridge.connected) throw new ApiError(503, "exchange_down", "the exchange is not connected");

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
    const reject = await Promise.race([this.bridge.cancel(row.portfolio_id, row.engine_order_id, row.symbol_id), done.then(() => null)]);
    if (reject && reject.type === p.EventType.Reject) {
      await this.settled();
      const current = (await this.get(userId, orderId))!;
      if (current.status === "filled") throw new ApiError(409, "not_open", "order already filled");
      throw new ApiError(409, "cancel_rejected", p.REJECT_REASONS[reject.reason] ?? "rejected");
    }
    await done;
    await this.settled();
    return (await this.get(userId, orderId))!;
  }

  async get(userId: number, id: number): Promise<Order | null> {
    const { rows } = await this.db.query(
      `SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE o.id = $1 AND o.user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async list(userId: number, opts: { open?: boolean; league?: number; limit: number; before?: number }): Promise<Order[]> {
    const { rows } = await this.db.query(
      `SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM}
       WHERE o.user_id = $1 AND ($2::boolean IS NOT TRUE OR o.status IN ('pending', 'open', 'partially_filled'))
         AND ($3::bigint IS NULL OR o.id < $3) AND ($5::bigint IS NULL OR pf.league_id = $5)
       ORDER BY o.id DESC LIMIT $4`,
      [userId, opts.open ?? null, opts.before ?? null, opts.limit, opts.league ?? null],
    );
    return rows.map(toOrder);
  }

  async fills(userId: number, opts: { league?: number; limit: number }): Promise<Fill[]> {
    const { rows } = await this.db.query(
      `SELECT f.id, f.order_id, pf.league_id, s.ticker AS symbol, f.side, f.price, f.qty, f.commission, f.created_at
       FROM fills f JOIN symbols s ON s.id = f.symbol_id JOIN portfolios pf ON pf.id = f.portfolio_id
       WHERE f.user_id = $1 AND ($3::bigint IS NULL OR pf.league_id = $3) ORDER BY f.id DESC LIMIT $2`,
      [userId, opts.limit, opts.league ?? null],
    );
    return rows.map((r) => ({
      id: r.id, orderId: r.order_id, league: r.league_id, symbol: r.symbol, side: r.side, price: r.price, qty: r.qty,
      commission: r.commission, createdAt: r.created_at.toISOString(),
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
      "SELECT id, user_id, portfolio_id, symbol_id, side, qty FROM orders WHERE engine_order_id = $1 FOR UPDATE",
      [e.orderId],
    );
    if (byEngineId.rows[0]) return byEngineId.rows[0];
    const byClId = await client.query(
      `UPDATE orders SET engine_order_id = $1 WHERE id = $2 AND portfolio_id = $3 AND engine_order_id IS NULL
       RETURNING id, user_id, portfolio_id, symbol_id, side, qty`,
      [e.orderId, e.clOrdId, e.account],
    );
    return byClId.rows[0];
  }

  private async apply(e: p.EngineEvent): Promise<void> {
    let id: number | undefined;
    let userId: number | undefined;
    switch (e.type) {
      case p.EventType.Ack: {
        const r = await this.db.query(
          `UPDATE orders SET engine_order_id = $2, status = 'open', updated_at = now()
           WHERE id = $1 AND portfolio_id = $3 AND status = 'pending' RETURNING id, user_id`,
          [e.clOrdId, e.orderId, e.account],
        );
        ({ id, user_id: userId } = r.rows[0] ?? {});
        break;
      }
      case p.EventType.Reject: {
        // Rejects for cancel requests carry the cancel's own id, which matches no order.
        const r = await this.db.query(
          `UPDATE orders SET status = 'rejected', leaves = 0, reject_reason = $2, updated_at = now()
           WHERE id = $1 AND portfolio_id = $3 AND status = 'pending' RETURNING id, user_id`,
          [e.clOrdId, p.REJECT_REASONS[e.reason] ?? String(e.reason), e.account],
        );
        ({ id, user_id: userId } = r.rows[0] ?? {});
        break;
      }
      case p.EventType.Fill: {
        let fill: { orderId: number; league: number; commission: number } | undefined;
        await this.tx(async (client) => {
          const o = await this.orderForEvent(client, e);
          if (!o) return;
          id = o.id;
          userId = o.user_id;
          const league = await client.query(
            `SELECT ${LEAGUE_COLUMNS} FROM portfolios pf JOIN leagues l ON l.id = pf.league_id WHERE pf.id = $1`,
            [o.portfolio_id],
          );
          const fee = commission(toLeague(league.rows[0]), e.price, e.qty);
          // The fill row goes in first: if this exact fill was already recorded
          // (a replayed or duplicated event), nothing below runs.
          const inserted = await client.query(
            `INSERT INTO fills (order_id, user_id, portfolio_id, symbol_id, side, price, qty, commission, trade_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
            [o.id, o.user_id, o.portfolio_id, o.symbol_id, o.side, e.price, e.qty, fee, e.tradeId],
          );
          if (!inserted.rows[0]) return;
          await applyFill(client, o.portfolio_id, { symbolId: o.symbol_id, side: o.side, price: e.price, qty: e.qty, commission: fee });
          await client.query(
            `UPDATE orders SET leaves = $2, filled_qty = filled_qty + $3,
               status = CASE WHEN $2 = 0 THEN 'filled'::order_status ELSE 'partially_filled'::order_status END,
               reject_reason = NULL, updated_at = now()
             WHERE id = $1`,
            [o.id, e.leaves, e.qty],
          );
          fill = { orderId: o.id, league: league.rows[0].id, commission: fee };
        });
        if (fill) {
          this.emit(`fill:${userId}`, {
            ...fill, symbol: e.symbol, side: e.side === p.Side.Buy ? "buy" : "sell", price: e.price, qty: e.qty,
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
          userId = o.user_id;
        });
        break;
      }
      case p.EventType.Replaced: {
        const r = await this.db.query(
          `UPDATE orders SET price = $2, leaves = $3, updated_at = now() WHERE engine_order_id = $1 RETURNING id, user_id`,
          [e.orderId, e.price, e.qty],
        );
        ({ id, user_id: userId } = r.rows[0] ?? {});
        break;
      }
    }
    if (id !== undefined && userId !== undefined) {
      const order = await this.get(userId, id);
      if (order) this.emit(`user:${userId}`, order);
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
