import type { Metadata } from "next";
import { Suspense } from "react";

import { LeaguesApp } from "@/components/leagues/LeaguesScreen";

export const metadata: Metadata = { title: "Leagues · Ticker" };

export default function LeaguesPage() {
  return (
    <Suspense>
      <LeaguesApp />
    </Suspense>
  );
}
