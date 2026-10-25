// A small blocking client for talking to a Server in tests.
#pragma once

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <cstring>
#include <optional>
#include <stdexcept>
#include <vector>

#include "ticker/protocol.hpp"

namespace ticker::testing {

struct Msg {
    wire::MsgType type;
    std::vector<std::uint8_t> bytes;

    template <typename T>
    T as() const {
        return wire::read_as<T>(bytes.data());
    }
};

class TestClient {
public:
    explicit TestClient(std::uint16_t port, int timeout_ms = 2000) {
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (::connect(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0)
            throw std::runtime_error("connect failed");
        int one = 1;
        ::setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        timeval tv{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
        ::setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
        ::setsockopt(fd_, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);  // a stuck server fails the test, not hangs it
    }
    ~TestClient() { ::close(fd_); }

    TestClient(const TestClient&) = delete;
    TestClient& operator=(const TestClient&) = delete;

    template <typename T>
    void send(const T& m) {
        send_raw(&m, sizeof m);
    }

    void send_raw(const void* p, std::size_t n) {
        if (::send(fd_, p, n, MSG_NOSIGNAL) != ssize_t(n)) throw std::runtime_error("send failed");
    }

    // Next message, or nothing on timeout / disconnect.
    std::optional<Msg> read() {
        wire::Header h;
        if (!read_exact(&h, sizeof h)) return std::nullopt;
        Msg m{h.type, std::vector<std::uint8_t>(h.length)};
        std::memcpy(m.bytes.data(), &h, sizeof h);
        if (h.length < sizeof h || !read_exact(m.bytes.data() + sizeof h, h.length - sizeof h)) return std::nullopt;
        return m;
    }

    // Reads until an event matches `pred`; skips everything else.
    template <typename Pred>
    std::optional<Event> wait_event(Pred pred) {
        while (auto m = read()) {
            if (m->type != wire::MsgType::EventMsg) continue;
            Event e = m->as<wire::EventMsg>().event;
            if (pred(e)) return e;
        }
        return std::nullopt;
    }

    std::optional<wire::LogonAck> logon(AccountId account, std::uint32_t flags = 0, std::uint64_t token = 0) {
        auto m = wire::make<wire::Logon>(wire::MsgType::Logon);
        m.account = account;
        m.flags = flags;
        m.token = token;
        send(m);
        auto r = read();
        if (!r || r->type != wire::MsgType::LogonAck) return std::nullopt;
        return r->as<wire::LogonAck>();
    }

    void new_order(SymbolId sym, Side side, Price price, Qty qty, std::uint64_t cl = 0,
                   OrdType type = OrdType::Limit, TIF tif = TIF::GTC, AccountId account = 0) {
        auto m = wire::make<wire::NewOrder>(wire::MsgType::NewOrder);
        m.symbol = sym;
        m.side = side;
        m.price = price;
        m.qty = qty;
        m.cl_ord_id = cl;
        m.ord_type = type;
        m.tif = tif;
        m.account = account;
        send(m);
    }

    void symbol_msg(wire::MsgType type, SymbolId sym) {
        auto m = wire::make<wire::SymbolMsg>(type);
        m.symbol = sym;
        send(m);
    }

    // True once the server has closed the connection.
    bool closed() {
        std::uint8_t b;
        return ::recv(fd_, &b, 1, 0) == 0;
    }

private:
    bool read_exact(void* p, std::size_t n) {
        auto* out = static_cast<std::uint8_t*>(p);
        while (n > 0) {
            ssize_t r = ::recv(fd_, out, n, 0);
            if (r <= 0) return false;
            out += r;
            n -= std::size_t(r);
        }
        return true;
    }

    int fd_;
};

}  // namespace ticker::testing
