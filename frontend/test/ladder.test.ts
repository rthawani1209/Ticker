import { describe, expect, it } from "vitest";

import { addTrade } from "@/components/trade/useTrading";
import type { Order } from "@/lib/api";
import { ladderRows } from "@/lib/ladder";

const order = (o: Partial<Order>): Order =>
  ({ symbol: "NOVA", side: "buy", price: 100_00, leaves: 5, ...o }) as Order;

describe("depth ladder", () => {
  it("lists asks above bids, highest price first, with your own size marked", () => {
    const rows = ladderRows(
      {
        bids: [
          { price: 100_00, qty: 30 },
          { price: 99_90, qty: 10 },
        ],
        asks: [
          { price: 100_10, qty: 7 },
          { price: 100_20, qty: 3 },
        ],
      },
      [order({}), order({ symbol: "HELX" }), order({ side: "sell", price: 100_20, leaves: 2 })],
      "NOVA",
    );
    expect(rows.map((r) => r.price)).toEqual([100_20, 100_10, 100_00, 99_90]);
    expect(rows[0]).toMatchObject({ ask: 3, mineSell: 2 });
    expect(rows[2]).toMatchObject({ bid: 30, mineBuy: 5 });
  });
});

describe("chart bars", () => {
  const trade = (price: number, qty: number, ms: number) => ({
    price,
    qty,
    side: "buy" as const,
    tradeId: ms,
    time: ms,
  });

  it("folds trades into 15-second bars", () => {
    let bars = addTrade([], 15, trade(100, 1, 30_000));
    bars = addTrade(bars, 15, trade(105, 2, 31_000));
    bars = addTrade(bars, 15, trade(98, 1, 44_999));
    expect(bars).toEqual([{ time: 30, open: 100, high: 105, low: 98, close: 98, volume: 4 }]);
    bars = addTrade(bars, 15, trade(101, 1, 45_000));
    expect(bars).toHaveLength(2);
    expect(bars[1]).toMatchObject({ time: 45, open: 101 });
  });
});
