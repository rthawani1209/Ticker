// A deliberately simple order book used only to check the real one.
//
// Same rules, same events, none of the performance tricks: std::map for price levels,
// std::list for the queue at each level, and linear scans wherever that's easier to
// read. If the fast book and this one ever disagree, one of them has a bug.
#pragma once

#include <algorithm>
#include <cstdlib>
#include <list>
#include <map>
#include <vector>

#include "ticker/config.hpp"
#include "ticker/types.hpp"

namespace ticker::testing {

class ReferenceBook {
public:
    ReferenceBook(SymbolId symbol, const SymbolConfig& cfg)
        : symbol_(symbol), cfg_(cfg), ref_(cfg.ref_price), anchor_(cfg.ref_price) {}

    void process(const Command& c, std::vector<Event>& out) {
        now_ = c.ts;
        if (halted_ && now_ >= halt_until_) resume(out);
        if (!halted_ && now_ >= anchor_ts_ + cfg_.circuit_window_ns) {
            anchor_ = ref_;
            anchor_ts_ = now_;
        }
        if (c.type == CmdType::Halt) {
            if (!halted_) halt(UINT64_MAX, out);
            halt_until_ = UINT64_MAX;
            return;
        }
        if (c.type == CmdType::Resume) {
            if (halted_) resume(out);
            return;
        }
        if (halted_ && (c.type == CmdType::New || c.type == CmdType::Replace))
            return reject(c, RejectReason::Halted, out);
        if (c.type == CmdType::New) return on_new(c, out);
        if (c.type == CmdType::Cancel) return on_cancel(c, out);
        if (c.type == CmdType::Replace) return on_replace(c, out);
        if (c.type == CmdType::Snapshot) return on_snapshot(c, out);
        reject(c, RejectReason::InvalidField, out);
    }

    std::size_t order_count() const {
        std::size_t n = 0;
        for (auto& [p, q] : bids_) n += q.size();
        for (auto& [p, q] : asks_) n += q.size();
        return n + stops_.size();
    }

private:
    struct Order {
        OrderId id;
        std::uint64_t cl;
        Price price;
        Qty qty;
        AccountId account;
        SessionId session;
        Side side;
    };
    using Queue = std::list<Order>;

    struct Stop {
        Order o;
        Price stop;
        OrdType type;
        TIF tif;
    };

    bool trips(Price p) const {
        return cfg_.circuit_bps && std::abs(p - anchor_) * 10'000 > anchor_ * Price(cfg_.circuit_bps);
    }

    void halt(std::uint64_t until, std::vector<Event>& out) {
        halted_ = true;
        halt_until_ = until;
        Event e{};
        e.type = EventType::TradingStatus;
        e.symbol = symbol_;
        e.reason = 1;
        e.price = ref_;
        e.level_qty = until == UINT64_MAX ? 0 : until;
        out.push_back(e);
    }

    void resume(std::vector<Event>& out) {
        halted_ = false;
        anchor_ = ref_;
        anchor_ts_ = now_;
        Event e{};
        e.type = EventType::TradingStatus;
        e.symbol = symbol_;
        e.price = ref_;
        out.push_back(e);
    }

    std::map<Price, Queue>& side_map(Side s) { return s == Side::Buy ? bids_ : asks_; }

    std::uint64_t level_total(Side s, Price p) {
        auto& m = side_map(s);
        auto it = m.find(p);
        if (it == m.end()) return 0;
        std::uint64_t t = 0;
        for (auto& o : it->second) t += o.qty;
        return t;
    }

    // Opposite-side prices in matching order (best first).
    std::vector<Price> prices_to_match(Side taker) {
        std::vector<Price> ps;
        if (taker == Side::Buy)
            for (auto& [p, q] : asks_) ps.push_back(p);
        else
            for (auto it = bids_.rbegin(); it != bids_.rend(); ++it) ps.push_back(it->first);
        return ps;
    }

    static bool crosses(Side taker, Price limit, Price p) { return taker == Side::Buy ? p <= limit : p >= limit; }

