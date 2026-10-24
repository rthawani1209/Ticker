// Replays one or more journals through a fresh engine and prints a hash of the output.
// Two runs of the same journal must print the same hash.
//
//   ticker-replay journal-0.bin [journal-1.bin ...] [--dump]
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "ticker/engine.hpp"
#include "ticker/journal.hpp"

using namespace ticker;

int main(int argc, char** argv) {
    bool dump = false;
    std::vector<std::string> paths;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--dump") == 0)
            dump = true;
        else
            paths.emplace_back(argv[i]);
    }
    if (paths.empty()) {
        std::fprintf(stderr, "usage: %s journal... [--dump]\n", argv[0]);
        return 2;
    }

    const auto symbols = default_symbols();
    for (const auto& path : paths) {
        Engine engine(symbols);
        JournalReader reader(path);
        std::vector<Event> out;
        std::uint64_t hash = hash_events({});
        std::uint64_t events = 0, trades = 0;
        Command cmd;
        while (reader.next(cmd)) {
            out.clear();
            engine.process(cmd, out);
            hash = hash_events(out, hash);
            events += out.size();
            for (const auto& e : out) {
                trades += e.type == EventType::Trade;
                if (dump)
                    std::printf("%-13s sym=%u side=%d acct=%u id=%llu px=%lld qty=%u leaves=%u\n",
                                std::string(to_string(e.type)).c_str(), e.symbol, int(e.side), e.account,
                                (unsigned long long)e.order_id, (long long)e.price, e.qty, e.leaves);
            }
        }
        std::printf("%s: %llu commands, %llu events, %llu trades, hash %016llx%s\n", path.c_str(),
                    (unsigned long long)reader.records_read(), (unsigned long long)events,
                    (unsigned long long)trades, (unsigned long long)hash,
                    reader.damaged() ? " (stopped at a damaged record)" : "");
    }
}
