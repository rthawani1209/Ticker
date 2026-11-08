import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "@/lib/csp";

const rule = (csp: string, name: string) =>
  csp.split("; ").find((d) => d.startsWith(name + " ")) ?? "";

describe("content security policy", () => {
  // Production: REST through this site, the socket straight to the backend.
  const prod = contentSecurityPolicy("abc123", "", "wss://api.example.app/ws", false);

  it("only runs scripts from this site or with the nonce", () => {
    expect(rule(prod, "script-src")).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(prod).not.toContain("unsafe-eval");
    expect(rule(prod, "object-src")).toBe("object-src 'none'");
    expect(rule(prod, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("lets the page reach the API through this site and the socket over wss", () => {
    expect(rule(prod, "connect-src")).toBe("connect-src 'self' wss://api.example.app");
    expect(prod).toContain("upgrade-insecure-requests");
  });

  it("allows a backend on another origin", () => {
    const csp = contentSecurityPolicy(
      "n",
      "https://api.example.app",
      "wss://api.example.app/ws",
      false,
    );
    expect(rule(csp, "connect-src")).toBe(
      "connect-src 'self' https://api.example.app wss://api.example.app",
    );
  });

  it("allows eval and plain http only for local development", () => {
    const dev = contentSecurityPolicy("n", "http://localhost:8080", "ws://localhost:8080/ws", true);
    expect(rule(dev, "script-src")).toContain("'unsafe-eval'");
    expect(rule(dev, "connect-src")).toBe(
      "connect-src 'self' http://localhost:8080 ws://localhost:8080",
    );
    expect(dev).not.toContain("upgrade-insecure-requests");
  });
});
