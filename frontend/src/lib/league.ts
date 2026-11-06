// Helpers for the Leagues screen: invite links, and turning the create form's text
// fields into the API's body (money in cents, dates as ISO strings).
import type { NewLeague } from "./api";
import { parseDollars } from "./format";

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

export function inviteLink(origin: string, code: string): string {
  return `${origin}/leagues?join=${code}`;
}

// Accepts a bare code or a whole invite link, any case, with stray spaces.
export function codeFrom(input: string): string | null {
  let text = input.trim();
  const m = /[?&]join=([^&#\s]+)/.exec(text);
  if (m) text = decodeURIComponent(m[1]!);
  text = text.replace(/[\s-]/g, "").toUpperCase();
  return CODE.test(text) ? text : null;
}

export interface LeagueForm {
  name: string;
  startingCash: string; // dollars
  endsOn: string; // yyyy-mm-dd from a date input, or ""
  commission: string; // dollars per order, or ""
  allowShort: boolean;
  maxPosition: string; // shares, or ""
}

export const EMPTY_FORM: LeagueForm = {
  name: "",
  startingCash: "100000",
  endsOn: "",
  commission: "",
  allowShort: true,
  maxPosition: "",
};

// Checks the form the same way the API will, so mistakes show next to the field.
export function readLeagueForm(
  f: LeagueForm,
  now = new Date(),
): { ok: true; body: NewLeague } | { ok: false; field: keyof LeagueForm; message: string } {
  const name = f.name.trim();
  if (name.length < 3 || name.length > 60)
    return { ok: false, field: "name", message: "3 to 60 characters" };

  const cash = parseDollars(f.startingCash);
  if (cash === null || cash < 1_000_00 || cash > 10_000_000_00)
    return { ok: false, field: "startingCash", message: "$1,000 to $10,000,000" };

  let endsAt: string | undefined;
  if (f.endsOn) {
    // The league runs to the end of that day, in the browser's time zone.
    const end = new Date(`${f.endsOn}T23:59:59`);
    if (Number.isNaN(end.getTime()) || end <= now)
      return { ok: false, field: "endsOn", message: "pick a day after today" };
    endsAt = end.toISOString();
  }

  let commissionCents = 0;
  if (f.commission.trim()) {
    const c = f.commission.trim() === "0" ? 0 : parseDollars(f.commission);
    if (c === null || c > 100_00)
      return { ok: false, field: "commission", message: "$0 to $100 per order" };
    commissionCents = c;
  }

  let maxPosition: number | null = null;
  if (f.maxPosition.trim()) {
    const n = Number(f.maxPosition.replace(/,/g, ""));
    if (!Number.isInteger(n) || n <= 0 || n > 10_000_000)
      return { ok: false, field: "maxPosition", message: "a whole number of shares" };
    maxPosition = n;
  }

  return {
    ok: true,
    body: {
      name,
      startingCash: cash,
      endsAt,
      commissionCents,
      allowShort: f.allowShort,
      maxPosition,
    },
  };
}

export function formatPct(fraction: number, digits = 2): string {
  const pct = fraction * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}
