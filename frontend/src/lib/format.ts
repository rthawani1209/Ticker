// Prices travel as integer cents everywhere; these turn them into text.

export type Direction = "up" | "down" | "flat";

const price = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatPrice(cents: number): string {
  return price.format(cents / 100);
}

export function formatMoney(cents: number): string {
  return money.format(cents / 100);
}

export function direction(delta: number): Direction {
  return delta > 0 ? "up" : delta < 0 ? "down" : "flat";
}

// "▲ +2.24%" style change from a reference price. The arrow and sign mean it
// still reads correctly without color.
export function formatChange(cents: number, refCents: number): { text: string; dir: Direction } {
  const dir = direction(cents - refCents);
  if (refCents === 0) return { text: "–", dir: "flat" };
  const pct = ((cents - refCents) / refCents) * 100;
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "■";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return { text: `${arrow} ${sign}${Math.abs(pct).toFixed(2)}%`, dir };
}

// "142.35" -> 14235. Null for anything that isn't a positive amount with at most 2 decimals.
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/[$,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 ? cents : null;
}
