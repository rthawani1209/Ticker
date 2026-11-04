import type { NewOrder, Side } from "./api";
import { parseDollars } from "./format";

export type TicketType = "limit" | "market" | "stop" | "bracket";

export interface Ticket {
  side: Side;
  type: TicketType;
  qty: string;
  price: string; // limit price; also the entry for a bracket
  stop: string; // stop trigger
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
