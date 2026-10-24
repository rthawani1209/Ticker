#include "server.hpp"

#include <gtest/gtest.h>

#include <filesystem>

#include "test_client.hpp"

using namespace ticker;
using namespace ticker::testing;
using wire::MsgType;

namespace {

// Small books so a test server starts fast and stays light.
std::vector<SymbolConfig> small_symbols() {
    std::vector<SymbolConfig> v;
    for (const char* name : {"AAA", "BBB", "CCC"}) {
        SymbolConfig s;
        s.name = name;
        s.max_price = 20000;
        s.max_orders = 1024;
        v.push_back(s);
    }
    return v;
}

ServerConfig test_config() {
    ServerConfig cfg;
    cfg.host = "127.0.0.1";
    cfg.port = 0;
    cfg.shards = 2;
    cfg.symbols = small_symbols();
    return cfg;
}

auto is(EventType t) {
    return [t](const Event& e) { return e.type == t; };
}

std::uint32_t error_code(TestClient& c) {
    auto m = c.read();
    if (!m || m->type != MsgType::Error) return 0;
    return std::uint32_t(m->as<wire::Error>().code);
}

}  // namespace

TEST(ServerTest, LogonAndAck) {
    Server server(test_config());
    server.start();

    TestClient c(server.port());
    auto ack = c.logon(7);
    ASSERT_TRUE(ack);
    EXPECT_GT(ack->session, 0u);
    EXPECT_EQ(ack->symbols, 3u);

    c.new_order(1, Side::Buy, 10000, 5, 42);
    auto e = c.wait_event(is(EventType::Ack));
    ASSERT_TRUE(e);
    EXPECT_EQ(e->cl_ord_id, 42u);
    EXPECT_EQ(e->account, 7u);
    EXPECT_EQ(e->symbol, 1u);
}

TEST(ServerTest, TwoClientsTradeAndMarketDataSeesIt) {
    Server server(test_config());
    server.start();

    TestClient md(server.port());
    ASSERT_TRUE(md.logon(99, wire::kMarketData));
    TestClient buyer(server.port()), seller(server.port());
    ASSERT_TRUE(buyer.logon(1));
    ASSERT_TRUE(seller.logon(2));

    buyer.new_order(2, Side::Buy, 10010, 10, 1);
    ASSERT_TRUE(buyer.wait_event(is(EventType::Ack)));
    seller.new_order(2, Side::Sell, 10000, 4, 2);

    auto sell_fill = seller.wait_event(is(EventType::Fill));
    ASSERT_TRUE(sell_fill);
    EXPECT_EQ(sell_fill->price, 10010);  // resting price wins
    EXPECT_EQ(sell_fill->qty, 4u);

    auto buy_fill = buyer.wait_event(is(EventType::Fill));
    ASSERT_TRUE(buy_fill);
    EXPECT_EQ(buy_fill->leaves, 6u);

    auto trade = md.wait_event(is(EventType::Trade));
    ASSERT_TRUE(trade);
    EXPECT_EQ(trade->symbol, 2u);
    EXPECT_EQ(trade->qty, 4u);
    EXPECT_EQ(trade->session, 0u);
}

TEST(ServerTest, OrderBeforeLogonIsRejected) {
    Server server(test_config());
    server.start();

    TestClient c(server.port());
    c.new_order(0, Side::Buy, 10000, 1);
    EXPECT_EQ(error_code(c), std::uint32_t(wire::ErrorCode::NotLoggedIn));
    EXPECT_TRUE(c.closed());
}

TEST(ServerTest, GarbageIsRejected) {
    Server server(test_config());
    server.start();

    TestClient c(server.port());
    const std::uint8_t junk[8] = {0xff, 0xff, 0x01, 0x01, 0, 0, 0, 0};
    c.send_raw(junk, sizeof junk);
    EXPECT_EQ(error_code(c), std::uint32_t(wire::ErrorCode::BadMessage));
    EXPECT_TRUE(c.closed());
}

TEST(ServerTest, HaltNeedsAdmin) {
    auto cfg = test_config();
    cfg.token = 1234;
    Server server(cfg);
    server.start();

    TestClient user(server.port());
    ASSERT_TRUE(user.logon(1));
    user.symbol_msg(MsgType::Halt, 0);
    EXPECT_EQ(error_code(user), std::uint32_t(wire::ErrorCode::NotAllowed));

    TestClient admin(server.port());
    ASSERT_TRUE(admin.logon(0, wire::kAdmin | wire::kMarketData, 1234));
    admin.symbol_msg(MsgType::Halt, 0);
    auto status = admin.wait_event(is(EventType::TradingStatus));
    ASSERT_TRUE(status);
    EXPECT_EQ(status->reason, 1);  // halted
}

