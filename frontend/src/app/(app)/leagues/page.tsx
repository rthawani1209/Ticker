import type { Metadata } from "next";

import { LeaguesApp } from "@/components/leagues/LeaguesScreen";

export const metadata: Metadata = { title: "Leagues · Ticker" };

export default function LeaguesPage() {
  return <LeaguesApp />;
}
