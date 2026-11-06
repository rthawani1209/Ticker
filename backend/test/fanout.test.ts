// Two gateways sharing one Redis: only the first turns engine events into the
// public feed, and a client on either one still gets every message once.
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { buildApp } from "../src/app.js";
import { FANOUT_CHANNEL, RedisFanout } from "../src/ws/fanout.js";
import { auth, connectWs, signUp, startBackend, type Backend } from "./harness.js";

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("fan-out across gateways", () => {
  let b: Backend;
  let second: Awaited<ReturnType<typeof buildApp>>;
  let secondFanout: RedisFanout;
  let secondRedis: Redis;
  const urls: string[] = [];

  beforeAll(async () => {
    b = await startBackend();
    await b.app.listen({ host: "127.0.0.1", port: 0 });
    // The second gateway shares the database and engine session but relays the
    // feed from Redis instead of publishing it.
    secondRedis = new Redis(REDIS_URL!);
    secondFanout = new RedisFanout(secondRedis);
    await secondFanout.ready;
    second = await buildApp({
      ...b.deps,
      config: { ...b.deps.config, MARKET_PUBLISHER: false },
      redis: secondRedis,
      fanout: secondFanout,
    });
    await second.listen({ host: "127.0.0.1", port: 0 });
    for (const app of [b.app, second]) {
      const { port } = app.server.address() as { port: number };
      urls.push(`ws://127.0.0.1:${port}/ws`);
    }
  });
  afterAll(async () => {
    await second?.close();
    await secondFanout?.close();
    secondRedis?.disconnect();
    await b?.stop();
  });

  const subscribe = async (url: string, channels: string[]) => {
    const client = await connectWs(url);
    for (const channel of channels) {
      client.ws.send(JSON.stringify({ op: "subscribe", channel }));
      await client.next("subscribed");
    }
    return client;
  };
  const closeAll = (...sockets: WebSocket[]) => sockets.forEach((ws) => ws.close());

  it("delivers every trade to clients on both gateways, once each", async () => {
    const alice = await signUp(b);
    const bob = await signUp(b);
    const a = await subscribe(urls[0]!, ["trades:MESA"]);
    const c = await subscribe(urls[1]!, ["trades:MESA"]);

    await b.app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: auth(alice.token),
      payload: { symbol: "MESA", side: "sell", price: 18_800, qty: 5 },
    });
    for (const qty of [1, 2]) {
      await b.app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: auth(bob.token),
        payload: { symbol: "MESA", side: "buy", price: 18_800, qty },
      });
    }
    for (const client of [a, c]) {
      expect(await client.next("trades:MESA")).toMatchObject({ qty: 1, price: 18_800 });
      expect(await client.next("trades:MESA")).toMatchObject({ qty: 2, price: 18_800 });
      await expect(client.next("trades:MESA", 300)).rejects.toThrow();
    }
    closeAll(a.ws, c.ws);
  });

  it("relays news published by the simulator", async () => {
    const a = await subscribe(urls[0]!, ["news"]);
    const c = await subscribe(urls[1]!, ["news"]);
    const headline = {
      ticker: "NOVA",
      text: "Nova beats estimates",
      impact: 0.02,
      time: Date.now(),
    };
    // The simulator publishes the same envelope straight to Redis.
    const pub = new Redis(REDIS_URL!);
    await pub.publish(FANOUT_CHANNEL, JSON.stringify({ channel: "news", data: headline }));
    pub.disconnect();
    expect(await a.next("news")).toEqual(headline);
    expect(await c.next("news")).toEqual(headline);
    closeAll(a.ws, c.ws);
  });
});
