"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getCandles,
  getSymbols,
  getTrades,
  me,
  WS_URL,
  type Candle,
  type Depth,
  type Fill,
  type NewOrder,
  type Order,
  type Portfolio,
  type SymbolSummary,
  type Trade,
} from "@/lib/api";
import { applyLevel } from "@/lib/depth";

const TAPE = 40;
const EMPTY: Depth = { bids: [], asks: [] };

export interface Reply {
  ok: boolean;
  order?: Order;
  error?: string;
  message?: string;
}

// Everything the trade screen shows, kept live. Market data and order entry share one
// WebSocket; your portfolio, open orders and fills reload from REST whenever one of
// your orders changes.
export function useTrading(token: string, symbol: string, league?: number) {
  const [connected, setConnected] = useState(false);
  // The gateway says whether it can reach the exchange; orders fail while it can't.
  const [exchangeUp, setExchangeUp] = useState(true);
  const [symbols, setSymbols] = useState<SymbolSummary[]>([]);
  const [book, setBook] = useState<Depth>(EMPTY);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [candles, setCandles] = useState<{ seconds: number; bars: Candle[] }>({
    seconds: 15,
    bars: [],
  });
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);

  const ws = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, (r: Reply) => void>());
  const nextRef = useRef(0);

  const reloadMine = useCallback(() => {
    Promise.all([
      me.portfolio(token, league),
      me.openOrders(token, league),
      me.fills(token, league),
    ]).then(
      ([p, o, f]) => {
        setPortfolio(p);
        setOrders(o);
        setFills(f);
      },
      () => {},
    );
  }, [token, league]);

  // Watchlist rows and your portfolio marks: a light poll is plenty.
  useEffect(() => {
    const abort = new AbortController();
    const load = () => getSymbols(abort.signal).then(setSymbols, () => {});
    load();
    reloadMine();
    const a = setInterval(load, 2000);
    const b = setInterval(reloadMine, 5000);
    return () => {
      abort.abort();
      clearInterval(a);
      clearInterval(b);
    };
  }, [reloadMine]);

  // Per-symbol history to start the chart and tape from.
  useEffect(() => {
    const abort = new AbortController();
    getCandles(symbol, abort.signal).then(
      (c) => setCandles({ seconds: c.seconds, bars: c.candles }),
      () => {},
    );
    getTrades(symbol, abort.signal).then(
      (t) => setTrades(t.slice(0, TAPE)),
      () => {},
    );
    return () => abort.abort();
  }, [symbol]);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const replies = pending.current;
    // Several order updates often arrive together; reload once after they settle.
    const reloadSoon = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reloadMine, 150);
    };

    const connect = () => {
      const socket = new WebSocket(WS_URL);
      ws.current = socket;
      socket.onopen = () => {
        setConnected(true);
        // Signs in first (the server handles messages in order). Not a ?token= query
        // param, which would end up in access logs. A refreshed token reconnects.
        socket.send(JSON.stringify({ op: "auth", token }));
        for (const channel of [`book:${symbol}`, `trades:${symbol}`, "me:orders"]) {
          socket.send(JSON.stringify({ op: "subscribe", channel }));
        }
      };
      socket.onmessage = (msg) => {
        const { channel, data } = JSON.parse(msg.data as string);
        if (data?.ref && replies.has(data.ref)) {
          replies.get(data.ref)!(
            channel === "error"
              ? { ok: false, error: data.error, message: data.message }
              : { ok: true, order: data.order },
          );
          replies.delete(data.ref);
          return;
        }
        if (channel === "exchange") {
          setExchangeUp(Boolean(data.up));
        } else if (channel === `book:${symbol}`) {
          if (data.snapshot) setBook({ bids: data.bids, asks: data.asks });
          else setBook((b) => applyLevel(b, data.side, data.price, data.qty));
        } else if (channel === `trades:${symbol}`) {
          setTrades((t) => [data, ...t].slice(0, TAPE));
          setCandles((c) => ({ ...c, bars: addTrade(c.bars, c.seconds, data) }));
        } else if (channel === "me:orders") {
          reloadSoon();
        }
      };
      socket.onclose = () => {
        setConnected(false);
        for (const resolve of replies.values()) {
          resolve({ ok: false, error: "disconnected", message: "connection lost, try again" });
        }
        replies.clear();
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(reloadTimer);
      ws.current?.close();
      ws.current = null;
      setBook(EMPTY);
    };
  }, [token, symbol, reloadMine]);

  const request = useCallback((msg: object): Promise<Reply> => {
    const socket = ws.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: "disconnected", message: "not connected yet" });
    }
    const ref = `t${++nextRef.current}`;
    return new Promise((resolve) => {
      pending.current.set(ref, resolve);
      socket.send(JSON.stringify({ ...msg, ref }));
    });
  }, []);

  // Orders go to the league being traded; the practice league when none is picked.
  const placeOrder = useCallback(
    (order: NewOrder) => request({ op: "order", order: league ? { ...order, league } : order }),
    [request, league],
  );
  const cancelOrder = useCallback((id: number) => request({ op: "cancel", id }), [request]);

  return {
    connected: connected && exchangeUp,
    symbols,
    book,
    trades,
    candles,
    portfolio,
    orders,
    fills,
    placeOrder,
    cancelOrder,
  };
}

// Folds one live trade into the bars, the same way the API builds them.
export function addTrade(bars: Candle[], seconds: number, t: Trade): Candle[] {
  const time = Math.floor(t.time / 1000 / seconds) * seconds;
  const last = bars.at(-1);
  if (last && last.time === time) {
    const bar = {
      ...last,
      high: Math.max(last.high, t.price),
      low: Math.min(last.low, t.price),
      close: t.price,
      volume: last.volume + t.qty,
    };
    return [...bars.slice(0, -1), bar];
  }
  if (last && last.time > time) return bars; // late message for an older bar
  const bar = { time, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.qty };
  return [...bars, bar];
}
