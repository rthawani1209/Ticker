import random

from conftest import ack_all, event

from ticker_sim.bots import MarketMaker, Momentum, NewsTrader, Noise
from ticker_sim.news import NewsItem
from ticker_sim.protocol import EventType, OrdType, Side, TIF

NOVA = 0  # ref price 14,000


def make(cls, ctx, symbols=(NOVA,), **kw):
    return cls(900_001, list(symbols), ctx, random.Random(3), **kw)


def fill(bot, order_id, side, price, qty, leaves=0, symbol=NOVA):
    bot.on_event(event(EventType.FILL, symbol=symbol, side=side, account=bot.account, order_id=order_id,
                       price=price, qty=qty, leaves=leaves))


# ---- market maker ----------------------------------------------------------------


def test_market_maker_quotes_both_sides_around_fair(ctx, engine):
    mm = make(MarketMaker, ctx, levels=3)
    mm.on_tick(1.0, 0.05)
    orders = engine.orders()
    bids = [o["price"] for o in orders if o["side"] == Side.BUY]
    asks = [o["price"] for o in orders if o["side"] == Side.SELL]
    assert len(bids) == 3 and len(asks) == 3
    assert max(bids) < 14_000 < min(asks)
    assert all(o["tif"] == TIF.GTC and o["account"] == 900_001 for o in orders)


def test_market_maker_leans_against_inventory(ctx, engine):
    flat = make(MarketMaker, ctx)
    flat.on_tick(1.0, 0.05)
    flat_bid = max(o["price"] for o in engine.orders() if o["side"] == Side.BUY)

    engine.clear()
    long = make(MarketMaker, ctx)
    long.position[NOVA] = 500
    long.on_tick(1.0, 0.05)
    long_bid = max(o["price"] for o in engine.orders() if o["side"] == Side.BUY)
    assert long_bid < flat_bid  # long inventory: bid lower to buy less, sell more


def test_market_maker_stops_buying_at_max_inventory(ctx, engine):
    mm = make(MarketMaker, ctx, max_inventory=100)
    mm.position[NOVA] = 100
    mm.on_tick(1.0, 0.05)
    assert {o["side"] for o in engine.orders()} == {Side.SELL}


def test_market_maker_keeps_unchanged_quotes(ctx, engine):
    mm = make(MarketMaker, ctx)
    mm.on_tick(1.0, 0.05)
    ack_all(mm, engine)
    engine.clear()
    mm.on_tick(2.0, 0.05)  # nothing moved
    assert engine.cancels() == [] and engine.orders() == []


def test_market_maker_requotes_after_news(ctx, engine):
    mm = make(MarketMaker, ctx, lag_s=0.5)
    mm.on_tick(1.0, 0.05)
    ack_all(mm, engine)
    engine.clear()
    ctx.fair.jump(NOVA, 500)
    mm.on_news(NewsItem(1, 1.5, "upgrade", "x", NOVA, 500))
    for i in range(20):
        mm.on_tick(2.0 + i * 0.1, 0.1)
    assert engine.cancels()
    assert min(o["price"] for o in engine.orders() if o["side"] == Side.BUY) > 14_000


def test_quotes_stay_inside_the_price_band(ctx, engine):
    mm = make(MarketMaker, ctx, lag_s=0.01)
    ctx.fair.jump(NOVA, 3_000)  # true value 30% above the last trade
    mm.on_tick(1.0, 0.05)
    lo, hi = mm.band(NOVA)
    assert all(lo <= o["price"] <= hi for o in engine.orders())
    assert hi < 14_000 * 1.10


# ---- momentum ----------------------------------------------------------------------


def test_momentum_buys_an_uptrend_and_sets_a_stop(ctx, engine):
    bot = make(Momentum, ctx, fast_s=2, slow_s=20, threshold_bps=20, size=50)
    book = ctx.market.books[NOVA]
    t = 0.0
    while t < 40 and not engine.orders():
        t += 0.5
        book.last = int(14_000 * (1 + 0.001 * max(0.0, t - 25)))  # flat, then climbing
        book.asks = {book.last + 5: 100}
        book.bids = {book.last - 5: 100}
        bot.on_tick(t, 0.5)
    (entry,) = engine.orders()
    assert entry["side"] == Side.BUY and entry["tif"] == TIF.IOC
    assert entry["price"] > book.last  # crosses the spread

    (oid,) = ack_all(bot, engine)
    engine.clear()
    fill(bot, oid, Side.BUY, book.last + 5, entry["qty"])
    (stop,) = engine.orders()
    assert stop["ord_type"] == OrdType.STOP and stop["side"] == Side.SELL
    assert stop["stop_price"] < book.last and stop["qty"] == entry["qty"]


