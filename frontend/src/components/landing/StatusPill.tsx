"use client";

import { useMarketFeed } from "./MarketFeed";
import styles from "./StatusPill.module.css";

const TEXT = {
  connecting: "Connecting to the exchange",
  live: "Live · bots trading now",
  replay: "Replay · exchange offline, showing a recorded session",
} as const;

// Says what the board next to it is actually showing, from /health.
export function StatusPill() {
  const { mode } = useMarketFeed();
  return (
    <span className={`label ${styles.pill}`} data-mode={mode} role="status">
      <span className={styles.dot} aria-hidden="true" />
      {TEXT[mode]}
    </span>
  );
}
