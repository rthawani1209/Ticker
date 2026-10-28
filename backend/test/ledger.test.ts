import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyTrade, rebuild } from "../src/ledger.js";
import { sharpeRatio } from "../src/leaderboard.js";
import { auth, signUp, startBackend, type Backend } from "./harness.js";

describe("position math", () => {
  const flat = { qty: 0, cost: 0, realized: 0 };

  it("averages the cost of buys and realizes profit on sells", () => {
    let pos = applyTrade(flat, 10, 100_00);
    pos = applyTrade(pos, 10, 110_00);
    expect(pos).toEqual({ qty: 20, cost: 2_100_00, realized: 0 }); // average $105
    pos = applyTrade(pos, -5, 120_00);
    expect(pos).toEqual({ qty: 15, cost: 1_575_00, realized: 75_00 }); // 5 x ($120 - $105)
  });

  it("goes from long to short in one trade", () => {
    const pos = applyTrade({ qty: 10, cost: 1_000_00, realized: 0 }, -15, 90_00);
    expect(pos).toEqual({ qty: -5, cost: -450_00, realized: -100_00 });
  });

  it("realizes profit when a short is bought back lower", () => {
    const pos = applyTrade({ qty: -10, cost: -1_000_00, realized: 0 }, 4, 80_00);
    expect(pos).toEqual({ qty: -6, cost: -600_00, realized: 80_00 });
  });

  it("rebuilds cash and positions from fills, commissions included", () => {
    const { cash, positions } = rebuild(100_000_00, [
      { symbolId: 1, side: "buy", price: 50_00, qty: 100, commission: 1_00 },
      { symbolId: 1, side: "sell", price: 55_00, qty: 40, commission: 1_00 },
      { symbolId: 2, side: "sell", price: 20_00, qty: 10, commission: 0 },
    ]);
    expect(cash).toBe(100_000_00 - 5_000_00 - 1_00 + 2_200_00 - 1_00 + 200_00);
    expect(positions.get(1)).toEqual({ qty: 60, cost: 3_000_00, realized: 200_00 - 2_00 });
    expect(positions.get(2)).toEqual({ qty: -10, cost: -200_00, realized: 0 });
  });
});

describe("sharpe ratio", () => {
  it("is the annualized mean over the standard deviation of returns", () => {
    // Returns of +1%, -0.5%, +1%: mean 0.5%, sample sd 0.866%, 365 daily periods a year.
    const equity = [100, 101, 100.495, 101.49995];
    const daily = sharpeRatio(equity, 86_400)!;
    expect(daily).toBeCloseTo((0.005 / 0.00866025) * Math.sqrt(365), 2);
  });

  it("needs at least two returns that vary", () => {
    expect(sharpeRatio([100, 101], 60)).toBeNull();
    expect(sharpeRatio([100, 100, 100], 60)).toBeNull();
  });
});

let b: Backend;
beforeAll(async () => {
  b = await startBackend();
});
afterAll(() => b?.stop());

type User = Awaited<ReturnType<typeof signUp>>;
const place = (u: User, payload: object) => b.app.inject({ method: "POST", url: "/v1/orders", headers: auth(u.token), payload });
const get = (u: User, url: string) => b.app.inject({ url, headers: auth(u.token) });
const post = (u: User, url: string, payload: object) => b.app.inject({ method: "POST", url, headers: auth(u.token), payload });

// The live cash and positions of a portfolio must match a replay of its fills.
async function expectRebuildMatches(portfolioId: number) {
  await b.orders.settled();
  const pf = (await b.db.query(
    "SELECT pf.cash, l.starting_cash FROM portfolios pf JOIN leagues l ON l.id = pf.league_id WHERE pf.id = $1",
    [portfolioId],
  )).rows[0];
  const fills = await b.db.query(
    "SELECT symbol_id, side, price, qty, commission FROM fills WHERE portfolio_id = $1 ORDER BY id",
    [portfolioId],
  );
  const replay = rebuild(pf.starting_cash, fills.rows.map((f) => ({ symbolId: f.symbol_id, side: f.side, price: f.price, qty: f.qty, commission: f.commission })));
  expect(pf.cash).toBe(replay.cash);
  const live = await b.db.query("SELECT symbol_id, qty, cost, realized FROM positions WHERE portfolio_id = $1", [portfolioId]);
  expect(live.rows.length).toBe(replay.positions.size);
  for (const r of live.rows) {
    expect({ qty: r.qty, cost: r.cost, realized: r.realized }).toEqual(replay.positions.get(r.symbol_id));
  }
  return fills.rows.length;
}

