import type { NextConfig } from "next";

// No cacheComponents or partial prerendering: every page carries a per-request CSP nonce
// (src/proxy.ts), and a prerendered shell can't.
const nextConfig: NextConfig = {
  // With BACKEND_URL set (production), /v1 is forwarded to the backend so the browser
  // talks to one site. See NEXT_PUBLIC_API_URL in src/lib/api.ts.
  async rewrites() {
    const backend = process.env.BACKEND_URL?.replace(/\/$/, "");
    return backend
      ? [
          { source: "/v1/:path*", destination: `${backend}/v1/:path*` },
          { source: "/health", destination: `${backend}/health` },
        ]
      : [];
  },
};

export default nextConfig;
