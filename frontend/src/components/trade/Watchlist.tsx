import { PriceCell } from "@/components/ui/PriceCell";
import type { SymbolSummary } from "@/lib/api";
import { formatChange } from "@/lib/format";

import styles from "./Watchlist.module.css";

export function Watchlist({
  symbols,
  active,
  onPick,
}: {
  symbols: SymbolSummary[];
  active: string;
  onPick: (ticker: string) => void;
}) {
  return (
    <nav className={styles.list} aria-label="Watchlist">
      <div className={`label ${styles.head}`}>
        <span>Watchlist</span>
        <span>{symbols.length} · sim</span>
      </div>
      <ul>
        {symbols.map((s) => {
          const change = formatChange(s.last, s.refPrice);
          return (
            <li key={s.ticker}>
              <button
                type="button"
                className={styles.row}
                aria-current={s.ticker === active ? "true" : undefined}
                onClick={() => onPick(s.ticker)}
              >
                <span className={styles.sym}>{s.ticker}</span>
                <PriceCell cents={s.last} />
                <span className={`mono ${styles.co}`}>{s.company}</span>
                <span className={`mono ${styles.chg}`} data-direction={change.dir}>
                  {s.halted ? "HALTED" : change.text}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
