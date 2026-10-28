// The backend's REST API. Matches backend/src/routes/market.ts.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export interface SymbolSummary {
  ticker: string;
  company: string;
  sector: string;
  refPrice: number;
  last: number;
  change: number;
  bid: number | null;
  ask: number | null;
  volume: number;
  halted: boolean;
}

export async function getSymbols(signal?: AbortSignal): Promise<SymbolSummary[]> {
  const res = await fetch(`${API_URL}/v1/symbols`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`GET /v1/symbols failed: ${res.status}`);
  return res.json();
}
