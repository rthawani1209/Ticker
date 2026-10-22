#include "ticker/order_book.hpp"

#include <gtest/gtest.h>

#include "test_util.hpp"

using namespace ticker;
using namespace ticker::testing;

namespace {

SymbolConfig cfg() {
    SymbolConfig c;
    c.name = "TEST";
    c.max_price = 4096;
    c.ref_price = 1000;
    c.band_bps = 2000;  // +-20%
    c.max_order_qty = 10'000;
    c.max_orders = 64;
    return c;
}

class BookTest : public ::testing::Test {
protected:
    OrderBook book{0, cfg()};
    std::vector<Event> out;

    std::vector<Event> send(const Command& c) {
        out.clear();
        book.process(c, out);
        return out;
    }

    OrderId place(Side s, Price p, Qty q, AccountId a = 1) {
        auto evs = send(limit(s, p, q, a));
        EXPECT_EQ(evs.front().type, EventType::Ack);
        return evs.front().order_id;
    }
};

}  // namespace

TEST_F(BookTest, RestingOrderSetsBestPrices) {
    place(Side::Buy, 990, 10);
    place(Side::Buy, 995, 10);
    place(Side::Sell, 1005, 10);
    place(Side::Sell, 1010, 10);
    EXPECT_EQ(book.best_bid(), 995);
    EXPECT_EQ(book.best_ask(), 1005);
    EXPECT_EQ(book.depth_at(Side::Buy, 990), 10u);
    EXPECT_EQ(book.order_count(), 4u);
}

TEST_F(BookTest, AckThenDeltaForRestingOrder) {
    auto evs = send(limit(Side::Buy, 1000, 7, 1, TIF::GTC, 42));
    ASSERT_EQ(evs.size(), 2u);
    EXPECT_EQ(evs[0].type, EventType::Ack);
    EXPECT_EQ(evs[0].cl_ord_id, 42u);
    EXPECT_EQ(evs[1].type, EventType::BookDelta);
    EXPECT_EQ(evs[1].level_qty, 7u);
}

TEST_F(BookTest, FullFillAtRestingPrice) {
    place(Side::Sell, 1000, 10, 1);
    auto evs = send(limit(Side::Buy, 1010, 10, 2));
    auto fills = of_type(evs, EventType::Fill);
    ASSERT_EQ(fills.size(), 2u);
    // Trades happen at the resting order's price, not the aggressor's.
    EXPECT_EQ(fills[0].price, 1000);
    EXPECT_EQ(fills[0].account, 2u);
    EXPECT_EQ(fills[0].leaves, 0u);
    EXPECT_EQ(fills[1].account, 1u);
    EXPECT_EQ(fills[1].leaves, 0u);
    EXPECT_EQ(book.best_ask(), 0);
    EXPECT_EQ(book.best_bid(), 0);
    EXPECT_EQ(book.order_count(), 0u);
}

TEST_F(BookTest, PriceThenTimePriority) {
    OrderId a = place(Side::Sell, 1001, 5, 1);
    OrderId b = place(Side::Sell, 1000, 5, 2);
    OrderId c = place(Side::Sell, 1000, 5, 3);
    auto fills = of_type(send(limit(Side::Buy, 1001, 12, 9)), EventType::Fill);
    ASSERT_EQ(fills.size(), 6u);
    EXPECT_EQ(fills[1].order_id, b);  // best price, first in
    EXPECT_EQ(fills[3].order_id, c);  // best price, second in
    EXPECT_EQ(fills[5].order_id, a);  // worse price last
    EXPECT_EQ(fills[5].qty, 2u);
    EXPECT_EQ(fills[5].leaves, 3u);
    EXPECT_EQ(book.depth_at(Side::Sell, 1001), 3u);
}

TEST_F(BookTest, PartialFillRestsRemainder) {
    place(Side::Sell, 1000, 4, 1);
    auto evs = send(limit(Side::Buy, 1000, 10, 2));
    EXPECT_EQ(book.best_bid(), 1000);
    EXPECT_EQ(book.depth_at(Side::Buy, 1000), 6u);
    EXPECT_EQ(evs.back().type, EventType::BookDelta);
    EXPECT_EQ(evs.back().level_qty, 6u);
}

TEST_F(BookTest, SweepsSeveralLevels) {
    place(Side::Sell, 1000, 3, 1);
    place(Side::Sell, 1002, 3, 1);
    place(Side::Sell, 1004, 3, 1);
    auto trades = of_type(send(limit(Side::Buy, 1003, 9, 2)), EventType::Trade);
    ASSERT_EQ(trades.size(), 2u);
    EXPECT_EQ(trades[0].price, 1000);
    EXPECT_EQ(trades[1].price, 1002);
    EXPECT_EQ(book.best_bid(), 1003);
    EXPECT_EQ(book.best_ask(), 1004);
}

