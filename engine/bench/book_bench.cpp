// Microbenchmarks for the order book, run against the reference book as a baseline.
#include <benchmark/benchmark.h>

#include "order_flow.hpp"
#include "reference_book.hpp"
#include "test_util.hpp"
#include "ticker/order_book.hpp"

using namespace ticker;
using namespace ticker::testing;

namespace {

SymbolConfig bench_cfg() {
    SymbolConfig c;
    c.ref_price = 10'000;
    c.circuit_bps = 0;
    return c;
}

std::vector<Command> make_flow(std::size_t n, std::uint64_t seed = 42) {
    // Run the flow through a real book once so cancels/replaces point at live orders.
    OrderFlow flow(seed, bench_cfg(), false);
    OrderBook book(0, bench_cfg());
    std::vector<Command> cmds;
    std::vector<Event> out;
    cmds.reserve(n);
    for (std::size_t i = 0; i < n; ++i) {
        cmds.push_back(flow.next());
        out.clear();
        book.process(cmds.back(), out);
        flow.observe(out);
    }
    return cmds;
}

template <typename Book>
void BM_MixedFlow(benchmark::State& state) {
    static const auto cmds = make_flow(200'000);
    std::vector<Event> out;
    out.reserve(4096);
    for (auto _ : state) {
        state.PauseTiming();
        auto book = std::make_unique<Book>(0, bench_cfg());
        state.ResumeTiming();
        for (const auto& c : cmds) {
            out.clear();
            book->process(c, out);
        }
        benchmark::DoNotOptimize(out.data());
    }
    state.SetItemsProcessed(std::int64_t(state.iterations() * cmds.size()));
}
BENCHMARK(BM_MixedFlow<OrderBook>)->Name("MixedFlow/fast")->Unit(benchmark::kMillisecond);
BENCHMARK(BM_MixedFlow<ReferenceBook>)->Name("MixedFlow/reference")->Unit(benchmark::kMillisecond);

// Add a resting order and cancel it, with `depth` other orders already on the book.
template <typename Book>
void BM_AddCancel(benchmark::State& state) {
    Book book(0, bench_cfg());
    std::vector<Event> out;
    out.reserve(64);
    const auto depth = state.range(0);
    for (std::int64_t i = 0; i < depth; ++i) {
        Command c = limit(i % 2 ? Side::Buy : Side::Sell, i % 2 ? 9'900 - i % 50 : 10'100 + i % 50, 10, 1);
        out.clear();
        book.process(c, out);
    }
    Command add = limit(Side::Buy, 9'950, 10, 2);
    Command del = cancel(0, 2);
    for (auto _ : state) {
        out.clear();
        book.process(add, out);
        del.order_id = out[0].order_id;
        out.clear();
        book.process(del, out);
        benchmark::DoNotOptimize(out.data());
    }
    state.SetItemsProcessed(state.iterations() * 2);
}
BENCHMARK(BM_AddCancel<OrderBook>)->Name("AddCancel/fast")->Arg(100)->Arg(10'000);
BENCHMARK(BM_AddCancel<ReferenceBook>)->Name("AddCancel/reference")->Arg(100)->Arg(10'000);

// An aggressive order that takes one resting order, which is then replenished.
template <typename Book>
void BM_Match(benchmark::State& state) {
    Book book(0, bench_cfg());
    std::vector<Event> out;
    out.reserve(64);
    for (int i = 0; i < 1000; ++i) {
        out.clear();
        book.process(limit(Side::Sell, 10'001 + i % 20, 10, 1), out);
    }
    Command take = limit(Side::Buy, 10'001, 10, 2, TIF::IOC);
    Command refill = limit(Side::Sell, 10'001, 10, 1);
    for (auto _ : state) {
        out.clear();
        book.process(take, out);
        out.clear();
        book.process(refill, out);
        benchmark::DoNotOptimize(out.data());
    }
    state.SetItemsProcessed(state.iterations() * 2);
}
BENCHMARK(BM_Match<OrderBook>)->Name("Match/fast");
BENCHMARK(BM_Match<ReferenceBook>)->Name("Match/reference");

}  // namespace

BENCHMARK_MAIN();
