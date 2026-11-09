import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().default("postgres://ticker:ticker@localhost:5432/ticker"),
  REDIS_URL: z.string().optional(), // without it, rate limits are kept in memory (fine for one instance)
  JWT_SECRET: z.string().min(32).default("dev-only-secret-change-me-dev-only-secret"),
  ENGINE_HOST: z.string().default("127.0.0.1"),
  ENGINE_PORT: z.coerce.number().int().default(9100),
  ENGINE_TOKEN: z.coerce.bigint().default(0n),
  // With several gateways behind Redis, exactly one turns engine events into the
  // public feed; the rest only relay it. A single gateway keeps the default.
  MARKET_PUBLISHER: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  // How often portfolio values are saved for return charts and the Sharpe ratio.
  SNAPSHOT_INTERVAL_S: z.coerce.number().int().min(1).default(60),
  // How many proxies in front of the backend add to X-Forwarded-For (Railway's edge is
  // one). Only the entries those proxies added are believed; anything further left was
  // written by the client. 0 ignores the header. "true" is kept as an alias for 1.
  TRUST_PROXY: z
    .string()
    .default("0")
    .transform((v) => (v === "true" ? 1 : v === "false" ? 0 : Number(v)))
    .pipe(z.number().int().min(0).max(5)),
  // Shared with the web app. Requests it forwards carry the visitor's IP in
  // x-ticker-client-ip, signed with this, because Vercel's own IP is all the backend sees.
  EDGE_SECRET: z.string().min(24).optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (cfg.NODE_ENV === "production" && cfg.JWT_SECRET.startsWith("dev-only")) {
    throw new Error("JWT_SECRET must be set in production");
  }
  return cfg;
}
