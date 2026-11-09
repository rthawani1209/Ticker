import type { Db } from "./db/pool.js";

export interface SymbolInfo {
  id: number;
  ticker: string;
  company: string;
  sector: string;
  refPrice: number;
  // Orders must be priced below this. Same rule as price_ceiling() in the engine's config.hpp.
  maxPrice: number;
}

export function priceCeiling(refPrice: number): number {
  return Math.min(1 << 18, Math.max(1 << 16, refPrice * 8));
}

export async function loadSymbols(db: Db): Promise<SymbolInfo[]> {
  const { rows } = await db.query(
    "SELECT id, ticker, company, sector, ref_price FROM symbols ORDER BY id",
  );
  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    company: r.company,
    sector: r.sector,
    refPrice: r.ref_price,
    maxPrice: priceCeiling(r.ref_price),
  }));
}
