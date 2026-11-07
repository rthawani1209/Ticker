"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AppHeader } from "@/components/app/AppHeader";
import ui from "@/components/app/Page.module.css";
import { SessionGate } from "@/components/session/SessionGate";
import { Button } from "@/components/ui/Button";
import {
  API_URL,
  ApiError,
  apiKeys,
  leagues as leagueApi,
  type ApiKey,
  type League,
  type Session,
} from "@/lib/api";

import styles from "./BotsScreen.module.css";

export function BotsApp() {
  return <SessionGate>{(session) => <BotsScreen session={session} />}</SessionGate>;
}

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "never";

function BotsScreen({ session }: { session: Session }) {
  const token = session.accessToken;
  const guest = session.user.role === "guest";
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [leagueList, setLeagueList] = useState<League[]>([]);
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => apiKeys.list(token).then(setKeys, () => setKeys([])), [token]);

  useEffect(() => {
    if (guest) return;
    load();
    leagueApi.list(token).then(setLeagueList, () => {});
  }, [guest, load, token]);

  const revoke = async (k: ApiKey) => {
    if (!window.confirm(`Revoke "${k.name}"? Its open orders are cancelled and it stops working.`))
      return;
    try {
      const r = await apiKeys.revoke(token, k.id);
      setError(null);
      setFresh(null);
      await load();
      setNote(
        r.cancelled
          ? `Revoked "${k.name}" and cancelled ${r.cancelled} open order${r.cancelled === 1 ? "" : "s"}.`
          : `Revoked "${k.name}".`,
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't revoke it");
    }
  };

  const leagueName = (id: number | null) =>
    id === null ? "Practice" : (leagueList.find((l) => l.id === id)?.name ?? `League ${id}`);

  return (
    <div className={ui.page}>
      <AppHeader session={session} />
      <main className={ui.body}>
        <div className={ui.head}>
          <div>
            <span className="label">Automate</span>
            <h1>Bots</h1>
          </div>
          <p className={styles.lede}>
            Trade from your own code with an API key. Keys can trade and read your account in one
            league, nothing else.
          </p>
        </div>

        {guest ? (
          <p className={ui.empty}>
            API keys need an account. <Link href="/login?mode=register">Save your account</Link>{" "}
            first.
          </p>
        ) : (
          <div className={styles.layout}>
            <div className={styles.main}>
              {fresh && (
                <section className={styles.fresh} role="status">
                  <span className="label">New key · {fresh.name}</span>
                  <p>Copy it now. It won&apos;t be shown again.</p>
                  <CopyField value={fresh.key} />
                </section>
              )}
              {error && <p className={ui.error}>{error}</p>}
              {note && (
                <p className={`mono ${styles.note}`} role="status">
                  {note}
                </p>
              )}

              <section className={ui.panel} aria-label="Your API keys">
                <header>
                  <span className="label">Your keys</span>
                  <span className="mono">{keys ? `${keys.length} of 5` : ""}</span>
                </header>
                {keys === null ? (
                  <p className={ui.empty}>Loading…</p>
                ) : keys.length === 0 ? (
                  <p className={ui.empty}>No keys yet. Make one to start a bot.</p>
                ) : (
                  <div className={ui.scroll}>
                    <table className={`mono ${ui.table} ${styles.keys}`}>
                      <thead>
                        <tr className="label">
                          <th>Name</th>
                          <th className={styles.wide}>Key</th>
                          <th className={styles.wide}>League</th>
                          <th>Limits</th>
                          <th>Last used</th>
                          <th aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {keys.map((k) => (
                          <tr key={k.id}>
                            <td>{k.name}</td>
                            <td className={`${styles.muted} ${styles.wide}`}>{k.prefix}_…</td>
                            <td className={styles.wide}>{leagueName(k.league)}</td>
                            <td>
                              {k.maxOrderQty.toLocaleString("en-US")} sh · {k.ordersPerSecond}/s
                            </td>
                            <td className={styles.muted}>{when(k.lastUsedAt)}</td>
                            <td>
                              <button
                                type="button"
                                className={styles.revoke}
                                onClick={() => revoke(k)}
                              >
                                Revoke
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <NewKey
                token={token}
                leagues={leagueList}
                disabled={(keys?.length ?? 0) >= 5}
                onCreated={(name, key) => {
                  setFresh({ name, key });
                  setError(null);
                  setNote(null);
                  load();
                }}
              />
            </div>

            <aside className={`${ui.panel} ${styles.guide}`} aria-label="Quick start">
              <header>
                <span className="label">Quick start · Python</span>
              </header>
              <ol>
                <li>
                  Get the starter kit from <code>sdk/python</code> in the Ticker repo. No installs:
                  it uses only the standard library.
                </li>
                <li>Trade:</li>
              </ol>
              <pre className="mono">{`from ticker_sdk import Ticker

t = Ticker("${API_URL}",
           "tk_...")
q = t.quote("NOVA")
t.buy("NOVA", 10, price=q.bid)`}</pre>
              <ol start={3}>
                <li>
                  Or run the sample market maker:
                  <pre className="mono">{`export TICKER_URL=${API_URL}
export TICKER_KEY=tk_...
python examples/market_maker.py NOVA`}</pre>
                </li>
              </ol>
              <p className={styles.muted}>
                Over the rate limit you get a 429; an admin can pause every bot at once.
              </p>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}

function NewKey({
  token,
  leagues,
  disabled,
  onCreated,
}: {
  token: string;
  leagues: League[];
  disabled: boolean;
  onCreated: (name: string, key: string) => void;
}) {
  const [name, setName] = useState("");
  const [league, setLeague] = useState("");
  const [maxQty, setMaxQty] = useState("1000");
  const [rate, setRate] = useState("5");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const qty = Number(maxQty);
    const perSecond = Number(rate);
    if (!name.trim()) return setProblem("Give it a name");
    if (!Number.isInteger(qty) || qty < 1 || qty > 100_000)
      return setProblem("Max shares is 1 to 100,000");
    if (!Number.isInteger(perSecond) || perSecond < 1 || perSecond > 20)
      return setProblem("Orders a second is 1 to 20");
    setBusy(true);
    try {
      const k = await apiKeys.create(token, {
        name: name.trim(),
        league: league ? Number(league) : undefined,
        maxOrderQty: qty,
        ordersPerSecond: perSecond,
      });
      setName("");
      setProblem(null);
      onCreated(k.name, k.key);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "Couldn't make the key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={`${ui.panel} ${styles.form}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <header>
        <span className="label">New key</span>
      </header>
      <div className={styles.fields}>
        <label>
          <span className="label">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="market maker"
          />
        </label>
        <label>
          <span className="label">League</span>
          <select value={league} onChange={(e) => setLeague(e.target.value)}>
            {leagues.map((l) => (
              <option key={l.id} value={l.isPractice ? "" : l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Max shares an order</span>
          <input
            className="mono"
            inputMode="numeric"
            value={maxQty}
            onChange={(e) => setMaxQty(e.target.value)}
          />
        </label>
        <label>
          <span className="label">Orders a second</span>
          <input
            className="mono"
            inputMode="numeric"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </label>
      </div>
      <footer>
        {problem && (
          <span className={`mono ${styles.problem}`} role="alert">
            {problem}
          </span>
        )}
        <Button type="submit" disabled={busy || disabled}>
          {disabled ? "5 keys max" : busy ? "Making…" : "Make key"}
        </Button>
      </footer>
    </form>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.copy}>
      <code className="mono">{value}</code>
      <Button
        variant="ghost"
        onClick={() =>
          navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            },
            () => {},
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
