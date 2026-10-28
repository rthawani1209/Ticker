// Plain data types shared by the engine, the reference engine and the tools.
// Padding is explicit so Commands and Events can be hashed and journaled byte-for-byte.
#pragma once

#include <cstdint>
#include <string_view>

namespace ticker {

using OrderId = std::uint64_t;
using Price = std::int64_t;  // in ticks (1 tick = $0.01)
using Qty = std::uint32_t;
using AccountId = std::uint32_t;
using SymbolId = std::uint32_t;
using SessionId = std::uint32_t;

enum class Side : std::uint8_t { Buy = 0, Sell = 1 };
// Stop orders wait off the book until the last trade reaches their stop price,
// then enter as a market (Stop) or limit (StopLimit) order.
enum class OrdType : std::uint8_t { Limit = 0, Market = 1, Stop = 2, StopLimit = 3 };
enum class TIF : std::uint8_t { GTC = 0, IOC = 1, FOK = 2 };

constexpr Side opposite(Side s) { return s == Side::Buy ? Side::Sell : Side::Buy; }

enum class RejectReason : std::uint8_t {
    None = 0,
    UnknownSymbol,
    InvalidQty,
    InvalidPrice,
    MaxQtyExceeded,
    PriceBand,
    UnknownOrder,
    NotOwner,
    InvalidField,
    Halted,
    StopPriceCrossed,  // the stop would trigger immediately
};

enum class CancelReason : std::uint8_t {
    User = 0,
    Unfilled,       // IOC/market remainder
    FokUnfillable,
    SelfTrade,
    BookFull,
    Halted,  // circuit breaker tripped while this order was matching
};

// ---- Input -------------------------------------------------------------------------

enum class CmdType : std::uint8_t { New = 0, Cancel = 1, Replace = 2, Snapshot = 3, Halt = 4, Resume = 5 };

struct Command {
    CmdType type{};
    Side side{};
    OrdType ord_type{};
    TIF tif{};
    SymbolId symbol{};
    SessionId session{};
    AccountId account{};
    std::uint64_t cl_ord_id{};
    OrderId order_id{};  // target of Cancel/Replace
    Price price{};
    Price stop_price{};
    Qty qty{};
    // Orders with the same nonzero group never trade with each other (self-trade
    // prevention across accounts, e.g. one student's portfolios in different leagues).
    // Zero means the account is the group.
    std::uint32_t stp_group{};
    // Set by the gateway when the command arrives. The engine never reads a clock,
    // so replaying a journal gives the same result.
    std::uint64_t ts{};

    friend bool operator==(const Command&, const Command&) = default;
};
static_assert(sizeof(Command) == 64);

// ---- Output ------------------------------------------------------------------------

enum class EventType : std::uint8_t {
    Ack = 0,
    Reject,
    Fill,       // one per side of a trade
    Cancelled,
    Replaced,
    Trade,      // public
    BookDelta,  // public: level at `price` now has `level_qty` resting
    SnapshotLevel,
    SnapshotEnd,
    Triggered,      // a stop order reached its stop price and is now live
    TradingStatus,  // public: reason 1 = halted, 0 = open; level_qty = resume time (ns) if known
};

struct Event {
    EventType type{};
    Side side{};
    std::uint8_t reason{};  // RejectReason or CancelReason
    std::uint8_t pad0{};
    SymbolId symbol{};
    SessionId session{};  // 0 = public market data
    AccountId account{};
    OrderId order_id{};
    std::uint64_t cl_ord_id{};
    Price price{};
    Qty qty{};
    Qty leaves{};
    std::uint64_t trade_id{};
    std::uint64_t level_qty{};

    friend bool operator==(const Event&, const Event&) = default;
};
static_assert(sizeof(Event) == 64);

std::string_view to_string(EventType t);
std::string_view to_string(RejectReason r);
std::string_view to_string(CancelReason r);

}  // namespace ticker
