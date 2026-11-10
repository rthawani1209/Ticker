import { describe, expect, it } from "vitest";

import { parseDollars } from "@/lib/format";
import { amendChange, ticketOrder, type Ticket } from "@/lib/ticket";

const base: Ticket = {
  side: "buy",
  type: "limit",
  qty: "10",
  price: "142.35",
  stop: "",
  takeProfit: "",
  stopLoss: "",
};

describe("order ticket", () => {
  it("reads dollar amounts as cents", () => {
    expect(parseDollars("142.35")).toBe(14235);
    expect(parseDollars("$1,042.5")).toBe(104250);
    expect(parseDollars("0")).toBeNull();
    expect(parseDollars("1.234")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
  });

  it("builds each order type", () => {
    expect(ticketOrder(base, "NOVA")).toEqual({
      symbol: "NOVA",
      side: "buy",
      type: "limit",
      qty: 10,
      price: 14235,
    });
    expect(ticketOrder({ ...base, type: "market" }, "NOVA")).toMatchObject({ type: "market" });
    expect(ticketOrder({ ...base, type: "stop", stop: "140" }, "NOVA")).toMatchObject({
      type: "stop",
      stopPrice: 14000,
    });
    expect(
      ticketOrder({ ...base, type: "stop_limit", stop: "143", price: "143.50" }, "NOVA"),
    ).toEqual({
      symbol: "NOVA",
      side: "buy",
      type: "stop_limit",
      qty: 10,
      stopPrice: 14300,
      price: 14350,
    });
    expect(ticketOrder({ ...base, type: "stop_limit", stop: "" }, "NOVA")).toBe(
      "Enter a stop price",
    );
    expect(ticketOrder({ ...base, type: "stop_limit", stop: "143", price: "" }, "NOVA")).toBe(
      "Enter a limit price",
    );
  });

  it("puts bracket exits on the right sides of the entry", () => {
    const long = { ...base, type: "bracket" as const, takeProfit: "150", stopLoss: "138" };
    expect(ticketOrder(long, "NOVA")).toMatchObject({ takeProfit: 15000, stopLoss: 13800 });
    expect(ticketOrder({ ...long, takeProfit: "138", stopLoss: "150" }, "NOVA")).toMatch(
      /above the entry/,
    );
    const short = { ...long, side: "sell" as const, takeProfit: "138", stopLoss: "150" };
    expect(ticketOrder(short, "NOVA")).toMatchObject({ side: "sell", takeProfit: 13800 });
  });

  it("says what's missing instead of sending a bad order", () => {
    expect(ticketOrder({ ...base, qty: "0" }, "NOVA")).toMatch(/whole number/);
    expect(ticketOrder({ ...base, price: "" }, "NOVA")).toMatch(/limit price/);
    expect(ticketOrder({ ...base, type: "bracket" }, "NOVA")).toMatch(/take-profit/);
  });
});

describe("amend", () => {
  const now = { price: 14000, leaves: 10 };
  it("sends only what changed", () => {
    expect(amendChange("140.50", "10", now)).toEqual({ price: 14050 });
    expect(amendChange("140.00", "4", now)).toEqual({ qty: 4 });
    expect(amendChange("", "12", now)).toEqual({ qty: 12 });
    expect(amendChange("140", "10", now)).toBe("Nothing to change");
  });
  it("says what's wrong", () => {
    expect(amendChange("abc", "10", now)).toBe("Enter a price in dollars and cents");
    expect(amendChange("141", "0", now)).toBe("Enter a whole number of shares");
  });
});
