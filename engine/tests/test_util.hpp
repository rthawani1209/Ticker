#pragma once

#include <vector>

#include "ticker/types.hpp"

namespace ticker::testing {

inline Command limit(Side side, Price price, Qty qty, AccountId account = 1, TIF tif = TIF::GTC,
                     std::uint64_t cl = 0) {
    Command c{};
    c.type = CmdType::New;
    c.side = side;
    c.ord_type = OrdType::Limit;
    c.tif = tif;
    c.price = price;
    c.qty = qty;
    c.account = account;
    c.session = account;
    c.cl_ord_id = cl;
    return c;
}

inline Command market(Side side, Qty qty, AccountId account = 1, TIF tif = TIF::IOC) {
    Command c = limit(side, 0, qty, account, tif);
    c.ord_type = OrdType::Market;
    return c;
}

inline Command cancel(OrderId id, AccountId account = 1) {
    Command c{};
    c.type = CmdType::Cancel;
    c.order_id = id;
    c.account = account;
    c.session = account;
    return c;
}

inline Command replace(OrderId id, Price price, Qty qty, AccountId account = 1) {
    Command c{};
    c.type = CmdType::Replace;
    c.order_id = id;
    c.price = price;
    c.qty = qty;
    c.account = account;
    c.session = account;
    return c;
}

inline std::vector<Event> of_type(const std::vector<Event>& evs, EventType t) {
    std::vector<Event> r;
    for (auto& e : evs)
        if (e.type == t) r.push_back(e);
    return r;
}

}  // namespace ticker::testing
