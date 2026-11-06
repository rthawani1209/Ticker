"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AppHeader } from "@/components/app/AppHeader";
import ui from "@/components/app/Page.module.css";
import { SessionGate } from "@/components/session/SessionGate";
import {
  leagues as leagueApi,
  me,
  type Analytics,
  type Fill,
  type League,
  type Portfolio,
  type Session,
} from "@/lib/api";
import { direction, formatMoney, formatPrice } from "@/lib/format";
import { formatPct } from "@/lib/league";
import { queryParam } from "@/lib/query";

import { EquityChart } from "./EquityChart";
import styles from "./PortfolioScreen.module.css";

const REFRESH_MS = 10_000;
const FILLS_SHOWN = 15;

export function PortfolioApp() {
  return <SessionGate>{(session) => <PortfolioScreen session={session} />}</SessionGate>;
}

interface Data {
  analytics: Analytics;
  portfolio: Portfolio;
  fills: Fill[];
}

function PortfolioScreen({ session }: { session: Session }) {
  const token = session.accessToken;
  const [leagues, setLeagues] = useState<League[]>([]);
  // undefined = practice; /portfolio?league=ID opens that league
  const [league, setLeague] = useState<number | undefined>(
    () => Number(queryParam("league")) || undefined,
  );
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    leagueApi.list(token).then(setLeagues, () => {});
  }, [token]);

  const load = useCallback(
    () =>
      Promise.all([
        me.analytics(token, league),
        me.portfolio(token, league),
        me.fills(token, league),
      ]).then(
        ([analytics, portfolio, fills]) => {
          setData({ analytics, portfolio, fills });
          setError(null);
        },
        (e: Error) => setError(e.message || "couldn't load your portfolio"),
      ),
    [token, league],
  );

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const current = leagues.find((l) => (league ? l.id === league : l.isPractice));
  const a = data?.analytics;
  const held = data?.portfolio.positions.filter((p) => p.qty !== 0) ?? [];
  const gross = held.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);

  return (
    <div className={ui.page}>
      <AppHeader
        session={session}
        equity={a?.equity ?? null}
        equityLabel={current?.isPractice === false ? current.name : "practice"}
      />
      <main className={ui.body}>
        <div className={ui.head}>
          <div>
            <span className="label">Portfolio</span>
            <h1>{current?.name ?? "Practice"}</h1>
          </div>
          {leagues.length > 1 && (
            <label className={styles.switch}>
              <span className="label">League</span>
              <select
                value={league ?? ""}
                onChange={(e) => {
                  setData(null);
                  setLeague(e.target.value ? Number(e.target.value) : undefined);
                }}
              >
                {leagues.map((l) => (
                  <option key={l.id} value={l.isPractice ? "" : l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {error && (
          <p className={`mono ${ui.error}`} role="alert">
            {error}
          </p>
        )}

        <section className={styles.stats} aria-label="Statistics">
          <Stat label="Equity" big value={a ? formatMoney(a.equity) : null} />
          <Stat
            label="Return"
            value={a ? formatPct(a.returnPct) : null}
            dir={a ? direction(a.returnPct) : undefined}
            note={a ? `from ${formatMoney(a.startingCash)}` : undefined}
          />
          <Stat
            label="Max drawdown"
            value={a ? (a.maxDrawdown === 0 ? "0.00%" : formatPct(-a.maxDrawdown)) : null}
            dir={a && a.maxDrawdown > 0 ? "down" : undefined}
            note="worst fall from a peak"
          />
          <Stat
            label="Sharpe"
            value={a ? (a.sharpe === null ? "—" : a.sharpe.toFixed(2)) : null}
            note={a?.sharpe === null ? "after about 30 min of trading" : "annualized"}
          />
          <Stat
            label="Win rate"
            value={a ? (a.winRate === null ? "—" : `${Math.round(a.winRate * 100)}%`) : null}
            note={a ? `${a.wins} of ${a.roundTrips} closed trades` : undefined}
          />
        </section>

        <section className={`${ui.panel} ${styles.curve}`} aria-label="Equity curve">
          <header>
            <span className="label">Equity over time</span>
            <span className={`label ${styles.hint}`}>baseline = starting cash</span>
          </header>
          {a && a.history.length > 1 ? (
            <EquityChart history={a.history} startingCash={a.startingCash} />
          ) : (
            <p className={ui.empty}>
              The curve starts after your first minute in the market. Make a trade and come back.
            </p>
          )}
        </section>

        <div className={styles.split}>
          <section className={ui.panel} aria-label="Positions">
            <header>
              <span className="label">Positions</span>
              <span className="mono">Cash {data ? formatMoney(data.portfolio.cash) : "—"}</span>
            </header>
            {held.length === 0 ? (
              <p className={ui.empty}>
                No open positions. <Link href="/trade">Go trade</Link>
              </p>
            ) : (
              <div className={ui.scroll}>
                <table className={`mono ${ui.table}`}>
                  <thead>
                    <tr className="label">
                      <th>Symbol</th>
                      <th>Qty</th>
                      <th>Avg</th>
                      <th>Last</th>
                      <th>Value</th>
                      <th>Unrealized</th>
                      <th aria-label="Share of holdings" />
                    </tr>
                  </thead>
                  <tbody>
                    {held.map((p) => (
                      <tr key={p.symbol}>
                        <td>
                          <strong>{p.symbol}</strong>
                          {p.qty < 0 && <span className={ui.tag}>short</span>}
                        </td>
                        <td>{p.qty.toLocaleString("en-US")}</td>
                        <td>{p.avgPrice === null ? "—" : formatPrice(Math.abs(p.avgPrice))}</td>
                        <td>{formatPrice(p.mark)}</td>
                        <td>{formatMoney(p.marketValue)}</td>
                        <td data-direction={direction(p.unrealized)}>
                          {formatMoney(p.unrealized)}
                        </td>
                        <td className={styles.weight}>
                          <span style={{ width: `${(Math.abs(p.marketValue) / gross) * 100}%` }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={ui.panel} aria-label="Recent fills">
            <header>
              <span className="label">Recent fills</span>
            </header>
            {data && data.fills.length === 0 ? (
              <p className={ui.empty}>Nothing filled yet.</p>
            ) : (
              <div className={ui.scroll}>
                <table className={`mono ${ui.table}`}>
                  <thead>
                    <tr className="label">
                      <th>Time</th>
                      <th>Symbol</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.fills.slice(0, FILLS_SHOWN).map((f) => (
                      <tr key={f.id}>
                        <td>
                          {new Date(f.createdAt).toLocaleTimeString("en-US", { hour12: false })}
                        </td>
                        <td>{f.symbol}</td>
                        <td className={ui.side} data-side={f.side}>
                          {f.side}
                        </td>
                        <td>{f.qty.toLocaleString("en-US")}</td>
                        <td>{formatPrice(f.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  dir,
  big,
}: {
  label: string;
  value: string | null;
  note?: string;
  dir?: "up" | "down" | "flat";
  big?: boolean;
}) {
  return (
    <div className={styles.stat} data-big={big}>
      <span className="label">{label}</span>
      <strong className="mono" data-direction={dir}>
        {value ?? <span className={styles.skeleton} aria-label="loading" />}
      </strong>
      {note && <span className={styles.note}>{note}</span>}
    </div>
  );
}
