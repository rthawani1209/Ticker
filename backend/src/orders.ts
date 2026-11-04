// Orders as the API sees them: stored in Postgres, sent to the engine through the
// bridge, and kept up to date from the engine's private events.
//
// Every order belongs to a portfolio (one per user per league), and the portfolio id
// is the account the engine sees. Fills update the ledger in the same transaction.
import { EventEmitter } from "node:events";

import type { PoolClient } from "pg";

import type { Db } from "./db/pool.js";
import { EngineDown, type EngineBridge } from "./engine/bridge.js";
import * as p from "./engine/protocol.js";
import { ApiError } from "./errors.js";
import {
  applyFill,
  checkOrder,
  commission,
  LEAGUE_COLUMNS,
  toLeague,
  type Marks,
} from "./ledger.js";

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
  takeProfit?: number; // bracket exits, cents
  stopLoss?: number;
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
  takeProfit: number | null;
  stopLoss: number | null;
  parentId: number | null; // set on a bracket's exit orders
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
  limit: p.OrdType.Limit,
  market: p.OrdType.Market,
  stop: p.OrdType.Stop,
  stop_limit: p.OrdType.StopLimit,
};
const TIFS: Record<TifName, p.TIF> = { gtc: p.TIF.GTC, ioc: p.TIF.IOC, fok: p.TIF.FOK };

const ORDER_COLUMNS = `o.id, pf.league_id, s.ticker AS symbol, o.side, o.type, o.tif, o.price, o.stop_price, o.qty, o.leaves,
  o.filled_qty, o.status, o.reject_reason, o.take_profit, o.stop_loss, o.parent_id, o.created_at, o.updated_at`;