TEST_F(BookTest, IocNeverRests) {
    place(Side::Sell, 1000, 3, 1);
    auto evs = send(limit(Side::Buy, 1000, 5, 2, TIF::IOC));
    auto c = of_type(evs, EventType::Cancelled);
    ASSERT_EQ(c.size(), 1u);
    EXPECT_EQ(c[0].qty, 2u);
    EXPECT_EQ(c[0].reason, std::uint8_t(CancelReason::Unfilled));
    EXPECT_EQ(book.order_count(), 0u);
}

TEST_F(BookTest, FokKillsWhenNotFullyFillable) {
    place(Side::Sell, 1000, 3, 1);
    place(Side::Sell, 1001, 3, 1);
    auto evs = send(limit(Side::Buy, 1001, 7, 2, TIF::FOK));
    EXPECT_TRUE(of_type(evs, EventType::Fill).empty());
    auto c = of_type(evs, EventType::Cancelled);
    ASSERT_EQ(c.size(), 1u);
    EXPECT_EQ(c[0].reason, std::uint8_t(CancelReason::FokUnfillable));
    EXPECT_EQ(book.depth_at(Side::Sell, 1000), 3u);
}

TEST_F(BookTest, FokFillsAcrossLevels) {
    place(Side::Sell, 1000, 3, 1);
    place(Side::Sell, 1001, 3, 1);
    auto evs = send(limit(Side::Buy, 1001, 6, 2, TIF::FOK));
    EXPECT_EQ(of_type(evs, EventType::Trade).size(), 2u);
    EXPECT_TRUE(of_type(evs, EventType::Cancelled).empty());
}

TEST_F(BookTest, FokIgnoresLiquidityBehindOwnOrder) {
    place(Side::Sell, 1000, 3, 1);
    place(Side::Sell, 1000, 3, 2);  // our own order
    place(Side::Sell, 1000, 3, 1);
    auto evs = send(limit(Side::Buy, 1000, 5, 2, TIF::FOK));
    EXPECT_TRUE(of_type(evs, EventType::Fill).empty());
}

TEST_F(BookTest, MarketOrderStopsAtPriceBand) {
    place(Side::Sell, 1100, 5, 1);
    place(Side::Sell, 1199, 5, 1);  // band is 1000 +-20%, still inside
    auto evs = send(market(Side::Buy, 20, 2));
    EXPECT_EQ(of_type(evs, EventType::Trade).size(), 2u);
    auto c = of_type(evs, EventType::Cancelled);
    ASSERT_EQ(c.size(), 1u);
    EXPECT_EQ(c[0].qty, 10u);
}

TEST_F(BookTest, MarketOrderOnEmptyBookCancels) {
    auto evs = send(market(Side::Sell, 5, 2));
    ASSERT_EQ(evs.size(), 2u);
    EXPECT_EQ(evs[1].type, EventType::Cancelled);
}

TEST_F(BookTest, SelfTradePreventionCancelsIncoming) {
    place(Side::Sell, 1000, 5, 1);
    place(Side::Sell, 1000, 5, 7);
    auto evs = send(limit(Side::Buy, 1000, 10, 7));
    // Trades with account 1, then hits its own order and stops.
    auto fills = of_type(evs, EventType::Fill);
    ASSERT_EQ(fills.size(), 2u);
    auto c = of_type(evs, EventType::Cancelled);
    ASSERT_EQ(c.size(), 1u);
    EXPECT_EQ(c[0].reason, std::uint8_t(CancelReason::SelfTrade));
    EXPECT_EQ(c[0].qty, 5u);
    EXPECT_EQ(book.depth_at(Side::Sell, 1000), 5u);
    EXPECT_EQ(book.best_bid(), 0);
}

