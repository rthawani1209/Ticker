import type { Metadata } from "next";
import { Suspense } from "react";

import { BotsApp } from "@/components/bots/BotsScreen";

export const metadata: Metadata = { title: "Bots · Ticker" };

export default function BotsPage() {
  return (
    <Suspense>
      <BotsApp />
    </Suspense>
  );
}
