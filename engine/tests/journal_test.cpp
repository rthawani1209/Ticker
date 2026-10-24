#include "ticker/journal.hpp"

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>

#include "order_flow.hpp"
#include "ticker/engine.hpp"

using namespace ticker;
namespace fs = std::filesystem;

namespace {

class JournalTest : public ::testing::Test {
protected:
    fs::path path = fs::temp_directory_path() /
                    ("ticker-journal-" + std::to_string(::testing::UnitTest::GetInstance()->random_seed()) + "-" +
                     ::testing::UnitTest::GetInstance()->current_test_info()->name() + ".bin");
    void SetUp() override { fs::remove(path); }
    void TearDown() override { fs::remove(path); }

    // Runs `n` commands through an engine while journaling them; returns the output hash.
    std::uint64_t record(std::size_t n, std::uint64_t seed = 5) {
        SymbolConfig cfg;
        std::vector<SymbolConfig> syms{cfg};
        Engine engine(syms);
        ticker::testing::OrderFlow flow(seed, cfg);
        JournalWriter j(path.string());
        std::vector<Event> out;
        std::uint64_t h = hash_events({});
        for (std::size_t i = 0; i < n; ++i) {
            Command c = flow.next();
            j.append(c);
            out.clear();
            engine.process(c, out);
            flow.observe(out);
            h = hash_events(out, h);
        }
        return h;
    }

    std::uint64_t replay(std::uint64_t* count = nullptr) {
        SymbolConfig cfg;
        std::vector<SymbolConfig> syms{cfg};
        Engine engine(syms);
        JournalReader r(path.string());
        std::vector<Event> out;
        std::uint64_t h = hash_events({});
        Command c;
        while (r.next(c)) {
            out.clear();
            engine.process(c, out);
            h = hash_events(out, h);
        }
        if (count) *count = r.records_read();
        return h;
    }
};

}  // namespace

TEST_F(JournalTest, ReplayIsByteIdentical) {
    std::uint64_t live = record(50'000);
    std::uint64_t n = 0;
    EXPECT_EQ(replay(&n), live);
    EXPECT_EQ(n, 50'000u);
}

TEST_F(JournalTest, DifferentFlowDifferentHash) {
    std::uint64_t a = record(5'000, 1);
    fs::remove(path);
    std::uint64_t b = record(5'000, 2);
    EXPECT_NE(a, b);
}

TEST_F(JournalTest, TornTailIsIgnoredAndCutOnReopen) {
    record(1'000);
    fs::resize_file(path, fs::file_size(path) - 10);  // crash mid-write
    {
        JournalReader r(path.string());
        Command c;
        while (r.next(c)) {}
        EXPECT_EQ(r.records_read(), 999u);
        EXPECT_TRUE(r.damaged());
    }
    {
        JournalWriter w(path.string());
        EXPECT_EQ(w.records(), 999u);
        Command c{};
        c.type = CmdType::Snapshot;
        w.append(c);
    }
    JournalReader r(path.string());
    Command c;
    while (r.next(c)) {}
    EXPECT_EQ(r.records_read(), 1000u);
    EXPECT_FALSE(r.damaged());
    EXPECT_EQ(c.type, CmdType::Snapshot);
}

TEST_F(JournalTest, CorruptRecordStopsReplay) {
    record(100);
    {
        std::fstream f(path, std::ios::in | std::ios::out | std::ios::binary);
        f.seekp(16 + 72 * 40 + 20);
        f.put('\x5a');
    }
    JournalReader r(path.string());
    Command c;
    while (r.next(c)) {}
    EXPECT_EQ(r.records_read(), 40u);
    EXPECT_TRUE(r.damaged());
}

TEST_F(JournalTest, RefusesToOverwriteOtherFiles) {
    {
        std::ofstream f(path);
        f << "definitely not a journal, just some notes";
    }
    EXPECT_THROW(JournalWriter w(path.string()), std::runtime_error);
}

TEST(Crc32c, KnownValue) {
    // Standard check value for CRC-32C.
    EXPECT_EQ(crc32c("123456789", 9), 0xE3069283u);
}
