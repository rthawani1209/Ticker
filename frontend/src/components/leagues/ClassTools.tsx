"use client";

import { useCallback, useEffect, useState } from "react";

import ui from "@/components/app/Page.module.css";
import { Button } from "@/components/ui/Button";
import {
  ApiError,
  classroom,
  type Assignment,
  type Grade,
  type League,
  type RosterRow,
} from "@/lib/api";
import {
  describeGoal,
  describeValue,
  EMPTY_ASSIGNMENT,
  KINDS,
  ORDER_TYPES,
  readAssignmentForm,
} from "@/lib/assignment";
import { direction, formatMoney } from "@/lib/format";
import { formatPct } from "@/lib/league";

import styles from "./ClassTools.module.css";

const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// Teacher view of a league they own: roster, assignments with every grade, exports.
export function ClassTools({
  token,
  league,
  meId,
}: {
  token: string;
  league: League;
  meId: number;
}) {
  const [tab, setTab] = useState<"roster" | "assignments">("roster");
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [work, setWork] = useState<(Assignment & { grades: Grade[] })[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([classroom.roster(token, league.id), classroom.assignments(token, league.id)]).then(
      ([r, a]) => {
        // The teacher is a member of their own league; leave them out of the class lists.
        setRoster(r.filter((x) => x.userId !== meId));
        setWork(a);
        setError(null);
      },
      (e) => setError(e instanceof ApiError ? e.message : "couldn't load the class"),
    );
  }, [token, league.id, meId]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = (what: "trades" | "grades") =>
    classroom.download(token, league.id, what).catch(() => setError("Export failed, try again"));

  return (
    <section className={`${ui.panel} ${styles.tools}`} aria-label="Teacher tools">
      <header>
        <div className={styles.tabs} role="tablist" aria-label="Teacher tools">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "roster"}
            onClick={() => setTab("roster")}
          >
            Roster {roster && <span>{roster.length}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "assignments"}
            onClick={() => setTab("assignments")}
          >
            Assignments {work && <span>{work.length}</span>}
          </button>
        </div>
        <div className={styles.exports}>
          <Button variant="ghost" onClick={() => exportCsv("trades")}>
            Trades CSV
          </Button>
          <Button variant="ghost" onClick={() => exportCsv("grades")}>
            Grades CSV
          </Button>
        </div>
      </header>
      {error && (
        <p className={ui.error} role="alert">
          {error}
        </p>
      )}
      {tab === "roster" ? (
        <Roster rows={roster} />
      ) : (
        <Assignments token={token} league={league} meId={meId} work={work} onChange={load} />
      )}
    </section>
  );
}

