// Binary wire protocol between clients (the Node gateway, bots, the load generator)
// and the engine server.
//
// Every message starts with a 4-byte header and has a fixed size per type. Fields
// are little-endian and naturally aligned, with explicit padding, so encoding is a
// memcpy. See docs/protocol.md for the full table.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "ticker/types.hpp"

namespace ticker::wire {

constexpr std::uint8_t kVersion = 1;

enum class MsgType : std::uint8_t {
    // client -> server
    Logon = 1,
    NewOrder = 2,
    Cancel = 3,
    Replace = 4,
    Subscribe = 5,  // ask for a snapshot of one symbol; also turns on market data
    Halt = 6,       // admin only
    Resume = 7,     // admin only

    // server -> client
    LogonAck = 64,
    EventMsg = 65,
    Stats = 66,
    Error = 67,
};

// Logon flags
constexpr std::uint32_t kMarketData = 1;  // receive public trades and book updates
constexpr std::uint32_t kProxy = 2;       // may send orders for any account (the web gateway, the bot simulator)
constexpr std::uint32_t kAdmin = 4;       // may halt and resume symbols

enum class ErrorCode : std::uint32_t {
    BadMessage = 1,
    NotLoggedIn = 2,
    AlreadyLoggedIn = 3,
    BadToken = 4,
    NotAllowed = 5,
    SlowConsumer = 6,
};

struct Header {
    std::uint16_t length;  // whole message, header included
    MsgType type;
    std::uint8_t version;
};

struct Logon {
    Header h;
    AccountId account;
    std::uint32_t flags;
    std::uint32_t pad;
    std::uint64_t token;  // required for proxy/admin when the server has a token set
};

struct NewOrder {
    Header h;
    AccountId account;  // ignored unless the session is a proxy
    std::uint64_t cl_ord_id;
    SymbolId symbol;
    Side side;
    OrdType ord_type;
    TIF tif;
    std::uint8_t pad;
    Price price;
    Price stop_price;
    Qty qty;
    std::uint32_t pad2;
};

struct Cancel {
    Header h;
    AccountId account;
    std::uint64_t cl_ord_id;
    OrderId order_id;
    SymbolId symbol;
    std::uint32_t pad;
};

struct Replace {
    Header h;
    AccountId account;
    std::uint64_t cl_ord_id;
    OrderId order_id;
    SymbolId symbol;
    Qty qty;
    Price price;
};

// Subscribe, Halt and Resume all carry just a symbol.
struct SymbolMsg {
    Header h;
    SymbolId symbol;
};

struct LogonAck {
    Header h;
    SessionId session;
    std::uint32_t flags;
    std::uint32_t symbols;  // symbol ids are 0..symbols-1
};

struct EventMsg {
    Header h;
    std::uint32_t pad;
    Event event;
};

// Sent to market-data sessions about once a second per matching thread.
// Latency is measured from when the server decoded the order to when the
// matching thread finished with it.
struct Stats {
    Header h;
    std::uint32_t shard;
    std::uint64_t commands;
    std::uint64_t p50_ns;
    std::uint64_t p99_ns;
    std::uint64_t p999_ns;
    std::uint64_t max_ns;
};

struct Error {
    Header h;
    ErrorCode code;
};

static_assert(sizeof(Header) == 4);
static_assert(sizeof(Logon) == 24);
static_assert(sizeof(NewOrder) == 48);
static_assert(sizeof(Cancel) == 32);
static_assert(sizeof(Replace) == 40);
static_assert(sizeof(SymbolMsg) == 8);
static_assert(sizeof(LogonAck) == 16);
static_assert(sizeof(EventMsg) == 72);
static_assert(sizeof(Stats) == 48);
static_assert(sizeof(Error) == 8);

constexpr std::size_t kMaxMessage = sizeof(EventMsg);

// Size of a message type, or 0 if the type is unknown.
std::size_t message_size(MsgType t);

enum class Parse { Ok, NeedMore, Bad };

// Checks the front of `buf` for one complete, well-formed message. On Ok, `h` is its
// header and h.length bytes can be consumed.
Parse peek(const std::uint8_t* buf, std::size_t n, Header& h);

template <typename T>
T make(MsgType type) {
    T m{};
    m.h.length = sizeof(T);
    m.h.type = type;
    m.h.version = kVersion;
    return m;
}

template <typename T>
T read_as(const std::uint8_t* buf) {
    T m;
    std::memcpy(&m, buf, sizeof m);
    return m;
}

}  // namespace ticker::wire
