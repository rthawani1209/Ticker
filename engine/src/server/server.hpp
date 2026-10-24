// The exchange server: one network thread plus one matching thread per shard.
//
//   clients --TCP--> [io thread: epoll, decode] --SPSC ring--> [shard thread: journal, match]
//   clients <--TCP-- [io thread: encode, route] <--SPSC ring-- [shard thread]
//
// Symbols are split across shards by id. Each shard owns its books outright, so
// matching needs no locks and stays deterministic. The io thread owns every socket.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "ticker/config.hpp"
#include "ticker/engine.hpp"
#include "ticker/histogram.hpp"
#include "ticker/journal.hpp"
#include "ticker/protocol.hpp"
#include "ticker/spsc_ring.hpp"

namespace ticker {

struct ServerConfig {
    std::string host = "0.0.0.0";
    std::uint16_t port = 9100;  // 0 picks a free port
    unsigned shards = 2;
    std::string journal_dir;  // empty = no journal, nothing survives a restart
    bool fsync = false;       // fsync the journal after every batch, not just write()
    std::uint64_t token = 0;  // required for proxy/admin logons when non-zero
    std::vector<SymbolConfig> symbols = default_symbols();
};

class Server {
public:
    explicit Server(ServerConfig cfg);
    ~Server();

    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    // Binds, replays any journals, and starts all threads.
    void start();
    void stop();

    std::uint16_t port() const { return port_; }
    std::uint64_t recovered_commands() const { return recovered_; }

private:
    struct Stats {
        std::uint64_t commands, p50, p99, p999, max;
    };
    struct OutMsg {
        Event event;
        Stats stats;
        bool is_stats;
    };

    struct Shard {
        explicit Shard(const std::vector<SymbolConfig>& symbols) : engine(symbols) {}
        Engine engine;
        std::unique_ptr<JournalWriter> journal;
        SpscRing<Command, 1 << 15> in;
        SpscRing<OutMsg, 1 << 16> out;
        std::thread thread;
    };

    struct Connection {
        int fd;
        SessionId session;
        AccountId account = 0;
        std::uint32_t flags = 0;
        bool logged_in = false;
        bool closing = false;
        std::vector<std::uint8_t> rbuf;
        std::vector<std::uint8_t> wbuf;
        std::size_t woff = 0;
        bool want_write = false;
        bool dirty = false;  // already in dirty_
    };

    void run_shard(unsigned i);
    void run_io();

    void accept_all();
    void on_readable(Connection& c);
    void on_message(Connection& c, const wire::Header& h, const std::uint8_t* msg);
    void send_cmd(const Command& cmd);
    bool drain_shards();
    void deliver(const Event& e);
    void queue(Connection& c, const void* data, std::size_t n);
    void flush_writes();
    void fail(Connection& c, wire::ErrorCode code);
    void close_conn(Connection& c);

    unsigned shard_of(SymbolId s) const { return s % unsigned(shards_.size()); }

    ServerConfig cfg_;
    std::vector<std::unique_ptr<Shard>> shards_;
    std::atomic<bool> running_{false};
    std::thread io_thread_;
    int listen_fd_ = -1;
    int epoll_fd_ = -1;
    std::uint16_t port_ = 0;
    std::uint64_t recovered_ = 0;

    // io thread only
    SessionId next_session_ = 1;
    std::unordered_map<int, std::unique_ptr<Connection>> by_fd_;
    std::unordered_map<SessionId, Connection*> by_session_;
    std::vector<Connection*> dirty_;
    std::vector<std::unique_ptr<Connection>> graveyard_;  // freed after the current loop pass
};

}  // namespace ticker
