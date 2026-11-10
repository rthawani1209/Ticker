// Helpers for the Leagues screen: invite links, and turning the create form's text
// fields into the API's body (money in cents, dates as ISO strings).
import type { NewLeague, OrderType } from "./api";
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

export const ORDER_TYPES: { value: OrderType; label: string }[] = [
  { value: "limit", label: "Limit" },
  { value: "market", label: "Market" },
  { value: "stop", label: "Stop" },
  { value: "stop_limit", label: "Stop limit" },
];

export interface LeagueForm {
  name: string;
  startingCash: string; // dollars
  startsOn: string; // yyyy-mm-dd from a date input, or "" for now
  endsOn: string; // yyyy-mm-dd from a date input, or ""
  commission: string; // dollars per order, or ""
  commissionPct: string; // percent of each fill, or ""
  allowShort: boolean;
  maxPosition: string; // shares, or ""
  allowedTypes: OrderType[];
}

export const EMPTY_FORM: LeagueForm = {
  name: "",
  startingCash: "100000",
  startsOn: "",
  endsOn: "",
  commission: "",
  commissionPct: "",
  allowShort: true,
  maxPosition: "",
  allowedTypes: ORDER_TYPES.map((t) => t.value),
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

  let startsAt: string | undefined;
  let start = now;
  if (f.startsOn) {
    // From the start of that day, in the browser's time zone. Today means now.
    const day = new Date(`${f.startsOn}T00:00:00`);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (Number.isNaN(day.getTime()) || day < today)
      return { ok: false, field: "startsOn", message: "pick today or a later day" };
    if (day > now) {
      start = day;
      startsAt = day.toISOString();
    }
  }

  let endsAt: string | undefined;
  if (f.endsOn) {
    // The league runs to the end of that day, in the browser's time zone.
    const end = new Date(`${f.endsOn}T23:59:59`);
    if (Number.isNaN(end.getTime()) || end <= start)
      return {
        ok: false,
        field: "endsOn",
        message: startsAt ? "pick a day after the start" : "pick a day after today",
      };
    endsAt = end.toISOString();
  }

  let commissionCents = 0;
  if (f.commission.trim()) {
    const c = f.commission.trim() === "0" ? 0 : parseDollars(f.commission);
    if (c === null || c > 100_00)
      return { ok: false, field: "commission", message: "$0 to $100 per order" };
    commissionCents = c;
  }

  let commissionBps = 0;
  if (f.commissionPct.trim()) {
    const pct = Number(f.commissionPct.trim().replace(/%$/, ""));
    const bps = Math.round(pct * 100);
    if (!Number.isFinite(pct) || pct < 0 || bps > 1000 || Math.abs(pct * 100 - bps) > 1e-9)
      return { ok: false, field: "commissionPct", message: "0% to 10%, to two decimals" };
    commissionBps = bps;
  }

  if (f.allowedTypes.length === 0)
    return { ok: false, field: "allowedTypes", message: "allow at least one order type" };

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
      startsAt,
      endsAt,
      commissionCents,
      commissionBps,
      allowShort: f.allowShort,
      maxPosition,
      allowedTypes: f.allowedTypes,
    },
  };
}

export function formatPct(fraction: number, digits = 2): string {
  const pct = fraction * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}
