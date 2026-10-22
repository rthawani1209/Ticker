#include "ticker/engine.hpp"

namespace ticker {

Engine::Engine(const std::vector<SymbolConfig>& symbols) {
    books_.reserve(symbols.size());
    for (SymbolId i = 0; i < symbols.size(); ++i) books_.push_back(std::make_unique<OrderBook>(i, symbols[i]));
}

void Engine::process(const Command& cmd, std::vector<Event>& out) {
    if (cmd.symbol < books_.size()) return books_[cmd.symbol]->process(cmd, out);

    Event e{};
    e.type = EventType::Reject;
    e.side = cmd.side;
    e.reason = std::uint8_t(RejectReason::UnknownSymbol);
    e.symbol = cmd.symbol;
    e.session = cmd.session;
    e.account = cmd.account;
    e.order_id = cmd.order_id;
    e.cl_ord_id = cmd.cl_ord_id;
    out.push_back(e);
}

}  // namespace ticker