describe("buying power", () => {
  it("rejects buys the portfolio can't pay for, counting open orders", async () => {
    const u = await signUp(b);
    const tooBig = await place(u, { symbol: "NOVA", side: "buy", price: 140_00, qty: 1000 }); // $140k of $100k
    expect(tooBig.statusCode).toBe(422);
    expect(tooBig.json().error).toBe("insufficient_funds");

    expect((await place(u, { symbol: "NOVA", side: "buy", price: 139_00, qty: 700 })).statusCode).toBe(201); // $97,300 rests
    const second = await place(u, { symbol: "NOVA", side: "buy", price: 139_00, qty: 30 }); // $4,170 more
    expect(second.json().error).toBe("insufficient_funds");
  });

  it("holds margin against shorts", async () => {
    const u = await signUp(b);
    // A $37,500 short needs 50% of it ($18,750) on top of the sale proceeds.
    expect((await place(u, { symbol: "KILN", side: "sell", price: 25_50, qty: 1500 })).statusCode).toBe(201);
    // $255,000 more would need $127,500.
    const big = await place(u, { symbol: "KILN", side: "sell", price: 25_50, qty: 10_000 });
    expect(big.json().error).toBe("insufficient_funds");
  });

  it("lets you sell shares you hold without margin", async () => {
    const [buyer, seller] = [await signUp(b), await signUp(b)];
    await place(seller, { symbol: "QSTR", side: "sell", price: 12_00, qty: 8000 }); // $96k short
    const buy = await place(buyer, { symbol: "QSTR", side: "buy", price: 12_00, qty: 8000 });
    expect(buy.json().status).toBe("filled");
    // Now holding 8000 shares and $4,000 of cash: selling them all back needs nothing.
    const sell = await place(buyer, { symbol: "QSTR", side: "sell", price: 12_50, qty: 8000 });
    expect(sell.statusCode).toBe(201);
    // Anything past those 8000 is a short: 20,000 more would need $125,000 of margin.
    const short = await place(buyer, { symbol: "QSTR", side: "sell", price: 12_50, qty: 20_000 });
    expect(short.json().error).toBe("insufficient_funds");
  });
});

