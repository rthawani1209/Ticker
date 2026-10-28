import { describe, expect, it } from "vitest";

import { formatChange, formatMoney, formatPrice } from "@/lib/format";

describe("format", () => {
  it("shows cents as dollars with two decimals", () => {
    expect(formatPrice(14237)).toBe("142.37");
    expect(formatPrice(31145000)).toBe("311,450.00");
    expect(formatMoney(10438217)).toBe("$104,382.17");
  });

  it("puts an arrow and a sign on changes so they read without color", () => {
    expect(formatChange(14237, 13925)).toEqual({ text: "▲ +2.24%", dir: "up" });
    expect(formatChange(2486, 2574)).toEqual({ text: "▼ −3.42%", dir: "down" });
    expect(formatChange(5800, 5800)).toEqual({ text: "■ 0.00%", dir: "flat" });
  });
});
