#pragma once

#include <memory>
#include <vector>

#include "ticker/config.hpp"
#include "ticker/order_book.hpp"

namespace ticker {

// Routes commands to the right symbol's book. Single-threaded and deterministic:
// the same commands in the same order always produce the same events.
class Engine {
public:
    explicit Engine(const std::vector<SymbolConfig>& symbols);

    void process(const Command& cmd, std::vector<Event>& out);

    OrderBook& book(SymbolId id) { return *books_[id]; }
    std::size_t symbol_count() const { return books_.size(); }

private:
    std::vector<std::unique_ptr<OrderBook>> books_;
};

}  // namespace ticker
