import random
import struct

import pytest

from ticker_sim import protocol as p
from ticker_sim.bots import Context
from ticker_sim.fair_value import FairValue
from ticker_sim.market import Market


class FakeEngine:
    """Collects what bots send and lets tests reply with engine events."""

    def __init__(self) -> None:
        self.sent: list[bytes] = []

    def __call__(self, msg: bytes) -> None:
        self.sent.append(msg)

    def orders(self) -> list[dict]:
        out = []
        for m in self.sent:
            _, t, _ = p.HEADER.unpack_from(m)
            if t == p.MsgType.NEW_ORDER:
                f = p.NEW_ORDER.unpack(m)
                out.append(dict(account=f[3], cl=f[4], symbol=f[5], side=p.Side(f[6]), ord_type=p.OrdType(f[7]),
                                tif=p.TIF(f[8]), price=f[10], stop_price=f[11], qty=f[12]))
        return out

    def cancels(self) -> list[int]:
        return [p.CANCEL.unpack(m)[5] for m in self.sent if p.HEADER.unpack_from(m)[1] == p.MsgType.CANCEL]

    def clear(self) -> None:
        self.sent.clear()


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def ctx(engine) -> Context:
    market = Market()
    # A simple two-sided book on every symbol: one tick either side of the reference price.
    for book in market.books.values():
        book.bids[book.last - 5] = 100
        book.asks[book.last + 5] = 100
    return Context(market, FairValue(random.Random(1)), engine)


def event(type_, **kw) -> p.Event:
    base = dict(side=p.Side.BUY, reason=0, symbol=0, session=1, account=0, order_id=0, cl_ord_id=0,
                price=0, qty=0, leaves=0, trade_id=0, level_qty=0)
    base.update(kw)
    return p.Event(type_, **base)


def ack_all(bot, engine: FakeEngine, start_id: int = 1000) -> list[int]:
    """Acks every order the bot has sent so far, like the engine would."""
    ids = []
    for i, o in enumerate(engine.orders()):
        if o["cl"] in bot.pending:
            oid = start_id + i
            bot.on_event(event(p.EventType.ACK, symbol=o["symbol"], side=o["side"], account=bot.account,
                               order_id=oid, cl_ord_id=o["cl"], price=o["price"], qty=o["qty"], leaves=o["qty"]))
            ids.append(oid)
    return ids
