from conftest import event

from ticker_sim.market import Market
from ticker_sim.protocol import EventType, Side


def test_book_follows_deltas_and_trades():
    m = Market()
    m.on_event(event(EventType.BOOK_DELTA, symbol=1, side=Side.BUY, price=5_790, level_qty=30), 0)
    m.on_event(event(EventType.BOOK_DELTA, symbol=1, side=Side.SELL, price=5_810, level_qty=20), 0)
    book = m.books[1]
    assert (book.best_bid(), book.best_ask(), book.mid()) == (5_790, 5_810, 5_800)

    m.on_event(event(EventType.TRADE, symbol=1, price=5_810, qty=20), 1.5)
    m.on_event(event(EventType.BOOK_DELTA, symbol=1, side=Side.SELL, price=5_810, level_qty=0), 1.5)
    assert book.best_ask() is None
    assert book.last == 5_810 and book.volume == 20
    assert book.mid() == 5_810  # one-sided book falls back to the last trade


def test_halt_and_resume():
    m = Market()
    m.on_event(event(EventType.TRADING_STATUS, symbol=2, reason=1), 0)
    assert m.books[2].halted
    m.on_event(event(EventType.TRADING_STATUS, symbol=2, reason=0), 0)
    assert not m.books[2].halted
