// ticker-engine: the matching engine as a TCP server.
//
//   ticker-engine [--port 9100] [--shards 2] [--journal-dir DIR] [--fsync] [--token N]
//
// The token can also come from TICKER_TOKEN so it doesn't show up in `ps`.
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "server.hpp"

using namespace ticker;

namespace {

[[noreturn]] void usage(const char* argv0) {
    std::fprintf(stderr, "usage: %s [--host H] [--port N] [--shards N] [--journal-dir DIR] [--fsync] [--token N]\n",
                 argv0);
    std::exit(2);
}

}  // namespace

int main(int argc, char** argv) {
    ServerConfig cfg;
    if (const char* t = std::getenv("TICKER_TOKEN")) cfg.token = std::strtoull(t, nullptr, 10);

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto value = [&]() -> const char* {
            if (i + 1 >= argc) usage(argv[0]);
            return argv[++i];
        };
        if (a == "--host")
            cfg.host = value();
        else if (a == "--port")
            cfg.port = std::uint16_t(std::atoi(value()));
        else if (a == "--shards")
            cfg.shards = unsigned(std::atoi(value()));
        else if (a == "--journal-dir")
            cfg.journal_dir = value();
        else if (a == "--fsync")
            cfg.fsync = true;
        else if (a == "--token")
            cfg.token = std::strtoull(value(), nullptr, 10);
        else
            usage(argv[0]);
    }

    // Block the signals before any thread starts so only sigwait below sees them.
    sigset_t sigs;
    sigemptyset(&sigs);
    sigaddset(&sigs, SIGINT);
    sigaddset(&sigs, SIGTERM);
    pthread_sigmask(SIG_BLOCK, &sigs, nullptr);

    Server server(cfg);
    try {
        server.start();
    } catch (const std::exception& e) {
        std::fprintf(stderr, "ticker-engine: %s\n", e.what());
        return 1;
    }
    std::printf("ticker-engine listening on %s:%u (%u shards, %zu symbols, %llu commands recovered)\n",
                cfg.host.c_str(), server.port(), cfg.shards, cfg.symbols.size(),
                static_cast<unsigned long long>(server.recovered_commands()));
    std::fflush(stdout);

    int sig = 0;
    sigwait(&sigs, &sig);
    std::printf("ticker-engine: shutting down\n");
    server.stop();
    return 0;
}
