"use client";

import { useEffect, useState } from "react";

import { PriceCell } from "@/components/ui/PriceCell";
import { getSymbols, type SymbolSummary } from "@/lib/api";
import { formatChange } from "@/lib/format";

import styles from "./LiveBoard.module.css";

const POLL_MS = 2000;

// The read-only market on the landing page. Polls the public symbols endpoint;
// the trading screen uses the WebSocket instead.
export function LiveBoard() {
  const [symbols, setSymbols] = useState<SymbolSummary[] | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    const load = () =>
      getSymbols(abort.signal).then(
        (s) => {
          setSymbols(s);
          setOffline(false);
        },
        () => {
          if (!abort.signal.aborted) setOffline(true);
        },
      );
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, []);

  if (offline && !symbols) {
    return <p className={styles.note}>The market is offline right now. Check back in a minute.</p>;
  }
  if (!symbols) {
    return <p className={styles.note}>Connecting to the market…</p>;
  }

  return (
    <ul className={styles.board} aria-label="Live prices">
      {symbols.map((s) => {
        const change = formatChange(s.last, s.refPrice);
        return (
          <li key={s.ticker} className={styles.row}>
            <span className={styles.ticker} title={s.company}>
              {s.ticker}
            </span>
            <PriceCell cents={s.last} />
            <span className={`mono ${styles.change}`} data-direction={change.dir}>
              {s.halted ? "HALTED" : change.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