TEST_F(BookTest, Rejects) {
    EXPECT_EQ(send(limit(Side::Buy, 1000, 0)).at(0).reason, std::uint8_t(RejectReason::InvalidQty));
    EXPECT_EQ(send(limit(Side::Buy, 1000, 10'001)).at(0).reason, std::uint8_t(RejectReason::MaxQtyExceeded));
    EXPECT_EQ(send(limit(Side::Buy, 0, 1)).at(0).reason, std::uint8_t(RejectReason::InvalidPrice));
    EXPECT_EQ(send(limit(Side::Buy, 5000, 1)).at(0).reason, std::uint8_t(RejectReason::InvalidPrice));
    EXPECT_EQ(send(limit(Side::Buy, 1201, 1)).at(0).reason, std::uint8_t(RejectReason::PriceBand));
    EXPECT_EQ(send(limit(Side::Buy, 799, 1)).at(0).reason, std::uint8_t(RejectReason::PriceBand));
    EXPECT_EQ(send(limit(Side::Buy, 1200, 1)).at(0).type, EventType::Ack);
    EXPECT_EQ(send(cancel(12345)).at(0).reason, std::uint8_t(RejectReason::UnknownOrder));
}

TEST_F(BookTest, PriceBandFollowsLastTrade) {
    place(Side::Sell, 1150, 1, 1);
    send(limit(Side::Buy, 1150, 1, 2));
    EXPECT_EQ(book.reference_price(), 1150);
    // 1350 was outside the original band but is within 20% of 1150.
    EXPECT_EQ(send(limit(Side::Buy, 1350, 1)).at(0).type, EventType::Ack);
}

TEST_F(BookTest, CancelRemovesOrder) {
    OrderId id = place(Side::Buy, 1000, 5);
    place(Side::Buy, 999, 5);
    auto evs = send(cancel(id));
    ASSERT_EQ(evs.size(), 2u);
    EXPECT_EQ(evs[0].type, EventType::Cancelled);
    EXPECT_EQ(evs[0].qty, 5u);
    EXPECT_EQ(evs[1].level_qty, 0u);
    EXPECT_EQ(book.best_bid(), 999);
    EXPECT_EQ(send(cancel(id)).at(0).type, EventType::Reject);
}

TEST_F(BookTest, CancelRequiresOwner) {
    OrderId id = place(Side::Buy, 1000, 5, 1);
    auto evs = send(cancel(id, 2));
    EXPECT_EQ(evs.at(0).reason, std::uint8_t(RejectReason::NotOwner));
    EXPECT_EQ(book.order_count(), 1u);
}

TEST_F(BookTest, CancelFromMiddleOfQueue) {
    OrderId a = place(Side::Sell, 1000, 1, 1);
    OrderId b = place(Side::Sell, 1000, 2, 1);
    OrderId c = place(Side::Sell, 1000, 3, 1);
    send(cancel(b));
    auto fills = of_type(send(limit(Side::Buy, 1000, 4, 2)), EventType::Fill);
    ASSERT_EQ(fills.size(), 4u);
    EXPECT_EQ(fills[1].order_id, a);
    EXPECT_EQ(fills[3].order_id, c);
}

TEST_F(BookTest, ReplaceDownKeepsPriority) {
    OrderId a = place(Side::Sell, 1000, 5, 1);
    OrderId b = place(Side::Sell, 1000, 5, 3);
    send(replace(a, 1000, 2, 1));
    auto fills = of_type(send(limit(Side::Buy, 1000, 2, 2)), EventType::Fill);
    ASSERT_EQ(fills.size(), 2u);
    EXPECT_EQ(fills[1].order_id, a);
    EXPECT_EQ(book.depth_at(Side::Sell, 1000), 5u);
    (void)b;
}

TEST_F(BookTest, ReplaceUpLosesPriority) {
    OrderId a = place(Side::Sell, 1000, 5, 1);
    OrderId b = place(Side::Sell, 1000, 5, 3);
    send(replace(a, 1000, 6, 1));
    auto fills = of_type(send(limit(Side::Buy, 1000, 2, 2)), EventType::Fill);
    ASSERT_EQ(fills.size(), 2u);
    EXPECT_EQ(fills[1].order_id, b);
}

TEST_F(BookTest, ReplaceToCrossingPriceTrades) {
    place(Side::Sell, 1005, 5, 1);
    OrderId bid = place(Side::Buy, 1000, 5, 2);
    auto evs = send(replace(bid, 1005, 5, 2));
    EXPECT_EQ(evs[0].type, EventType::Replaced);
    auto fills = of_type(evs, EventType::Fill);
    ASSERT_EQ(fills.size(), 2u);
    EXPECT_EQ(fills[0].order_id, bid);
    EXPECT_EQ(book.order_count(), 0u);
}

TEST_F(BookTest, SnapshotListsLevelsBestFirst) {
    place(Side::Buy, 990, 1);
    place(Side::Buy, 995, 2);
    place(Side::Buy, 995, 3);
    place(Side::Sell, 1010, 4);
    place(Side::Sell, 1005, 5);
    Command c{};
    c.type = CmdType::Snapshot;
    c.session = 9;
    auto evs = send(c);
    ASSERT_EQ(evs.size(), 5u);
    EXPECT_EQ(evs[0].price, 995);
    EXPECT_EQ(evs[0].level_qty, 5u);
    EXPECT_EQ(evs[1].price, 990);
    EXPECT_EQ(evs[2].price, 1005);
    EXPECT_EQ(evs[3].price, 1010);
    EXPECT_EQ(evs[4].type, EventType::SnapshotEnd);
    EXPECT_EQ(evs[4].session, 9u);
}

TEST_F(BookTest, BookFullCancelsInsteadOfResting) {
    for (int i = 0; i < 64; ++i) place(Side::Buy, 900 + i, 1);
    auto evs = send(limit(Side::Buy, 950, 1));
    auto c = of_type(evs, EventType::Cancelled);
    ASSERT_EQ(c.size(), 1u);
    EXPECT_EQ(c[0].reason, std::uint8_t(CancelReason::BookFull));
}

TEST_F(BookTest, OrderIdsAreUniqueAcrossSymbols) {
    OrderBook other{3, cfg()};
    std::vector<Event> o2;
    other.process(limit(Side::Buy, 1000, 1), o2);
    OrderId here = place(Side::Buy, 1000, 1);
    EXPECT_NE(here, o2[0].order_id);
}
