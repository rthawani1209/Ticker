"use client";

import { PriceCell } from "@/components/ui/PriceCell";
import { formatChange } from "@/lib/format";

import { DepthChart } from "./DepthChart";
import styles from "./MarketBoard.module.css";
import { useMarketFeed } from "./MarketFeed";
import { Tape } from "./Tape";

// The landing page's read-only market: every symbol ticking, and the depth and tape for
// whichever one you pick.
export function MarketBoard() {
  const { mode, symbols, focus, setFocus, book, trades } = useMarketFeed();

  if (!symbols) {
    return (
      <p className={styles.note}>
        {mode === "replay" ? "Loading the recorded session…" : "Connecting to the market…"}
      </p>
    );
  }

  return (
    <div className={styles.board} data-mode={mode}>
      <ul className={styles.rows} aria-label="Prices">
        {symbols.map((s) => {
          const change = formatChange(s.last, s.refPrice);
          return (
            <li key={s.ticker}>
              <button
                type="button"
                className={styles.row}
                aria-pressed={s.ticker === focus}
                onClick={() => setFocus(s.ticker)}
              >
                <span className={styles.ticker} title={s.company}>
                  {s.ticker}
                </span>
                <PriceCell cents={s.last} />
                <span className={`mono ${styles.change}`} data-direction={change.dir}>
                  {s.halted ? "HALTED" : change.text}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className={styles.detail}>
        <div className={styles.depth}>
          <span className={`label ${styles.sub}`}>{focus} · depth</span>
          <DepthChart book={book} ticker={focus} />
        </div>
        <div className={styles.tape}>
          <span className={`label ${styles.sub}`}>Tape</span>
          <Tape trades={trades} />
        </div>
      </div>
    </div>
  );
}
