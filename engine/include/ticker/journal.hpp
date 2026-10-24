// Write-ahead journal of every command the engine accepts. Because the engine is
// deterministic, replaying a journal rebuilds the exact same books and produces the
// exact same events. That's how the server recovers after a crash, and how a
// disputed competition result can be checked.
//
// File layout: a 16-byte header, then fixed-size records of {Command, crc32c}.
#pragma once

#include <cstdint>
#include <cstdio>
#include <span>
#include <string>

#include "ticker/types.hpp"

namespace ticker {

std::uint32_t crc32c(const void* data, std::size_t len);

// FNV-1a over raw event bytes. Two runs produced the same output iff the hashes match
// (for all practical purposes), which keeps replay checks cheap.
std::uint64_t hash_events(std::span<const Event> events, std::uint64_t seed = 14695981039346656037ull);

class JournalWriter {
public:
    // Opens or creates the journal. An existing file is validated first and any torn
    // record at the end (from a crash mid-write) is cut off before appending.
    explicit JournalWriter(const std::string& path, bool sync_every_flush = false);
    ~JournalWriter();

    JournalWriter(const JournalWriter&) = delete;
    JournalWriter& operator=(const JournalWriter&) = delete;

    void append(const Command& cmd);
    // Pushes buffered records to the OS, and to disk if sync_every_flush is set.
    void flush();

    std::uint64_t records() const { return records_; }

private:
    std::FILE* f_ = nullptr;
    bool sync_;
    std::uint64_t records_ = 0;
};

class JournalReader {
public:
    explicit JournalReader(const std::string& path);
    ~JournalReader();

    JournalReader(const JournalReader&) = delete;
    JournalReader& operator=(const JournalReader&) = delete;

    // False at the end of the file or at the first damaged record.
    bool next(Command& cmd);

    std::uint64_t records_read() const { return read_; }
    // True if reading stopped because of a partial or corrupt record.
    bool damaged() const { return damaged_; }
    // Bytes up to and including the last good record.
    std::uint64_t good_bytes() const;

private:
    std::FILE* f_ = nullptr;
    std::uint64_t read_ = 0;
    bool damaged_ = false;
};

}  // namespace ticker
