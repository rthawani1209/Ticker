import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { csvCell, toCsv } from "../src/csv.js";
import { grade } from "../src/grading.js";
import { auth, signUp, startBackend, type Backend } from "./harness.js";

let b: Backend;
beforeAll(async () => {
  b = await startBackend();
});
afterAll(() => b?.stop());

type User = Awaited<ReturnType<typeof signUp>>;
const setRole = (u: User, role: string) =>
  b.db.query("UPDATE users SET role = $2 WHERE id = $1", [u.id, role]);
const req = (u: User | null, method: string, url: string, payload?: object) =>
  b.app.inject({
    method: method as "GET",
    url,
    headers: u ? auth(u.token) : {},
    ...(payload ? { payload } : {}),
  });
const place = (u: User, payload: object) => req(u, "POST", "/v1/orders", payload);

async function guest() {
  const res = await b.app.inject({
    method: "POST",
    url: "/v1/auth/guest",
    remoteAddress: "10.3.3.3",
  });
  return { id: res.json().user.id, token: res.json().accessToken } as User;
}

describe("roles", () => {
  // Who may call each route. Every registered route must be listed here, so a new
  // route can't ship without someone deciding who's allowed to call it.
  //   public: anyone; user: any signed-in user, guests too; account: not a guest;
  //   professor: professors and admins; admin: admins only.
  const ACCESS: Record<string, "public" | "user" | "account" | "professor" | "admin" | "skip"> = {
    "OPTIONS *": "skip", // CORS preflight
    "GET /ws": "skip", // WebSocket upgrade; auth is covered in ws.test.ts
    "GET /health": "public",
    "POST /v1/auth/register": "public",
    "POST /v1/auth/guest": "public",
    "POST /v1/auth/login": "public",
    "POST /v1/auth/refresh": "public",
    "POST /v1/auth/logout": "public",
    "GET /v1/symbols": "public",
    "GET /v1/market/:ticker": "public",
    "GET /v1/market/:ticker/trades": "public",
    "GET /v1/market/:ticker/candles": "public",
    "GET /v1/engine/stats": "public",
    "POST /v1/orders": "user",
    "GET /v1/orders": "user",
    "GET /v1/orders/:id": "user",
    "DELETE /v1/orders/:id": "user",
    "PATCH /v1/orders/:id": "user",
    "GET /v1/fills": "user",
    "GET /v1/leagues": "user",
    "GET /v1/leagues/:id": "user",
    "GET /v1/leagues/:id/leaderboard": "user",
    "GET /v1/leagues/:id/assignments": "user",
    "GET /v1/positions": "user",
    "GET /v1/positions/analytics": "user",
    "GET /v1/me": "user",
    "POST /v1/leagues": "account",
    "POST /v1/leagues/join": "account",
    "GET /v1/classes/:id/roster": "professor",
    "GET /v1/classes/:id/fairplay": "professor",
    "GET /v1/classes/:id/trades": "professor",
    "GET /v1/classes/:id/trades.csv": "professor",
    "GET /v1/classes/:id/assignments": "professor",
    "POST /v1/classes/:id/assignments": "professor",
    "DELETE /v1/classes/:id/assignments/:aid": "professor",
    "GET /v1/classes/:id/grades.csv": "professor",
    "GET /v1/admin/users": "admin",
    "PATCH /v1/admin/users/:id": "admin",
    "PUT /v1/admin/bots": "admin",
    "GET /v1/keys": "account",
    "POST /v1/keys": "account",
    "DELETE /v1/keys/:id": "account",
  };

  it("lists every route", () => {
    const registered = b.app.routeList.map((r) => `${r.method} ${r.url}`).sort();
    expect(registered).toEqual(Object.keys(ACCESS).sort());
  });

  it("lets each role call exactly the routes it should", async () => {
    const student = await signUp(b);
    const professor = await signUp(b);
    const admin = await signUp(b);
    await setRole(professor, "professor");
    await setRole(admin, "admin");
    const g = await guest();
    const league = (await req(professor, "POST", "/v1/leagues", { name: "Roles 101" })).json();

    const callers = { anonymous: null, guest: g, student, professor, admin } as const;
    const allowed: Record<string, (keyof typeof callers)[]> = {
      public: ["anonymous", "guest", "student", "professor", "admin"],
      user: ["guest", "student", "professor", "admin"],
      account: ["student", "professor", "admin"],
      professor: ["professor", "admin"],
      admin: ["admin"],
    };
    const bodies: Record<string, object> = {
      "POST /v1/classes/:id/assignments": {
        title: "Make five trades",
        kind: "trades_at_least",
        target: 5,
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      "PATCH /v1/admin/users/:id": { role: "student" },
      "PUT /v1/admin/bots": { enabled: true },
      "PATCH /v1/orders/:id": { qty: 1 },
      "POST /v1/keys": { name: "rbac bot" },
      "POST /v1/leagues": { name: "Another league" },
      "POST /v1/leagues/join": { code: league.inviteCode },
    };
    const path = (url: string) =>
      url
        .replace(":ticker", "NOVA")
        .replace(":aid", "999999")
        .replace("/admin/users/:id", `/admin/users/${student.id}`)
        .replace(":id", String(league.id));

    for (const [route, level] of Object.entries(ACCESS)) {
      if (level === "skip") continue;
      const [method, url] = route.split(" ") as [string, string];
      for (const [who, user] of Object.entries(callers)) {
        if (method === "POST" && url.startsWith("/v1/auth")) continue; // covered in auth.test.ts
        const res = await req(user, method, path(url), bodies[route]);
        const ok = allowed[level]!.includes(who as keyof typeof callers);
        const denied = [401, 403].includes(res.statusCode);
        expect({ route, who, denied }, res.body).toEqual({ route, who, denied: !ok });
      }
    }
  });
});

describe("classroom", () => {
  it("shows a professor their class, grades assignments and exports CSV", async () => {
    const prof = await signUp(b);
    await setRole(prof, "professor");
    const [ana, ben] = [await signUp(b), await signUp(b)];
    const league = (await req(prof, "POST", "/v1/leagues", { name: "Econ =101" })).json();
    for (const s of [ana, ben])
      await req(s, "POST", "/v1/leagues/join", { code: league.inviteCode });

    const due = new Date(Date.now() + 3_600_000).toISOString();
    const make = async (body: object) =>
      (
        await req(prof, "POST", `/v1/classes/${league.id}/assignments`, { dueAt: due, ...body })
      ).json();
    const trades2 = await make({ title: "Make two trades", kind: "trades_at_least", target: 2 });
    const useStop = await make({ title: "Use a stop", kind: "use_order_type", orderType: "stop" });
    const earn = await make({ title: "Earn 1%", kind: "return_at_least", target: 100 });
    expect(trades2.id).toBeGreaterThan(0);

    // ana buys 10 from ben at $140 and sells 10 back at $141; ben does nothing else.
    const cross = async (buyer: User, seller: User, price: number, qty: number) => {
      await place(seller, { symbol: "NOVA", side: "sell", price, qty, league: league.id });
      const r = await place(buyer, {
        symbol: "NOVA",
        side: "buy",
        price,
        qty,
        tif: "ioc",
        league: league.id,
      });
      expect(r.json().status).toBe("filled");
    };
    await cross(ana, ben, 140_00, 10);
    await cross(ben, ana, 141_00, 10);
    await b.orders.settled();

    const graded = (await req(prof, "GET", `/v1/classes/${league.id}/assignments`)).json();
    const byTitle = Object.fromEntries(graded.map((a: any) => [a.title, a.grades]));
    const of = (title: string, u: User) => byTitle[title].find((g: any) => g.userId === u.id);
    expect(of("Make two trades", ana)).toMatchObject({ value: 2, passed: true });
    expect(of("Make two trades", ben)).toMatchObject({ value: 2, passed: true });
    expect(of("Use a stop", ana)).toMatchObject({ value: 0, passed: false });
    expect(of("Earn 1%", ana)).toMatchObject({ passed: false }); // +$10 on $100k is 1 bp
    expect(of("Earn 1%", ana).value).toBe(1);
    expect(byTitle["Make two trades"]).toHaveLength(2); // the professor isn't graded

    // A student only sees their own grade.
    const mine = (await req(ana, "GET", `/v1/leagues/${league.id}/assignments`)).json();
    expect(mine.map((a: any) => a.id)).toEqual([trades2.id, useStop.id, earn.id]);
    expect(mine[0]).toMatchObject({ value: 2, passed: true });
    expect(mine[0].grades).toBeUndefined();

    const roster = (await req(prof, "GET", `/v1/classes/${league.id}/roster`)).json();
    expect(roster.map((r: any) => r.userId).sort()).toEqual([ana.id, ben.id].sort());
    expect(roster.find((r: any) => r.userId === ana.id)).toMatchObject({ trades: 2 });

    const tradeList = (await req(prof, "GET", `/v1/classes/${league.id}/trades?limit=3`)).json();
    expect(tradeList).toHaveLength(3);
    const older = (
      await req(prof, "GET", `/v1/classes/${league.id}/trades?before=${tradeList.at(-1).id}`)
    ).json();
    expect(older).toHaveLength(1); // 4 fills in all, paged 3 + 1

    const csv = await req(prof, "GET", `/v1/classes/${league.id}/trades.csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="Econ-101-trades.csv"');
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toBe("time,student,symbol,side,qty,price,commission,order_id");
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain(",NOVA,");

    const grades = (await req(prof, "GET", `/v1/classes/${league.id}/grades.csv`)).body;
    expect(grades.split("\r\n")[0]).toBe(
      "student,email,equity,return_pct,trades,Make two trades,Use a stop,Earn 1%",
    );
    expect(grades).toContain(
      `${ana.name},${ana.name}@example.com,100010.00,0.01,2,pass,pending,pending`,
    );

    // Deleting an assignment removes it for students too.
    expect(
      (await req(prof, "DELETE", `/v1/classes/${league.id}/assignments/${earn.id}`)).statusCode,
    ).toBe(204);
    expect((await req(ana, "GET", `/v1/leagues/${league.id}/assignments`)).json()).toHaveLength(2);
  });

  it("keeps professors to their own leagues and checks assignment input", async () => {
    const [owner, other] = [await signUp(b), await signUp(b)];
    await setRole(owner, "professor");
    await setRole(other, "professor");
    const league = (await req(owner, "POST", "/v1/leagues", { name: "Mine only" })).json();
    expect((await req(other, "GET", `/v1/classes/${league.id}/roster`)).statusCode).toBe(404);

    const bad = async (body: object) =>
      (await req(owner, "POST", `/v1/classes/${league.id}/assignments`, body)).statusCode;
    const due = new Date(Date.now() + 60_000).toISOString();
    expect(await bad({ title: "x", kind: "trades_at_least", target: 1, dueAt: due })).toBe(400);
    expect(await bad({ title: "Use stops", kind: "use_order_type", dueAt: due })).toBe(400);
    expect(
      await bad({
        title: "Trade",
        kind: "trades_at_least",
        target: 1,
        orderType: "stop",
        dueAt: due,
      }),
    ).toBe(400);
    expect(
      await bad({
        title: "Late",
        kind: "trades_at_least",
        target: 1,
        dueAt: "2020-01-01T00:00:00Z",
      }),
    ).toBe(400);
  });

  it("takes a role away on the very next request", async () => {
    const [admin, prof] = [await signUp(b), await signUp(b)];
    await setRole(admin, "admin");
    await setRole(prof, "professor");
    const league = (await req(prof, "POST", "/v1/leagues", { name: "Short lived" })).json();
    expect((await req(prof, "GET", `/v1/classes/${league.id}/roster`)).statusCode).toBe(200);

    const res = await req(admin, "PATCH", `/v1/admin/users/${prof.id}`, { role: "student" });
    expect(res.json()).toMatchObject({ id: prof.id, role: "student" });
    // Same access token, which still says "professor": refused anyway.
    expect((await req(prof, "GET", `/v1/classes/${league.id}/roster`)).statusCode).toBe(403);

    expect(
      (await req(admin, "PATCH", `/v1/admin/users/${admin.id}`, { role: "student" })).statusCode,
    ).toBe(409);
    const g = await guest();
    expect(
      (await req(admin, "PATCH", `/v1/admin/users/${g.id}`, { role: "professor" })).statusCode,
    ).toBe(404);
    const found = (await req(admin, "GET", `/v1/admin/users?q=${prof.name}`)).json();
    expect(found.map((u: any) => u.id)).toEqual([prof.id]);
  });
});

describe("grading and CSV helpers", () => {
  const stats = {
    returnBps: 250,
    trades: 3,
    drawdownBps: 400,
    typesUsed: new Set(["limit", "bracket"]),
  };
  it("grades each kind", () => {
    expect(grade({ kind: "return_at_least", target: 250, orderType: null }, stats).passed).toBe(
      true,
    );
    expect(grade({ kind: "trades_at_least", target: 4, orderType: null }, stats).passed).toBe(
      false,
    );
    expect(grade({ kind: "drawdown_at_most", target: 300, orderType: null }, stats).passed).toBe(
      false,
    );
    // Never trading isn't a low drawdown.
    const idle = { ...stats, trades: 0, drawdownBps: 0 };
    expect(grade({ kind: "drawdown_at_most", target: 300, orderType: null }, idle).passed).toBe(
      false,
    );
    expect(grade({ kind: "use_order_type", target: 0, orderType: "bracket" }, stats)).toEqual({
      value: 1,
      passed: true,
    });
  });

  it("quotes and defuses spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell(-12.5)).toBe("-12.5"); // real numbers stay numbers
    expect(csvCell("-0.23")).toBe("-0.23"); // so do numbers formatted as text
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(toCsv(["a", "b"], [[1, null]])).toBe("a,b\r\n1,\r\n");
  });
});