function toOrder(r: any): Order {
  return {
    id: r.id,
    league: r.league_id,
    symbol: r.symbol,
    side: r.side,
    type: r.type,
    tif: r.tif,
    price: r.price,
    stopPrice: r.stop_price,
    qty: r.qty,
    leaves: r.leaves,
    filledQty: r.filled_qty,
    status: r.status,
    rejectReason: r.reject_reason,
    takeProfit: r.take_profit,
    stopLoss: r.stop_loss,
    parentId: r.parent_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const ORDER_FROM =
  "orders o JOIN symbols s ON s.id = o.symbol_id JOIN portfolios pf ON pf.id = o.portfolio_id";

export class OrderService extends EventEmitter {
  // Engine events are applied to the database one at a time, in arrival order.
  private queue: Promise<void> = Promise.resolve();

  readonly marks: Marks;

  constructor(
    private db: Db,
    private bridge: EngineBridge,
  ) {
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
    if (!this.bridge.connected)
      throw new ApiError(503, "exchange_down", "the exchange is not connected");
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
      await checkOrder(
        client,
        toLeague(row),
        { id: row.portfolio_id, cash: row.cash },
        input,
        this.marks,
      );
      id = await insertOrder(client, userId, row.portfolio_id, input);
      account = row.portfolio_id;
    });
    return this.send(userId, id, account, input);
  }

  private async send(userId: number, id: number, account: number, input: OrderInput) {
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

  // Bracket bookkeeping runs after an order's fill, ack or cancel has been written. It
  // runs outside the event queue (send() waits on that queue), one bracket at a time.
  private afterUpdate(orderId: number): void {
    setImmediate(() => this.bracketsFor(orderId).catch((err) => this.emit("error", err)));
  }

  private bracketLocks = new Map<number, Promise<void>>();

  private serial(entryId: number, fn: () => Promise<void>): Promise<void> {
    const next = (this.bracketLocks.get(entryId) ?? Promise.resolve()).then(fn);
    const tail = next.catch(() => {});
    this.bracketLocks.set(entryId, tail);
    tail.then(() => {
      if (this.bracketLocks.get(entryId) === tail) this.bracketLocks.delete(entryId);
    });
    return next;
  }

  // The brackets an update can affect: its own (as entry or exit), or for any other
  // order, every bracket on that stock in that portfolio, because the position moved.
  private async bracketsFor(orderId: number): Promise<void> {
    const { rows } = await this.db.query(
      "SELECT id, parent_id, take_profit, portfolio_id, symbol_id FROM orders WHERE id = $1",
      [orderId],
    );
    const o = rows[0];
    if (!o) return;
    let entries: number[];
    if (o.parent_id !== null) entries = [o.parent_id];
    else if (o.take_profit !== null) entries = [o.id];
    else {
      const r = await this.db.query(
        `SELECT DISTINCT parent_id FROM orders WHERE portfolio_id = $1 AND symbol_id = $2
           AND parent_id IS NOT NULL AND status IN ('pending', 'open', 'partially_filled')`,
        [o.portfolio_id, o.symbol_id],
      );
      entries = r.rows.map((x) => x.parent_id);
    }
    for (const id of entries) await this.serial(id, () => this.syncExits(id));
  }

  // Brings a bracket's exits in line with what they protect: the entry's filled quantity,
  // minus what the exits have already closed, capped at the position actually held (if
  // the shares went some other way, an exit must not turn into a short). The take-profit
  // and the stop-loss should each be working for exactly that much. So a partial fill of
  // one shrinks the other, a full fill cancels it, and the first sync after the entry is
  // done sends both. Exits skip the buying-power check, which this keeps safe.
  private async syncExits(entryId: number): Promise<void> {
    // Nothing can be sent or cancelled now; reconcile() runs this again on reconnect.
    if (!this.bridge.connected) return;
    const { rows } = await this.db.query(
      `SELECT id, user_id, portfolio_id, symbol_id, side, status, filled_qty, take_profit, stop_loss
       FROM orders WHERE id = $1`,
      [entryId],
    );
    const e = rows[0];
    if (!e || e.take_profit === null || e.filled_qty === 0) return;
    if (!["filled", "cancelled"].includes(e.status)) return;

    const [exitRows, pos] = await Promise.all([
      this.db.query(
        `SELECT id, type, status, leaves, filled_qty, price, engine_order_id, reject_reason
         FROM orders WHERE parent_id = $1 ORDER BY id`,
        [entryId],
      ),
      this.db.query("SELECT qty FROM positions WHERE portfolio_id = $1 AND symbol_id = $2", [
        e.portfolio_id,
        e.symbol_id,
      ]),
    ]);
    const exits = exitRows.rows;
    const held = (pos.rows[0]?.qty ?? 0) * (e.side === "buy" ? 1 : -1);
    const closed = exits.reduce((sum, x) => sum + x.filled_qty, 0);
    const protect = Math.max(0, Math.min(e.filled_qty - closed, held));

    const base = {
      symbolId: e.symbol_id,
      side: (e.side === "buy" ? "sell" : "buy") as SideName,
      tif: "gtc" as const,
    };
    const exit = (type: "limit" | "stop", qty: number): OrderInput =>
      type === "limit"
        ? { ...base, qty, type, price: Number(e.take_profit) }
        : { ...base, qty, type, stopPrice: Number(e.stop_loss) };

    const toSend: OrderInput[] = [];
    for (const type of ["limit", "stop"] as const) {
      const legs = exits.filter((x) => x.type === type);
      // 'resized' marks a stop we're cancelling to replace with a smaller one.
      const working = legs.filter(
        (x) =>
          ["pending", "open", "partially_filled"].includes(x.status) &&
          x.reject_reason !== "resized",
      );
      if (working.length === 0) {
        // Send it if it was never sent, or if the exchange was down when it was.
        const latest = legs.at(-1);
        const unsent =
          !latest ||
          (latest.status === "rejected" && latest.reject_reason === "exchange_unavailable");
        if (protect > 0 && unsent) toSend.push(exit(type, protect));
        continue;
      }
      for (const x of working) {
        // A pending exit gets checked again when its ack arrives.
        if (x.leaves <= protect || x.engine_order_id === null) continue;
        if (protect === 0) {
          this.bridge.cancel(e.portfolio_id, x.engine_order_id, e.symbol_id).catch(() => {});
        } else if (type === "limit") {
          this.bridge.replace(
            e.portfolio_id,
            x.id,
            x.engine_order_id,
            e.symbol_id,
            protect,
            x.price,
          );
        } else {
          // The engine can't amend a waiting stop, so cancel it and send a smaller one.
          await this.db.query("UPDATE orders SET reject_reason = 'resized' WHERE id = $1", [x.id]);
          this.bridge.cancel(e.portfolio_id, x.engine_order_id, e.symbol_id).catch(() => {});
          toSend.push(exit("stop", protect));
        }
      }
    }
    if (toSend.length === 0) return;

    const ids: number[] = [];
    await this.tx(async (client) => {
      for (const x of toSend)
        ids.push(await insertOrder(client, e.user_id, e.portfolio_id, x, e.id));
      await client.query("UPDATE orders SET exits_sent = true WHERE id = $1", [e.id]);
    });
    for (const [i, x] of toSend.entries()) {
      try {
        await this.send(e.user_id, ids[i]!, e.portfolio_id, x);
      } catch (err) {
        if (!(err instanceof EngineDown)) throw err;
        // Lost the exchange mid-way: mark it so the reconnect sweep sends it again.
        await this.db.query(
          `UPDATE orders SET status = 'rejected', leaves = 0, reject_reason = 'exchange_unavailable'
           WHERE id = $1 AND status = 'pending'`,
          [ids[i]],
        );
      }
    }
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
    if (!this.bridge.connected)
      throw new ApiError(503, "exchange_down", "the exchange is not connected");

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
    const reject = await Promise.race([
      this.bridge.cancel(row.portfolio_id, row.engine_order_id, row.symbol_id),
      done.then(() => null),
    ]);
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

  async list(
    userId: number,
    opts: { open?: boolean; league?: number; limit: number; before?: number },
  ): Promise<Order[]> {
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
      id: r.id,
      orderId: r.order_id,
      league: r.league_id,
      symbol: r.symbol,
      side: r.side,
      price: r.price,
      qty: r.qty,
      commission: r.commission,
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
    // Brackets whose entry finished while the exchange was away, or whose exits it
    // refused or couldn't be resized, get synced now. Not awaited: this runs inside the
    // event queue, and sending waits on that queue.
    const brackets = await this.db.query(
      `SELECT id FROM orders o WHERE take_profit IS NOT NULL AND parent_id IS NULL AND filled_qty > 0
         AND status IN ('filled', 'cancelled')
         AND (NOT exits_sent OR EXISTS (
           SELECT 1 FROM orders c WHERE c.parent_id = o.id AND (c.status IN ('pending', 'open', 'partially_filled')
             OR c.reject_reason = 'exchange_unavailable')))`,
    );
    for (const r of brackets.rows) {
      this.serial(r.id, () => this.syncExits(r.id)).catch((err) => this.emit("error", err));
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
        if (id !== undefined) this.afterUpdate(id);
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
          await applyFill(client, o.portfolio_id, {
            symbolId: o.symbol_id,
            side: o.side,
            price: e.price,
            qty: e.qty,
            commission: fee,
          });
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
          this.afterUpdate(fill.orderId);
          this.emit(`fill:${userId}`, {
            ...fill,
            symbol: e.symbol,
            side: e.side === p.Side.Buy ? "buy" : "sell",
            price: e.price,
            qty: e.qty,
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
        if (id !== undefined) this.afterUpdate(id);
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

async function insertOrder(
  client: PoolClient,
  userId: number,
  portfolioId: number,
  input: OrderInput,
  parentId: number | null = null,
): Promise<number> {
  const { rows } = await client.query(
    `INSERT INTO orders (user_id, portfolio_id, symbol_id, side, type, tif, price, stop_price, qty, leaves,
       take_profit, stop_loss, parent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12) RETURNING id`,
    [
      userId,
      portfolioId,
      input.symbolId,
      input.side,
      input.type,
      input.tif,
      input.price ?? null,
      input.stopPrice ?? null,
      input.qty,
      input.takeProfit ?? null,
      input.stopLoss ?? null,
      parentId,
    ],
  );
  return rows[0].id;
}
