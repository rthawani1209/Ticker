// The backend's REST and WebSocket API. Matches backend/src/routes/market.ts and
// backend/src/ws/hub.ts.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
export const WS_URL = API_URL.replace(/^http/, "ws") + "/ws";

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

export interface Level {
  price: number;
  qty: number;
}

export interface Depth {
  bids: Level[]; // best (highest) first
  asks: Level[]; // best (lowest) first
}

export interface Trade {
  price: number;
  qty: number;
  side: "buy" | "sell"; // the side that crossed the spread
  tradeId: number;
  time: number;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(API_URL + path, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

export const getSymbols = (signal?: AbortSignal) => get<SymbolSummary[]>("/v1/symbols", signal);

// True only when the database and the exchange are both up.
export async function getHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    return (await get<{ ok: boolean }>("/health", signal)).ok;
  } catch {
    return false;
  }
}

export const getTrades = (ticker: string, signal?: AbortSignal) =>
  get<Trade[]>(`/v1/market/${ticker}/trades`, signal);
