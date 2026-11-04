"use client";

import { useState } from "react";

import type { Fill, Order, Portfolio } from "@/lib/api";
import { direction, formatMoney, formatPrice } from "@/lib/format";

import styles from "./Blotter.module.css";

type Tab = "positions" | "orders" | "fills";

interface Props {
  portfolio: Portfolio | null;
  orders: Order[];
  fills: Fill[];
  onCancel: (id: number) => void;
  onPick: (symbol: string) => void;
}

const time = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function describe(o: Order): string {
  if (o.type === "market") return "market";
  if (o.type === "stop") return `stop ${formatPrice(o.stopPrice!)}`;
  if (o.type === "stop_limit")
    return `stop ${formatPrice(o.stopPrice!)} lmt ${formatPrice(o.price!)}`;
  return formatPrice(o.price!);
}

// Positions, open orders and fills under the chart.
export function Blotter({ portfolio, orders, fills, onCancel, onPick }: Props) {
  const [tab, setTab] = useState<Tab>("positions");
  const positions = portfolio?.positions.filter((p) => p.qty !== 0) ?? [];
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "positions", label: "Positions", count: positions.length },
    { id: "orders", label: "Open orders", count: orders.length },
    { id: "fills", label: "Fills" },
  ];
  const pnl = positions.reduce((sum, p) => sum + p.unrealized, 0);

  return (
    <section className={styles.blotter} aria-label="Your account">
      <div className={styles.tabs} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={styles.tab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.count !== undefined && <span className="mono"> {t.count}</span>}
          </button>
        ))}
        <span className={`mono ${styles.pnl}`} data-direction={direction(pnl)}>
          Open P&amp;L {pnl >= 0 ? "+" : "−"}
          {formatMoney(Math.abs(pnl))}
        </span>
      </div>

      <div className={styles.body} role="tabpanel">
        {tab === "positions" && (
          <Table
            empty="No positions yet. Your first fill shows up here."
            head={["Symbol", "Qty", "Avg", "Last", "Unrealized", "Realized"]}
            rows={positions.map((p) => ({
              key: p.symbol,
              cells: [
                <button
                  key="s"
                  type="button"
                  className={styles.sym}
                  onClick={() => onPick(p.symbol)}
                >
                  {p.symbol}
                  {p.qty < 0 && <span className={styles.tag}>short</span>}
                </button>,
                p.qty.toLocaleString("en-US"),
                p.avgPrice === null ? "—" : formatPrice(p.avgPrice),
                formatPrice(p.mark),
                <Signed key="u" cents={p.unrealized} />,
                <Signed key="r" cents={p.realized} />,
              ],
            }))}
          />
        )}
        {tab === "orders" && (
          <Table
            empty="No open orders."
            head={["Symbol", "Side", "Price", "Filled", "Status", ""]}
            rows={orders.map((o) => ({
              key: String(o.id),
              cells: [
                <span key="s">
                  {o.symbol}
                  {o.parentId !== null && <span className={styles.tag}>exit</span>}
                  {o.takeProfit !== null && <span className={styles.tag}>bracket</span>}
                </span>,
                <span key="d" data-side={o.side} className={styles.side}>
                  {o.side}
                </span>,
                describe(o),
                `${o.filledQty}/${o.qty}`,
                o.status.replace("_", " "),
                <button
                  key="c"
                  type="button"
                  className={styles.cancel}
                  onClick={() => onCancel(o.id)}
                >
                  Cancel
                </button>,
              ],
            }))}
          />
        )}
        {tab === "fills" && (
          <Table
            empty="No fills yet."
            head={["Time", "Symbol", "Side", "Qty", "Price", "Fee"]}
            rows={fills.map((f) => ({
              key: String(f.id),
              cells: [
                time.format(new Date(f.createdAt)),
                f.symbol,
                <span key="d" data-side={f.side} className={styles.side}>
                  {f.side}
                </span>,
                f.qty.toLocaleString("en-US"),
                formatPrice(f.price),
                formatMoney(f.commission),
              ],
            }))}
          />
        )}
      </div>
    </section>
  );
}

function Signed({ cents }: { cents: number }) {
  return (
    <span data-direction={direction(cents)} className={styles.signed}>
      {cents > 0 ? "+" : cents < 0 ? "−" : ""}
      {formatMoney(Math.abs(cents))}
    </span>
  );
}

function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: { key: string; cells: React.ReactNode[] }[];
  empty: string;
}) {
  if (rows.length === 0) return <p className={styles.empty}>{empty}</p>;
  return (
    <table className={`mono ${styles.table}`}>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i} className="label">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            {r.cells.map((c, i) => (
              <td key={i}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
