// Feeds the same random order flow to the real book and the reference book and
// requires byte-identical output. Set TICKER_FUZZ_COMMANDS to run longer.
#include <gtest/gtest.h>

#include <cstdlib>
#include <random>
#include <sstream>
#include <unordered_map>

#include "order_flow.hpp"
#include "reference_book.hpp"
#include "ticker/order_book.hpp"

using namespace ticker;
using namespace ticker::testing;

namespace {

std::string describe(const Event& e) {
    std::ostringstream s;
    s << to_string(e.type) << " side=" << int(e.side) << " reason=" << int(e.reason) << " acct=" << e.account
      << " id=" << e.order_id << " px=" << e.price << " qty=" << e.qty << " leaves=" << e.leaves
      << " lvl=" << e.level_qty << " trade=" << e.trade_id;
    return s.str();
}

void run(std::uint64_t seed, std::size_t commands, const SymbolConfig& cfg, std::size_t min_trade_ratio = 20) {
    OrderBook fast(0, cfg);
    ReferenceBook ref(0, cfg);
    OrderFlow gen(seed, cfg);
    std::vector<Event> a, b;
    std::size_t trades = 0;

    for (std::size_t i = 0; i < commands; ++i) {
        Command c = gen.next();
        a.clear();
        b.clear();
        fast.process(c, a);
        ref.process(c, b);
        if (a != b) {
            std::ostringstream msg;
            msg << "seed " << seed << ", command #" << i << " type=" << int(c.type) << "\nfast:\n";
            for (auto& e : a) msg << "  " << describe(e) << "\n";
            msg << "reference:\n";
            for (auto& e : b) msg << "  " << describe(e) << "\n";
            FAIL() << msg.str();
        }
        for (auto& e : a) trades += e.type == EventType::Trade;
        gen.observe(a);
    }
    EXPECT_EQ(fast.order_count(), ref.order_count());
    EXPECT_GT(trades, commands / min_trade_ratio) << "generator isn't producing enough trades to be a useful test";
}

std::size_t budget(std::size_t dflt) {
    if (const char* s = std::getenv("TICKER_FUZZ_COMMANDS")) return std::strtoull(s, nullptr, 10);
    return dflt;
}

}  // namespace

TEST(Differential, DefaultSymbol) {
    SymbolConfig cfg;
    cfg.max_price = 1 << 14;
    cfg.ref_price = 5000;
    for (std::uint64_t seed = 1; seed <= 5; ++seed) run(seed, budget(40'000), cfg);
}

TEST(Differential, TinyBookHitsCapacity) {
    SymbolConfig cfg;
    cfg.max_price = 256;
    cfg.ref_price = 128;
    cfg.band_bps = 5000;
    cfg.max_orders = 20;
    cfg.max_order_qty = 300;
    for (std::uint64_t seed = 100; seed <= 104; ++seed) run(seed, budget(40'000), cfg);
}

TEST(Differential, CircuitBreakerTrips) {
    SymbolConfig cfg;
    cfg.max_price = 4096;
    cfg.ref_price = 1000;
    cfg.band_bps = 1000;
    cfg.circuit_bps = 300;  // 3% so it trips often
    cfg.circuit_window_ns = 200'000'000;
    cfg.halt_ns = 30'000'000;
    // Halted markets don't trade, so expect fewer trades here.
    for (std::uint64_t seed = 300; seed <= 304; ++seed) run(seed, budget(40'000), cfg, 100);
}

TEST(Differential, WideBandLowPrices) {
    SymbolConfig cfg;
    cfg.max_price = 2048;
    cfg.ref_price = 40;
    cfg.band_bps = 9000;
    cfg.circuit_bps = 0;  // one tick is 2.5% here, the breaker would never stay open
    for (std::uint64_t seed = 200; seed <= 204; ++seed) run(seed, budget(40'000), cfg);
}
