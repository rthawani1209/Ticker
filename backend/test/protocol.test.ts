import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as p from "../src/engine/protocol.js";
import { PRICE_BAND_BPS } from "../src/ledger.js";

describe("engine protocol", () => {
  it("lays out a new order like the C++ struct", () => {
    const b = p.newOrder({
      account: 42, clOrdId: 7, symbol: 3, side: p.Side.Sell, ordType: p.OrdType.Limit, tif: p.TIF.IOC,
      price: 10_050, stopPrice: 0, qty: 25,
    });
    expect(b.length).toBe(48);
    expect([...b.subarray(0, 4)]).toEqual([48, 0, p.MsgType.NewOrder, p.VERSION]);
    expect(b.readUInt32LE(4)).toBe(42);
    expect(b.readBigUInt64LE(8)).toBe(7n);
    expect(b.readUInt32LE(16)).toBe(3);
    expect(b[20]).toBe(p.Side.Sell);
    expect(b[22]).toBe(p.TIF.IOC);
    expect(b.readBigInt64LE(24)).toBe(10_050n);
    expect(b.readUInt32LE(40)).toBe(25);
  });

  it("sizes every message like the engine", () => {
    expect(p.logon(1, 0).length).toBe(24);
    expect(p.cancel(1, 2, 3, 4).length).toBe(32);
    expect(p.symbolMsg(p.MsgType.Subscribe, 1).length).toBe(8);
  });

  it("decodes events", () => {
    const b = Buffer.alloc(72);
    b.writeUInt16LE(72, 0);
    b[2] = p.MsgType.Event;
    b[3] = p.VERSION;
    b[8] = p.EventType.Fill;
    b[9] = p.Side.Buy;
    b.writeUInt32LE(2, 12);
    b.writeUInt32LE(99, 20);
    b.writeBigUInt64LE((3n << 40n) | 5n, 24);
    b.writeBigUInt64LE(11n, 32);
    b.writeBigInt64LE(9_990n, 40);
    b.writeUInt32LE(10, 48);
    b.writeUInt32LE(4, 52);
    const m = p.decode(b);
    expect(m).toMatchObject({
      kind: "event", type: p.EventType.Fill, side: p.Side.Buy, symbol: 2, account: 99,
      orderId: 3 * 2 ** 40 + 5, clOrdId: 11, price: 9_990, qty: 10, leaves: 4,
    });
  });

  it("splits a stream and keeps the partial tail", () => {
    const a = p.symbolMsg(p.MsgType.Subscribe, 1);
    const b = p.logon(1, 0);
    const [msgs, rest] = p.split(Buffer.concat([a, b.subarray(0, 10)]));
    expect(msgs).toHaveLength(1);
    expect(rest.length).toBe(10);
  });

  it("rejects garbage", () => {
    expect(() => p.split(Buffer.from([0xff, 0xff, 1, 1]))).toThrow(p.ProtocolError);
  });
});

describe("engine config", () => {
  it("uses the same price band as the engine", () => {
    // The ledger reserves market orders at the band edge, so the two must agree.
    const header = readFileSync(new URL("../../engine/include/ticker/config.hpp", import.meta.url), "utf8");
    const m = /band_bps = ([\d']+);/.exec(header);
    expect(m, "band_bps not found in config.hpp").not.toBeNull();
    expect(PRICE_BAND_BPS).toBe(Number(m![1]!.replaceAll("'", "")));
  });
});
