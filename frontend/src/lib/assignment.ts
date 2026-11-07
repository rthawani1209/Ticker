// Assignment wording and the create form, shared by the teacher and student views.
import type { Assignment, AssignmentKind, NewAssignment } from "./api";

export const KINDS: { kind: AssignmentKind; label: string; unit: string }[] = [
  { kind: "return_at_least", label: "Return at least", unit: "%" },
  { kind: "trades_at_least", label: "Make at least", unit: "trades" },
  { kind: "drawdown_at_most", label: "Max drawdown at most", unit: "%" },
  { kind: "use_order_type", label: "Use the order type", unit: "" },
];

export const ORDER_TYPES = ["limit", "market", "stop", "stop_limit", "bracket"] as const;

// "Return at least 5%", "Make at least 10 trades", "Use a stop order"
export function describeGoal(a: Pick<Assignment, "kind" | "target" | "orderType">): string {
  switch (a.kind) {
    case "return_at_least":
      return `Return at least ${a.target / 100}%`;
    case "trades_at_least":
      return `Make at least ${a.target} trade${a.target === 1 ? "" : "s"}`;
    case "drawdown_at_most":
      return `Keep max drawdown under ${a.target / 100}%`;
    case "use_order_type":
      return `Fill a ${(a.orderType ?? "").replace("_", "-")} order`;
  }
}

// The measured value in the goal's units.
export function describeValue(kind: AssignmentKind, value: number | null): string {
  if (value === null) return "—";
  if (kind === "return_at_least" || kind === "drawdown_at_most")
    return `${(value / 100).toFixed(2)}%`;
  if (kind === "use_order_type") return value ? "yes" : "not yet";
  return String(value);
}

export interface AssignmentForm {
  title: string;
  kind: AssignmentKind;
  target: string;
  orderType: string;
  dueOn: string; // yyyy-mm-dd
}

export const EMPTY_ASSIGNMENT: AssignmentForm = {
  title: "",
  kind: "return_at_least",
  target: "",
  orderType: "stop",
  dueOn: "",
};

export function readAssignmentForm(
  f: AssignmentForm,
  now = new Date(),
): { ok: true; body: NewAssignment } | { ok: false; field: keyof AssignmentForm; message: string } {
  const title = f.title.trim();
  if (title.length < 3 || title.length > 120)
    return { ok: false, field: "title", message: "3 to 120 characters" };
  const due = new Date(`${f.dueOn}T23:59:59`);
  if (!f.dueOn || Number.isNaN(due.getTime()) || due <= now)
    return { ok: false, field: "dueOn", message: "pick a due date after today" };

  if (f.kind === "use_order_type")
    return {
      ok: true,
      body: { title, kind: f.kind, target: 0, orderType: f.orderType, dueAt: due.toISOString() },
    };

  const n = Number(f.target.trim());
  if (f.kind === "trades_at_least") {
    if (!Number.isInteger(n) || n < 1 || n > 100_000)
      return { ok: false, field: "target", message: "a whole number of trades" };
    return { ok: true, body: { title, kind: f.kind, target: n, dueAt: due.toISOString() } };
  }
  // Percentages go to the API as basis points.
  if (!f.target.trim() || !Number.isFinite(n) || n < 0 || n > 1000)
    return { ok: false, field: "target", message: "a percentage, like 5 or 2.5" };
  return {
    ok: true,
    body: { title, kind: f.kind, target: Math.round(n * 100), dueAt: due.toISOString() },
  };
}
