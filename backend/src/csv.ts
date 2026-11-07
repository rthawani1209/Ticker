// CSV for spreadsheet exports. Quotes every field that needs it, and defuses cells a
// spreadsheet would run as a formula (=, +, -, @ at the start) by prefixing a quote.
const FORMULA = /^[=+\-@\t\r]/;
const NUMBER = /^-?\d+(\.\d+)?$/; // "-0.23" is a number, not a formula

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && FORMULA.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
