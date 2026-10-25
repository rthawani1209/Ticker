import pytest

from ticker_sim import protocol as p


def test_sizes_match_the_cpp_structs():
    # static_asserts in engine/include/ticker/protocol.hpp
    assert p.LOGON.size == 24
    assert p.NEW_ORDER.size == 48
    assert p.CANCEL.size == 32
    assert p.REPLACE.size == 40
    assert p.SYMBOL_MSG.size == 8
    assert p.LOGON_ACK.size == 16
    assert p.EVENT.size == 72
    assert p.STATS.size == 48
    assert p.ERROR.size == 8


def test_new_order_layout():
    m = p.new_order(3, p.Side.SELL, 25, 10_050, cl_ord_id=7, account=42, tif=p.TIF.IOC)
    assert len(m) == 48
    assert m[:4] == bytes([48, 0, p.MsgType.NEW_ORDER, p.VERSION])
    assert int.from_bytes(m[4:8], "little") == 42  # account
    assert int.from_bytes(m[8:16], "little") == 7  # cl_ord_id
    assert int.from_bytes(m[16:20], "little") == 3  # symbol
    assert m[20] == p.Side.SELL and m[22] == p.TIF.IOC
    assert int.from_bytes(m[24:32], "little", signed=True) == 10_050
    assert int.from_bytes(m[40:44], "little") == 25


def test_decode_event():
    raw = p.EVENT.pack(72, p.MsgType.EVENT, p.VERSION, 0,
                       p.EventType.FILL, p.Side.SELL, 0, 0, 2, 5, 900_001, 1 << 40 | 9, 77, 9_990, 10, 5, 3, 0)
    e = p.decode(raw)
    assert e.type == p.EventType.FILL and e.side == p.Side.SELL
    assert (e.symbol, e.session, e.account) == (2, 5, 900_001)
    assert (e.order_id, e.cl_ord_id, e.price, e.qty, e.leaves, e.trade_id) == (1 << 40 | 9, 77, 9_990, 10, 5, 3)


def test_decode_error_and_ack():
    assert p.decode(p.ERROR.pack(8, p.MsgType.ERROR, p.VERSION, 4)) == p.ErrorCode.BAD_TOKEN
    ack = p.decode(p.LOGON_ACK.pack(16, p.MsgType.LOGON_ACK, p.VERSION, 12, 3, 8))
    assert (ack.session, ack.flags, ack.symbols) == (12, 3, 8)


def test_split_keeps_partial_messages():
    a = p.ERROR.pack(8, p.MsgType.ERROR, p.VERSION, 1)
    b = p.LOGON_ACK.pack(16, p.MsgType.LOGON_ACK, p.VERSION, 1, 0, 8)
    buf = bytearray(a + b[:5])
    assert p.split(buf) == [a]
    assert len(buf) == 5
    buf += b[5:]
    assert p.split(buf) == [b]
    assert buf == bytearray()


def test_split_rejects_garbage():
    with pytest.raises(p.ProtocolError):
        p.split(bytearray(b"\xff\xff\x01\x01"))
