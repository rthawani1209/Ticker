#pragma once

#include <bit>
#include <cassert>
#include <cstdint>
#include <vector>

namespace ticker {

// Open-addressing hash map from order id to a pointer, sized once up front.
// Linear probing with backward-shift deletion, so there are no tombstones and
// lookups stay short even after millions of inserts and erases. Key 0 marks an
// empty slot, which is fine because order ids start at 1.
template <typename V>
class OrderMap {
public:
    explicit OrderMap(std::size_t max_items) {
        std::size_t cap = std::bit_ceil(max_items * 2 + 1);
        slots_.resize(cap);
        mask_ = cap - 1;
    }

    V* find(std::uint64_t key) const {
        for (std::size_t i = index(key);; i = (i + 1) & mask_) {
            const Slot& s = slots_[i];
            if (s.key == key) return s.value;
            if (s.key == 0) return nullptr;
        }
    }

    void insert(std::uint64_t key, V* value) {
        assert(key != 0 && size_ < slots_.size() / 2);
        std::size_t i = index(key);
        while (slots_[i].key != 0) i = (i + 1) & mask_;
        slots_[i] = {key, value};
        ++size_;
    }

    bool erase(std::uint64_t key) {
        std::size_t i = index(key);
        while (slots_[i].key != key) {
            if (slots_[i].key == 0) return false;
            i = (i + 1) & mask_;
        }
        // Shift later entries of the same probe run back into the hole.
        std::size_t hole = i;
        for (std::size_t j = (i + 1) & mask_; slots_[j].key != 0; j = (j + 1) & mask_) {
            std::size_t home = index(slots_[j].key);
            // Move j into the hole unless its home lies cyclically in (hole, j].
            bool stays = hole <= j ? (hole < home && home <= j) : (hole < home || home <= j);
            if (!stays) {
                slots_[hole] = slots_[j];
                hole = j;
            }
        }
        slots_[hole] = {};
        --size_;
        return true;
    }

    std::size_t size() const { return size_; }

private:
    struct Slot {
        std::uint64_t key = 0;
        V* value = nullptr;
    };

    std::size_t index(std::uint64_t key) const {
        // Fibonacci hashing spreads sequential ids across the table.
        return std::size_t((key * 0x9E3779B97F4A7C15ull) >> 32) & mask_;
    }

    std::vector<Slot> slots_;
    std::size_t mask_ = 0;
    std::size_t size_ = 0;
};

}  // namespace ticker