describe("leagues", () => {
  let owner: User;
  let member: User;
  let strict: { id: number; inviteCode: string };

  beforeAll(async () => {
    owner = await signUp(b);
    member = await signUp(b);
  });

  it("creates a league with its own rules and an invite code", async () => {
    const res = await post(owner, "/v1/leagues", {
      name: "No shorts club",
      startingCash: 50_000_00,
      allowShort: false,
      maxPosition: 100,
      allowedTypes: ["limit"],
    });
    expect(res.statusCode).toBe(201);
    strict = res.json();
    expect(strict).toMatchObject({ name: "No shorts club", startingCash: 50_000_00, members: 1, isOwner: true });
    expect(strict.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("joins by invite code, once", async () => {
    const res = await post(member, "/v1/leagues/join", { code: strict.inviteCode.toLowerCase() });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: strict.id, members: 2, isOwner: false });
    expect(res.json().inviteCode).toBeUndefined();
    expect((await post(member, "/v1/leagues/join", { code: strict.inviteCode })).statusCode).toBe(200);
    expect((await post(member, "/v1/leagues/join", { code: "ZZZZZZZZ" })).statusCode).toBe(404);

    const mine = (await get(member, "/v1/leagues")).json();
    expect(mine.map((l: any) => l.name)).toEqual(["Practice", "No shorts club"]);
    const positions = (await get(member, `/v1/positions?league=${strict.id}`)).json();
    expect(positions).toMatchObject({ cash: 50_000_00, equity: 50_000_00, positions: [] });
  });

  it("keeps outsiders out", async () => {
    const outsider = await signUp(b);
    expect((await get(outsider, `/v1/leagues/${strict.id}`)).statusCode).toBe(404);
    expect((await get(outsider, `/v1/leagues/${strict.id}/leaderboard`)).statusCode).toBe(404);
    expect((await get(outsider, `/v1/positions?league=${strict.id}`)).statusCode).toBe(404);
    const order = await place(outsider, { symbol: "MESA", side: "buy", price: 180_00, qty: 1, league: strict.id });
    expect(order.json().error).toBe("not_a_member");
  });

  it("enforces the league's rules", async () => {
    const inLeague = (payload: object) => place(member, { ...payload, league: strict.id });
    expect((await inLeague({ symbol: "MESA", side: "buy", type: "market", qty: 1 })).json().error).toBe("order_type_not_allowed");
    expect((await inLeague({ symbol: "MESA", side: "sell", price: 190_00, qty: 1 })).json().error).toBe("short_not_allowed");
    expect((await inLeague({ symbol: "MESA", side: "buy", price: 180_00, qty: 101 })).json().error).toBe("position_limit");
    expect((await inLeague({ symbol: "MESA", side: "buy", price: 180_00, qty: 60 })).statusCode).toBe(201);
    // 60 resting + 50 more is past the limit too.
    expect((await inLeague({ symbol: "MESA", side: "buy", price: 180_00, qty: 50 })).json().error).toBe("position_limit");
  });

  it("refuses orders before a league starts", async () => {
    const later = (await post(owner, "/v1/leagues", {
      name: "Starts next week",
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    })).json();
    const res = await place(owner, { symbol: "MESA", side: "buy", price: 180_00, qty: 1, league: later.id });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("league_closed");
  });

  it("charges commission on fills and keeps positions per league", async () => {
    const league = (await post(owner, "/v1/leagues", { name: "Fees", commissionCents: 1_00, commissionBps: 10 })).json();
    await post(member, "/v1/leagues/join", { code: league.inviteCode });

    expect((await place(owner, { symbol: "BRKL", side: "sell", price: 74_50, qty: 50, league: league.id })).statusCode).toBe(201);
    const buy = await place(member, { symbol: "BRKL", side: "buy", price: 74_50, qty: 50, league: league.id });
    expect(buy.json()).toMatchObject({ status: "filled", league: league.id });
    await b.orders.settled();

    const fee = 1_00 + Math.round((74_50 * 50 * 10) / 10_000); // $1 + 10 bps of $3,725
    const seller = (await get(owner, `/v1/positions?league=${league.id}`)).json();
    expect(seller.cash).toBe(100_000_00 + 3_725_00 - fee);
    expect(seller.positions).toEqual([
      { symbol: "BRKL", qty: -50, avgPrice: 74_50, mark: 74_50, marketValue: -3_725_00, unrealized: 0, realized: -fee },
    ]);
    const buyer = (await get(member, `/v1/positions?league=${league.id}`)).json();
    expect(buyer.cash).toBe(100_000_00 - 3_725_00 - fee);
    expect(buyer.equity).toBe(100_000_00 - fee);

    // The practice portfolios didn't move.
    expect((await get(member, "/v1/positions")).json().cash).toBe(100_000_00);
    const fills = (await get(member, `/v1/fills?league=${league.id}`)).json();
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ league: league.id, commission: fee });

    const ids = await b.db.query("SELECT id FROM portfolios WHERE league_id = $1", [league.id]);
    for (const r of ids.rows) expect(await expectRebuildMatches(r.id)).toBe(1);
  });
});

describe("self-trade prevention", () => {
  it("stops one person's portfolios in different leagues from trading with each other", async () => {
    const [owner, other] = [await signUp(b), await signUp(b)];
    const league = (await post(owner, "/v1/leagues", { name: "Wash trade check" })).json();

    // Selling cheap from practice and buying in the league would move money between them.
    const practiceSell = await place(owner, { symbol: "BRKL", side: "sell", price: 70_00, qty: 100 });
    expect(practiceSell.json().status).toBe("open");
    const leagueBuy = await place(owner, { symbol: "BRKL", side: "buy", price: 70_00, qty: 100, league: league.id, tif: "ioc" });
    expect(leagueBuy.statusCode).toBe(201);
    expect(leagueBuy.json()).toMatchObject({ status: "cancelled", filledQty: 0, rejectReason: "self_trade" });

    // Someone else can still take the order.
    const fair = await place(other, { symbol: "BRKL", side: "buy", price: 70_00, qty: 100 });
    expect(fair.json().status).toBe("filled");
    await b.orders.settled();
    expect((await get(owner, `/v1/positions?league=${league.id}`)).json()).toMatchObject({ cash: 100_000_00, positions: [] });
  });
});

