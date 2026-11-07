"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AppHeader } from "@/components/app/AppHeader";
import ui from "@/components/app/Page.module.css";
import { SessionGate } from "@/components/session/SessionGate";
import { Button } from "@/components/ui/Button";
import { ApiError, leagues as api, type League, type Session, type Standing } from "@/lib/api";
import { direction, formatMoney } from "@/lib/format";
import { queryParam } from "@/lib/query";
import { codeFrom, EMPTY_FORM, formatPct, inviteLink, readLeagueForm } from "@/lib/league";

import { ClassTools, MyAssignments } from "./ClassTools";
import styles from "./LeaguesScreen.module.css";

const BOARD_REFRESH_MS = 5_000;

export function LeaguesApp() {
  return <SessionGate>{(session) => <LeaguesScreen session={session} />}</SessionGate>;
}

const running = (l: League, now = new Date()) =>
  new Date(l.startsAt) <= now && (!l.endsAt || new Date(l.endsAt) > now);

const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function LeaguesScreen({ session }: { session: Session }) {
  const token = session.accessToken;
  const guest = session.user.role === "guest";
  const [list, setList] = useState<League[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  // An invite link lands here as /leagues?join=CODE.
  const [joinCode, setJoinCode] = useState(() => queryParam("join") ?? "");
  const [joinError, setJoinError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      api.list(token).then((ls) => {
        setList(ls);
        return ls;
      }),
    [token],
  );

  useEffect(() => {
    reload().then(
      (ls) => setSelected((cur) => cur ?? ls.find((l) => !l.isPractice)?.id ?? ls[0]?.id ?? null),
      () => setList([]),
    );
  }, [reload]);

  const join = async () => {
    const code = codeFrom(joinCode);
    if (!code) return setJoinError("Codes are 8 letters and numbers");
    try {
      const league = await api.join(token, code);
      setJoinCode("");
      setJoinError(null);
      await reload();
      setSelected(league.id);
      window.history.replaceState(null, "", "/leagues");
    } catch (e) {
      setJoinError(e instanceof ApiError ? e.message : "Couldn't join, try again");
    }
  };

  const league = list?.find((l) => l.id === selected) ?? null;

  return (
    <div className={ui.page}>
      <AppHeader session={session} />
      <main className={ui.body}>
        <div className={ui.head}>
          <div>
            <span className="label">Compete</span>
            <h1>Leagues</h1>
          </div>
          {guest ? (
            <p className={styles.guest}>
              Leagues need an account. <Link href="/login?mode=register">Save your account</Link> to
              create one or join with a code.
            </p>
          ) : (
            <div className={styles.actions}>
              <form
                className={styles.join}
                onSubmit={(e) => {
                  e.preventDefault();
                  join();
                }}
              >
                <label>
                  <span className="label">Invite code</span>
                  <input
                    className="mono"
                    value={joinCode}
                    onChange={(e) => {
                      setJoinCode(e.target.value);
                      setJoinError(null);
                    }}
                    placeholder="ABCD2345"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={joinError !== null}
                    aria-describedby={joinError ? "join-error" : undefined}
                  />
                </label>
                <Button variant="ghost" type="submit" disabled={!joinCode.trim()}>
                  Join
                </Button>
                {joinError && (
                  <span id="join-error" className={`mono ${styles.fieldError}`} role="alert">
                    {joinError}
                  </span>
                )}
              </form>
              <Button onClick={() => setCreating((c) => !c)} aria-expanded={creating}>
                {creating ? "Close" : "New league"}
              </Button>
            </div>
          )}
        </div>

        {creating && (
          <CreateLeague
            token={token}
            onCreated={async (l) => {
              setCreating(false);
              await reload();
              setSelected(l.id);
            }}
          />
        )}

        <div className={styles.layout}>
          <nav className={styles.list} aria-label="Your leagues">
            {list === null && <p className={ui.empty}>Loading…</p>}
            {list?.map((l) => (
              <button
                key={l.id}
                type="button"
                className={styles.item}
                aria-current={l.id === selected ? "true" : undefined}
                onClick={() => setSelected(l.id)}
              >
                <span className={styles.itemName}>{l.name}</span>
                <span className="mono">
                  {l.members} {l.members === 1 ? "trader" : "traders"}
                  {l.endsAt ? ` · ends ${dateText(l.endsAt)}` : ""}
                </span>
                {l.isOwner && <span className={`${ui.tag} ${styles.owner}`}>owner</span>}
              </button>
            ))}
          </nav>

          {league ? (
            <div className={styles.stack}>
              <LeagueDetail
                key={league.id}
                token={token}
                league={league}
                me={session.user.username}
              />
              {league.isOwner &&
              (session.user.role === "professor" || session.user.role === "admin") ? (
                <ClassTools
                  key={`t${league.id}`}
                  token={token}
                  league={league}
                  meId={session.user.id}
                />
              ) : (
                !league.isPractice && (
                  <MyAssignments key={`a${league.id}`} token={token} league={league} />
                )
              )}
            </div>
          ) : (
            list && (
              <p className={ui.empty}>
                You&apos;re not in any leagues yet. Create one or join with a code.
              </p>
            )
          )}
        </div>
      </main>
    </div>
  );
}

function LeagueDetail({ token, league, me }: { token: string; league: League; me: string }) {
  const [by, setBy] = useState<"return" | "sharpe">("return");
  const [board, setBoard] = useState<Standing[] | null>(null);
  const [copied, setCopied] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  useEffect(() => {
    let live = true;
    const load = () =>
      api.leaderboard(token, league.id, by).then(
        (b) => live && setBoard(b),
        () => live && setBoard([]),
      );
    load();
    const timer = setInterval(load, BOARD_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [token, league.id, by]);

  const link = league.inviteCode && origin ? inviteLink(origin, league.inviteCode) : null;
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const rules = [
    `${formatMoney(league.startingCash)} start`,
    league.commissionCents || league.commissionBps
      ? `${formatMoney(league.commissionCents)}${league.commissionBps ? ` + ${league.commissionBps / 100}%` : ""} per fill`
      : "no commission",
    league.allowShort ? `shorting on (${league.marginBps / 100}% margin)` : "no shorting",
    league.maxPosition ? `max ${league.maxPosition.toLocaleString("en-US")} shares` : null,
    league.allowedTypes.length < 4 ? league.allowedTypes.join(", ").replace(/_/g, " ") : null,
  ].filter(Boolean) as string[];

  return (
    <section className={`${ui.panel} ${styles.detail}`} aria-label={league.name}>
      <header className={styles.detailHead}>
        <div>
          <h2>{league.name}</h2>
          <span className="mono">
            {dateText(league.startsAt)} – {league.endsAt ? dateText(league.endsAt) : "no end date"}
          </span>
        </div>
        <div className={styles.links}>
          {!league.isPractice && running(league) && (
            <Link className={styles.mine} href={`/trade?league=${league.id}`}>
              Trade in this league →
            </Link>
          )}
          <Link
            className={styles.mine}
            href={`/portfolio${league.isPractice ? "" : `?league=${league.id}`}`}
          >
            My portfolio here →
          </Link>
        </div>
      </header>

      <ul className={styles.rules}>
        {rules.map((r) => (
          <li key={r} className="mono">
            {r}
          </li>
        ))}
      </ul>

      {link && (
        <div className={styles.invite}>
          <span className="label">Invite link</span>
          <code className="mono">{link}</code>
          <Button variant="ghost" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <span className={`mono ${styles.code}`}>code {league.inviteCode}</span>
        </div>
      )}

      <div className={styles.boardHead}>
        <span className="label">Leaderboard</span>
        <div className={styles.toggle} role="tablist" aria-label="Rank by">
          {(["return", "sharpe"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={by === k}
              onClick={() => {
                setBoard(null);
                setBy(k);
              }}
            >
              {k === "return" ? "Return" : "Sharpe"}
            </button>
          ))}
        </div>
      </div>

      {board === null ? (
        <p className={ui.empty}>Loading…</p>
      ) : board.length === 0 ? (
        <p className={ui.empty}>
          {by === "sharpe"
            ? "Sharpe shows up after about 30 minutes of trading, once there is enough history to mean something."
            : "Rankings appear within a second of the league starting."}
        </p>
      ) : (
        <div className={ui.scroll}>
          <table className={`mono ${ui.table}`}>
            <thead>
              <tr className="label">
                <th>#</th>
                <th className={styles.left}>Trader</th>
                <th>Equity</th>
                <th>Return</th>
                <th>Sharpe</th>
              </tr>
            </thead>
            <tbody>
              {board.map((s) => (
                <tr key={s.portfolioId} data-you={s.username === me || undefined}>
                  <td className={styles.rank}>{s.rank}</td>
                  <td className={styles.left}>
                    {s.username}
                    {s.username === me && <span className={ui.tag}>you</span>}
                  </td>
                  <td>{formatMoney(s.equity)}</td>
                  <td data-direction={direction(s.returnPct)}>{formatPct(s.returnPct)}</td>
                  <td>{s.sharpe === null ? "—" : s.sharpe.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CreateLeague({ token, onCreated }: { token: string; onCreated: (l: League) => void }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setProblem(null);
  };

  const submit = async () => {
    const r = readLeagueForm(form);
    if (!r.ok) return setProblem({ field: r.field, message: r.message });
    setBusy(true);
    try {
      onCreated(await api.create(token, r.body));
    } catch (e) {
      setProblem({
        field: "form",
        message: e instanceof ApiError ? e.message : "Couldn't create it",
      });
    } finally {
      setBusy(false);
    }
  };

  const err = (field: string) =>
    problem?.field === field ? (
      <span className={`mono ${styles.fieldError}`} role="alert">
        {problem.message}
      </span>
    ) : null;

  return (
    <form
      className={`${ui.panel} ${styles.create}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <header>
        <span className="label">New league</span>
        <span className="mono">starts now · everyone trades the same market</span>
      </header>
      <div className={styles.fields}>
        <label className={styles.wide}>
          <span className="label">Name</span>
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Econ 101 · Fall"
            maxLength={60}
            autoFocus
          />
          {err("name")}
        </label>
        <label>
          <span className="label">Starting cash ($)</span>
          <input
            className="mono"
            inputMode="decimal"
            value={form.startingCash}
            onChange={(e) => set("startingCash", e.target.value)}
          />
          {err("startingCash")}
        </label>
        <label>
          <span className="label">Ends on (optional)</span>
          <input type="date" value={form.endsOn} onChange={(e) => set("endsOn", e.target.value)} />
          {err("endsOn")}
        </label>
        <label>
          <span className="label">Commission per order ($)</span>
          <input
            className="mono"
            inputMode="decimal"
            value={form.commission}
            onChange={(e) => set("commission", e.target.value)}
            placeholder="0"
          />
          {err("commission")}
        </label>
        <label>
          <span className="label">Max shares per stock</span>
          <input
            className="mono"
            inputMode="numeric"
            value={form.maxPosition}
            onChange={(e) => set("maxPosition", e.target.value)}
            placeholder="no limit"
          />
          {err("maxPosition")}
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={form.allowShort}
            onChange={(e) => set("allowShort", e.target.checked)}
          />
          <span>Allow short selling</span>
        </label>
      </div>
      <footer className={styles.createFoot}>
        {err("form")}
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create league"}
        </Button>
      </footer>
    </form>
  );
}
