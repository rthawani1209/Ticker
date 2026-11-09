import { createHmac } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { API_URL, WS_URL } from "@/lib/api";
import { contentSecurityPolicy } from "@/lib/csp";

// A fresh nonce on every page request. Next.js reads it from the CSP request header and
// puts it on its own scripts; the root layout puts it on the theme script.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/v1/") || pathname === "/health") return forwardToBackend(request);

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce, API_URL, WS_URL, process.env.NODE_ENV === "development");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return response;
}

// /v1 calls are rewritten to the backend, which then sees Vercel's IP for every visitor.
// Pass the visitor's IP along, signed with a secret the backend shares, so per-IP
// sign-up and login limits still count people one by one. Vercel sets x-forwarded-for
// to the visitor's IP itself, overwriting anything the browser sent.
function forwardToBackend(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("x-ticker-client-ip");
  headers.delete("x-ticker-client-sig");
  const secret = process.env.EDGE_SECRET;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (secret && ip) {
    headers.set("x-ticker-client-ip", ip);
    headers.set("x-ticker-client-sig", createHmac("sha256", secret).update(ip).digest("base64url"));
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    {
      // Pages only: static files and link prefetches don't need a policy.
      source: "/((?!_next/static|_next/image|favicon.ico|replay/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
