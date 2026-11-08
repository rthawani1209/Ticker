import type { NextConfig } from "next";

// No cacheComponents or partial prerendering: every page carries a per-request CSP nonce
// (src/proxy.ts), and a prerendered shell can't.
const nextConfig: NextConfig = {};

export default nextConfig;
