// Binary wire protocol for ticker-engine. Mirrors engine/include/ticker/protocol.hpp;
// docs/protocol.md has the full table. All fields little-endian.

export const VERSION = 1;

export const MsgType = {
  Logon: 1,
  NewOrder: 2,
  Cancel: 3,
  Replace: 4,
  Subscribe: 5,
  Halt: 6,
  Resume: 7,
  LogonAck: 64,
  Event: 65,
  Stats: 66,
  Error: 67,
} as const;

export const Flags = { MarketData: 1, Proxy: 2, Admin: 4 } as const;

export const SIZES: Record<number, number> = {
  [MsgType.Logon]: 24,
  [MsgType.NewOrder]: 48,
  [MsgType.Cancel]: 32,
  [MsgType.Replace]: 40,
  [MsgType.Subscribe]: 8,
  [MsgType.Halt]: 8,
  [MsgType.Resume]: 8,
  [MsgType.LogonAck]: 16,
  [MsgType.Event]: 72,
  [MsgType.Stats]: 48,
  [MsgType.Error]: 8,
};

export enum Side { Buy = 0, Sell = 1 }
export enum OrdType { Limit = 0, Market = 1, Stop = 2, StopLimit = 3 }
export enum TIF { GTC = 0, IOC = 1, FOK = 2 }

export enum EventType {
  Ack = 0,
  Reject,
  Fill,
  Cancelled,
  Replaced,
  Trade,
  BookDelta,
  SnapshotLevel,
  SnapshotEnd,
  Triggered,
  TradingStatus,
}

export const REJECT_REASONS = [
  "none", "unknown_symbol", "invalid_qty", "invalid_price", "max_qty_exceeded", "price_band",
  "unknown_order", "not_owner", "invalid_field", "halted", "stop_price_crossed",
] as const;

export const CANCEL_REASONS = ["user", "unfilled", "fok_unfillable", "self_trade", "book_full", "halted"] as const;

export const ERROR_CODES = [
  "", "bad_message", "not_logged_in", "already_logged_in", "bad_token", "not_allowed", "slow_consumer",
] as const;

export interface EngineEvent {
  type: EventType;
  side: Side;
  reason: number;
  symbol: number;
  session: number;
  account: number;
  orderId: number;
  clOrdId: number;
  price: number;
  qty: number;
  leaves: number;
  tradeId: number;
  levelQty: number;
}

export interface LogonAck { kind: "logon_ack"; session: number; flags: number; symbols: number }
export interface Stats { kind: "stats"; shard: number; commands: number; p50: number; p99: number; p999: number; max: number }
export interface EngineError { kind: "error"; code: string }
export type Message = ({ kind: "event" } & EngineEvent) | LogonAck | Stats | EngineError;

export class ProtocolError extends Error {}

function header(type: number): Buffer {
  const size = SIZES[type]!;
  const b = Buffer.alloc(size);
  b.writeUInt16LE(size, 0);
  b.writeUInt8(type, 2);
  b.writeUInt8(VERSION, 3);
  return b;
}

export function logon(account: number, flags: number, token: bigint = 0n): Buffer {
  const b = header(MsgType.Logon);
  b.writeUInt32LE(account, 4);
  b.writeUInt32LE(flags, 8);
  b.writeBigUInt64LE(token, 16);
  return b;
}

export interface NewOrderFields {
  account: number;
  clOrdId: number;
  symbol: number;
  side: Side;
  ordType: OrdType;
  tif: TIF;
  price: number;
  stopPrice: number;
  qty: number;
  // Orders in the same nonzero group never trade with each other; 0 means just this account.
  stpGroup?: number;
}

export function newOrder(o: NewOrderFields): Buffer {
  const b = header(MsgType.NewOrder);
  b.writeUInt32LE(o.account, 4);
  b.writeBigUInt64LE(BigInt(o.clOrdId), 8);
  b.writeUInt32LE(o.symbol, 16);
  b.writeUInt8(o.side, 20);
  b.writeUInt8(o.ordType, 21);
  b.writeUInt8(o.tif, 22);
  b.writeBigInt64LE(BigInt(o.price), 24);
  b.writeBigInt64LE(BigInt(o.stopPrice), 32);
  b.writeUInt32LE(o.qty, 40);
  b.writeUInt32LE(o.stpGroup ?? 0, 44);
  return b;
}

export function cancel(account: number, clOrdId: number, orderId: number, symbol: number): Buffer {
  const b = header(MsgType.Cancel);
  b.writeUInt32LE(account, 4);
  b.writeBigUInt64LE(BigInt(clOrdId), 8);
  b.writeBigUInt64LE(BigInt(orderId), 16);
  b.writeUInt32LE(symbol, 24);
  return b;
}

export function symbolMsg(type: number, symbol: number): Buffer {
  const b = header(type);
  b.writeUInt32LE(symbol, 4);
  return b;
}

// u64 fields we use (order ids, trade ids, counters) all stay below 2^53.
const u64 = (b: Buffer, off: number) => Number(b.readBigUInt64LE(off));

export function decode(b: Buffer): Message {
  const len = b.readUInt16LE(0);
  const type = b.readUInt8(2);
  if (b.readUInt8(3) !== VERSION || SIZES[type] !== len) throw new ProtocolError(`bad header type=${type} len=${len}`);
  switch (type) {
    case MsgType.Event: {
      const e = 8; // the Event struct starts after the header and 4 bytes of padding
      return {
        kind: "event",
        type: b.readUInt8(e),
        side: b.readUInt8(e + 1),
        reason: b.readUInt8(e + 2),
        symbol: b.readUInt32LE(e + 4),
        session: b.readUInt32LE(e + 8),
        account: b.readUInt32LE(e + 12),
        orderId: u64(b, e + 16),
        clOrdId: u64(b, e + 24),
        price: Number(b.readBigInt64LE(e + 32)),
        qty: b.readUInt32LE(e + 40),
        leaves: b.readUInt32LE(e + 44),
        tradeId: u64(b, e + 48),
        levelQty: u64(b, e + 56),
      };
    }
    case MsgType.LogonAck:
      return { kind: "logon_ack", session: b.readUInt32LE(4), flags: b.readUInt32LE(8), symbols: b.readUInt32LE(12) };
    case MsgType.Stats:
      return {
        kind: "stats", shard: b.readUInt32LE(4), commands: u64(b, 8),
        p50: u64(b, 16), p99: u64(b, 24), p999: u64(b, 32), max: u64(b, 40),
      };
    case MsgType.Error:
      return { kind: "error", code: ERROR_CODES[b.readUInt32LE(4)] ?? "unknown" };
    default:
      throw new ProtocolError(`unexpected message type ${type}`);
  }
}

// Splits a stream buffer into whole messages; returns them and whatever is left over.
export function split(buf: Buffer): [Buffer[], Buffer] {
  const out: Buffer[] = [];
  let pos = 0;
  while (buf.length - pos >= 4) {
    const len = buf.readUInt16LE(pos);
    const type = buf.readUInt8(pos + 2);
    if (buf.readUInt8(pos + 3) !== VERSION || SIZES[type] !== len) throw new ProtocolError(`bad header type=${type}`);
    if (buf.length - pos < len) break;
    out.push(buf.subarray(pos, pos + len));
    pos += len;
  }
  return [out, buf.subarray(pos)];
}
