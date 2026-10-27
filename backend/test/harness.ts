// Spins up the whole backend for a test file: a fresh database schema, a real
// ticker-engine on a random port, and the Fastify app.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Redis } from "ioredis";

import { buildApp } from "../src/app.js";
import { Tokens } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { EngineBridge } from "../src/engine/bridge.js";
import { Leaderboard } from "../src/leaderboard.js";
import { OrderService } from "../src/orders.js";
import { loadSymbols } from "../src/symbols.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ENGINE_BIN = process.env.TICKER_ENGINE ?? path.join(root, "engine/build/ticker-engine");
const TOKEN = 5150n;

export function startEngine(): Promise<{ proc: ChildProcess; port: number }> {
  if (!existsSync(ENGINE_BIN)) throw new Error(`build the engine first: ${ENGINE_BIN} not found`);
  const proc = spawn(ENGINE_BIN, ["--host", "127.0.0.1", "--port", "0", "--token", String(TOKEN), "--shards", "1"]);
  return new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.stdout!.once("data", (d: Buffer) => {
      const m = /:(\d+) /.exec(d.toString());
      if (m) resolve({ proc, port: Number(m[1]) });
      else reject(new Error(`unexpected engine output: ${d}`));
    });
  });
}

export async function startBackend() {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://ticker:ticker@localhost:5432/ticker_test",
  });
  const db = createPool(config.DATABASE_URL);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(db);

  const engine = await startEngine();
  const symbols = await loadSymbols(db);
  const bridge = new EngineBridge({ host: "127.0.0.1", port: engine.port, token: TOKEN, refPrices: symbols.map((s) => s.refPrice) });
  await bridge.start();
  const orders = new OrderService(db, bridge);
  orders.on("error", (err) => console.error("event apply failed", err));

  const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : undefined;
  if (redis) await redis.flushdb();
  // Tests call leaderboard.refresh() themselves instead of running the timer.
  const leaderboard = new Leaderboard(db, orders.marks, symbols.map((s) => s.id), redis, 60);
  const app = await buildApp({
    config, db, redis, bridge, orders, leaderboard,
    tokens: new Tokens(config.JWT_SECRET, db),
    symbols,
    symbolsByTicker: new Map(symbols.map((s) => [s.ticker, s])),
  });
  await app.ready();

  return {
    app, db, bridge, orders, leaderboard, engine,
    async stop() {
      bridge.stop();
      await app.close();
      await db.end();
      redis?.disconnect();
      engine.proc.kill("SIGTERM");
    },
  };
}

export type Backend = Awaited<ReturnType<typeof startBackend>>;

let n = 0;
let signUps = 0;
export async function signUp(b: Backend, name = `user${++n}_${process.pid}`) {
  const k = ++signUps;
  const res = await b.app.inject({
    method: "POST",
    url: "/v1/auth/register",
    // A different address per sign-up, so test files can make more than 10 users a minute.
    remoteAddress: `10.1.${(k >> 8) & 255}.${k & 255}`,
    payload: { email: `${name}@example.com`, username: name, password: "correct horse battery" },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const body = res.json();
  const cookie = res.cookies.find((c) => c.name === "ticker_rt")!.value;
  // The practice portfolio's id is the account the engine sees for this user.
  const { rows } = await b.db.query(
    "SELECT p.id FROM portfolios p JOIN leagues l ON l.id = p.league_id WHERE l.is_practice AND p.user_id = $1",
    [body.user.id],
  );
  return { id: body.user.id as number, portfolio: rows[0].id as number, token: body.accessToken as string, cookie, name };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
