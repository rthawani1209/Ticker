"""Binary wire protocol for ticker-engine. Mirrors engine/include/ticker/protocol.hpp.

Every message is a fixed-size little-endian struct with a 4-byte header
(length u16, type u8, version u8). See docs/protocol.md.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum

VERSION = 1


class MsgType(IntEnum):
    LOGON = 1
    NEW_ORDER = 2
    CANCEL = 3
    REPLACE = 4
    SUBSCRIBE = 5
    HALT = 6
    RESUME = 7
    LOGON_ACK = 64
    EVENT = 65
    STATS = 66
    ERROR = 67


# Logon flags
MARKET_DATA = 1
PROXY = 2
ADMIN = 4


class Side(IntEnum):
    BUY = 0
    SELL = 1

    @property
    def sign(self) -> int:
        return 1 if self is Side.BUY else -1


class OrdType(IntEnum):
    LIMIT = 0
    MARKET = 1
    STOP = 2
    STOP_LIMIT = 3


class TIF(IntEnum):
    GTC = 0
    IOC = 1
    FOK = 2


class EventType(IntEnum):
    ACK = 0
    REJECT = 1
    FILL = 2
    CANCELLED = 3
    REPLACED = 4
    TRADE = 5
    BOOK_DELTA = 6
    SNAPSHOT_LEVEL = 7
    SNAPSHOT_END = 8
    TRIGGERED = 9
    TRADING_STATUS = 10


class RejectReason(IntEnum):
    NONE = 0
    UNKNOWN_SYMBOL = 1
    INVALID_QTY = 2
    INVALID_PRICE = 3
    MAX_QTY_EXCEEDED = 4
    PRICE_BAND = 5
    UNKNOWN_ORDER = 6
    NOT_OWNER = 7
    INVALID_FIELD = 8
    HALTED = 9
    STOP_PRICE_CROSSED = 10


class ErrorCode(IntEnum):
    BAD_MESSAGE = 1
    NOT_LOGGED_IN = 2
    ALREADY_LOGGED_IN = 3
    BAD_TOKEN = 4
    NOT_ALLOWED = 5
    SLOW_CONSUMER = 6


HEADER = struct.Struct("<HBB")
LOGON = struct.Struct("<HBBIIIQ")
NEW_ORDER = struct.Struct("<HBBIQIBBBBqqII")
CANCEL = struct.Struct("<HBBIQQII")
REPLACE = struct.Struct("<HBBIQQIIq")
SYMBOL_MSG = struct.Struct("<HBBI")
LOGON_ACK = struct.Struct("<HBBIII")
EVENT = struct.Struct("<HBBI" + "BBBBIIIQQqIIQQ")
STATS = struct.Struct("<HBBIQQQQQ")
ERROR = struct.Struct("<HBBI")

SIZES = {
    MsgType.LOGON: LOGON.size,
    MsgType.NEW_ORDER: NEW_ORDER.size,
    MsgType.CANCEL: CANCEL.size,
    MsgType.REPLACE: REPLACE.size,
    MsgType.SUBSCRIBE: SYMBOL_MSG.size,
    MsgType.HALT: SYMBOL_MSG.size,
    MsgType.RESUME: SYMBOL_MSG.size,
    MsgType.LOGON_ACK: LOGON_ACK.size,
    MsgType.EVENT: EVENT.size,
    MsgType.STATS: STATS.size,
    MsgType.ERROR: ERROR.size,
}


@dataclass(slots=True)
class Event:
    type: EventType
    side: Side
    reason: int
    symbol: int
    session: int
    account: int
    order_id: int
    cl_ord_id: int
    price: int
    qty: int
    leaves: int
    trade_id: int
    level_qty: int


@dataclass(slots=True)
class LogonAck:
    session: int
    flags: int
    symbols: int


@dataclass(slots=True)
class Stats:
    shard: int
    commands: int
    p50_ns: int
    p99_ns: int
    p999_ns: int
    max_ns: int


class ProtocolError(Exception):
    pass


def _hdr(t: MsgType) -> tuple[int, int, int]:
    return SIZES[t], t, VERSION


def logon(account: int, flags: int, token: int = 0) -> bytes:
    return LOGON.pack(*_hdr(MsgType.LOGON), account, flags, 0, token)


def new_order(
    symbol: int,
    side: Side,
    qty: int,
    price: int = 0,
    *,
    cl_ord_id: int = 0,
    account: int = 0,
    ord_type: OrdType = OrdType.LIMIT,
    tif: TIF = TIF.GTC,
    stop_price: int = 0,
) -> bytes:
    return NEW_ORDER.pack(
        *_hdr(MsgType.NEW_ORDER), account, cl_ord_id, symbol, side, ord_type, tif, 0, price, stop_price, qty, 0
    )


def cancel(symbol: int, order_id: int, *, cl_ord_id: int = 0, account: int = 0) -> bytes:
    return CANCEL.pack(*_hdr(MsgType.CANCEL), account, cl_ord_id, order_id, symbol, 0)


def replace(symbol: int, order_id: int, qty: int, price: int, *, cl_ord_id: int = 0, account: int = 0) -> bytes:
    return REPLACE.pack(*_hdr(MsgType.REPLACE), account, cl_ord_id, order_id, symbol, qty, price)


def symbol_msg(t: MsgType, symbol: int) -> bytes:
    return SYMBOL_MSG.pack(*_hdr(t), symbol)


def decode(buf: bytes | memoryview) -> Event | LogonAck | Stats | ErrorCode:
    """Decodes one complete server-to-client message."""
    length, t, version = HEADER.unpack_from(buf)
    if version != VERSION or SIZES.get(t) != length:
        raise ProtocolError(f"bad header: type={t} length={length} version={version}")
    if t == MsgType.EVENT:
        f = EVENT.unpack_from(buf)
        # f[0:4] is the header and padding; f[7] is the event's own padding byte.
        return Event(EventType(f[4]), Side(f[5]), f[6], *f[8:])
    if t == MsgType.LOGON_ACK:
        return LogonAck(*LOGON_ACK.unpack_from(buf)[3:])
    if t == MsgType.STATS:
        return Stats(*STATS.unpack_from(buf)[3:])
    if t == MsgType.ERROR:
        return ErrorCode(ERROR.unpack_from(buf)[3])
    raise ProtocolError(f"unexpected message type {t}")


def split(buf: bytearray) -> list[bytes]:
    """Removes every complete message from the front of buf and returns them."""
    out = []
    pos = 0
    while len(buf) - pos >= HEADER.size:
        length, t, version = HEADER.unpack_from(buf, pos)
        if version != VERSION or SIZES.get(t) != length:
            raise ProtocolError(f"bad header: type={t} length={length} version={version}")
        if len(buf) - pos < length:
            break
        out.append(bytes(buf[pos : pos + length]))
        pos += length
    del buf[:pos]
    return out