TEST(ServerTest, ProxyNeedsTokenAndCanTradeForAnyAccount) {
    auto cfg = test_config();
    cfg.token = 1234;
    Server server(cfg);
    server.start();

    TestClient bad(server.port());
    auto m = wire::make<wire::Logon>(MsgType::Logon);
    m.flags = wire::kProxy;
    m.token = 1;
    bad.send(m);
    EXPECT_EQ(error_code(bad), std::uint32_t(wire::ErrorCode::BadToken));

    TestClient proxy(server.port());
    ASSERT_TRUE(proxy.logon(0, wire::kProxy, 1234));
    proxy.new_order(0, Side::Sell, 10000, 1, 5, OrdType::Limit, TIF::GTC, 555);
    auto ack = proxy.wait_event(is(EventType::Ack));
    ASSERT_TRUE(ack);
    EXPECT_EQ(ack->account, 555u);

    // A normal session can't pick its account.
    TestClient user(server.port());
    ASSERT_TRUE(user.logon(8));
    user.new_order(0, Side::Sell, 10000, 1, 6, OrdType::Limit, TIF::GTC, 555);
    auto ack2 = user.wait_event(is(EventType::Ack));
    ASSERT_TRUE(ack2);
    EXPECT_EQ(ack2->account, 8u);
}

TEST(ServerTest, SubscribeSendsSnapshot) {
    Server server(test_config());
    server.start();

    TestClient trader(server.port());
    ASSERT_TRUE(trader.logon(1));
    trader.new_order(1, Side::Buy, 9990, 3, 1);
    trader.new_order(1, Side::Buy, 9980, 2, 2);
    trader.new_order(1, Side::Sell, 10020, 7, 3);
    for (int i = 0; i < 3; ++i) ASSERT_TRUE(trader.wait_event(is(EventType::Ack)));

    TestClient viewer(server.port());
    ASSERT_TRUE(viewer.logon(2));
    viewer.symbol_msg(MsgType::Subscribe, 1);

    std::vector<Event> levels;
    while (auto e = viewer.wait_event([](const Event& ev) {
               return ev.type == EventType::SnapshotLevel || ev.type == EventType::SnapshotEnd;
           })) {
        if (e->type == EventType::SnapshotEnd) break;
        levels.push_back(*e);
    }
    ASSERT_EQ(levels.size(), 3u);
    EXPECT_EQ(levels[0].price, 9990);
    EXPECT_EQ(levels[0].level_qty, 3u);
    EXPECT_EQ(levels[1].price, 9980);
    EXPECT_EQ(levels[2].price, 10020);
    EXPECT_EQ(levels[2].side, Side::Sell);

    // Subscribing also turns on live market data.
    trader.new_order(1, Side::Buy, 9970, 1, 4);
    auto delta = viewer.wait_event(is(EventType::BookDelta));
    ASSERT_TRUE(delta);
    EXPECT_EQ(delta->price, 9970);
}

TEST(ServerTest, RestartRecoversBookFromJournal) {
    auto dir = std::filesystem::temp_directory_path() / ("ticker-server-test-" + std::to_string(::getpid()));
    std::filesystem::remove_all(dir);
    auto cfg = test_config();
    cfg.journal_dir = dir.string();

    SessionId first_session;
    {
        Server server(cfg);
        server.start();
        TestClient c(server.port());
        auto ack = c.logon(1);
        ASSERT_TRUE(ack);
        first_session = ack->session;
        c.new_order(0, Side::Sell, 10050, 9, 1);
        c.new_order(2, Side::Buy, 9950, 4, 2);
        ASSERT_TRUE(c.wait_event(is(EventType::Ack)));
        ASSERT_TRUE(c.wait_event(is(EventType::Ack)));
    }

    Server server(cfg);
    server.start();
    EXPECT_EQ(server.recovered_commands(), 2u);

    TestClient c(server.port());
    auto ack = c.logon(2);
    ASSERT_TRUE(ack);
    EXPECT_GT(ack->session, first_session);  // never reuse a session that owns resting orders

    // The resting sell survived: a buy crosses it.
    c.new_order(0, Side::Buy, 10050, 9, 3);
    auto fill = c.wait_event(is(EventType::Fill));
    ASSERT_TRUE(fill);
    EXPECT_EQ(fill->price, 10050);
    EXPECT_EQ(fill->qty, 9u);

    std::filesystem::remove_all(dir);
}

TEST(ServerTest, PipelinedBurstIsFullyAcked) {
    Server server(test_config());
    server.start();

    TestClient c(server.port());
    ASSERT_TRUE(c.logon(1));
    TestClient other(server.port());
    ASSERT_TRUE(other.logon(2));

    // Fire everything without reading, so the rings and write buffers back up.
    // Alternating sides at one price keeps the book from filling.
    constexpr int kOrders = 20000;
    for (int i = 0; i < kOrders; ++i) {
        TestClient& who = i % 2 ? other : c;
        who.new_order(SymbolId(i % 3), i % 2 ? Side::Sell : Side::Buy, 10000, 1, std::uint64_t(i));
    }

    int acks = 0;
    while (acks < kOrders / 2 && c.wait_event(is(EventType::Ack))) ++acks;
    EXPECT_EQ(acks, kOrders / 2);
}
