// Checks that the book never touches the heap while processing orders. Lives in its
// own binary because it replaces the global operator new.
#include <gtest/gtest.h>

#include <atomic>
#include <cstdlib>
#include <new>

#include "order_flow.hpp"
#include "ticker/order_book.hpp"

namespace {
std::atomic<std::size_t> g_allocs{0};
}

void* operator new(std::size_t n) {
    ++g_allocs;
    if (void* p = std::malloc(n ? n : 1)) return p;
    throw std::bad_alloc();
}
// gcc can't tell these pair with the operator new above and warns about a mismatch.
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wmismatched-new-delete"
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
#pragma GCC diagnostic pop

using namespace ticker;

TEST(NoAlloc, HotPathDoesNotAllocate) {
    SymbolConfig cfg;
    cfg.max_orders = 1 << 14;
    std::vector<Event> out;
    out.reserve(1 << 16);

    // The generator allocates (it tracks live orders), so record its commands
    // first using a scratch book, then replay them into a fresh book and count.
    std::vector<Command> cmds;
    cmds.reserve(300'000);
    {
        ticker::testing::OrderFlow flow(9, cfg, false);
        OrderBook scratch(0, cfg);
        for (int i = 0; i < 300'000; ++i) {
            cmds.push_back(flow.next());
            out.clear();
            scratch.process(cmds.back(), out);
            flow.observe(out);
        }
    }

    OrderBook book(0, cfg);
    std::size_t before = g_allocs.load();
    std::size_t trades = 0;
    for (const auto& c : cmds) {
        out.clear();
        book.process(c, out);
        for (auto& e : out) trades += e.type == EventType::Trade;
    }
    EXPECT_EQ(g_allocs.load() - before, 0u);
    EXPECT_GT(trades, 1000u);
}
