import { describe, expect, it } from "vitest";

import { codeFrom, EMPTY_FORM, formatPct, inviteLink, readLeagueForm } from "@/lib/league";

describe("invite codes", () => {
  it("round-trips through an invite link", () => {
    const link = inviteLink("https://ticker.app", "ABCD2345");
    expect(link).toBe("https://ticker.app/leagues?join=ABCD2345");
    expect(codeFrom(link)).toBe("ABCD2345");
  });

  it("accepts a typed code in any case with spaces or a dash", () => {
    expect(codeFrom(" abcd-2345 ")).toBe("ABCD2345");
    expect(codeFrom("abcd 2345")).toBe("ABCD2345");
  });

  it("rejects codes with the wrong length or look-alike characters", () => {
    expect(codeFrom("ABC")).toBeNull();
    expect(codeFrom("ABCD234O")).toBeNull(); // O is never used
    expect(codeFrom("ABCD2341")).toBeNull(); // nor 1
    expect(codeFrom("")).toBeNull();
  });
});

describe("new league form", () => {
  const now = new Date("2026-11-06T12:00:00");
  const ok = { ...EMPTY_FORM, name: "Econ 101" };

  it("sends sensible defaults", () => {
    expect(readLeagueForm(ok, now)).toEqual({
      ok: true,
      body: {
        name: "Econ 101",
        startingCash: 100_000_00,
        endsAt: undefined,
        commissionCents: 0,
        allowShort: true,
        maxPosition: null,
      },
    });
  });

  it("turns dollars, dates and share limits into API values", () => {
    const r = readLeagueForm(
      {
        ...ok,
        startingCash: "$25,000",
        commission: "1.50",
        maxPosition: "5,000",
        endsOn: "2026-12-01",
      },
      now,
    );
    expect(r.ok && r.body).toMatchObject({
      startingCash: 25_000_00,
      commissionCents: 150,
      maxPosition: 5000,
      endsAt: new Date("2026-12-01T23:59:59").toISOString(),
    });
  });

  it("points at the field that's wrong", () => {
    const field = (f: Partial<typeof ok>) => {
      const r = readLeagueForm({ ...ok, ...f }, now);
      return r.ok ? null : r.field;
    };
    expect(field({ name: "ab" })).toBe("name");
    expect(field({ startingCash: "500" })).toBe("startingCash");
    expect(field({ startingCash: "lots" })).toBe("startingCash");
    expect(field({ endsOn: "2026-11-01" })).toBe("endsOn");
    expect(field({ commission: "250" })).toBe("commission");
    expect(field({ maxPosition: "1.5" })).toBe("maxPosition");
    expect(field({ commission: "0" })).toBeNull();
  });
});

describe("percent text", () => {
  it("signs and rounds", () => {
    expect(formatPct(0.0123)).toBe("+1.23%");
    expect(formatPct(-0.5)).toBe("−50.00%");
    expect(formatPct(0)).toBe("0.00%");
  });
});
