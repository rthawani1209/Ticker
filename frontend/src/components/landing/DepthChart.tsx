import type { Depth } from "@/lib/api";
import { depthGeometry } from "@/lib/depth";
import { formatPrice } from "@/lib/format";

import styles from "./DepthChart.module.css";

const W = 480;
const H = 150;

// Cumulative size on each side of the spread. The best bid and ask get a glowing edge
// because that's where the next trade will happen.
export function DepthChart({ book, ticker }: { book: Depth; ticker: string }) {
  const g = depthGeometry(book, W, H);
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;

  return (
    <figure className={styles.figure}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={styles.svg}
        role="img"
        aria-label={
          bid !== undefined && ask !== undefined
            ? `${ticker} depth: best bid ${formatPrice(bid)}, best ask ${formatPrice(ask)}`
            : `${ticker} depth: book is empty`
        }
      >
        <defs>
          <linearGradient id="depth-bid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--up)" stopOpacity="0.32" />
            <stop offset="1" stopColor="var(--up)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="depth-ask" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--down)" stopOpacity="0.32" />
            <stop offset="1" stopColor="var(--down)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={g.bid} fill="url(#depth-bid)" className={styles.bid} />
        <path d={g.ask} fill="url(#depth-ask)" className={styles.ask} />
        {g.bidX !== null && (
          <line x1={g.bidX} x2={g.bidX} y1={0} y2={H} className={`${styles.edge} ${styles.up}`} />
        )}
        {g.askX !== null && (
          <line x1={g.askX} x2={g.askX} y1={0} y2={H} className={`${styles.edge} ${styles.down}`} />
        )}
      </svg>
      <figcaption className={`mono ${styles.caption}`}>
        <span className={styles.upText}>BID {bid !== undefined ? formatPrice(bid) : "—"}</span>
        <span>SPREAD {bid !== undefined && ask !== undefined ? formatPrice(ask - bid) : "—"}</span>
        <span className={styles.downText}>ASK {ask !== undefined ? formatPrice(ask) : "—"}</span>
      </figcaption>
    </figure>
  );
}
