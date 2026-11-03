import { describe, expect, it } from "vitest";

import { applyLevel, cumulative, depthGeometry } from "@/lib/depth";

const book = {
  bids: [
    { price: 10_00, qty: 5 },
    { price: 9_98, qty: 10 },
  ],
  asks: [
    { price: 10_02, qty: 3 },
    { price: 10_05, qty: 12 },
  ],
};

describe("depth", () => {
  it("adds up size from the best price outward", () => {
    expect(cumulative(book.bids)).toEqual([
      { price: 10_00, total: 5 },
      { price: 9_98, total: 15 },
    ]);
  });

  it("puts bids left of the spread and asks right of it", () => {
    const g = depthGeometry(book, 100, 50);
    expect(g.bidX).not.toBeNull();
    expect(g.bidX!).toBeLessThan(g.askX!);
    // the bid area runs to the left edge, the ask area to the right edge
    expect(g.bid).toContain("H0.0");
    expect(g.ask).toContain("H100.0");
  });

  it("draws nothing for an empty book", () => {
    expect(depthGeometry({ bids: [], asks: [] }, 100, 50)).toEqual({
      bid: "",
      ask: "",
      bidX: null,
      askX: null,
    });
  });

  it("applies level updates and keeps each side sorted best first", () => {
    let b = applyLevel(book, "bid", 10_01, 7);
    expect(b.bids.map((l) => l.price)).toEqual([10_01, 10_00, 9_98]);
    b = applyLevel(b, "ask", 10_02, 0);
    expect(b.asks).toEqual([{ price: 10_05, qty: 12 }]);
    b = applyLevel(b, "bid", 10_00, 9);
    expect(b.bids[1]).toEqual({ price: 10_00, qty: 9 });
  });
});
