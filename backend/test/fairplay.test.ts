import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collusion, spoofing } from "../src/fairplay.js";
import { auth, signUp, startBackend, type Backend } from "./harness.js";

let b: Backend;
beforeAll(async () => {
  b = await startBackend();
});
afterAll(() => b?.stop());

type User = Awaited<ReturnType<typeof signUp>>;
const req = (u: User, method: string, url: string, payload?: object) =>
  b.app.inject({
    method: method as "GET",
    url,
    headers: auth(u.token),
    ...(payload ? { payload } : {}),
  });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A class with a professor, a market maker quoting both sides, and some students.
async function classWith(n: number) {
  const prof = await signUp(b);
  await b.db.query("UPDATE users SET role = 'professor' WHERE id = $1", [prof.id]);
  const league = (await req(prof, "POST", "/v1/leagues", { name: "Fair play" })).json();
  const people: User[] = [];
  for (let i = 0; i < n + 1; i++) {
    const u = await signUp(b);
    await req(u, "POST", "/v1/leagues/join", { code: league.inviteCode });
    people.push(u);
  }
  const place = async (u: User, order: object) => {
    const r = await req(u, "POST", "/v1/orders", { tif: "gtc", ...order, league: league.id });
    expect(r.statusCode, r.body).toBe(201);
    await pause(60); // stay under 20 orders a second
    return r.json();
  };
  const cancel = async (u: User, id: number) => {
    expect((await req(u, "DELETE", `/v1/orders/${id}`)).statusCode).toBe(200);
    await pause(60);
  };
  const report = async () => {
    await b.orders.settled();
    const r = await req(prof, "GET", `/v1/classes/${league.id}/fairplay`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  const [maker, ...students] = people as [User, ...User[]];
  return { maker, students, place, cancel, report };
}

describe("fair play", () => {
  it("flags two students who pass money through off-market trades, not a pair who trade fairly", async () => {
    const { maker, students, place, report } = await classWith(4);
    const [ana, ben, cal, dee] = students as [User, User, User, User];
    // A thin market: bid 90, ask 104, so the middle is 97.
    await place(maker, { symbol: "VYNE", side: "buy", price: 90_00, qty: 100 });
    await place(maker, { symbol: "VYNE", side: "sell", price: 104_00, qty: 100 });

    const cross = async (buyer: User, seller: User, price: number) => {
      await place(seller, { symbol: "VYNE", side: "sell", price, qty: 10 });
      const r = await place(buyer, { symbol: "VYNE", side: "buy", price, qty: 10, tif: "ioc" });
      expect(r.status).toBe("filled");
    };
    // ana buys high from ben and sells back low: about $90 moves from ana to ben each round trip (prices stay inside the 10% band).
    for (let i = 0; i < 3; i++) {
      await cross(ana, ben, 102_00);
      await cross(ben, ana, 93_00);
    }
    // cal and dee also only trade with each other, but at the middle of the book.
    for (let i = 0; i < 3; i++) {
      await cross(cal, dee, 97_00);
      await cross(dee, cal, 97_00);
    }

    const r = await report();
    const pair = (x: User, y: User) =>
      r.collusion.find((p: any) => [p.a, p.b].sort().join() === [x.name, y.name].sort().join());
    expect(pair(ana, ben)).toMatchObject({ trades: 6, shares: 60, shareOfA: 1, flagged: true });
    expect(pair(ana, ben).offMarket).toBeGreaterThan(0.04);
    expect(pair(cal, dee)).toMatchObject({ trades: 6, flagged: false });
    expect(pair(cal, dee).offMarket).toBeLessThan(0.005);
    expect(r.collusion.filter((p: any) => p.flagged)).toHaveLength(1);
    expect(r.spoofing.some((s: any) => s.flagged)).toBe(false);
  });

  it("flags big orders cancelled to push the price, not a market maker cancelling small quotes", async () => {
    const { maker, students, place, cancel, report } = await classWith(2);
    const [sam, mo] = students as [User, User];
    await place(maker, { symbol: "MESA", side: "buy", price: 186_00, qty: 200 });
    await place(maker, { symbol: "MESA", side: "sell", price: 190_00, qty: 200 });

    // sam keeps putting a big bid at the top of the book and pulling it, then sells a little.
    for (let i = 0; i < 20; i++) {
      const o = await place(sam, { symbol: "MESA", side: "buy", price: 187_00, qty: 400 });
      await cancel(sam, o.id);
    }
    // mo quotes small on both sides and cancels most of them, like a market-making bot.
    for (let i = 0; i < 20; i++) {
      const buy = i % 2 === 0;
      const o = await place(mo, {
        symbol: "MESA",
        side: buy ? "buy" : "sell",
        price: buy ? 186_50 : 189_50,
        qty: 10,
      });
      await cancel(mo, o.id);
    }
    for (const u of [sam, mo])
      for (let i = 0; i < 2; i++)
        expect(
          (await place(u, { symbol: "MESA", side: "sell", price: 186_00, qty: 10, tif: "ioc" }))
            .status,
        ).toBe("filled");

    const r = await report();
    const of = (u: User) => r.spoofing.find((s: any) => s.username === u.name);
    expect(of(sam)).toMatchObject({ orders: 22, oppositeFills: 2, flagged: true });
    expect(of(sam).sizeRatio).toBe(40);
    expect(of(mo)).toMatchObject({ orders: 22, flagged: false });
    expect(of(mo).sizeRatio).toBe(1);
    expect(of(mo).cancelRate).toBeGreaterThanOrEqual(0.9); // cancels as much as sam
    expect(r.collusion.some((p: any) => p.flagged)).toBe(false);
  });

  it("works on the numbers alone", () => {
    const vol = new Map([
      [1, 100],
      [2, 1000],
    ]);
    const t = (buyer: number, seller: number, price: number) => ({
      tradeId: "x",
      buyer,
      seller,
      qty: 10,
      price,
      refPrice: 100,
    });
    const trades = [1, 2, 3, 4, 5].map(() => t(1, 2, 105));
    // 50 of 1's 100 shares were with 2, at 5% off: flagged even though 2 trades a lot with others.
    expect(collusion(trades, vol)[0]).toMatchObject({
      shareOfA: 0.5,
      shareOfB: 0.05,
      flagged: true,
    });
    expect(collusion(trades.slice(0, 4), vol)[0]!.flagged).toBe(false); // too few trades
    expect(spoofing([])).toMatchObject({ orders: 0, flagged: false, sizeRatio: null });
    // All cancelled and none filled: nothing was gained, so it isn't spoofing.
    const pulled = Array.from({ length: 30 }, () => ({
      side: "buy" as const,
      qty: 500,
      filledQty: 0,
      cancelled: true,
    }));
    expect(spoofing(pulled).flagged).toBe(false);
  });
});
