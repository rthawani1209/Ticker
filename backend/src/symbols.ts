import type { Db } from "./db/pool.js";

export interface SymbolInfo { id: number; ticker: string; company: string; sector: string; refPrice: number }

export async function loadSymbols(db: Db): Promise<SymbolInfo[]> {
  const { rows } = await db.query("SELECT id, ticker, company, sector, ref_price FROM symbols ORDER BY id");
  return rows.map((r) => ({ id: r.id, ticker: r.ticker, company: r.company, sector: r.sector, refPrice: r.ref_price }));
}
