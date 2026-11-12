import { isIP } from "node:net";

// The visitor's IP from x-forwarded-for, or null. Vercel replaces the header with just
// the visitor's IP, but behind a proxy that appends instead, anything before the last
// entry came from the browser and can be made up. So only the last entry counts.
export function visitorIp(forwardedFor: string | null): string | null {
  const ip = forwardedFor?.split(",").at(-1)?.trim();
  return ip && isIP(ip) ? ip : null;
}
