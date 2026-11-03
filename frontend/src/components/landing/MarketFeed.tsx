"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import {
  getHealth,
  getSymbols,
  getTrades,
  WS_URL,
  type Depth,
  type SymbolSummary,
  type Trade,
} from "@/lib/api";
import { applyLevel } from "@/lib/depth";
import { replayDepth, replaySymbols, replayTrades, type Recording } from "@/lib/replay";

// "live" streams from the exchange. "replay" plays a recorded session from
// public/replay/market.json when the exchange is down, so the page never shows nothing.
export type FeedMode = "connecting" | "live" | "replay";

interface Feed {
  mode: FeedMode;
  symbols: SymbolSummary[] | null;
  focus: string;
  setFocus: (ticker: string) => void;
  book: Depth;
  trades: Trade[]; // newest first
}

const HEALTH_MS = 10_000;
const SYMBOLS_MS = 2000;
const TAPE = 24;
const EMPTY: Depth = { bids: [], asks: [] };

const FeedContext = createContext<Feed | null>(null);

export function useMarketFeed(): Feed {
  const feed = useContext(FeedContext);
  if (!feed) throw new Error("useMarketFeed needs a <MarketFeed> above it");
  return feed;
}

export function MarketFeed({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<FeedMode>("connecting");
  const [symbols, setSymbols] = useState<SymbolSummary[] | null>(null);
  const [focus, setFocusState] = useState("NOVA");
  const [book, setBook] = useState<Depth>(EMPTY);
  const [trades, setTrades] = useState<Trade[]>([]);

  const setFocus = useCallback((ticker: string) => {
    setFocusState(ticker);
    setBook(EMPTY);
    setTrades([]);
  }, []);

  const addTrades = useCallback((fresh: Trade[]) => {
    if (fresh.length) setTrades((t) => [...fresh.reverse(), ...t].slice(0, TAPE));
  }, []);

  // Health decides the mode. Two misses in a row before giving up on live, so one
  // slow response doesn't flip the page into replay.
  useEffect(() => {
    const abort = new AbortController();
    let misses = 0;
    const check = async () => {
      const ok = await getHealth(abort.signal);
      if (abort.signal.aborted) return;
      misses = ok ? 0 : misses + 1;
      setMode((m) => (ok ? "live" : m === "connecting" || misses >= 2 ? "replay" : m));
    };
    check();
    const timer = setInterval(check, HEALTH_MS);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, []);

  // Live: symbol rows over REST, the focused book and trades over the WebSocket.
  useEffect(() => {
    if (mode !== "live") return;
    const abort = new AbortController();
    const loadSymbols = () => getSymbols(abort.signal).then(setSymbols, () => {});
    loadSymbols();
    const timer = setInterval(loadSymbols, SYMBOLS_MS);
    getTrades(focus, abort.signal).then(
      (t) => setTrades(t.slice(0, TAPE)),
      () => {},
    );

    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        for (const channel of [`book:${focus}`, `trades:${focus}`]) {
          ws?.send(JSON.stringify({ op: "subscribe", channel }));
        }
      };
      ws.onmessage = (msg) => {
        const { channel, data } = JSON.parse(msg.data as string);
        if (channel === `book:${focus}`) {
          if (data.snapshot) setBook({ bids: data.bids, asks: data.asks });
          else setBook((b) => applyLevel(b, data.side, data.price, data.qty));
        } else if (channel === `trades:${focus}`) {
          addTrades([data]);
        }
      };
      ws.onclose = () => {
        if (!abort.signal.aborted) retry = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      abort.abort();
      clearInterval(timer);
      clearTimeout(retry);
      ws?.close();
    };
  }, [mode, focus, addTrades]);

  // Replay: step through the recording once a second, looping at the end.
  useEffect(() => {
    if (mode !== "replay") return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    fetch("/replay/market.json", { signal: abort.signal })
      .then((r) => r.json() as Promise<Recording>)
      .then((rec) => {
        let frame = 0;
        const step = () => {
          setSymbols(replaySymbols(rec, frame));
          setBook(replayDepth(rec, frame, focus));
          addTrades(replayTrades(rec, frame, focus, Date.now()));
          frame = (frame + 1) % rec.frames.length;
        };
        step();
        timer = setInterval(step, rec.intervalMs);
      })
      .catch(() => {});
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [mode, focus, addTrades]);

  return (
    <FeedContext value={{ mode, symbols, focus, setFocus, book, trades }}>{children}</FeedContext>
  );
}
