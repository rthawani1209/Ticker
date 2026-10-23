#include "ticker/order_book.hpp"

#include <algorithm>
#include <cassert>

namespace ticker {

OrderBook::OrderBook(SymbolId symbol, const SymbolConfig& cfg)
    : symbol_(symbol),
      cfg_(cfg),
      bids_(std::size_t(cfg.max_price)),
      asks_(std::size_t(cfg.max_price)),
      bid_tree_(std::size_t(cfg.max_price)),
      ask_tree_(std::size_t(cfg.max_price)),
      buy_stops_(std::size_t(cfg.max_price)),
      sell_stops_(std::size_t(cfg.max_price)),
      buy_stop_tree_(std::size_t(cfg.max_price)),
      sell_stop_tree_(std::size_t(cfg.max_price)),
      ref_price_(cfg.ref_price),
      pool_(cfg.max_orders),
      by_id_(cfg.max_orders) {
    assert(cfg.max_price > 1 && std::size_t(cfg.max_price) <= BitTree::kMaxBits);
}

void OrderBook::process(const Command& cmd, std::vector<Event>& out) {
    switch (cmd.type) {
        case CmdType::New: on_new(cmd, out); break;
        case CmdType::Cancel: on_cancel(cmd, out); break;
        case CmdType::Replace: on_replace(cmd, out); break;
        case CmdType::Snapshot: on_snapshot(cmd, out); break;
        default: reject(cmd, RejectReason::InvalidField, out); break;
    }
}

std::uint64_t OrderBook::depth_at(Side side, Price price) const {
    if (price <= 0 || price >= cfg_.max_price) return 0;
    return levels(side)[price].total;
}

RejectReason OrderBook::check_price(Price price) const {
    if (price < 1 || price >= cfg_.max_price) return RejectReason::InvalidPrice;
    // Integer form of |price - ref| / ref > band_bps / 10000
    Price diff = price > ref_price_ ? price - ref_price_ : ref_price_ - price;
    if (diff * 10'000 > ref_price_ * Price(cfg_.band_bps)) return RejectReason::PriceBand;
    return RejectReason::None;
}

void OrderBook::reject(const Command& cmd, RejectReason why, std::vector<Event>& out) const {
    Event e{};
    e.type = EventType::Reject;
    e.side = cmd.side;
    e.reason = std::uint8_t(why);
    e.symbol = cmd.symbol;
    e.session = cmd.session;
    e.account = cmd.account;
    e.order_id = cmd.order_id;
    e.cl_ord_id = cmd.cl_ord_id;
    out.push_back(e);
}

void OrderBook::on_new(const Command& cmd, std::vector<Event>& out) {
    if (std::uint8_t(cmd.side) > 1 || std::uint8_t(cmd.ord_type) > 3 || std::uint8_t(cmd.tif) > 2)
        return reject(cmd, RejectReason::InvalidField, out);
    if (cmd.qty == 0) return reject(cmd, RejectReason::InvalidQty, out);
    if (cmd.qty > cfg_.max_order_qty) return reject(cmd, RejectReason::MaxQtyExceeded, out);

    const bool is_stop = cmd.ord_type == OrdType::Stop || cmd.ord_type == OrdType::StopLimit;
    const bool has_limit = cmd.ord_type == OrdType::Limit || cmd.ord_type == OrdType::StopLimit;
    if (has_limit) {
        if (auto r = check_price(cmd.price); r != RejectReason::None) return reject(cmd, r, out);
    }
    if (is_stop) {
        if (cmd.stop_price < 1 || cmd.stop_price >= cfg_.max_price) return reject(cmd, RejectReason::InvalidPrice, out);
        bool crossed = cmd.side == Side::Buy ? cmd.stop_price <= ref_price_ : cmd.stop_price >= ref_price_;
        if (crossed) return reject(cmd, RejectReason::StopPriceCrossed, out);
    }

    OrderId id = (OrderId(symbol_) + 1) << 40 | next_seq_++;

    Event ack{};
    ack.type = EventType::Ack;
    ack.side = cmd.side;
    ack.symbol = symbol_;
    ack.session = cmd.session;
    ack.account = cmd.account;
    ack.order_id = id;
    ack.cl_ord_id = cmd.cl_ord_id;
    ack.price = has_limit ? cmd.price : 0;
    ack.qty = cmd.qty;
    ack.leaves = cmd.qty;
    out.push_back(ack);

    if (is_stop) return add_stop(cmd, id, out);

    Incoming in{id,       cmd.cl_ord_id, cmd.session, cmd.account,
                cmd.side, has_limit ? cmd.price : market_limit(cmd.side), cmd.qty,
                cmd.ord_type == OrdType::Limit && cmd.tif == TIF::GTC,
                cmd.tif == TIF::FOK};
    execute(in, out);
    run_stops(out);
}

// Market orders are protected: they only sweep as far as the price band.
Price OrderBook::market_limit(Side side) const {
    Price band = ref_price_ * Price(cfg_.band_bps) / 10'000;
    return side == Side::Buy ? std::min(cfg_.max_price - 1, ref_price_ + band) : std::max<Price>(1, ref_price_ - band);
}

void OrderBook::add_stop(const Command& cmd, OrderId id, std::vector<Event>& out) {
    Order* o = pool_.acquire();
    if (!o) {
        Event e{};
        e.type = EventType::Cancelled;
        e.side = cmd.side;
        e.reason = std::uint8_t(CancelReason::BookFull);
        e.symbol = symbol_;
        e.session = cmd.session;
        e.account = cmd.account;
        e.order_id = id;
        e.cl_ord_id = cmd.cl_ord_id;
        e.price = cmd.price;
        e.qty = cmd.qty;
        out.push_back(e);
        return;
    }
    *o = Order{id,         cmd.cl_ord_id, cmd.price, cmd.stop_price, cmd.qty, cmd.account, cmd.session,
               cmd.side,   cmd.ord_type,  cmd.tif,   true,           nullptr, nullptr};
    link_stop(o);
    by_id_.insert(id, o);
}

// Triggers every stop the last trade has reached. Triggered orders can trade and
// move the price further, which can trigger more stops, so this loops until quiet.
void OrderBook::run_stops(std::vector<Event>& out) {
    for (;;) {
        Order* o = nullptr;
        if (!buy_stop_tree_.empty()) {
            Price p = buy_stop_tree_.find_next(0);
            if (p <= ref_price_) o = buy_stops_[p].head;
        }
        if (!o && !sell_stop_tree_.empty()) {
            Price p = sell_stop_tree_.find_prev(std::size_t(cfg_.max_price - 1));
            if (p >= ref_price_) o = sell_stops_[p].head;
        }
        if (!o) return;

        unlink_stop(o);
        by_id_.erase(o->id);

        Event e{};
        e.type = EventType::Triggered;
        e.side = o->side;
        e.symbol = symbol_;
        e.session = o->session;
        e.account = o->account;
        e.order_id = o->id;
        e.cl_ord_id = o->cl_ord_id;
        e.price = o->stop_price;
        e.qty = o->qty;
        e.leaves = o->qty;
        out.push_back(e);

        const bool limit = o->type == OrdType::StopLimit;
        Incoming in{o->id,   o->cl_ord_id, o->session, o->account,
                    o->side, limit ? o->price : market_limit(o->side), o->qty,
                    limit && o->tif == TIF::GTC,
                    o->tif == TIF::FOK};
        pool_.release(o);
        execute(in, out);
    }
}

bool OrderBook::fok_fillable(const Incoming& in) const {
    const Side opp = opposite(in.side);
    const Level* lv = levels(opp);
    const BitTree& t = opp == Side::Buy ? bid_tree_ : ask_tree_;
    std::uint64_t have = 0;
    Price p = opp == Side::Buy ? best_bid_ : best_ask_;
    while (p > 0 && (in.side == Side::Buy ? p <= in.limit : p >= in.limit)) {
        for (const Order* o = lv[p].head; o; o = o->next) {
            // Matching stops at our own order, so liquidity behind it doesn't count.
            if (o->account == in.account) return false;
            have += o->qty;
            if (have >= in.qty) return true;
        }
        std::int64_t nxt = opp == Side::Buy ? t.find_prev(std::size_t(p - 1)) : t.find_next(std::size_t(p + 1));
        p = nxt < 0 ? 0 : nxt;
    }
    return false;
}

void OrderBook::execute(const Incoming& in, std::vector<Event>& out) {
    auto cancelled = [&](CancelReason why, Qty qty) {
        Event e{};
        e.type = EventType::Cancelled;
        e.side = in.side;
        e.reason = std::uint8_t(why);
        e.symbol = symbol_;
        e.session = in.session;
        e.account = in.account;
        e.order_id = in.id;
        e.cl_ord_id = in.cl_ord_id;
        e.price = in.limit;
        e.qty = qty;
        out.push_back(e);
    };

    if (in.fok && !fok_fillable(in)) return cancelled(CancelReason::FokUnfillable, in.qty);

    const Side opp = opposite(in.side);
    Level* opp_levels = levels(opp);
    Qty remaining = in.qty;
    bool self_trade = false;

    while (remaining > 0 && !self_trade) {
        const Price best = in.side == Side::Buy ? best_ask_ : best_bid_;
        if (best == 0) break;
        if (in.side == Side::Buy ? best > in.limit : best < in.limit) break;

        Level& level = opp_levels[best];
        Order* o = level.head;
        while (o && remaining > 0) {
            if (o->account == in.account) {
                self_trade = true;
                break;
            }
            const Qty fill = std::min(remaining, o->qty);
            remaining -= fill;
            o->qty -= fill;
            level.total -= fill;
            const std::uint64_t trade_id = (std::uint64_t(symbol_) + 1) << 40 | next_trade_++;
            ref_price_ = best;

            Event e{};
            e.type = EventType::Fill;
            e.symbol = symbol_;
            e.price = best;
            e.qty = fill;
            e.trade_id = trade_id;

            e.side = in.side;
            e.session = in.session;
            e.account = in.account;
            e.order_id = in.id;
            e.cl_ord_id = in.cl_ord_id;
            e.leaves = remaining;
            out.push_back(e);

            e.side = o->side;
            e.session = o->session;
            e.account = o->account;
            e.order_id = o->id;
            e.cl_ord_id = o->cl_ord_id;
            e.leaves = o->qty;
            out.push_back(e);

            Event t{};
            t.type = EventType::Trade;
            t.side = in.side;
            t.symbol = symbol_;
            t.price = best;
            t.qty = fill;
            t.trade_id = trade_id;
            out.push_back(t);

            emit_delta(opp, best, out);

            Order* next = o->next;
            if (o->qty == 0) {
                unlink(o);
                by_id_.erase(o->id);
                pool_.release(o);
            }
            o = next;
        }
    }

    if (remaining == 0) return;
    if (self_trade) return cancelled(CancelReason::SelfTrade, remaining);
    if (!in.can_rest) return cancelled(CancelReason::Unfilled, remaining);

    Order* o = pool_.acquire();
    if (!o) return cancelled(CancelReason::BookFull, remaining);
    *o = Order{in.id,   in.cl_ord_id,   in.limit, 0,     remaining, in.account, in.session,
               in.side, OrdType::Limit, TIF::GTC, false, nullptr,   nullptr};
    link(o);
    by_id_.insert(o->id, o);
    emit_delta(in.side, in.limit, out);
}

void OrderBook::on_cancel(const Command& cmd, std::vector<Event>& out) {
    Order* o = by_id_.find(cmd.order_id);
    if (!o) return reject(cmd, RejectReason::UnknownOrder, out);
    if (o->account != cmd.account) return reject(cmd, RejectReason::NotOwner, out);

    Event e{};
    e.type = EventType::Cancelled;
    e.side = o->side;
    e.reason = std::uint8_t(CancelReason::User);
    e.symbol = symbol_;
    e.session = o->session;
    e.account = o->account;
    e.order_id = o->id;
    e.cl_ord_id = o->cl_ord_id;
    e.price = o->price;
    e.qty = o->qty;
    out.push_back(e);

    if (o->waiting) {
        unlink_stop(o);
        by_id_.erase(o->id);
        pool_.release(o);
        return;
    }
    const Side side = o->side;
    const Price price = o->price;
    unlink(o);
    by_id_.erase(o->id);
    pool_.release(o);
    emit_delta(side, price, out);
}

void OrderBook::on_replace(const Command& cmd, std::vector<Event>& out) {
    if (cmd.qty == 0) return reject(cmd, RejectReason::InvalidQty, out);
    if (cmd.qty > cfg_.max_order_qty) return reject(cmd, RejectReason::MaxQtyExceeded, out);
    if (auto r = check_price(cmd.price); r != RejectReason::None) return reject(cmd, r, out);
    Order* o = by_id_.find(cmd.order_id);
    if (!o) return reject(cmd, RejectReason::UnknownOrder, out);
    if (o->account != cmd.account) return reject(cmd, RejectReason::NotOwner, out);
    // Waiting stops can't be amended; cancel and send a new one.
    if (o->waiting) return reject(cmd, RejectReason::InvalidField, out);

    Event e{};
    e.type = EventType::Replaced;
    e.side = o->side;
    e.symbol = symbol_;
    e.session = o->session;
    e.account = o->account;
    e.order_id = o->id;
    e.cl_ord_id = cmd.cl_ord_id;
    e.price = cmd.price;
    e.qty = cmd.qty;
    e.leaves = cmd.qty;

    // Shrinking an order at the same price keeps its place in the queue.
    // Anything else is a cancel and a fresh order at the back of the queue.
    if (cmd.price == o->price && cmd.qty <= o->qty) {
        levels(o->side)[o->price].total -= o->qty - cmd.qty;
        o->qty = cmd.qty;
        o->cl_ord_id = cmd.cl_ord_id;
        out.push_back(e);
        emit_delta(o->side, o->price, out);
        return;
    }

    Incoming in{o->id, cmd.cl_ord_id, o->session, o->account, o->side, cmd.price, cmd.qty, true, false};
    const Price old_price = o->price;
    unlink(o);
    by_id_.erase(o->id);
    pool_.release(o);
    out.push_back(e);
    emit_delta(in.side, old_price, out);
    execute(in, out);
    run_stops(out);
}

void OrderBook::on_snapshot(const Command& cmd, std::vector<Event>& out) {
    Event e{};
    e.type = EventType::SnapshotLevel;
    e.symbol = symbol_;
    e.session = cmd.session;

    e.side = Side::Buy;
    for (Price p = best_bid_; p > 0;) {
        e.price = p;
        e.level_qty = bids_[p].total;
        out.push_back(e);
        std::int64_t nxt = bid_tree_.find_prev(std::size_t(p - 1));
        p = nxt < 0 ? 0 : nxt;
    }
    e.side = Side::Sell;
    for (Price p = best_ask_; p > 0;) {
        e.price = p;
        e.level_qty = asks_[p].total;
        out.push_back(e);
        std::int64_t nxt = ask_tree_.find_next(std::size_t(p + 1));
        p = nxt < 0 ? 0 : nxt;
    }

    Event end{};
    end.type = EventType::SnapshotEnd;
    end.symbol = symbol_;
    end.session = cmd.session;
    end.price = ref_price_;
    out.push_back(end);
}

void OrderBook::link(Order* o) {
    Level& l = levels(o->side)[o->price];
    o->prev = l.tail;
    o->next = nullptr;
    if (l.tail)
        l.tail->next = o;
    else {
        l.head = o;
        tree(o->side).set(std::size_t(o->price));
    }
    l.tail = o;
    l.total += o->qty;

    if (o->side == Side::Buy) {
        if (o->price > best_bid_) best_bid_ = o->price;
    } else if (best_ask_ == 0 || o->price < best_ask_) {
        best_ask_ = o->price;
    }
}

void OrderBook::unlink(Order* o) {
    Level& l = levels(o->side)[o->price];
    (o->prev ? o->prev->next : l.head) = o->next;
    (o->next ? o->next->prev : l.tail) = o->prev;
    l.total -= o->qty;
    if (l.head) return;

    BitTree& t = tree(o->side);
    t.clear(std::size_t(o->price));
    if (o->side == Side::Buy && o->price == best_bid_) {
        std::int64_t p = t.find_prev(std::size_t(o->price));
        best_bid_ = p < 0 ? 0 : p;
    } else if (o->side == Side::Sell && o->price == best_ask_) {
        std::int64_t p = t.find_next(std::size_t(o->price));
        best_ask_ = p < 0 ? 0 : p;
    }
}

void OrderBook::link_stop(Order* o) {
    const bool buy = o->side == Side::Buy;
    Level& l = (buy ? buy_stops_ : sell_stops_)[o->stop_price];
    o->prev = l.tail;
    o->next = nullptr;
    if (l.tail)
        l.tail->next = o;
    else {
        l.head = o;
        (buy ? buy_stop_tree_ : sell_stop_tree_).set(std::size_t(o->stop_price));
    }
    l.tail = o;
}

void OrderBook::unlink_stop(Order* o) {
    const bool buy = o->side == Side::Buy;
    Level& l = (buy ? buy_stops_ : sell_stops_)[o->stop_price];
    (o->prev ? o->prev->next : l.head) = o->next;
    (o->next ? o->next->prev : l.tail) = o->prev;
    if (!l.head) (buy ? buy_stop_tree_ : sell_stop_tree_).clear(std::size_t(o->stop_price));
}

void OrderBook::emit_delta(Side side, Price price, std::vector<Event>& out) const {
    Event e{};
    e.type = EventType::BookDelta;
    e.side = side;
    e.symbol = symbol_;
    e.price = price;
    e.level_qty = levels(side)[price].total;
    out.push_back(e);
}

}  // namespace ticker
