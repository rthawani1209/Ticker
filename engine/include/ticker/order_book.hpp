#pragma once

#include <cstdint>
#include <vector>

#include "ticker/bit_tree.hpp"
#include "ticker/config.hpp"
#include "ticker/order_map.hpp"
#include "ticker/pool.hpp"
#include "ticker/types.hpp"

namespace ticker {

// Limit order book for one symbol with price-time priority.
//
// Each side is a flat array of price levels indexed by tick, and each level is an
// intrusive doubly linked list of orders in arrival order. A BitTree per side finds
// the next non-empty level, and an OrderMap gives O(1) cancel by id. Order nodes come
// from a pre-allocated pool, so nothing on the matching path allocates.
class OrderBook {
public:
    OrderBook(SymbolId symbol, const SymbolConfig& cfg);

    OrderBook(const OrderBook&) = delete;
    OrderBook& operator=(const OrderBook&) = delete;

    // Applies one command and appends the resulting events to `out`.
    void process(const Command& cmd, std::vector<Event>& out);

    // Introspection, mainly for tests. Prices are 0 when that side is empty.
    Price best_bid() const { return best_bid_; }
    Price best_ask() const { return best_ask_; }
    std::uint64_t depth_at(Side side, Price price) const;
    std::size_t order_count() const { return pool_.in_use(); }
    Price reference_price() const { return ref_price_; }
    SymbolId symbol() const { return symbol_; }

private:
    struct Order {
        OrderId id;
        std::uint64_t cl_ord_id;
        Price price;
        Qty qty;  // open quantity
        AccountId account;
        SessionId session;
        Side side;
        Order* prev;
        Order* next;
    };

    struct Level {
        std::uint64_t total = 0;
        Order* head = nullptr;
        Order* tail = nullptr;
    };

    struct Incoming {
        OrderId id;
        std::uint64_t cl_ord_id;
        SessionId session;
        AccountId account;
        Side side;
        Price limit;
        Qty qty;
        bool can_rest;
        bool fok;
    };

    void on_new(const Command& cmd, std::vector<Event>& out);
    void on_cancel(const Command& cmd, std::vector<Event>& out);
    void on_replace(const Command& cmd, std::vector<Event>& out);
    void on_snapshot(const Command& cmd, std::vector<Event>& out);

    void execute(const Incoming& in, std::vector<Event>& out);
    bool fok_fillable(const Incoming& in) const;

    void link(Order* o);
    void unlink(Order* o);
    void emit_delta(Side side, Price price, std::vector<Event>& out) const;

    RejectReason check_price(Price price) const;
    void reject(const Command& cmd, RejectReason why, std::vector<Event>& out) const;

    Level* levels(Side s) { return s == Side::Buy ? bids_.data() : asks_.data(); }
    const Level* levels(Side s) const { return s == Side::Buy ? bids_.data() : asks_.data(); }
    BitTree& tree(Side s) { return s == Side::Buy ? bid_tree_ : ask_tree_; }

    SymbolId symbol_;
    SymbolConfig cfg_;
    std::vector<Level> bids_;
    std::vector<Level> asks_;
    BitTree bid_tree_;
    BitTree ask_tree_;
    Price best_bid_ = 0;
    Price best_ask_ = 0;
    Price ref_price_;

    Pool<Order> pool_;
    OrderMap<Order> by_id_;
    std::uint64_t next_seq_ = 1;
    std::uint64_t next_trade_ = 1;
};

}  // namespace ticker
