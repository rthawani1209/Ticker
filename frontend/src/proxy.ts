import { NextResponse, type NextRequest } from "next/server";

import { API_URL, WS_URL } from "@/lib/api";
import { contentSecurityPolicy } from "@/lib/csp";

// A fresh nonce on every page request. Next.js reads it from the CSP request header and
// puts it on its own scripts; the root layout puts it on the theme script.
export function proxy(request: NextRequest) {
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
