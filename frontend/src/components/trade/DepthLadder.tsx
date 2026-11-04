"use client";

import { useEffect, useRef } from "react";

import type { Depth, Order, Side } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { ladderRows } from "@/lib/ladder";

import styles from "./DepthLadder.module.css";

interface Props {
  symbol: string;
  book: Depth;
  mine: Order[];
  qty: number;
  onTrade: (side: Side, price: number) => void;
}

// Every resting order in the book by price. Click the bid column to buy at that price
// or the ask column to sell there, for the quantity in the ticket.
export function DepthLadder({ symbol, book, mine, qty, onTrade }: Props) {
  const rows = ladderRows(book, mine, symbol);
  const biggest = Math.max(1, ...rows.map((r) => Math.max(r.bid, r.ask)));
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  const list = useRef<HTMLOListElement>(null);
  const centered = useRef("");

  // Start each symbol with the spread in the middle; after that, leave the scroll to you.
  const count = rows.length;
  useEffect(() => {
    const el = list.current;
    if (!el || centered.current === symbol || el.scrollHeight <= el.clientHeight) return;
    const best = el.querySelector<HTMLElement>('[data-best="ask"]');
    if (!best || !el.querySelector('[data-best="bid"]')) return;
    el.scrollTop = best.offsetTop - el.clientHeight / 2 + best.offsetHeight;
    centered.current = symbol;
  }, [count, symbol]);

  return (
    <div className={styles.ladder}>
      <div className={`label ${styles.head}`}>
        <span>Bid size</span>
        <span>Price</span>
        <span>Ask size</span>
      </div>
      {rows.length === 0 && <p className={`mono ${styles.empty}`}>Nobody is quoting {symbol}.</p>}
      <ol ref={list} className={`mono ${styles.rows}`}>
        {rows.map((r) => (
          <li
            key={r.price}
            className={styles.row}
            data-best={r.price === bestBid ? "bid" : r.price === bestAsk ? "ask" : undefined}
          >
            <button
              type="button"
              className={`${styles.cell} ${styles.bid}`}
              onClick={() => onTrade("buy", r.price)}
              aria-label={`Buy ${qty} ${symbol} at ${formatPrice(r.price)}`}
            >
              <span
                className={styles.bar}
                style={{ width: `${(r.bid / biggest) * 100}%` }}
                aria-hidden="true"
              />
              {r.mineBuy > 0 && <span className={styles.mine}>you {r.mineBuy}</span>}
              <span>{r.bid > 0 ? r.bid.toLocaleString("en-US") : ""}</span>
            </button>
            <span className={styles.price}>{formatPrice(r.price)}</span>
            <button
              type="button"
              className={`${styles.cell} ${styles.ask}`}
              onClick={() => onTrade("sell", r.price)}
              aria-label={`Sell ${qty} ${symbol} at ${formatPrice(r.price)}`}
            >
              <span
                className={styles.bar}
                style={{ width: `${(r.ask / biggest) * 100}%` }}
                aria-hidden="true"
              />
              <span>{r.ask > 0 ? r.ask.toLocaleString("en-US") : ""}</span>
              {r.mineSell > 0 && <span className={styles.mine}>you {r.mineSell}</span>}
            </button>
          </li>
        ))}
      </ol>
      {bestBid !== undefined && bestAsk !== undefined && (
        <p className={`mono ${styles.spread}`}>
          spread {formatPrice(bestAsk - bestBid)} ·{" "}
          {(((bestAsk - bestBid) / bestBid) * 1e4).toFixed(1)} bp
        </p>
      )}
    </div>
  );
}