function Roster({ rows }: { rows: RosterRow[] | null }) {
  if (!rows) return <p className={ui.empty}>Loading…</p>;
  return (
    <div className={ui.scroll}>
      <table className={`mono ${ui.table}`}>
        <thead>
          <tr className="label">
            <th>Student</th>
            <th>Email</th>
            <th>Equity</th>
            <th>Return</th>
            <th>Trades</th>
            <th>Last trade</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId}>
              <td>{r.username}</td>
              <td className={styles.muted}>{r.email ?? "—"}</td>
              <td>{formatMoney(r.equity)}</td>
              <td data-direction={direction(r.returnPct)}>{formatPct(r.returnPct)}</td>
              <td>{r.trades}</td>
              <td className={styles.muted}>
                {r.lastTrade
                  ? new Date(r.lastTrade).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "never"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Assignments({
  token,
  league,
  meId,
  work,
  onChange,
}: {
  token: string;
  league: League;
  meId: number;
  work: (Assignment & { grades: Grade[] })[] | null;
  onChange: () => void;
}) {
  const [form, setForm] = useState(EMPTY_ASSIGNMENT);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setProblem(null);
  };

  const submit = async () => {
    const r = readAssignmentForm(form);
    if (!r.ok) return setProblem({ field: r.field, message: r.message });
    setBusy(true);
    try {
      await classroom.create(token, league.id, r.body);
      setForm(EMPTY_ASSIGNMENT);
      onChange();
    } catch (e) {
      setProblem({
        field: "form",
        message: e instanceof ApiError ? e.message : "Couldn't save it",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Assignment) => {
    if (!window.confirm(`Delete "${a.title}"? Students stop seeing it.`)) return;
    await classroom.remove(token, league.id, a.id).catch(() => {});
    onChange();
  };

  const err = (field: string) =>
    problem?.field === field ? (
      <span className={`mono ${styles.fieldError}`} role="alert">
        {problem.message}
      </span>
    ) : null;
  const unit = KINDS.find((k) => k.kind === form.kind)!.unit;

  return (
    <>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className={styles.title}>
          <span className="label">New assignment</span>
          <input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Week 1: beat the market"
            maxLength={120}
          />
          {err("title")}
        </label>
        <label>
          <span className="label">Goal</span>
          <select
            value={form.kind}
            onChange={(e) => set("kind", e.target.value as typeof form.kind)}
          >
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        {form.kind === "use_order_type" ? (
          <label>
            <span className="label">Order type</span>
            <select value={form.orderType} onChange={(e) => set("orderType", e.target.value)}>
              {ORDER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace("_", "-")}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            <span className="label">Target ({unit})</span>
            <input
              className="mono"
              inputMode="decimal"
              value={form.target}
              onChange={(e) => set("target", e.target.value)}
            />
            {err("target")}
          </label>
        )}
        <label>
          <span className="label">Due</span>
          <input type="date" value={form.dueOn} onChange={(e) => set("dueOn", e.target.value)} />
          {err("dueOn")}
        </label>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Add"}
        </Button>
        {err("form")}
      </form>

      {!work ? (
        <p className={ui.empty}>Loading…</p>
      ) : work.length === 0 ? (
        <p className={ui.empty}>
          No assignments yet. Grades update live until the due date, then freeze.
        </p>
      ) : (
        <ul className={styles.list}>
          {work.map((a) => {
            const students = a.grades.filter((g) => g.userId !== meId);
            const passed = students.filter((g) => g.passed).length;
            const expanded = open === a.id;
            return (
              <li key={a.id}>
                <div className={styles.row}>
                  <button
                    type="button"
                    className={styles.expand}
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : a.id)}
                  >
                    <strong>{a.title}</strong>
                    <span className="mono">
                      {describeGoal(a)} · due {dateText(a.dueAt)}
                    </span>
                  </button>
                  <span className={`mono ${styles.score}`}>
                    {passed}/{students.length} passing
                    <span className={styles.meter}>
                      <span
                        style={{
                          width: `${students.length ? (passed / students.length) * 100 : 0}%`,
                        }}
                      />
                    </span>
                  </span>
                  <button
                    type="button"
                    className={styles.delete}
                    onClick={() => remove(a)}
                    aria-label={`Delete ${a.title}`}
                  >
                    Delete
                  </button>
                </div>
                {expanded && (
                  <table className={`mono ${ui.table}`}>
                    <tbody>
                      {students.map((g) => (
                        <tr key={g.userId}>
                          <td>{g.username}</td>
                          <td>{describeValue(a.kind, g.value)}</td>
                          <td data-direction={g.passed ? "up" : "down"}>
                            {g.passed ? "pass" : "not yet"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// Student view: the league's assignments with how you're doing on each.
export function MyAssignments({ token, league }: { token: string; league: League }) {
  const [list, setList] = useState<
    (Assignment & { value: number | null; passed: boolean })[] | null
  >(null);

  useEffect(() => {
    classroom.mine(token, league.id).then(setList, () => setList([]));
  }, [token, league.id]);

  if (!list || list.length === 0) return null;
  return (
    <section className={`${ui.panel} ${styles.tools}`} aria-label="Assignments">
      <header>
        <span className="label">Assignments</span>
        <span className="mono">graded live until the due date</span>
      </header>
      <ul className={styles.list}>
        {list.map((a) => {
          const due = new Date(a.dueAt) <= new Date();
          return (
            <li key={a.id} className={styles.row}>
              <span className={styles.expand}>
                <strong>{a.title}</strong>
                <span className="mono">
                  {describeGoal(a)} · {due ? "closed" : "due"} {dateText(a.dueAt)}
                </span>
              </span>
              <span className="mono">{describeValue(a.kind, a.value)}</span>
              <span className={`mono ${styles.badge}`} data-pass={a.passed}>
                {a.passed ? "pass" : due ? "missed" : "in progress"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