def test_momentum_waits_for_warmup(ctx, engine):
    bot = make(Momentum, ctx, slow_s=30)
    ctx.market.books[NOVA].last = 15_000
    bot.on_tick(1.0, 1.0)
    assert engine.orders() == []


# ---- noise ---------------------------------------------------------------------------


def test_noise_trades_at_roughly_its_rate(ctx, engine):
    bot = make(Noise, ctx, symbols=range(8), orders_per_min=60)
    for i in range(1200):  # one simulated minute at 50 ms ticks
        bot.on_tick(i * 0.05, 0.05)
    n = len(engine.orders())
    assert 15 < n < 150
    assert {o["side"] for o in engine.orders()} == {Side.BUY, Side.SELL}


def test_noise_cancels_stale_orders(ctx, engine):
    bot = make(Noise, ctx, orders_per_min=600, aggressive=0.0, order_ttl_s=5)
    for i in range(10):
        bot.on_tick(i * 0.05, 0.05)
    ids = ack_all(bot, engine)
    assert ids
    bot.on_tick(10.0, 0.05)
    assert set(ids) <= set(engine.cancels())


def test_noise_leans_against_a_big_position(ctx, engine):
    bot = make(Noise, ctx, orders_per_min=6000, max_position=100)
    bot.position[NOVA] = 100
    for i in range(400):
        bot.on_tick(i * 0.05, 0.05)
    sides = [o["side"] for o in engine.orders()]
    assert sides.count(Side.SELL) > 3 * sides.count(Side.BUY)


# ---- news trader -----------------------------------------------------------------------


def test_news_trader_reacts_after_a_delay_then_exits(ctx, engine):
    bot = make(NewsTrader, ctx, symbols=range(8), reaction_s=(1.0, 2.0), hold_s=(10.0, 10.0), contrarian=0.0)
    ctx.now = 5.0
    bot.on_news(NewsItem(1, 5.0, "fda_rejection", "x", NOVA, -1500))
    bot.on_tick(5.5, 0.05)
    assert engine.orders() == []  # still "reading"

    bot.on_tick(7.1, 0.05)
    (o,) = engine.orders()
    assert o["side"] == Side.SELL and o["tif"] == TIF.IOC and o["symbol"] == NOVA
    assert o["price"] < 14_000 - 5  # sells through the bid

    (oid,) = ack_all(bot, engine)
    engine.clear()
    ctx.now = 7.2
    fill(bot, oid, Side.SELL, 13_990, o["qty"])
    bot.on_tick(12.0, 0.05)
    assert engine.orders() == []
    bot.on_tick(17.3, 0.05)
    (exit_,) = engine.orders()
    assert exit_["side"] == Side.BUY and exit_["qty"] == o["qty"]


def test_news_trader_ignores_small_news(ctx, engine):
    bot = make(NewsTrader, ctx, symbols=range(8))
    bot.on_news(NewsItem(1, 0.0, "upgrade", "x", NOVA, 20))
    bot.on_tick(10.0, 0.05)
    assert engine.orders() == []


# ---- shared bookkeeping --------------------------------------------------------------------


def test_fills_update_position_cash_and_orders(ctx, engine):
    bot = make(Noise, ctx)
    bot.limit(NOVA, Side.BUY, 13_990, 30)
    (oid,) = ack_all(bot, engine)
    fill(bot, oid, Side.BUY, 13_990, 10, leaves=20)
    assert bot.position[NOVA] == 10 and bot.cash == -139_900
    assert bot.orders[oid].leaves == 20
    fill(bot, oid, Side.BUY, 13_990, 20, leaves=0)
    assert oid not in bot.orders and bot.position[NOVA] == 30


def test_rejects_are_counted_and_cleared(ctx, engine):
    bot = make(Noise, ctx)
    cl = bot.limit(NOVA, Side.BUY, 1, 30)
    bot.on_event(event(EventType.REJECT, account=bot.account, cl_ord_id=cl, reason=5))
    assert bot.rejects["PRICE_BAND"] == 1 and not bot.pending
