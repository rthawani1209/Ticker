// libFuzzer target: raw bytes, read the way the server reads a client's socket, become
// orders, cancels and replaces for one symbol. The real book and the reference book
// (tests/reference_book.hpp) must give identical events for every message, and ASan/UBSan
// watch for memory errors on the way.
//
//   cmake -S engine -B engine/build-fuzz -DCMAKE_CXX_COMPILER=clang++ -DTICKER_FUZZ=ON
//   cmake --build engine/build-fuzz --target book_fuzz
//   engine/build-fuzz/book_fuzz -max_total_time=60 engine/fuzz/corpus
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "../tests/reference_book.hpp"
#include "ticker/order_book.hpp"
#include "ticker/protocol.hpp"

using namespace ticker;

namespace {

SymbolConfig small_book() {
    SymbolConfig cfg;
    cfg.max_price = 256;
    cfg.ref_price = 128;
    cfg.band_bps = 5000;
    cfg.max_orders = 32;
    cfg.max_order_qty = 300;
    return cfg;
}

// What the server builds from a proxy session's message (server.cpp on_message), for symbol 0.
bool to_command(const wire::Header& h, const std::uint8_t* msg, std::uint64_t ts, Command& cmd) {
    using namespace wire;
    cmd = Command{};
    cmd.session = 1;
    cmd.ts = ts;
    switch (h.type) {
        case MsgType::NewOrder: {
            auto m = read_as<NewOrder>(msg);
            cmd.type = CmdType::New;
            cmd.side = m.side;
            cmd.ord_type = m.ord_type;
            cmd.tif = m.tif;
            cmd.cl_ord_id = m.cl_ord_id;
            cmd.price = m.price;
            cmd.stop_price = m.stop_price;
            cmd.qty = m.qty;
            cmd.account = m.account % 8;  // a few accounts, so orders meet each other
            cmd.stp_group = m.stp_group % 3;
            return true;
        }
        case MsgType::Cancel: {
            auto m = read_as<Cancel>(msg);
            cmd.type = CmdType::Cancel;
            cmd.cl_ord_id = m.cl_ord_id;
            cmd.order_id = m.order_id % 64;  // ids are small, so cancels hit real orders
            cmd.account = m.account % 8;
            return true;
        }
        case MsgType::Replace: {
            auto m = read_as<Replace>(msg);
            cmd.type = CmdType::Replace;
            cmd.cl_ord_id = m.cl_ord_id;
            cmd.order_id = m.order_id % 64;
            cmd.price = m.price;
            cmd.qty = m.qty;
            cmd.account = m.account % 8;
            return true;
        }
        default:
            return false;
    }
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
    static const SymbolConfig cfg = small_book();
    OrderBook fast(0, cfg);
    testing::ReferenceBook ref(0, cfg);
    std::vector<Event> a, b;
    std::uint64_t ts = 1;

    std::size_t pos = 0;
    while (pos < size) {
        wire::Header h{};
        auto p = wire::peek(data + pos, size - pos, h);
        if (p != wire::Parse::Ok) {
            // The server drops the connection on Bad and waits on NeedMore. Skip a byte instead,
            // so one bad byte doesn't end the run.
            ++pos;
            continue;
        }
        Command cmd;
        // Time moves 1 ms per message, enough for halts to start and end within a run.
        if (to_command(h, data + pos, ts += 1'000'000, cmd)) {
            a.clear();
            b.clear();
            fast.process(cmd, a);
            ref.process(cmd, b);
            if (a != b) {
                std::fprintf(stderr, "books disagree at byte %zu (command type %d)\n", pos, int(cmd.type));
                std::abort();
            }
        }
        pos += h.length;
    }
    if (fast.order_count() != ref.order_count()) std::abort();
    return 0;
}
