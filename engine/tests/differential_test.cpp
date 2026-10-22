// Feeds the same random order flow to the real book and the reference book and
// requires byte-identical output. Set TICKER_FUZZ_COMMANDS to run longer.
#include <gtest/gtest.h>

#include <cstdlib>
#include <random>
#include <sstream>

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

class Generator {
public:
    Generator(std::uint64_t seed, const SymbolConfig& cfg) : rng_(seed), cfg_(cfg), mid_(cfg.ref_price) {}

    Command next() {
        // Let the "fair price" drift so the book moves around and the band gets exercised.
        mid_ += Price(rng_() % 5) - 2;
        mid_ = std::clamp<Price>(mid_, cfg_.ref_price / 2, cfg_.ref_price * 3 / 2);

        Command c{};
        c.symbol = 0;
        c.account = AccountId(1 + rng_() % 6);
        c.session = c.account;
        c.cl_ord_id = ++cl_;
        int roll = int(rng_() % 100);

        if (roll < 18 && !live_.empty()) {
            c.type = CmdType::Cancel;
            c.order_id = pick_live();
            if (rng_() % 10 == 0) c.account = AccountId(1 + rng_() % 6);  // sometimes not the owner
        } else if (roll < 30 && !live_.empty()) {
            c.type = CmdType::Replace;
            c.order_id = pick_live();
            c.price = mid_ + Price(rng_() % 21) - 10;
            c.qty = Qty(1 + rng_() % 50);
        } else if (roll < 31) {
            c.type = CmdType::Snapshot;
        } else if (roll < 33) {
            // Garbage the book has to reject cleanly.
            c.type = CmdType::New;
            c.side = Side(rng_() % 3);
            c.ord_type = OrdType(rng_() % 3);
            c.tif = TIF(rng_() % 4);
            c.price = Price(rng_() % (cfg_.max_price + 10)) - 5;
            c.qty = rng_() % 3 == 0 ? 0 : Qty(rng_() % (cfg_.max_order_qty * 2));
        } else {
            c.type = CmdType::New;
            c.side = rng_() % 2 ? Side::Buy : Side::Sell;
            c.ord_type = rng_() % 12 == 0 ? OrdType::Market : OrdType::Limit;
            int t = int(rng_() % 10);
            c.tif = t < 7 ? TIF::GTC : t < 9 ? TIF::IOC : TIF::FOK;
            // Mostly near the mid, sometimes far away to hit the band.
            Price spread = rng_() % 20 == 0 ? 400 : 12;
            c.price = mid_ + Price(rng_() % (2 * spread + 1)) - spread;
            c.qty = Qty(1 + rng_() % (rng_() % 8 == 0 ? 400 : 40));
        }
        return c;
    }

    void observe(const std::vector<Event>& evs) {
        for (auto& e : evs) {
            if (e.type == EventType::Ack) live_.push_back(e.order_id);
        }
    }

private:
    OrderId pick_live() {
        // Old ids that are already gone are fine; they test the UnknownOrder path.
        std::size_t i = rng_() % live_.size();
        OrderId id = live_[i];
        if (live_.size() > 4000) {
            live_[i] = live_.back();
            live_.pop_back();
        }
        return id;
    }

    std::mt19937_64 rng_;
    SymbolConfig cfg_;
    Price mid_;
    std::uint64_t cl_ = 0;
    std::vector<OrderId> live_;
};

void run(std::uint64_t seed, std::size_t commands, const SymbolConfig& cfg) {
    OrderBook fast(0, cfg);
    ReferenceBook ref(0, cfg);
    Generator gen(seed, cfg);
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
    EXPECT_GT(trades, commands / 200) << "generator isn't producing enough trades to be a useful test";
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

TEST(Differential, WideBandLowPrices) {
    SymbolConfig cfg;
    cfg.max_price = 2048;
    cfg.ref_price = 40;
    cfg.band_bps = 9000;
    for (std::uint64_t seed = 200; seed <= 204; ++seed) run(seed, budget(40'000), cfg);
}
