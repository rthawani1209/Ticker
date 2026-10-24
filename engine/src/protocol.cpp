#include "ticker/protocol.hpp"

namespace ticker::wire {

std::size_t message_size(MsgType t) {
    switch (t) {
        case MsgType::Logon: return sizeof(Logon);
        case MsgType::NewOrder: return sizeof(NewOrder);
        case MsgType::Cancel: return sizeof(Cancel);
        case MsgType::Replace: return sizeof(Replace);
        case MsgType::Subscribe:
        case MsgType::Halt:
        case MsgType::Resume: return sizeof(SymbolMsg);
        case MsgType::LogonAck: return sizeof(LogonAck);
        case MsgType::EventMsg: return sizeof(EventMsg);
        case MsgType::Stats: return sizeof(Stats);
        case MsgType::Error: return sizeof(Error);
    }
    return 0;
}

Parse peek(const std::uint8_t* buf, std::size_t n, Header& h) {
    if (n < sizeof(Header)) return Parse::NeedMore;
    std::memcpy(&h, buf, sizeof h);
    // Check the header before waiting for more bytes, so garbage is rejected
    // right away instead of stalling the connection.
    std::size_t want = message_size(h.type);
    if (want == 0 || h.length != want || h.version != kVersion) return Parse::Bad;
    if (n < want) return Parse::NeedMore;
    return Parse::Ok;
}

}  // namespace ticker::wire
