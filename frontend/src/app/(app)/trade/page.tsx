import type { Metadata } from "next";

import { TradeApp } from "@/components/trade/TradeApp";

export const metadata: Metadata = { title: "Trade · Ticker" };

export default function TradePage() {
  return <TradeApp />;
}
