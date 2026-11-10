import type { NewOrder, Side } from "./api";
import { parseDollars } from "./format";

export type TicketType = "limit" | "market" | "stop" | "stop_limit" | "bracket";

export interface Ticket {
  side: Side;
  type: TicketType;
  qty: string;
  price: string; // limit price; also the entry for a bracket
  stop: string; // stop trigger, for stop and stop-limit
  takeProfit: string;
  stopLoss: string;
}

// Turns what's typed in the ticket into an order, or says what's wrong with it.
export function ticketOrder(t: Ticket, symbol: string): NewOrder | string {
  const qty = Number(t.qty);
  if (!Number.isInteger(qty) || qty <= 0) return "Enter a whole number of shares";
  const base = { symbol, side: t.side, qty };
  if (t.type === "market") return { ...base, type: "market" };
  if (t.type === "stop") {
    const stopPrice = parseDollars(t.stop);
    return stopPrice ? { ...base, type: "stop", stopPrice } : "Enter a stop price";
  }
  const price = parseDollars(t.price);
  if (!price) return "Enter a limit price";
  if (t.type === "limit") return { ...base, type: "limit", price };
  if (t.type === "stop_limit") {
    // Waits off the book until the last trade reaches the stop, then rests as a limit.
    const stopPrice = parseDollars(t.stop);
    if (!stopPrice) return "Enter a stop price";
    return { ...base, type: "stop_limit", stopPrice, price };
  }

  const takeProfit = parseDollars(t.takeProfit);
  const stopLoss = parseDollars(t.stopLoss);
  if (!takeProfit || !stopLoss) return "A bracket needs a take-profit and a stop-loss";
  const long = t.side === "buy";
  if (
    long ? !(takeProfit > price && stopLoss < price) : !(takeProfit < price && stopLoss > price)
  ) {
    return long
      ? "Take-profit goes above the entry, stop-loss below"
      : "Take-profit goes below the entry, stop-loss above";
  }
  return { ...base, type: "limit", price, takeProfit, stopLoss };
}

// Reads the blotter's Amend fields. Blank keeps what the order has now.
export function amendChange(
  price: string,
  qty: string,
  current: { price: number; leaves: number },
): { price?: number; qty?: number } | string {
  const change: { price?: number; qty?: number } = {};
  if (price.trim()) {
    const p = parseDollars(price);
    if (!p) return "Enter a price in dollars and cents";
    if (p !== current.price) change.price = p;
  }
  if (qty.trim()) {
    const q = Number(qty);
    if (!Number.isInteger(q) || q <= 0) return "Enter a whole number of shares";
    if (q !== current.leaves) change.qty = q;
  }
  return change.price === undefined && change.qty === undefined ? "Nothing to change" : change;
}
