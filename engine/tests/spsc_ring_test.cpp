#include "ticker/spsc_ring.hpp"

#include <gtest/gtest.h>

#include <cstdint>
#include <thread>

using ticker::SpscRing;

TEST(SpscRing, FifoAndCapacity) {
    SpscRing<int, 4> q;
    for (int i = 0; i < 4; ++i) EXPECT_TRUE(q.try_push(i));
    EXPECT_FALSE(q.try_push(99));
    int v;
    for (int i = 0; i < 4; ++i) {
        ASSERT_TRUE(q.try_pop(v));
        EXPECT_EQ(v, i);
    }
    EXPECT_FALSE(q.try_pop(v));
}

TEST(SpscRing, WrapsAround) {
    SpscRing<int, 8> q;
    int v;
    for (int i = 0; i < 1000; ++i) {
        ASSERT_TRUE(q.try_push(i));
        ASSERT_TRUE(q.try_push(i + 1));
        ASSERT_TRUE(q.try_pop(v));
        EXPECT_EQ(v, i);
        ASSERT_TRUE(q.try_pop(v));
        EXPECT_EQ(v, i + 1);
    }
}

// Two threads hammer a small ring. Every value must arrive once, in order.
// Under TSan this also checks the memory ordering.
TEST(SpscRing, TwoThreadsKeepOrder) {
    struct Item {
        std::uint64_t seq;
        std::uint64_t check;
    };
    SpscRing<Item, 64> q;
    constexpr std::uint64_t kCount = 2'000'000;

    std::thread producer([&] {
        for (std::uint64_t i = 0; i < kCount; ++i) {
            Item it{i, i * 31 + 7};
            while (!q.try_push(it)) std::this_thread::yield();
        }
    });

    std::uint64_t expected = 0;
    Item it{};
    while (expected < kCount) {
        if (!q.try_pop(it)) continue;
        ASSERT_EQ(it.seq, expected);
        ASSERT_EQ(it.check, expected * 31 + 7);
        ++expected;
    }
    producer.join();
    EXPECT_EQ(q.size(), 0u);
}
