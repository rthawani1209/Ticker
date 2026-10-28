#include "server.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <filesystem>
#include <stdexcept>
#include <system_error>

namespace ticker {

namespace {

constexpr std::size_t kMaxPendingWrite = 64 << 20;  // drop clients that fall this far behind
constexpr std::size_t kBatch = 256;

std::uint64_t wall_ns() {
    using namespace std::chrono;
    return std::uint64_t(duration_cast<nanoseconds>(system_clock::now().time_since_epoch()).count());
}

[[noreturn]] void throw_errno(const char* what) { throw std::system_error(errno, std::generic_category(), what); }

inline void cpu_relax() {
#if defined(__x86_64__) || defined(__i386__)
    __builtin_ia32_pause();
#endif
}

}  // namespace

Server::Server(ServerConfig cfg) : cfg_(std::move(cfg)) {
    if (cfg_.shards == 0) cfg_.shards = 1;
    for (unsigned i = 0; i < cfg_.shards; ++i) shards_.push_back(std::make_unique<Shard>(cfg_.symbols));
}

Server::~Server() { stop(); }

void Server::start() {
    if (!cfg_.journal_dir.empty()) {
        namespace fs = std::filesystem;
        fs::create_directories(cfg_.journal_dir);
        SessionId max_session = 0;
        for (unsigned i = 0; i < shards_.size(); ++i) {
            Shard& s = *shards_[i];
            std::string path = (fs::path(cfg_.journal_dir) / ("shard-" + std::to_string(i) + ".journal")).string();
            if (fs::exists(path)) {
                // Rebuild the books by replaying everything this shard ever accepted.
                JournalReader r(path);
                std::vector<Event> scratch;
                Command c;
                while (r.next(c)) {
                    scratch.clear();
                    s.engine.process(c, scratch);
                    max_session = std::max(max_session, c.session);
                    ++recovered_;
                }
            }
            s.journal = std::make_unique<JournalWriter>(path, cfg_.fsync);
        }
        // New sessions must not reuse ids that resting orders still point at.
        next_session_ = max_session + 1;
    }

    listen_fd_ = ::socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (listen_fd_ < 0) throw_errno("socket");
    int one = 1;
    ::setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(cfg_.port);
    if (::inet_pton(AF_INET, cfg_.host.c_str(), &addr.sin_addr) != 1) throw std::runtime_error("bad host: " + cfg_.host);
    if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) throw_errno("bind");
    if (::listen(listen_fd_, 128) < 0) throw_errno("listen");
    socklen_t len = sizeof addr;
    ::getsockname(listen_fd_, reinterpret_cast<sockaddr*>(&addr), &len);
    port_ = ntohs(addr.sin_port);

    epoll_fd_ = ::epoll_create1(EPOLL_CLOEXEC);
    if (epoll_fd_ < 0) throw_errno("epoll_create1");
    epoll_event ev{};
    ev.events = EPOLLIN;
    ev.data.fd = listen_fd_;
    ::epoll_ctl(epoll_fd_, EPOLL_CTL_ADD, listen_fd_, &ev);

    running_ = true;
    for (unsigned i = 0; i < shards_.size(); ++i) shards_[i]->thread = std::thread([this, i] { run_shard(i); });
    io_thread_ = std::thread([this] { run_io(); });
}

void Server::stop() {
    if (!running_.exchange(false)) return;
    io_thread_.join();
    for (auto& s : shards_) s->thread.join();
    for (auto& [fd, c] : by_fd_) ::close(fd);
    by_fd_.clear();
    by_session_.clear();
    ::close(listen_fd_);
    ::close(epoll_fd_);
    for (auto& s : shards_) s->journal.reset();  // flushes
}

// ---- matching threads --------------------------------------------------------------