    RejectReason check_price(Price p) const {
        if (p < 1 || p >= cfg_.max_price) return RejectReason::InvalidPrice;
        if (std::abs(p - ref_) * 10'000 > ref_ * Price(cfg_.band_bps)) return RejectReason::PriceBand;
        return RejectReason::None;
    }

    void reject(const Command& c, RejectReason r, std::vector<Event>& out) {
        Event e{};
        e.type = EventType::Reject;
        e.side = c.side;
        e.reason = std::uint8_t(r);
        e.symbol = c.symbol;
        e.session = c.session;
        e.account = c.account;
        e.order_id = c.order_id;
        e.cl_ord_id = c.cl_ord_id;
        out.push_back(e);
    }

    void delta(Side s, Price p, std::vector<Event>& out) {
        Event e{};
        e.type = EventType::BookDelta;
        e.side = s;
        e.symbol = symbol_;
        e.price = p;
        e.level_qty = level_total(s, p);
        out.push_back(e);
    }

    void on_new(const Command& c, std::vector<Event>& out) {
        if (std::uint8_t(c.side) > 1 || std::uint8_t(c.ord_type) > 3 || std::uint8_t(c.tif) > 2)
            return reject(c, RejectReason::InvalidField, out);
        if (c.qty == 0) return reject(c, RejectReason::InvalidQty, out);
        if (c.qty > cfg_.max_order_qty) return reject(c, RejectReason::MaxQtyExceeded, out);
        bool is_stop = c.ord_type == OrdType::Stop || c.ord_type == OrdType::StopLimit;
        bool has_limit = c.ord_type == OrdType::Limit || c.ord_type == OrdType::StopLimit;
        if (has_limit) {
            if (auto r = check_price(c.price); r != RejectReason::None) return reject(c, r, out);
        }
        if (is_stop) {
            if (c.stop_price < 1 || c.stop_price >= cfg_.max_price) return reject(c, RejectReason::InvalidPrice, out);
            if (c.side == Side::Buy ? c.stop_price <= ref_ : c.stop_price >= ref_)
                return reject(c, RejectReason::StopPriceCrossed, out);
        }
        OrderId id = (OrderId(symbol_) + 1) << 40 | seq_++;

        Event ack{};
        ack.type = EventType::Ack;
        ack.side = c.side;
        ack.symbol = symbol_;
        ack.session = c.session;
        ack.account = c.account;
        ack.order_id = id;
        ack.cl_ord_id = c.cl_ord_id;
        ack.price = has_limit ? c.price : 0;
        ack.qty = c.qty;
        ack.leaves = c.qty;
        out.push_back(ack);

        Order o{id, c.cl_ord_id, has_limit ? c.price : market_limit(c.side), c.qty, c.account, c.session, c.side};
        if (is_stop) {
            if (order_count() >= cfg_.max_orders) {
                Event e{};
                e.type = EventType::Cancelled;
                e.side = c.side;
                e.reason = std::uint8_t(CancelReason::BookFull);
                e.symbol = symbol_;
                e.session = c.session;
                e.account = c.account;
                e.order_id = id;
                e.cl_ord_id = c.cl_ord_id;
                e.price = c.price;
                e.qty = c.qty;
                out.push_back(e);
                return;
            }
            o.price = c.price;
            stops_.push_back({o, c.stop_price, c.ord_type, c.tif});
            return;
        }
        execute(o, c.ord_type == OrdType::Limit && c.tif == TIF::GTC, c.tif == TIF::FOK, out);
        run_stops(out);
    }

    Price market_limit(Side side) const {
        Price band = ref_ * Price(cfg_.band_bps) / 10'000;
        return side == Side::Buy ? std::min(cfg_.max_price - 1, ref_ + band) : std::max<Price>(1, ref_ - band);
    }

    void run_stops(std::vector<Event>& out) {
        while (!halted_) {
            // Lowest triggered buy stop first, then highest triggered sell stop; ties by arrival.
            auto pick = stops_.end();
            for (auto it = stops_.begin(); it != stops_.end(); ++it)
                if (it->o.side == Side::Buy && it->stop <= ref_ && (pick == stops_.end() || it->stop < pick->stop))
                    pick = it;
            if (pick == stops_.end())
                for (auto it = stops_.begin(); it != stops_.end(); ++it)
                    if (it->o.side == Side::Sell && it->stop >= ref_ && (pick == stops_.end() || it->stop > pick->stop))
                        pick = it;
            if (pick == stops_.end()) return;

            Stop st = *pick;
            stops_.erase(pick);
            Event e{};
            e.type = EventType::Triggered;
            e.side = st.o.side;
            e.symbol = symbol_;
            e.session = st.o.session;
            e.account = st.o.account;
            e.order_id = st.o.id;
            e.cl_ord_id = st.o.cl;
            e.price = st.stop;
            e.qty = st.o.qty;
            e.leaves = st.o.qty;
            out.push_back(e);

            bool limit = st.type == OrdType::StopLimit;
            if (!limit) st.o.price = market_limit(st.o.side);
            execute(st.o, limit && st.tif == TIF::GTC, st.tif == TIF::FOK, out);
        }
    }

    void execute(Order in, bool can_rest, bool fok, std::vector<Event>& out) {
        auto cancel_in = [&](CancelReason r, Qty q) {
            Event e{};
            e.type = EventType::Cancelled;
            e.side = in.side;
            e.reason = std::uint8_t(r);
            e.symbol = symbol_;
            e.session = in.session;
            e.account = in.account;
            e.order_id = in.id;
            e.cl_ord_id = in.cl;
            e.price = in.price;
            e.qty = q;
            out.push_back(e);
        };

        Side opp = in.side == Side::Buy ? Side::Sell : Side::Buy;
        auto& book = side_map(opp);

        if (fok) {
            std::uint64_t have = 0;
            bool blocked = false;
            for (Price p : prices_to_match(in.side)) {
                if (!crosses(in.side, in.price, p) || blocked || have >= in.qty) break;
                if (trips(p)) break;
                for (auto& o : book[p]) {
                    if (o.account == in.account) {
                        blocked = true;
                        break;
                    }
                    have += o.qty;
                    if (have >= in.qty) break;
                }
            }
            if (have < in.qty) return cancel_in(CancelReason::FokUnfillable, in.qty);
        }

        bool self_trade = false;
        for (Price p : prices_to_match(in.side)) {
            if (in.qty == 0 || self_trade || !crosses(in.side, in.price, p)) break;
            if (trips(p)) {
                halt(now_ + cfg_.halt_ns, out);
                break;
            }
            Queue& q = book[p];
            while (!q.empty() && in.qty > 0) {
                Order& rest = q.front();
                if (rest.account == in.account) {
                    self_trade = true;
                    break;
                }
                Qty fill = std::min(in.qty, rest.qty);
                in.qty -= fill;
                rest.qty -= fill;
                std::uint64_t tid = (std::uint64_t(symbol_) + 1) << 40 | trade_seq_++;
                ref_ = p;

                Event f{};
                f.type = EventType::Fill;
                f.symbol = symbol_;
                f.price = p;
                f.qty = fill;
                f.trade_id = tid;
                f.side = in.side;
                f.session = in.session;
                f.account = in.account;
                f.order_id = in.id;
                f.cl_ord_id = in.cl;
                f.leaves = in.qty;
                out.push_back(f);
                f.side = rest.side;
                f.session = rest.session;
                f.account = rest.account;
                f.order_id = rest.id;
                f.cl_ord_id = rest.cl;
                f.leaves = rest.qty;
                out.push_back(f);

                Event t{};
                t.type = EventType::Trade;
                t.side = in.side;
                t.symbol = symbol_;
                t.price = p;
                t.qty = fill;
                t.trade_id = tid;
                out.push_back(t);

                if (rest.qty == 0) q.pop_front();
                if (q.empty()) book.erase(p);
                delta(opp, p, out);
                if (!book.count(p)) break;
            }
        }

        if (in.qty == 0) return;
        if (halted_) return cancel_in(CancelReason::Halted, in.qty);
        if (self_trade) return cancel_in(CancelReason::SelfTrade, in.qty);
        if (!can_rest) return cancel_in(CancelReason::Unfilled, in.qty);
        if (order_count() >= cfg_.max_orders) return cancel_in(CancelReason::BookFull, in.qty);
        side_map(in.side)[in.price].push_back(in);
        delta(in.side, in.price, out);
    }

    // Finds an order by id. Returns false if it isn't resting.
    bool find(OrderId id, Side& side, Price& price, Queue::iterator& it) {
        for (Side s : {Side::Buy, Side::Sell})
            for (auto& [p, q] : side_map(s))
                for (auto i = q.begin(); i != q.end(); ++i)
                    if (i->id == id) {
                        side = s;
                        price = p;
                        it = i;
                        return true;
                    }
        return false;
    }

    void remove(Side s, Price p, Queue::iterator it) {
        auto& m = side_map(s);
        m[p].erase(it);
        if (m[p].empty()) m.erase(p);
    }

    std::list<Stop>::iterator find_stop(OrderId id) {
        return std::find_if(stops_.begin(), stops_.end(), [&](const Stop& s) { return s.o.id == id; });
    }

    void on_cancel(const Command& c, std::vector<Event>& out) {
        if (auto st = find_stop(c.order_id); st != stops_.end()) {
            if (st->o.account != c.account) return reject(c, RejectReason::NotOwner, out);
            Event e{};
            e.type = EventType::Cancelled;
            e.side = st->o.side;
            e.reason = std::uint8_t(CancelReason::User);
            e.symbol = symbol_;
            e.session = st->o.session;
            e.account = st->o.account;
            e.order_id = st->o.id;
            e.cl_ord_id = st->o.cl;
            e.price = st->o.price;
            e.qty = st->o.qty;
            out.push_back(e);
            stops_.erase(st);
            return;
        }
        Side s;
        Price p;
        Queue::iterator it;
        if (!find(c.order_id, s, p, it)) return reject(c, RejectReason::UnknownOrder, out);
        if (it->account != c.account) return reject(c, RejectReason::NotOwner, out);
        Event e{};
        e.type = EventType::Cancelled;
        e.side = s;
        e.reason = std::uint8_t(CancelReason::User);
        e.symbol = symbol_;
        e.session = it->session;
        e.account = it->account;
        e.order_id = it->id;
        e.cl_ord_id = it->cl;
        e.price = p;
        e.qty = it->qty;
        out.push_back(e);
        remove(s, p, it);
        delta(s, p, out);
    }

    void on_replace(const Command& c, std::vector<Event>& out) {
        if (c.qty == 0) return reject(c, RejectReason::InvalidQty, out);
        if (c.qty > cfg_.max_order_qty) return reject(c, RejectReason::MaxQtyExceeded, out);
        if (auto r = check_price(c.price); r != RejectReason::None) return reject(c, r, out);
        if (auto st = find_stop(c.order_id); st != stops_.end()) {
            if (st->o.account != c.account) return reject(c, RejectReason::NotOwner, out);
            return reject(c, RejectReason::InvalidField, out);
        }
        Side s;
        Price p;
        Queue::iterator it;
        if (!find(c.order_id, s, p, it)) return reject(c, RejectReason::UnknownOrder, out);
        if (it->account != c.account) return reject(c, RejectReason::NotOwner, out);

        Event e{};
        e.type = EventType::Replaced;
        e.side = s;
        e.symbol = symbol_;
        e.session = it->session;
        e.account = it->account;
        e.order_id = it->id;
        e.cl_ord_id = c.cl_ord_id;
        e.price = c.price;
        e.qty = c.qty;
        e.leaves = c.qty;

        if (c.price == p && c.qty <= it->qty) {
            it->qty = c.qty;
            it->cl = c.cl_ord_id;
            out.push_back(e);
            delta(s, p, out);
            return;
        }
        Order moved = *it;
        moved.cl = c.cl_ord_id;
        moved.price = c.price;
        moved.qty = c.qty;
        remove(s, p, it);
        out.push_back(e);
        delta(s, p, out);
        execute(moved, true, false, out);
        run_stops(out);
    }

    void on_snapshot(const Command& c, std::vector<Event>& out) {
        Event e{};
        e.type = EventType::SnapshotLevel;
        e.symbol = symbol_;
        e.session = c.session;
        e.side = Side::Buy;
        for (auto it = bids_.rbegin(); it != bids_.rend(); ++it) {
            e.price = it->first;
            e.level_qty = level_total(Side::Buy, it->first);
            out.push_back(e);
        }
        e.side = Side::Sell;
        for (auto& [p, q] : asks_) {
            e.price = p;
            e.level_qty = level_total(Side::Sell, p);
            out.push_back(e);
        }
        Event end{};
        end.type = EventType::SnapshotEnd;
        end.symbol = symbol_;
        end.session = c.session;
        end.price = ref_;
        out.push_back(end);
    }

    SymbolId symbol_;
    SymbolConfig cfg_;
    Price ref_;
    std::map<Price, Queue> bids_;
    std::map<Price, Queue> asks_;
    std::list<Stop> stops_;  // arrival order
    std::uint64_t now_ = 0;
    bool halted_ = false;
    std::uint64_t halt_until_ = 0;
    Price anchor_;
    std::uint64_t anchor_ts_ = 0;
    std::uint64_t seq_ = 1;
    std::uint64_t trade_seq_ = 1;
};

}  // namespace ticker::testing
