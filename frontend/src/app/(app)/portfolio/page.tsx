import type { Metadata } from "next";

import { PortfolioApp } from "@/components/portfolio/PortfolioScreen";

export const metadata: Metadata = { title: "Portfolio · Ticker" };

export default function PortfolioPage() {
  return <PortfolioApp />;
}
