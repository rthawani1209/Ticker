import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signClientIp } from "../src/auth/edge.js";
import { startBackend, type Backend } from "./harness.js";

const SECRET = "edge-secret-for-tests-0123456789";

// Railway's edge in front of the backend, and the web app forwarding /v1 calls.
describe("client IP behind proxies", () => {
  let b: Backend;
  beforeAll(async () => {
    b = await startBackend({ TRUST_PROXY: "1", EDGE_SECRET: SECRET });
  });
  afterAll(() => b?.stop());

  async function guest(headers: Record<string, string>) {
    const res = await b.app.inject({
      method: "POST",
      url: "/v1/auth/guest",
      remoteAddress: "10.0.0.2", // Railway's edge
      headers,
    });
    return res.headers["x-ratelimit-remaining"];
  }

  it("takes the IP the trusted proxy added, not one the client wrote", async () => {
    // A client sends its own X-Forwarded-For; the edge appends the real address.
    const first = await guest({ "x-forwarded-for": "8.8.1.1, 198.51.100.7" });
    const second = await guest({ "x-forwarded-for": "8.8.2.1, 198.51.100.7" });
    expect(Number(second)).toBe(Number(first) - 1);
    // And two real visitors behind the same edge are counted apart.
    const third = await guest({ "x-forwarded-for": "198.51.100.8" });
    expect(Number(third)).toBe(Number(first));
  });

  it("believes the web app's client IP only when it is signed", async () => {
    const ip = "203.0.113.9";
    const signed = { "x-ticker-client-ip": ip, "x-ticker-client-sig": signClientIp(SECRET, ip) };
    const a = await guest({ ...signed, "x-forwarded-for": "198.51.100.50" });
    const c = await guest({ ...signed, "x-forwarded-for": "198.51.100.50" });
    expect(Number(c)).toBe(Number(a) - 1);

    // A different visitor through the same web app gets their own count.
    const other = "203.0.113.10";
    const fresh = await guest({
      "x-ticker-client-ip": other,
      "x-ticker-client-sig": signClientIp(SECRET, other),
      "x-forwarded-for": "198.51.100.50",
    });
    expect(Number(fresh)).toBe(Number(a));

    // A forged signature falls back to what the edge saw, the web app's IP, counted from scratch.
    const forged = await guest({
      "x-ticker-client-ip": "203.0.113.11",
      "x-ticker-client-sig": "forged",
      "x-forwarded-for": "198.51.100.50",
    });
    expect(Number(forged)).toBe(Number(a));
    const again = await guest({ "x-forwarded-for": "198.51.100.50" });
    expect(Number(again)).toBe(Number(a) - 1);
  });
});