void Server::run_shard(unsigned idx) {
    Shard& s = *shards_[idx];
    LatencyHistogram hist;
    std::vector<Command> batch;
    batch.reserve(kBatch);
    std::vector<Event> out;
    out.reserve(1 << 16);
    auto last_stats = std::chrono::steady_clock::now();
    unsigned idle = 0;

    auto publish = [&](const OutMsg& m) {
        while (!s.out.try_push(m)) {
            if (!running_) return false;
            std::this_thread::yield();
        }
        return true;
    };

    auto maybe_stats = [&] {
        auto now = std::chrono::steady_clock::now();
        if (now - last_stats < std::chrono::seconds(1)) return;
        last_stats = now;
        if (hist.count() == 0) return;
        OutMsg m{};
        m.is_stats = true;
        m.stats = {hist.count(), hist.percentile(0.5), hist.percentile(0.99), hist.percentile(0.999), hist.max()};
        publish(m);
        hist.reset();
    };

    while (running_) {
        batch.clear();
        Command c;
        while (batch.size() < kBatch && s.in.try_pop(c)) batch.push_back(c);

        if (batch.empty()) {
            // Spin briefly for low latency, then back off so an idle server isn't
            // burning a core per shard.
            if (++idle < 2'000)
                cpu_relax();
            else if (idle < 20'000)
                std::this_thread::yield();
            else
                std::this_thread::sleep_for(std::chrono::microseconds(100));
            maybe_stats();
            continue;
        }
        idle = 0;

        // Group commit: the whole batch is in the journal before any of it is
        // acknowledged, so nothing a client has seen can be lost in a crash.
        if (s.journal) {
            for (const auto& cmd : batch) s.journal->append(cmd);
            s.journal->flush();
        }

        for (const auto& cmd : batch) {
            out.clear();
            s.engine.process(cmd, out);
            for (const auto& e : out) {
                OutMsg m{};
                m.event = e;
                if (!publish(m)) return;
            }
            std::uint64_t now = wall_ns();
            hist.record(now > cmd.ts ? now - cmd.ts : 0);
        }
        maybe_stats();
    }
}

// ---- network thread ----------------------------------------------------------------

void Server::run_io() {
    epoll_event evs[64];
    bool busy = false;
    while (running_) {
        int n = ::epoll_wait(epoll_fd_, evs, 64, busy ? 0 : 1);
        for (int i = 0; i < n; ++i) {
            int fd = evs[i].data.fd;
            if (fd == listen_fd_) {
                accept_all();
                continue;
            }
            auto it = by_fd_.find(fd);
            if (it == by_fd_.end()) continue;
            Connection& c = *it->second;
            if (evs[i].events & (EPOLLIN | EPOLLERR | EPOLLHUP)) on_readable(c);
            if ((evs[i].events & EPOLLOUT) && !c.closing && !c.dirty) {
                c.dirty = true;
                dirty_.push_back(&c);
            }
        }
        busy = drain_shards();
        flush_writes();
        graveyard_.clear();
    }
}

void Server::accept_all() {
    for (;;) {
        int fd = ::accept4(listen_fd_, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (fd < 0) return;  // EAGAIN, or a transient error; epoll will tell us again
        int one = 1;
        ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);

        auto c = std::make_unique<Connection>();
        c->fd = fd;
        c->session = next_session_++;
        epoll_event ev{};
        ev.events = EPOLLIN;
        ev.data.fd = fd;
        ::epoll_ctl(epoll_fd_, EPOLL_CTL_ADD, fd, &ev);
        by_session_[c->session] = c.get();
        by_fd_[fd] = std::move(c);
    }
}

void Server::on_readable(Connection& c) {
    std::uint8_t tmp[64 * 1024];
    for (;;) {
        ssize_t r = ::recv(c.fd, tmp, sizeof tmp, 0);
        if (r > 0) {
            c.rbuf.insert(c.rbuf.end(), tmp, tmp + r);
            continue;
        }
        if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        if (r < 0 && errno == EINTR) continue;
        close_conn(c);  // peer closed, or a real error
        return;
    }

    std::size_t pos = 0;
    while (!c.closing) {
        wire::Header h;
        auto p = wire::peek(c.rbuf.data() + pos, c.rbuf.size() - pos, h);
        if (p == wire::Parse::NeedMore) break;
        if (p == wire::Parse::Bad) return fail(c, wire::ErrorCode::BadMessage);
        on_message(c, h, c.rbuf.data() + pos);
        pos += h.length;
    }
    if (!c.closing) c.rbuf.erase(c.rbuf.begin(), c.rbuf.begin() + std::ptrdiff_t(pos));
}

void Server::on_message(Connection& c, const wire::Header& h, const std::uint8_t* msg) {
    using namespace wire;

    if (h.type == MsgType::Logon) {
        if (c.logged_in) return fail(c, ErrorCode::AlreadyLoggedIn);
        auto m = read_as<Logon>(msg);
        bool privileged = m.flags & (kProxy | kAdmin);
        if (privileged && cfg_.token != 0 && m.token != cfg_.token) return fail(c, ErrorCode::BadToken);
        c.account = m.account;
        c.flags = m.flags & (kMarketData | kProxy | kAdmin);
        c.logged_in = true;
        auto ack = make<LogonAck>(MsgType::LogonAck);
        ack.session = c.session;
        ack.flags = c.flags;
        ack.symbols = std::uint32_t(cfg_.symbols.size());
        queue(c, &ack, sizeof ack);
        return;
    }
    if (!c.logged_in) return fail(c, ErrorCode::NotLoggedIn);

    Command cmd{};
    cmd.session = c.session;
    cmd.account = c.account;
    cmd.ts = wall_ns();
    const bool proxy = c.flags & kProxy;

    switch (h.type) {
        case MsgType::NewOrder: {
            auto m = read_as<NewOrder>(msg);
            cmd.type = CmdType::New;
            cmd.side = m.side;
            cmd.ord_type = m.ord_type;
            cmd.tif = m.tif;
            cmd.symbol = m.symbol;
            cmd.cl_ord_id = m.cl_ord_id;
            cmd.price = m.price;
            cmd.stop_price = m.stop_price;
            cmd.qty = m.qty;
            if (proxy) {
                cmd.account = m.account;
                cmd.stp_group = m.stp_group;
            }
            break;
        }
        case MsgType::Cancel: {
            auto m = read_as<Cancel>(msg);
            cmd.type = CmdType::Cancel;
            cmd.symbol = m.symbol;
            cmd.cl_ord_id = m.cl_ord_id;
            cmd.order_id = m.order_id;
            if (proxy) cmd.account = m.account;
            break;
        }
        case MsgType::Replace: {
            auto m = read_as<Replace>(msg);
            cmd.type = CmdType::Replace;
            cmd.symbol = m.symbol;
            cmd.cl_ord_id = m.cl_ord_id;
            cmd.order_id = m.order_id;
            cmd.price = m.price;
            cmd.qty = m.qty;
            if (proxy) cmd.account = m.account;
            break;
        }
        case MsgType::Subscribe:
            c.flags |= kMarketData;
            cmd.type = CmdType::Snapshot;
            cmd.symbol = read_as<SymbolMsg>(msg).symbol;
            break;
        case MsgType::Halt:
        case MsgType::Resume:
            if (!(c.flags & kAdmin)) return fail(c, ErrorCode::NotAllowed);
            cmd.type = h.type == MsgType::Halt ? CmdType::Halt : CmdType::Resume;
            cmd.symbol = read_as<SymbolMsg>(msg).symbol;
            break;
        default:
            return fail(c, ErrorCode::BadMessage);  // a server-to-client type
    }
    send_cmd(cmd);
}

void Server::send_cmd(const Command& cmd) {
    auto& ring = shards_[shard_of(cmd.symbol)]->in;
    // Backpressure: if the shard is behind, keep delivering its output (which is
    // what it's probably waiting on) until there's room.
    while (!ring.try_push(cmd)) {
        if (!running_) return;
        drain_shards();
        flush_writes();
    }
}

bool Server::drain_shards() {
    bool any = false;
    for (unsigned i = 0; i < shards_.size(); ++i) {
        OutMsg m;
        for (int k = 0; k < 4096 && shards_[i]->out.try_pop(m); ++k) {
            any = true;
            if (!m.is_stats) {
                deliver(m.event);
                continue;
            }
            auto st = wire::make<wire::Stats>(wire::MsgType::Stats);
            st.shard = i;
            st.commands = m.stats.commands;
            st.p50_ns = m.stats.p50;
            st.p99_ns = m.stats.p99;
            st.p999_ns = m.stats.p999;
            st.max_ns = m.stats.max;
            for (auto& [id, c] : by_session_)
                if (c->flags & wire::kMarketData) queue(*c, &st, sizeof st);
        }
    }
    return any;
}

void Server::deliver(const Event& e) {
    auto msg = wire::make<wire::EventMsg>(wire::MsgType::EventMsg);
    msg.event = e;
    if (e.session == 0) {
        for (auto& [id, c] : by_session_)
            if (c->flags & wire::kMarketData) queue(*c, &msg, sizeof msg);
        return;
    }
    // Replies for a session that has since disconnected are dropped. Its orders
    // stay on the book.
    auto it = by_session_.find(e.session);
    if (it != by_session_.end()) queue(*it->second, &msg, sizeof msg);
}

void Server::queue(Connection& c, const void* data, std::size_t n) {
    if (c.closing) return;
    auto* p = static_cast<const std::uint8_t*>(data);
    c.wbuf.insert(c.wbuf.end(), p, p + n);
    if (c.wbuf.size() - c.woff > kMaxPendingWrite) return close_conn(c);
    if (!c.dirty) {
        c.dirty = true;
        dirty_.push_back(&c);
    }
}

void Server::flush_writes() {
    for (Connection* c : dirty_) {
        c->dirty = false;
        if (c->closing) continue;
        while (c->woff < c->wbuf.size()) {
            ssize_t w = ::send(c->fd, c->wbuf.data() + c->woff, c->wbuf.size() - c->woff, MSG_NOSIGNAL);
            if (w > 0) {
                c->woff += std::size_t(w);
                continue;
            }
            if (w < 0 && errno == EINTR) continue;
            if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
            close_conn(*c);
            break;
        }
        if (c->closing) continue;

        bool pending = c->woff < c->wbuf.size();
        if (!pending) {
            c->wbuf.clear();
            c->woff = 0;
        } else if (c->woff > (1 << 20)) {
            c->wbuf.erase(c->wbuf.begin(), c->wbuf.begin() + std::ptrdiff_t(c->woff));
            c->woff = 0;
        }
        // Only ask epoll about writability while we actually have bytes stuck.
        if (pending != c->want_write) {
            c->want_write = pending;
            epoll_event ev{};
            ev.events = EPOLLIN | (pending ? EPOLLOUT : 0u);
            ev.data.fd = c->fd;
            ::epoll_ctl(epoll_fd_, EPOLL_CTL_MOD, c->fd, &ev);
        }
    }
    dirty_.clear();
}

void Server::fail(Connection& c, wire::ErrorCode code) {
    // Best effort: try to tell the client why before hanging up.
    auto err = wire::make<wire::Error>(wire::MsgType::Error);
    err.code = code;
    ::send(c.fd, &err, sizeof err, MSG_NOSIGNAL | MSG_DONTWAIT);
    close_conn(c);
}

void Server::close_conn(Connection& c) {
    if (c.closing) return;
    c.closing = true;
    ::epoll_ctl(epoll_fd_, EPOLL_CTL_DEL, c.fd, nullptr);
    ::close(c.fd);
    by_session_.erase(c.session);
    // Keep the object alive until the end of this loop iteration; callers up the
    // stack (and dirty_) may still hold a reference.
    auto it = by_fd_.find(c.fd);
    graveyard_.push_back(std::move(it->second));
    by_fd_.erase(it);
}

}  // namespace ticker
