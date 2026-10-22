#include <gtest/gtest.h>

#include <random>
#include <set>
#include <unordered_map>

#include "ticker/bit_tree.hpp"
#include "ticker/order_map.hpp"

using namespace ticker;

TEST(BitTree, EmptyFindsNothing) {
    BitTree t(1000);
    EXPECT_TRUE(t.empty());
    EXPECT_EQ(t.find_next(0), -1);
    EXPECT_EQ(t.find_prev(999), -1);
}

TEST(BitTree, WordAndBlockBoundaries) {
    BitTree t(BitTree::kMaxBits);
    for (std::size_t i : {0ul, 63ul, 64ul, 4095ul, 4096ul, 262143ul}) {
        t.set(i);
        EXPECT_EQ(t.find_next(i), std::int64_t(i));
        EXPECT_EQ(t.find_prev(i), std::int64_t(i));
        t.clear(i);
        EXPECT_TRUE(t.empty());
    }
}

TEST(BitTree, MatchesStdSet) {
    std::mt19937_64 rng(1);
    const std::size_t n = 70'000;
    BitTree t(n);
    std::set<std::size_t> s;
    for (int i = 0; i < 200'000; ++i) {
        std::size_t k = rng() % n;
        if (rng() % 3 == 0) {
            t.clear(k);
            s.erase(k);
        } else {
            t.set(k);
            s.insert(k);
        }
        std::size_t q = rng() % n;
        auto nx = s.lower_bound(q);
        ASSERT_EQ(t.find_next(q), nx == s.end() ? -1 : std::int64_t(*nx));
        auto pv = s.upper_bound(q);
        ASSERT_EQ(t.find_prev(q), pv == s.begin() ? -1 : std::int64_t(*std::prev(pv)));
    }
}

TEST(OrderMap, MatchesUnorderedMap) {
    std::mt19937_64 rng(2);
    OrderMap<int> m(5000);
    std::unordered_map<std::uint64_t, int*> ref;
    std::vector<int> values(5000);
    std::uint64_t next = 1;
    for (int i = 0; i < 300'000; ++i) {
        if (ref.size() < 5000 && (ref.empty() || rng() % 2)) {
            std::uint64_t k = next++;
            int* v = &values[k % values.size()];
            m.insert(k, v);
            ref[k] = v;
        } else {
            // Erase a random existing key.
            auto it = ref.begin();
            std::advance(it, rng() % std::min<std::size_t>(ref.size(), 16));
            ASSERT_TRUE(m.erase(it->first));
            ref.erase(it);
        }
        std::uint64_t probe = 1 + rng() % next;
        auto it = ref.find(probe);
        ASSERT_EQ(m.find(probe), it == ref.end() ? nullptr : it->second);
    }
    EXPECT_EQ(m.size(), ref.size());
}
