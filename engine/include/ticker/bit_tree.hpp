// Three-level bitmap over price levels. Finds the next non-empty level above or below
// a price in O(1): l0 has a bit per price, l1 a bit per non-zero l0 word, l2 a bit per
// non-zero l1 word. Supports up to 64^3 prices.
#pragma once

#include <bit>
#include <cassert>
#include <cstdint>
#include <vector>

namespace ticker {

class BitTree {
public:
    static constexpr std::size_t kMaxBits = 64 * 64 * 64;  // 262144

    explicit BitTree(std::size_t nbits) : nbits_(nbits), l0_((nbits + 63) / 64), l1_((l0_.size() + 63) / 64) {
        assert(nbits > 0 && nbits <= kMaxBits);
    }

    std::size_t size() const { return nbits_; }

    bool test(std::size_t i) const { return (l0_[i >> 6] >> (i & 63)) & 1; }

    void set(std::size_t i) {
        const std::size_t w = i >> 6;
        l0_[w] |= bit(i & 63);
        l1_[w >> 6] |= bit(w & 63);
        l2_ |= bit(w >> 6);
    }

    void clear(std::size_t i) {
        const std::size_t w = i >> 6;
        l0_[w] &= ~bit(i & 63);
        if (l0_[w] == 0) {
            l1_[w >> 6] &= ~bit(w & 63);
            if (l1_[w >> 6] == 0) l2_ &= ~bit(w >> 6);
        }
    }

    bool empty() const { return l2_ == 0; }

    // Smallest set index >= i, or -1.
    std::int64_t find_next(std::size_t i) const {
        if (i >= nbits_) return -1;
        std::size_t w = i >> 6;
        if (std::uint64_t m = l0_[w] & from(i & 63)) return std::int64_t(w << 6 | std::countr_zero(m));
        std::size_t w1 = (w >> 6);
        if (std::uint64_t m = l1_[w1] & from((w & 63) + 1)) {
            w = w1 << 6 | std::countr_zero(m);
            return std::int64_t(w << 6 | std::countr_zero(l0_[w]));
        }
        if (std::uint64_t m = l2_ & from(w1 + 1)) {
            w1 = std::countr_zero(m);
            w = w1 << 6 | std::countr_zero(l1_[w1]);
            return std::int64_t(w << 6 | std::countr_zero(l0_[w]));
        }
        return -1;
    }

    // Largest set index <= i, or -1.
    std::int64_t find_prev(std::size_t i) const {
        if (i >= nbits_) i = nbits_ - 1;
        std::size_t w = i >> 6;
        if (std::uint64_t m = l0_[w] & upto(i & 63)) return std::int64_t(w << 6 | top(m));
        std::size_t w1 = w >> 6;
        if ((w & 63) != 0) {
            if (std::uint64_t m = l1_[w1] & upto((w & 63) - 1)) {
                w = w1 << 6 | top(m);
                return std::int64_t(w << 6 | top(l0_[w]));
            }
        }
        if (w1 != 0) {
            if (std::uint64_t m = l2_ & upto(w1 - 1)) {
                w1 = top(m);
                w = w1 << 6 | top(l1_[w1]);
                return std::int64_t(w << 6 | top(l0_[w]));
            }
        }
        return -1;
    }

private:
    static constexpr std::uint64_t bit(std::size_t b) { return std::uint64_t{1} << b; }
    // Bits [b, 63]. b may be 64, meaning none.
    static constexpr std::uint64_t from(std::size_t b) { return b >= 64 ? 0 : ~std::uint64_t{0} << b; }
    // Bits [0, b].
    static constexpr std::uint64_t upto(std::size_t b) { return b >= 63 ? ~std::uint64_t{0} : (bit(b + 1) - 1); }
    static constexpr unsigned top(std::uint64_t m) { return 63u - unsigned(std::countl_zero(m)); }

    std::size_t nbits_;
    std::vector<std::uint64_t> l0_;
    std::vector<std::uint64_t> l1_;
    std::uint64_t l2_ = 0;
};

}  // namespace ticker
