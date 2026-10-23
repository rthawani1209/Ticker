// Random but market-like order flow: prices cluster around a drifting mid, cancels
// and replaces target orders that are actually resting, and now and then it sends
// garbage, halts, or stops that have already crossed. Used by the differential test
// and the benchmarks.
#pragma once

#include <algorithm>
#include <random>
#include <unordered_map>
#include <vector>

#include "ticker/config.hpp"
#include "ticker/types.hpp"

namespace ticker::testing {

class OrderFlow {
public:
    // With chaos off there are no invalid commands or halts, which is what the
    // benchmarks want: realistic traffic only.
    OrderFlow(std::uint64_t seed, const SymbolConfig& cfg, bool chaos = true)
        : rng_(seed), cfg_(cfg), mid_(cfg.ref_price), chaos_(chaos) {}

    Command next() {
        // Let the "fair price" drift so the book moves around and the band gets exercised.
        mid_ += Price(rng_() % 5) - 2;
        mid_ = std::clamp<Price>(mid_, cfg_.ref_price / 2, cfg_.ref_price * 3 / 2);
        // Stay near the last trade, otherwise the price band rejects everything.
        if (last_trade_) mid_ = (mid_ * 7 + last_trade_) / 8;

        Command c{};
        now_ += rng_() % 2'000'000;  // up to 2ms between commands
        c.ts = now_;
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
        } else if (chaos_ && roll < 32 && rng_() % 8 == 0) {
            c.type = CmdType::Halt;
        } else if (halted_ && rng_() % 20 == 0) {
            c.type = CmdType::Resume;  // an admin reopening the market
        } else if (chaos_ && roll < 33) {
            // Garbage the book has to reject cleanly.
            c.type = CmdType::New;
            c.side = Side(rng_() % 3);
            c.ord_type = OrdType(rng_() % 5);
            c.stop_price = Price(rng_() % 300);
            c.tif = TIF(rng_() % 4);
            c.price = Price(rng_() % (cfg_.max_price + 10)) - 5;
            c.qty = rng_() % 3 == 0 ? 0 : Qty(rng_() % (cfg_.max_order_qty * 2));
        } else {
            c.type = CmdType::New;
            c.side = rng_() % 2 ? Side::Buy : Side::Sell;
            int k = int(rng_() % 12);
            c.ord_type = k == 0 ? OrdType::Market : k == 1 ? OrdType::Stop : k == 2 ? OrdType::StopLimit : OrdType::Limit;
            int t = int(rng_() % 10);
            c.tif = t < 7 ? TIF::GTC : t < 9 ? TIF::IOC : TIF::FOK;
            // Mostly near the mid, sometimes far away to hit the band.
            Price spread = rng_() % 20 == 0 ? 400 : 12;
            c.price = mid_ + Price(rng_() % (2 * spread + 1)) - spread;
            c.qty = Qty(1 + rng_() % (rng_() % 8 == 0 ? 400 : 40));
            if (c.ord_type == OrdType::Stop || c.ord_type == OrdType::StopLimit) {
                // Usually on the correct side of the market, sometimes already crossed.
                Price off = Price(rng_() % 15) - 2;
                c.stop_price = c.side == Side::Buy ? mid_ + off : mid_ - off;
            }
        }
        return c;
    }

    // Tracks which orders are still resting so cancels and replaces mostly hit
    // something. Without this a small book clogs up with stale orders and stops trading.
    void observe(const std::vector<Event>& evs) {
        for (auto& e : evs) {
            if (e.type == EventType::Ack) {
                pos_[e.order_id] = live_.size();
                live_.push_back(e.order_id);
                last_dead_ = e.order_id;
            } else if (e.type == EventType::TradingStatus) {
                halted_ = e.reason == 1;
            } else if (e.type == EventType::Trade) {
                last_trade_ = e.price;
            } else if (e.type == EventType::Cancelled || (e.type == EventType::Fill && e.leaves == 0)) {
                forget(e.order_id);
            }
        }
    }

private:
    OrderId pick_live() {
        // Now and then target an order that's gone, to test the UnknownOrder path.
        if (rng_() % 20 == 0) return last_dead_ - rng_() % 50;
        return live_[rng_() % live_.size()];
    }

    void forget(OrderId id) {
        auto it = pos_.find(id);
        if (it == pos_.end()) return;
        std::size_t i = it->second;
        live_[i] = live_.back();
        pos_[live_[i]] = i;
        live_.pop_back();
        pos_.erase(id);
    }

    std::mt19937_64 rng_;
    SymbolConfig cfg_;
    Price mid_;
    bool chaos_;
    std::uint64_t cl_ = 0;
    std::vector<OrderId> live_;
    std::unordered_map<OrderId, std::size_t> pos_;
    OrderId last_dead_ = 0;
    Price last_trade_ = 0;
    std::uint64_t now_ = 0;
    bool halted_ = false;
};

}  // namespace ticker::testing
