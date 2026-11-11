// The JSON shape of a new order, shared by POST /v1/orders and the WebSocket "order" op.
import { z } from "zod";

import { ApiError } from "./errors.js";
import type { OrderInput } from "./orders.js";

const Cents = z.number().int().positive().max(10_000_000);

export const NewOrder = z
  .object({
    symbol: z.string().max(10).toUpperCase(),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["limit", "market", "stop", "stop_limit"]).default("limit"),
    tif: z.enum(["gtc", "ioc", "fok"]).optional(),
    qty: z.number().int().positive().max(100_000),
    price: Cents.optional(),
    stopPrice: Cents.optional(),
    // Bracket exits, sent once the order is done: a limit at takeProfit and a stop at stopLoss.
    takeProfit: Cents.optional(),
    stopLoss: Cents.optional(),
    league: z.number().int().positive().optional(), // defaults to the practice league
  })
  .superRefine((o, ctx) => {
    const needsPrice = o.type === "limit" || o.type === "stop_limit";
    const needsStop = o.type === "stop" || o.type === "stop_limit";
    if (needsPrice !== (o.price !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["price"],
        message: needsPrice ? "required" : `not allowed for ${o.type} orders`,
      });
    }
    if (needsStop !== (o.stopPrice !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["stopPrice"],
        message: needsStop ? "required" : `not allowed for ${o.type} orders`,
      });
    }
    // A buy stop-limit wakes up when the price rises to the stop, so a limit below the
    // stop could never fill then (and the reverse for a sell).
    if (o.type === "stop_limit" && o.price !== undefined && o.stopPrice !== undefined) {
      const ok = o.side === "buy" ? o.price >= o.stopPrice : o.price <= o.stopPrice;
      if (!ok)
        ctx.addIssue({
          code: "custom",
          path: ["price"],
          message:
            o.side === "buy" ? "must be at or above the stop" : "must be at or below the stop",
        });
    }
    if ((o.takeProfit === undefined) !== (o.stopLoss === undefined)) {
      ctx.addIssue({ code: "custom", path: ["stopLoss"], message: "a bracket needs both exits" });
    } else if (o.takeProfit !== undefined && o.stopLoss !== undefined) {
      // A long position takes profit above and stops out below; a short is the reverse.
      const ok = o.side === "buy" ? o.takeProfit > o.stopLoss : o.takeProfit < o.stopLoss;
      if (!ok) {
        ctx.addIssue({
          code: "custom",
          path: ["takeProfit"],
          message: `take-profit must be ${o.side === "buy" ? "above" : "below"} the stop-loss`,
        });
      }
    }
  });

export type NewOrderBody = z.infer<typeof NewOrder>;

export function toOrderInput(
  body: NewOrderBody,
  symbolsByTicker: Map<string, { id: number; maxPrice: number }>,
): { input: OrderInput; league?: number } {
  const sym = symbolsByTicker.get(body.symbol);
  if (!sym) throw new ApiError(422, "unknown_symbol", `no symbol ${body.symbol}`);
  for (const p of [body.price, body.stopPrice, body.takeProfit, body.stopLoss])
    if (p !== undefined && p >= sym.maxPrice)
      throw new ApiError(
        422,
        "invalid_price",
        `${body.symbol} prices must be below $${(sym.maxPrice / 100).toFixed(2)}`,
      );
  // Market orders can only be immediate; everything else rests until cancelled by default.
  const tif = body.tif ?? (body.type === "market" ? "ioc" : "gtc");
  const { league, symbol: _symbol, ...rest } = body;
  return { input: { ...rest, symbolId: sym.id, tif }, league };
}
