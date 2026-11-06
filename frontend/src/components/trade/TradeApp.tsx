"use client";

import { SessionGate } from "@/components/session/SessionGate";

import { TradeScreen } from "./TradeScreen";

// /trade: the trading screen once there's a session.
export function TradeApp() {
  return <SessionGate>{(session) => <TradeScreen session={session} />}</SessionGate>;
}
