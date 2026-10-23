#pragma once

#include <string>
#include <vector>

#include "ticker/types.hpp"

namespace ticker {

// Per-symbol trading rules. Valid limit prices are [1, max_price) ticks.
struct SymbolConfig {
    std::string name;
    Price max_price = 1 << 16;
    Price ref_price = 10'000;        // $100.00, used for price bands until the first trade
    std::uint32_t band_bps = 1'000;  // reject limits more than 10% away from the reference
    Qty max_order_qty = 100'000;
    std::uint32_t max_orders = 1 << 16;  // pool size, allocated up front

    // Circuit breaker: halt if a trade would move the price more than circuit_bps
    // from where it was at the start of the current window. 0 turns it off.
    std::uint32_t circuit_bps = 1'500;
    std::uint64_t circuit_window_ns = 300'000'000'000;  // 5 minutes
    std::uint64_t halt_ns = 300'000'000'000;
};

std::vector<SymbolConfig> default_symbols();

}  // namespace ticker
