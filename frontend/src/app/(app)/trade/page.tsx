import type { Metadata } from "next";
import { Suspense } from "react";

import { TradeApp } from "@/components/trade/TradeApp";

export const metadata: Metadata = { title: "Trade · Ticker" };

export default function TradePage() {
  return (
    <Suspense>
      <TradeApp />
    </Suspense>
  );
}
