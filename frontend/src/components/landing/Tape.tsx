import type { Trade } from "@/lib/api";
import { formatPrice } from "@/lib/format";

import styles from "./Tape.module.css";

const time = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// The time and sales feed: every trade on the focused stock, newest on top.
export function Tape({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) {
    return <p className={`mono ${styles.empty}`}>Waiting for the next trade…</p>;
  }
  return (
    <ol className={`mono ${styles.tape}`} aria-label="Recent trades">
      {trades.map((t) => (
        <li key={t.tradeId} className={styles.row} data-side={t.side}>
          <span className={styles.time}>{time.format(t.time)}</span>
          <span className={styles.price}>
            {t.side === "buy" ? "▲" : "▼"} {formatPrice(t.price)}
          </span>
          <span className={styles.qty}>{t.qty.toLocaleString("en-US")}</span>
        </li>
      ))}
    </ol>
  );
}
