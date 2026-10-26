import { Redis } from "ioredis";

import { buildApp } from "./app.js";
import { Tokens } from "./auth/tokens.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { EngineBridge } from "./engine/bridge.js";
import { OrderService } from "./orders.js";
import { loadSymbols } from "./symbols.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db, (m) => console.log(`migrate: ${m}`));

const symbols = await loadSymbols(db);
const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 }) : undefined;
const bridge = new EngineBridge({
  host: config.ENGINE_HOST,
  port: config.ENGINE_PORT,
  token: config.ENGINE_TOKEN,
  refPrices: symbols.map((s) => s.refPrice),
});
const orders = new OrderService(db, bridge);
const app = await buildApp(
  {
    config, db, redis, bridge, orders,
    tokens: new Tokens(config.JWT_SECRET, db),
    symbols,
    symbolsByTicker: new Map(symbols.map((s) => [s.ticker, s])),
  },
  { logger: true },
);

bridge.on("up", (session) => app.log.info({ session }, "connected to the exchange"));
bridge.on("down", () => app.log.warn("lost the exchange connection, reconnecting"));
bridge.on("warn", (msg) => app.log.warn(msg));
orders.on("error", (err) => app.log.error(err, "failed to apply an engine event"));

// Keep retrying in the background: the API (logins, history) works while the exchange is down.
bridge.start().catch((err) => {
  app.log.warn(`exchange not reachable yet (${err.message}), retrying`);
  const retry = setInterval(() => bridge.start().then(() => clearInterval(retry), () => {}), 2000);
});

await app.listen({ host: config.HOST, port: config.PORT });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    bridge.stop();
    await app.close();
    await db.end();
    redis?.disconnect();
    process.exit(0);
  });
}
