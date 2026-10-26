// The backend's single connection to ticker-engine. Logs on as a proxy (so it can
// trade for any user's account) with market data on, keeps a copy of every book,
// and reconnects if the engine restarts.
import { EventEmitter } from "node:events";
import net from "node:net";

import * as p from "./protocol.js";
import { SymbolBook } from "./market.js";

export interface BridgeOptions {
  host: string;
  port: number;
  token: bigint;
  refPrices: number[]; // starting price per symbol id
}

interface Waiter {
  resolve: (e: p.EngineEvent) => void;
  timer: NodeJS.Timeout;
}

export class EngineDown extends Error {
  constructor() {
    super("exchange is not connected");
  }
}

export class EngineBridge extends EventEmitter {
  books: SymbolBook[];
  stats = new Map<number, p.Stats>();
  connected = false;
  private socket: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private session = 0;
  private stopped = false;
  private retryMs = 250;
  private waiters = new Map<number, Waiter>(); // by cl_ord_id
  private nextCancelId = 2 ** 50; // cancel requests get their own id range, away from order ids

  constructor(private opts: BridgeOptions) {
    super();
    this.books = opts.refPrices.map((px) => new SymbolBook(px));
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      sock.setNoDelay(true);
      let loggedOn = false;

      sock.on("connect", () => {
        sock.write(p.logon(0, p.Flags.Proxy | p.Flags.MarketData, this.opts.token));
      });
      sock.on("data", (chunk) => {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        let msgs: Buffer[];
        try {
          [msgs, this.buf] = p.split(this.buf);
        } catch (err) {
          this.emit("warn", `engine sent garbage: ${(err as Error).message}`);
          sock.destroy();
          return;
        }
        for (const raw of msgs) {
          const m = p.decode(raw);
          if (m.kind === "logon_ack") {
            loggedOn = true;
            this.onLogon(sock, m.session);
            resolve();
          } else if (m.kind === "error") {
            this.emit("warn", `engine error: ${m.code}`);
            if (!loggedOn) reject(new Error(`engine refused logon: ${m.code}`));
          } else if (m.kind === "stats") {
            this.stats.set(m.shard, m);
          } else {
            this.onEvent(m);
          }
        }
      });
      sock.on("error", (err) => {
        if (!loggedOn) reject(err);
      });
      sock.on("close", () => {
        const wasUp = this.connected && this.socket === sock;
        if (this.socket === sock) {
          this.connected = false;
          this.socket = null;
        }
        if (wasUp) this.emit("down");
        if (loggedOn && !this.stopped) this.reconnectLater();
      });
    });
  }

  private reconnectLater(): void {
    setTimeout(() => {
      if (this.stopped) return;
      this.connect().then(
        () => (this.retryMs = 250),
        () => {
          this.retryMs = Math.min(this.retryMs * 2, 5000);
          this.reconnectLater();
        },
      );
    }, this.retryMs);
  }

  private onLogon(sock: net.Socket, session: number): void {
    this.socket = sock;
    this.session = session;
    this.connected = true;
    // Fresh snapshots: the books may have moved while we were away.
    for (let s = 0; s < this.books.length; s++) {
      this.books[s]!.bids.clear();
      this.books[s]!.asks.clear();
      sock.write(p.symbolMsg(p.MsgType.Subscribe, s));
    }
    this.emit("up", session);
  }

  private onEvent(e: p.EngineEvent): void {
    const book = this.books[e.symbol];
    const now = Date.now();
    if (e.session === 0 || e.type === p.EventType.SnapshotLevel || e.type === p.EventType.SnapshotEnd) {
      book?.apply(e, now);
      this.emit("market", e);
      return;
    }
    if (e.type === p.EventType.Ack || e.type === p.EventType.Reject) {
      const w = this.waiters.get(e.clOrdId);
      if (w) {
        clearTimeout(w.timer);
        this.waiters.delete(e.clOrdId);
        w.resolve(e);
      }
    }
    this.emit("private", e);
  }

  private write(msg: Buffer): void {
    if (!this.socket || !this.connected) throw new EngineDown();
    this.socket.write(msg);
  }

  // Sends an order and resolves with its Ack or Reject (or null if the engine
  // doesn't answer in time, which leaves the order's fate unknown until events arrive).
  submit(fields: p.NewOrderFields, timeoutMs = 2000): Promise<p.EngineEvent | null> {
    return new Promise((resolve, reject) => {
      try {
        this.write(p.newOrder(fields));
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        this.waiters.delete(fields.clOrdId);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(fields.clOrdId, { resolve, timer });
    });
  }

  // Asks the engine to cancel. Success shows up as a Cancelled event for the order;
  // this resolves with a Reject if the engine refused (e.g. the order already filled),
  // or null otherwise.
  cancel(account: number, orderId: number, symbol: number, timeoutMs = 2000): Promise<p.EngineEvent | null> {
    const id = this.nextCancelId++;
    return new Promise((resolve, reject) => {
      try {
        this.write(p.cancel(account, id, orderId, symbol));
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(id, { resolve, timer });
    });
  }
}
