#include "ticker/config.hpp"
#include "ticker/types.hpp"

namespace ticker {

std::string_view to_string(EventType t) {
    switch (t) {
        case EventType::Ack: return "Ack";
        case EventType::Reject: return "Reject";
        case EventType::Fill: return "Fill";
        case EventType::Cancelled: return "Cancelled";
        case EventType::Replaced: return "Replaced";
        case EventType::Trade: return "Trade";
        case EventType::BookDelta: return "BookDelta";
        case EventType::SnapshotLevel: return "SnapshotLevel";
        case EventType::SnapshotEnd: return "SnapshotEnd";
    }
    return "?";
}

std::string_view to_string(RejectReason r) {
    switch (r) {
        case RejectReason::None: return "None";
        case RejectReason::UnknownSymbol: return "UnknownSymbol";
        case RejectReason::InvalidQty: return "InvalidQty";
        case RejectReason::InvalidPrice: return "InvalidPrice";
        case RejectReason::MaxQtyExceeded: return "MaxQtyExceeded";
        case RejectReason::PriceBand: return "PriceBand";
        case RejectReason::UnknownOrder: return "UnknownOrder";
        case RejectReason::NotOwner: return "NotOwner";
        case RejectReason::InvalidField: return "InvalidField";
    }
    return "?";
}

std::string_view to_string(CancelReason r) {
    switch (r) {
        case CancelReason::User: return "User";
        case CancelReason::Unfilled: return "Unfilled";
        case CancelReason::FokUnfillable: return "FokUnfillable";
        case CancelReason::SelfTrade: return "SelfTrade";
        case CancelReason::BookFull: return "BookFull";
    }
    return "?";
}

std::vector<SymbolConfig> default_symbols() {
    // Fictional companies. Starting prices in cents.
    auto sym = [](const char* name, Price ref) {
        SymbolConfig c;
        c.name = name;
        c.ref_price = ref;
        return c;
    };
    return {
        sym("NOVA", 14'000), sym("HELX", 5'800), sym("ORBT", 31'000), sym("KILN", 2'500),
        sym("VYNE", 9'700),  sym("QSTR", 1'200), sym("BRKL", 7'450), sym("MESA", 18'800),
    };
}

}  // namespace ticker
