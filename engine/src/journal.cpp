#include "ticker/journal.hpp"

#include <unistd.h>

#include <array>
#include <cstring>
#include <filesystem>
#include <stdexcept>

namespace ticker {

namespace {

constexpr char kMagic[8] = {'T', 'I', 'C', 'K', 'J', 'N', 'L', '1'};
constexpr std::uint32_t kVersion = 1;

struct Header {
    char magic[8];
    std::uint32_t version;
    std::uint32_t record_size;
};
static_assert(sizeof(Header) == 16);

struct Record {
    Command cmd;
    std::uint32_t crc;
    std::uint32_t pad;
};
static_assert(sizeof(Record) == 72);

Header make_header() {
    Header h{};
    std::memcpy(h.magic, kMagic, sizeof kMagic);
    h.version = kVersion;
    h.record_size = sizeof(Record);
    return h;
}

bool valid_header(const Header& h) {
    return std::memcmp(h.magic, kMagic, sizeof kMagic) == 0 && h.version == kVersion &&
           h.record_size == sizeof(Record);
}

constexpr auto make_crc_table() {
    // Castagnoli polynomial, reflected.
    std::array<std::uint32_t, 256> t{};
    for (std::uint32_t i = 0; i < 256; ++i) {
        std::uint32_t c = i;
        for (int k = 0; k < 8; ++k) c = (c & 1) ? (c >> 1) ^ 0x82F63B78u : c >> 1;
        t[i] = c;
    }
    return t;
}
constexpr auto kCrcTable = make_crc_table();

}  // namespace

std::uint32_t crc32c(const void* data, std::size_t len) {
    auto* p = static_cast<const unsigned char*>(data);
    std::uint32_t c = ~0u;
    for (std::size_t i = 0; i < len; ++i) c = kCrcTable[(c ^ p[i]) & 0xFF] ^ (c >> 8);
    return ~c;
}

std::uint64_t hash_events(std::span<const Event> events, std::uint64_t h) {
    auto* p = reinterpret_cast<const unsigned char*>(events.data());
    for (std::size_t i = 0; i < events.size_bytes(); ++i) {
        h ^= p[i];
        h *= 1099511628211ull;
    }
    return h;
}

JournalWriter::JournalWriter(const std::string& path, bool sync_every_flush) : sync_(sync_every_flush) {
    std::uint64_t keep = 0;
    if (std::filesystem::exists(path) && std::filesystem::file_size(path) > 0) {
        JournalReader r(path);
        Command c;
        while (r.next(c)) {}
        if (r.records_read() == 0 && r.damaged() && std::filesystem::file_size(path) >= sizeof(Header)) {
            // Readable size but no valid header: refuse rather than overwrite someone's file.
            Header h{};
            if (std::FILE* f = std::fopen(path.c_str(), "rb")) {
                std::size_t n = std::fread(&h, sizeof h, 1, f);
                std::fclose(f);
                if (n == 1 && !valid_header(h)) throw std::runtime_error("not a ticker journal: " + path);
            }
        }
        keep = r.good_bytes();
        records_ = r.records_read();
        std::filesystem::resize_file(path, keep);
    }

    f_ = std::fopen(path.c_str(), keep ? "ab" : "wb");
    if (!f_) throw std::runtime_error("can't open journal: " + path);
    std::setvbuf(f_, nullptr, _IOFBF, 1 << 20);
    if (!keep) {
        Header h = make_header();
        std::fwrite(&h, sizeof h, 1, f_);
    }
}

JournalWriter::~JournalWriter() {
    if (!f_) return;
    flush();
    std::fclose(f_);
}

void JournalWriter::append(const Command& cmd) {
    Record r{};
    r.cmd = cmd;
    r.crc = crc32c(&r.cmd, sizeof r.cmd);
    if (std::fwrite(&r, sizeof r, 1, f_) != 1) throw std::runtime_error("journal write failed");
    ++records_;
}

void JournalWriter::flush() {
    std::fflush(f_);
    if (sync_) ::fsync(::fileno(f_));
}

JournalReader::JournalReader(const std::string& path) {
    f_ = std::fopen(path.c_str(), "rb");
    if (!f_) throw std::runtime_error("can't open journal: " + path);
    Header h{};
    if (std::fread(&h, sizeof h, 1, f_) != 1 || !valid_header(h)) damaged_ = true;
}

JournalReader::~JournalReader() {
    if (f_) std::fclose(f_);
}

bool JournalReader::next(Command& cmd) {
    if (damaged_) return false;
    Record r;
    std::size_t n = std::fread(&r, 1, sizeof r, f_);
    if (n == 0) return false;
    if (n != sizeof r || r.crc != crc32c(&r.cmd, sizeof r.cmd)) {
        damaged_ = true;
        return false;
    }
    cmd = r.cmd;
    ++read_;
    return true;
}

std::uint64_t JournalReader::good_bytes() const {
    if (read_ == 0 && damaged_) return 0;
    return sizeof(Header) + read_ * sizeof(Record);
}

}  // namespace ticker
