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
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (cfg.NODE_ENV === "production" && cfg.JWT_SECRET.startsWith("dev-only")) {
    throw new Error("JWT_SECRET must be set in production");
  }
  return cfg;
}
