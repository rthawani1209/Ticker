#pragma once

#include <atomic>
#include <cstddef>
#include <memory>
#include <new>
#include <type_traits>

namespace ticker {

// Bounded single-producer single-consumer queue. Exactly one thread may push and
// exactly one other thread may pop.
//
// The producer owns tail_, the consumer owns head_. Each side keeps a cached copy
// of the other side's index so it only touches the shared cache line when the
// queue looks full (producer) or empty (consumer).
template <typename T, std::size_t Capacity>
class SpscRing {
    static_assert(Capacity >= 2 && (Capacity & (Capacity - 1)) == 0, "capacity must be a power of two");
    static_assert(std::is_trivially_copyable_v<T>);

public:
    SpscRing() : slots_(std::make_unique<T[]>(Capacity)) {}

    SpscRing(const SpscRing&) = delete;
    SpscRing& operator=(const SpscRing&) = delete;

    bool try_push(const T& value) {
        const std::size_t tail = tail_.load(std::memory_order_relaxed);
        if (tail - head_cache_ == Capacity) {
            // Looks full. Acquire pairs with the consumer's release in try_pop, so
            // once we see the slot freed we may overwrite it.
            head_cache_ = head_.load(std::memory_order_acquire);
            if (tail - head_cache_ == Capacity) return false;
        }
        slots_[tail & kMask] = value;
        // Release publishes the slot write before the new tail becomes visible.
        tail_.store(tail + 1, std::memory_order_release);
        return true;
    }

    bool try_pop(T& out) {
        const std::size_t head = head_.load(std::memory_order_relaxed);
        if (head == tail_cache_) {
            tail_cache_ = tail_.load(std::memory_order_acquire);
            if (head == tail_cache_) return false;
        }
        out = slots_[head & kMask];
        head_.store(head + 1, std::memory_order_release);
        return true;
    }

    // Approximate; only exact when called from one of the two owning threads while
    // the other is idle.
    std::size_t size() const {
        return tail_.load(std::memory_order_acquire) - head_.load(std::memory_order_acquire);
    }

    static constexpr std::size_t capacity() { return Capacity; }

private:
    static constexpr std::size_t kMask = Capacity - 1;
    // 64 bytes on x86 and most ARM; hardware_destructive_interference_size triggers
    // an ABI warning on gcc, so spell it out.
    static constexpr std::size_t kLine = 64;

    // Consumer side.
    alignas(kLine) std::atomic<std::size_t> head_{0};
    std::size_t tail_cache_ = 0;

    // Producer side.
    alignas(kLine) std::atomic<std::size_t> tail_{0};
    std::size_t head_cache_ = 0;

    alignas(kLine) std::unique_ptr<T[]> slots_;
};

}  // namespace ticker
