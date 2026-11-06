import { describe, expect, it } from "vitest";

import { downsample, maxDrawdown, winRate } from "../src/analytics.js";

describe("max drawdown", () => {
  it("is the biggest fall from a running peak", () => {
    // Peak 120 -> 90 is 25%; the later 130 -> 110 is only about 15%.
    expect(maxDrawdown([100, 120, 90, 130, 110])).toBeCloseTo(0.25);
  });
  it("is zero when the curve only goes up or is too short", () => {
    expect(maxDrawdown([100, 101, 105])).toBe(0);
    expect(maxDrawdown([100])).toBe(0);
    expect(maxDrawdown([])).toBe(0);
  });
});

describe("win rate", () => {
  const fill = (
    side: "buy" | "sell",
    price: number,
    qty: number,
    commission = 0,
    symbolId = 0,
  ) => ({
    symbolId,
    side,
    price,
    qty,
    commission,
  });

  it("counts each closing fill as one round trip", () => {
    const r = winRate([
      fill("buy", 100, 10),
      fill("sell", 110, 5), // win
      fill("sell", 95, 5), // loss
      fill("sell", 90, 3), // opens a short, not a close
      fill("buy", 80, 3), // win on the short
    ]);
    expect(r).toEqual({ wins: 2, closed: 3, rate: 2 / 3 });
  });

  it("takes commission off before calling it a win", () => {
    const r = winRate([fill("buy", 100, 1), fill("sell", 101, 1, 5)]);
    expect(r).toEqual({ wins: 0, closed: 1, rate: 0 });
  });

  it("keeps symbols apart and returns null with nothing closed", () => {
    expect(winRate([fill("buy", 100, 1, 0, 1), fill("sell", 200, 1, 0, 2)]).rate).toBeNull();
  });
});

describe("downsample", () => {
  it("keeps the ends and at most max points", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsample(pts, 50);
    expect(out).toHaveLength(50);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(999);
    expect(downsample([1, 2, 3], 50)).toEqual([1, 2, 3]);
  });
});
