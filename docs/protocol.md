# Engine wire protocol

How clients (the Node backend, the bot simulator, the load generator) talk to `ticker-engine` over TCP. The C++ definitions are in [`engine/include/ticker/protocol.hpp`](../engine/include/ticker/protocol.hpp).

## Framing

Every message is a fixed-size, little-endian struct that starts with a 4-byte header:

| Field   | Type | Notes                              |
|---------|------|------------------------------------|
| length  | u16  | whole message, header included     |
| type    | u8   | message type, see below            |
| version | u8   | currently 1                        |

Each type has exactly one valid length. A header with an unknown type, wrong length or wrong version gets an `Error(BadMessage)` and the connection is closed. There is no resync: a client that sends garbage starts over.

## Client to server

| Type | Name      | Size | Fields after the header |
|------|-----------|------|-------------------------|
| 1    | Logon     | 24   | account u32, flags u32, pad u32, token u64 |
| 2    | NewOrder  | 48   | account u32, cl_ord_id u64, symbol u32, side u8, ord_type u8, tif u8, pad u8, price i64, stop_price i64, qty u32, stp_group u32 |
| 3    | Cancel    | 32   | account u32, cl_ord_id u64, order_id u64, symbol u32, pad u32 |
| 4    | Replace   | 40   | account u32, cl_ord_id u64, order_id u64, symbol u32, qty u32, price i64 |
| 5    | Subscribe | 8    | symbol u32 |
| 6    | Halt      | 8    | symbol u32 (admin only) |
| 7    | Resume    | 8    | symbol u32 (admin only) |

Prices are integer ticks (1 tick = 1 cent). `side`: 0 buy, 1 sell. `ord_type`: 0 limit, 1 market, 2 stop, 3 stop-limit. `tif`: 0 GTC, 1 IOC, 2 FOK.

Logon must come first. Flags:

- `1` market data: receive every public trade, book update and status change, plus `Stats`.
- `2` proxy: the `account` field on orders is used as-is. The web backend and the bot simulator log on this way and trade on behalf of many users. A normal session always trades as the account it logged on with.
- `4` admin: may halt and resume symbols.

If the server was started with a token, proxy and admin logons must send it.

`Subscribe` sends a snapshot of one symbol (one `SnapshotLevel` per price level, bids best first then asks best first, then `SnapshotEnd` carrying the reference price) and turns on market data for the session.

## Server to client

| Type | Name     | Size | Fields after the header |
|------|----------|------|-------------------------|
| 64   | LogonAck | 16   | session u32, flags u32, symbols u32 |
| 65   | Event    | 72   | pad u32, then the engine's 64-byte `Event` |
| 66   | Stats    | 48   | shard u32, commands u64, p50 u64, p99 u64, p99.9 u64, max u64 (ns) |
| 67   | Error    | 8    | code u32: 1 bad message, 2 not logged in, 3 already logged in, 4 bad token, 5 not allowed, 6 slow consumer |

Events with `session` 0 are public (trades, book deltas, trading status) and go to every market-data session. Everything else (acks, rejects, fills, cancels) goes only to the session that sent the order, or the session that owns the resting order. If that session has disconnected the message is dropped, but the order stays on the book.

A client that stops reading is disconnected once 64 MB of output is waiting for it.

## Threads and durability

One network thread owns every socket. Symbols are split across matching threads by `symbol % shards`, each with its own books, so matching needs no locks. The two sides talk over single-producer single-consumer rings.

With `--journal-dir`, each matching thread writes every command it accepts to `shard-N.journal` before processing it (in batches, one write per batch), and on startup replays the journal to rebuild its books. `--fsync` also forces each batch to disk. Replaying a journal always produces the same events; `ticker-replay` checks this.
