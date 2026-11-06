// Market data fan-out between gateway processes. One gateway (MARKET_PUBLISHER=true)
// turns engine events into channel messages and publishes them; every gateway,
// including that one, subscribes and pushes them to its own WebSocket clients.
// With Redis this works across processes. Without it, messages stay in-process,
// which is what a single gateway needs.
//
// The market-sim publishes news headlines to the same Redis channel.
import type { Redis } from "ioredis";

export const FANOUT_CHANNEL = "ticker:md";

export type FanoutHandler = (channel: string, data: unknown) => void;

export interface Fanout {
  publish(channel: string, data: unknown): void;
  subscribe(handler: FanoutHandler): () => void;
  close(): Promise<void>;
}

export class LocalFanout implements Fanout {
  private handlers = new Set<FanoutHandler>();

  publish(channel: string, data: unknown) {
    for (const h of this.handlers) h(channel, data);
  }

  subscribe(handler: FanoutHandler) {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  }

  async close() {
    this.handlers.clear();
  }
}

export class RedisFanout implements Fanout {
  private handlers = new Set<FanoutHandler>();
  private sub: Redis;
  readonly ready: Promise<unknown>;

  constructor(private pub: Redis) {
    // A connection in subscriber mode can't run other commands, so it gets its own.
    this.sub = pub.duplicate();
    this.sub.on("message", (_chan: string, raw: string) => {
      let msg: { channel?: unknown; data?: unknown };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof msg.channel !== "string") return;
      for (const h of this.handlers) h(msg.channel, msg.data);
    });
    this.ready = this.sub.subscribe(FANOUT_CHANNEL);
  }

  publish(channel: string, data: unknown) {
    // Fire and forget: a lost tick is replaced by the next one, and the book
    // deltas carry absolute level sizes, so a gap heals on the next change.
    this.pub.publish(FANOUT_CHANNEL, JSON.stringify({ channel, data })).catch(() => {});
  }

  subscribe(handler: FanoutHandler) {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  }

  async close() {
    this.handlers.clear();
    this.sub.disconnect();
  }
}