describe("fill history", () => {
  it("rebuilds every balance from fills after a run of random trades", async () => {
    const traders = [await signUp(b), await signUp(b), await signUp(b), await signUp(b)];
    const books = [{ symbol: "VYNE", ref: 97_00 }, { symbol: "ORBT", ref: 310_00 }, { symbol: "HELX", ref: 58_00 }];
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) % n);

    let trades = 0;
    for (let i = 0; i < 60; i++) {
      const maker = traders[rand(4)]!;
      const taker = traders.filter((t) => t !== maker)[rand(3)]!;
      const book = books[rand(3)]!;
      const side = rand(2) ? "buy" : "sell";
      const price = book.ref + (rand(41) - 20) * 5;
      const qty = 1 + rand(20);
      const rest = await place(maker, { symbol: book.symbol, side, price, qty });
      expect(rest.statusCode).toBe(201);
      const hit = await place(taker, { symbol: book.symbol, side: side === "buy" ? "sell" : "buy", price, qty: 1 + rand(qty), tif: "ioc" });
      expect(hit.statusCode).toBe(201);
      trades += hit.json().filledQty > 0 ? 1 : 0;
      // Pull whatever is left so the book doesn't pile up.
      const left = await get(maker, `/v1/orders/${rest.json().id}`);
      if (["open", "partially_filled"].includes(left.json().status)) {
        await b.app.inject({ method: "DELETE", url: `/v1/orders/${rest.json().id}`, headers: auth(maker.token) });
      }
      await new Promise((r) => setTimeout(r, 50)); // stay under the 20 orders/s limit
    }
    expect(trades).toBeGreaterThan(40);

    let fills = 0;
    for (const t of traders) fills += await expectRebuildMatches(t.portfolio);
    expect(fills).toBeGreaterThan(2 * 40);
  });
});

describe("leaderboard", () => {
  it("ranks by return every refresh and by Sharpe once there's history", async () => {
    const owner = await signUp(b);
    const [bull, bear] = [await signUp(b), await signUp(b)];
    const league = (await post(owner, "/v1/leagues", { name: "Ladder" })).json();
    for (const u of [bull, bear]) await post(u, "/v1/leagues/join", { code: league.inviteCode });
    const trade = async (buyer: User, seller: User, price: number, qty: number) => {
      await place(seller, { symbol: "MESA", side: "sell", price, qty, league: league.id });
      const res = await place(buyer, { symbol: "MESA", side: "buy", price, qty, tif: "ioc", league: league.id });
      expect(res.json().status).toBe("filled");
    };

    await trade(bull, bear, 188_00, 100); // bull long 100, bear short 100
    await trade(owner, bear, 189_00, 1); // the last price moves up a dollar
    await b.orders.settled();
    await b.leaderboard.refresh({ snapshot: true });

    const byReturn = (await get(owner, `/v1/leagues/${league.id}/leaderboard`)).json();
    expect(byReturn.map((s: any) => s.username)).toEqual([bull.name, owner.name, bear.name]);
    expect(byReturn[0]).toMatchObject({ rank: 1, equity: 100_000_00 + 100_00, returnPct: 0.001 });
    expect(byReturn[2].equity).toBe(100_000_00 - 100_00); // short 100 from $188, now $189

    // Two more snapshots at different prices give each portfolio two returns.
    await trade(owner, bear, 190_00, 1);
    await b.orders.settled();
    await b.leaderboard.refresh({ snapshot: true });
    await trade(owner, bear, 192_00, 1);
    await b.orders.settled();
    await b.leaderboard.refresh({ snapshot: true });

    const bySharpe = (await get(owner, `/v1/leagues/${league.id}/leaderboard?by=sharpe`)).json();
    expect(bySharpe[0].username).toBe(bull.name);
    expect(bySharpe[0].sharpe).toBeGreaterThan(0);
    expect(bySharpe.at(-1).username).toBe(bear.name);
    expect(bySharpe.at(-1).sharpe).toBeLessThan(0);
  });
});
