import { describe, expect, it } from "vitest";

import {
  describeGoal,
  describeValue,
  EMPTY_ASSIGNMENT,
  readAssignmentForm,
} from "@/lib/assignment";

const now = new Date("2026-11-07T12:00:00");
const base = { ...EMPTY_ASSIGNMENT, title: "Week 1", dueOn: "2026-11-14" };

describe("assignment form", () => {
  it("sends percentages as basis points", () => {
    const r = readAssignmentForm({ ...base, target: "2.5" }, now);
    expect(r.ok && r.body).toMatchObject({ kind: "return_at_least", target: 250 });
  });

  it("sends order-type goals with a zero target", () => {
    const r = readAssignmentForm({ ...base, kind: "use_order_type", orderType: "bracket" }, now);
    expect(r.ok && r.body).toMatchObject({ target: 0, orderType: "bracket" });
  });

  it("points at the bad field", () => {
    const field = (f: object) => {
      const r = readAssignmentForm({ ...base, target: "5", ...f }, now);
      return r.ok ? null : r.field;
    };
    expect(field({ title: "ab" })).toBe("title");
    expect(field({ dueOn: "" })).toBe("dueOn");
    expect(field({ dueOn: "2026-11-01" })).toBe("dueOn");
    expect(field({ target: "" })).toBe("target");
    expect(field({ kind: "trades_at_least", target: "2.5" })).toBe("target");
    expect(field({ kind: "trades_at_least", target: "10" })).toBeNull();
  });
});

describe("assignment text", () => {
  it("describes goals and values in their units", () => {
    expect(describeGoal({ kind: "return_at_least", target: 500, orderType: null })).toBe(
      "Return at least 5%",
    );
    expect(describeGoal({ kind: "trades_at_least", target: 1, orderType: null })).toBe(
      "Make at least 1 trade",
    );
    expect(describeGoal({ kind: "use_order_type", target: 0, orderType: "stop_limit" })).toBe(
      "Fill a stop-limit order",
    );
    expect(describeValue("drawdown_at_most", 125)).toBe("1.25%");
    expect(describeValue("use_order_type", 0)).toBe("not yet");
    expect(describeValue("trades_at_least", null)).toBe("—");
  });
});
