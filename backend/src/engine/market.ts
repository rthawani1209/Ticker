// Live market state rebuilt from the engine's public events.
import { EventType, Side, type EngineEvent } from "./protocol.js";

export interface Trade { price: number; qty: number; side: "buy" | "sell"; tradeId: number; time: number }

export class SymbolBook {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  trades: Trade[] = []; // newest last
  halted = false;
  haltedUntil = 0;
  volume = 0;

  constructor(public last: number) {}

  apply(e: EngineEvent, now: number): void {
    switch (e.type) {
      case EventType.BookDelta:
      case EventType.SnapshotLevel: {
        const levels = e.side === Side.Buy ? this.bids : this.asks;
        if (e.levelQty > 0) levels.set(e.price, e.levelQty);
        else levels.delete(e.price);
        break;
      }
      case EventType.Trade:
        this.last = e.price;
        this.volume += e.qty;
        this.trades.push({ price: e.price, qty: e.qty, side: e.side === Side.Buy ? "buy" : "sell", tradeId: e.tradeId, time: now });
        if (this.trades.length > 200) this.trades.splice(0, this.trades.length - 200);
        break;
      case EventType.SnapshotEnd:
        if (e.price) this.last = e.price;
        break;
      case EventType.TradingStatus:
        this.halted = e.reason === 1;
        this.haltedUntil = this.halted ? e.levelQty : 0;
        break;
    }
  }

  bestAsk(): number | undefined {
    let best: number | undefined;
    for (const price of this.asks.keys()) if (best === undefined || price < best) best = price;
    return best;
  }

  depth(levels = 10) {
    const sorted = (m: Map<number, number>, desc: boolean) =>
      [...m.entries()].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).slice(0, levels)
        .map(([price, qty]) => ({ price, qty }));
    return { bids: sorted(this.bids, true), asks: sorted(this.asks, false) };
  }
}
