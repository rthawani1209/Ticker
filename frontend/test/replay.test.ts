import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { replayDepth, replaySymbols, replayTrades, type Recording } from "@/lib/replay";

const rec = JSON.parse(
  readFileSync(resolve(__dirname, "../public/replay/market.json"), "utf8"),
) as Recording;

describe("recorded replay", () => {
  it("is a real recording with a book and trades", () => {
    expect(rec.frames.length).toBeGreaterThanOrEqual(60);
    expect(rec.frames.some((f) => Object.keys(f.t).length > 0)).toBe(true);
  });

  it("turns a frame into the same shapes the live API returns", () => {
    const symbols = replaySymbols(rec, 0);
    expect(symbols.map((s) => s.ticker)).toEqual(rec.symbols.map((s) => s.ticker));
    const nova = symbols.find((s) => s.ticker === "NOVA")!;
    expect(nova.change).toBe(nova.last - nova.refPrice);

    const depth = replayDepth(rec, 0, "NOVA");
    expect(depth.bids.length).toBeGreaterThan(0);
    // a crossed book would mean the recording is broken
    expect(depth.bids[0]!.price).toBeLessThan(depth.asks[0]!.price);
  });

  it("gives every replayed trade a unique id", () => {
    const ids = rec.frames.flatMap((_, i) => replayTrades(rec, i, "NOVA", 0).map((t) => t.tradeId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
