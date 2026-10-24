#include "ticker/protocol.hpp"

#include <gtest/gtest.h>

#include <random>
#include <vector>

#include "ticker/histogram.hpp"

using namespace ticker;
using namespace ticker::wire;

TEST(Protocol, RoundTripsANewOrder) {
    auto m = make<NewOrder>(MsgType::NewOrder);
    m.cl_ord_id = 42;
    m.symbol = 3;
    m.price = 12'345;
    m.qty = 100;
    std::uint8_t buf[sizeof m];
    std::memcpy(buf, &m, sizeof m);

    Header h;
    ASSERT_EQ(peek(buf, sizeof buf, h), Parse::Ok);
    EXPECT_EQ(h.type, MsgType::NewOrder);
    auto back = read_as<NewOrder>(buf);
    EXPECT_EQ(back.cl_ord_id, 42u);
    EXPECT_EQ(back.price, 12'345);
}

TEST(Protocol, WaitsForTheRestOfAMessage) {
    auto m = make<Cancel>(MsgType::Cancel);
    std::uint8_t buf[sizeof m];
    std::memcpy(buf, &m, sizeof m);
    Header h;
    EXPECT_EQ(peek(buf, 2, h), Parse::NeedMore);
    EXPECT_EQ(peek(buf, sizeof m - 1, h), Parse::NeedMore);
    EXPECT_EQ(peek(buf, sizeof m, h), Parse::Ok);
}

TEST(Protocol, RejectsBadHeaders) {
    auto m = make<Cancel>(MsgType::Cancel);
    std::uint8_t buf[sizeof m];
    Header h;

    m.h.length = 33;  // wrong size for the type
    std::memcpy(buf, &m, sizeof m);
    EXPECT_EQ(peek(buf, sizeof buf, h), Parse::Bad);

    m.h.length = sizeof m;
    m.h.version = 9;
    std::memcpy(buf, &m, sizeof m);
    EXPECT_EQ(peek(buf, sizeof buf, h), Parse::Bad);

    m.h.version = kVersion;
    m.h.type = MsgType(200);
    std::memcpy(buf, &m, sizeof m);
    EXPECT_EQ(peek(buf, 4, h), Parse::Bad);  // rejected from the header alone
}

// Throws random and mutated bytes at the parser the way the server reads a socket.
// It must never claim a message longer than the buffer; ASan checks the reads.
TEST(Protocol, FuzzParser) {
    std::mt19937_64 rng(11);
    std::vector<std::vector<std::uint8_t>> seeds;
    auto add = [&](auto msg) {
        std::vector<std::uint8_t> v(sizeof msg);
        std::memcpy(v.data(), &msg, sizeof msg);
        seeds.push_back(v);
    };
    add(make<Logon>(MsgType::Logon));
    add(make<NewOrder>(MsgType::NewOrder));
    add(make<Cancel>(MsgType::Cancel));
    add(make<Replace>(MsgType::Replace));
    add(make<SymbolMsg>(MsgType::Subscribe));

    std::size_t ok = 0;
    for (int iter = 0; iter < 200'000; ++iter) {
        std::vector<std::uint8_t> buf;
        int parts = 1 + int(rng() % 4);
        for (int p = 0; p < parts; ++p) {
            auto s = seeds[rng() % seeds.size()];
            if (rng() % 2)
                for (int k = 0; k < 3; ++k) s[rng() % s.size()] = std::uint8_t(rng());
            if (rng() % 4 == 0) s.resize(rng() % s.size());
            buf.insert(buf.end(), s.begin(), s.end());
        }
        if (rng() % 8 == 0) {
            buf.resize(rng() % 128);
            for (auto& b : buf) b = std::uint8_t(rng());
        }

        // Feed it in random-sized chunks like recv() would.
        std::vector<std::uint8_t> pending;
        std::size_t pos = 0;
        bool bad = false;
        while (pos < buf.size() && !bad) {
            std::size_t chunk = std::min<std::size_t>(buf.size() - pos, 1 + rng() % 50);
            pending.insert(pending.end(), buf.begin() + std::ptrdiff_t(pos), buf.begin() + std::ptrdiff_t(pos + chunk));
            pos += chunk;
            for (;;) {
                Header h;
                Parse r = peek(pending.data(), pending.size(), h);
                if (r == Parse::Bad) {
                    bad = true;
                    break;
                }
                if (r == Parse::NeedMore) break;
                ASSERT_LE(h.length, pending.size());
                ASSERT_EQ(h.length, message_size(h.type));
                ++ok;
                pending.erase(pending.begin(), pending.begin() + h.length);
            }
        }
    }
    EXPECT_GT(ok, 10'000u);
}

TEST(LatencyHistogram, PercentilesAreClose) {
    LatencyHistogram h;
    for (std::uint64_t v = 1; v <= 100'000; ++v) h.record(v);
    EXPECT_EQ(h.count(), 100'000u);
    EXPECT_EQ(h.max(), 100'000u);
    auto near = [](std::uint64_t got, double want) { return std::abs(double(got) - want) / want < 0.02; };
    EXPECT_TRUE(near(h.percentile(0.5), 50'000)) << h.percentile(0.5);
    EXPECT_TRUE(near(h.percentile(0.99), 99'000)) << h.percentile(0.99);
    EXPECT_EQ(h.percentile(1.0), 100'000u);
    h.reset();
    EXPECT_EQ(h.percentile(0.5), 0u);
}
