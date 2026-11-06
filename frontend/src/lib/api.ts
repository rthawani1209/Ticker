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

// True only when the database and the exchange are both up. Gives up after 3 seconds,
// so a hung API counts as down instead of leaving the caller waiting.
export async function getHealth(signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(3000);
  try {
    return (
      await get<{ ok: boolean }>("/health", signal ? AbortSignal.any([signal, timeout]) : timeout)
    ).ok;
  } catch {
    return false;
  }
}

export const getTrades = (ticker: string, signal?: AbortSignal) =>
  get<Trade[]>(`/v1/market/${ticker}/trades`, signal);

export interface Candle {
  time: number; // bar start, seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const getCandles = (ticker: string, signal?: AbortSignal) =>
  get<{ seconds: number; candles: Candle[] }>(`/v1/market/${ticker}/candles`, signal);

// ---- signed-in calls ----

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market" | "stop" | "stop_limit";

export interface User {
  id: number;
  username: string;
  role: "guest" | "student" | "professor" | "admin";
}

export interface Session {
  accessToken: string;
  user: User;
}

export interface Order {
  id: number;
  league: number;
  symbol: string;
  side: Side;
  type: OrderType;
  tif: "gtc" | "ioc" | "fok";
  price: number | null;
  stopPrice: number | null;
  qty: number;
  leaves: number;
  filledQty: number;
  status: "pending" | "open" | "partially_filled" | "filled" | "cancelled" | "rejected";
  rejectReason: string | null;
  takeProfit: number | null;
  stopLoss: number | null;
  parentId: number | null;
  createdAt: string;
}

export interface Fill {
  id: number;
  orderId: number;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  commission: number;
  createdAt: string;
}

export interface Position {
  symbol: string;
  qty: number;
  avgPrice: number | null;
  mark: number;
  marketValue: number;
  unrealized: number;
  realized: number;
}

export interface Portfolio {
  cash: number;
  equity: number;
  startingCash: number;
  returnPct: number;
  positions: Position[];
}

export interface Analytics {
  league: number;
  startingCash: number;
  equity: number;
  returnPct: number;
  maxDrawdown: number; // 0.12 = fell 12% from a peak
  sharpe: number | null;
  winRate: number | null;
  roundTrips: number;
  wins: number;
  history: { at: number; equity: number }[];
}

export interface League {
  id: number;
  name: string;
  isPractice: boolean;
  startsAt: string;
  endsAt: string | null;
  startingCash: number;
  commissionCents: number;
  commissionBps: number;
  maxPosition: number | null;
  allowShort: boolean;
  marginBps: number;
  allowedTypes: OrderType[];
  members: number;
  isOwner: boolean;
  inviteCode?: string; // only for the owner
}

export interface NewLeague {
  name: string;
  startingCash: number;
  endsAt?: string;
  commissionCents: number;
  allowShort: boolean;
  maxPosition: number | null;
}

export interface Standing {
  rank: number;
  portfolioId: number;
  username: string;
  equity: number;
  returnPct: number;
  sharpe: number | null;
}

export interface NewOrder {
  symbol: string;
  league?: number; // the practice league when left out
  side: Side;
  type: OrderType;
  qty: number;
  price?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// Auth calls send the refresh cookie, which lives on the API's /v1/auth path.
async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(API_URL + path, {
    ...rest,
    credentials: "include",
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(res.status, body.error ?? "error", body.message ?? res.statusText);
  return body as T;
}

export const auth = {
  refresh: () => call<Session>("/v1/auth/refresh", { method: "POST" }),
  guest: () => call<Session>("/v1/auth/guest", { method: "POST" }),
  login: (email: string, password: string) =>
    call<Session>("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  register: (email: string, username: string, password: string) =>
    call<Session>("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, username, password }),
    }),
  logout: () => call<void>("/v1/auth/logout", { method: "POST" }),
};

const leagueParam = (league?: number) => (league ? `?league=${league}` : "");

export const me = {
  portfolio: (token: string, league?: number) =>
    call<Portfolio>(`/v1/positions${leagueParam(league)}`, { token }),
  analytics: (token: string, league?: number) =>
    call<Analytics>(`/v1/positions/analytics${leagueParam(league)}`, { token }),
  openOrders: (token: string, league?: number) =>
    call<Order[]>(`/v1/orders?open=true&limit=100${league ? `&league=${league}` : ""}`, {
      token,
    }),
  fills: (token: string, league?: number) =>
    call<Fill[]>(`/v1/fills?limit=50${league ? `&league=${league}` : ""}`, { token }),
};

export const leagues = {
  list: (token: string) => call<League[]>("/v1/leagues", { token }),
  create: (token: string, body: NewLeague) =>
    call<League>("/v1/leagues", { method: "POST", token, body: JSON.stringify(body) }),
  join: (token: string, code: string) =>
    call<League>("/v1/leagues/join", { method: "POST", token, body: JSON.stringify({ code }) }),
  leaderboard: (token: string, id: number, by: "return" | "sharpe") =>
    call<Standing[]>(`/v1/leagues/${id}/leaderboard?by=${by}&limit=100`, { token }),
};
