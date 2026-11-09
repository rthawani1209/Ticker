import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { FastifyRequest } from "fastify";

// The web app forwards /v1 calls, so the backend sees Vercel's IP, and every visitor
// would share one sign-up and login limit. The web app's proxy sends the visitor's IP
// along with an HMAC of it. When the HMAC checks out, that IP replaces what the
// X-Forwarded-For hops would give; when it doesn't, the headers are dropped.
export function signClientIp(secret: string, ip: string): string {
  return createHmac("sha256", secret).update(ip).digest("base64url");
}

export function edgeClientIp(secret: string) {
  return async (req: FastifyRequest) => {
    const headers = req.raw.headers;
    const ip = headers["x-ticker-client-ip"];
    const sig = headers["x-ticker-client-sig"];
    delete headers["x-ticker-client-ip"];
    delete headers["x-ticker-client-sig"];
    if (typeof ip !== "string" || typeof sig !== "string" || !isIP(ip)) return;
    const want = Buffer.from(signClientIp(secret, ip));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return;
    // Fastify works req.ip out from the socket and X-Forwarded-For on every read, so
    // the signed IP goes in as the only entry; with one trusted hop it comes out as req.ip.
    headers["x-forwarded-for"] = ip;
  };
}
