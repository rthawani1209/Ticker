// Measures how long each command takes inside the book and prints percentiles.
// This is matching latency only: no network, no queues. See the gateway load test
// for end-to-end numbers.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "order_flow.hpp"
#include "ticker/order_book.hpp"

using namespace ticker;
using Clock = std::chrono::steady_clock;

int main(int argc, char** argv) {
    const std::size_t n = argc > 1 ? std::strtoull(argv[1], nullptr, 10) : 2'000'000;

    SymbolConfig cfg;
    cfg.circuit_bps = 0;
    testing::OrderFlow flow(7, cfg, false);
    OrderBook book(0, cfg);
    std::vector<Event> out;
    out.reserve(4096);

    std::vector<std::uint32_t> ns;
    ns.reserve(n);
    std::size_t trades = 0;

    for (std::size_t i = 0; i < n; ++i) {
        Command c = flow.next();
        out.clear();
        auto t0 = Clock::now();
        book.process(c, out);
        auto t1 = Clock::now();
        ns.push_back(std::uint32_t(std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count()));
        flow.observe(out);
        for (auto& e : out) trades += e.type == EventType::Trade;
    }

    std::sort(ns.begin(), ns.end());
    auto pct = [&](double p) { return ns[std::min(ns.size() - 1, std::size_t(p * double(ns.size())))]; };
    double mean = 0;
    for (auto v : ns) mean += v;
    mean /= double(ns.size());

    std::printf("commands  %zu (%zu trades, %zu orders resting at end)\n", n, trades, book.order_count());
    std::printf("mean      %.0f ns\n", mean);
    std::printf("p50       %u ns\n", pct(0.50));
    std::printf("p90       %u ns\n", pct(0.90));
    std::printf("p99       %u ns\n", pct(0.99));
    std::printf("p99.9     %u ns\n", pct(0.999));
    std::printf("max       %u ns\n", ns.back());
}
