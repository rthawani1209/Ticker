import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "@/lib/csp";

describe("content security policy", () => {
  const prod = contentSecurityPolicy("abc123", "https://api.ticker.example", false);
  const rule = (csp: string, name: string) =>
    csp.split("; ").find((d) => d.startsWith(name + " ")) ?? "";

  it("only runs scripts from this site or with the nonce", () => {
    expect(rule(prod, "script-src")).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(prod).not.toContain("unsafe-eval");
    expect(rule(prod, "object-src")).toBe("object-src 'none'");
    expect(rule(prod, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("lets the page reach the API over HTTPS and a secure WebSocket", () => {
    expect(rule(prod, "connect-src")).toBe(
      "connect-src 'self' https://api.ticker.example wss://api.ticker.example",
    );
    expect(prod).toContain("upgrade-insecure-requests");
  });

  it("allows eval and plain http only for local development", () => {
    const dev = contentSecurityPolicy("n", "http://localhost:8080", true);
    expect(rule(dev, "script-src")).toContain("'unsafe-eval'");
    expect(rule(dev, "connect-src")).toContain("ws://localhost:8080");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });
});
