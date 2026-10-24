#pragma once

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>

namespace ticker {

// Log-linear latency histogram, in the spirit of HdrHistogram: values below 128 are
// exact, above that each power of two is split into 64 buckets, so any reported
// percentile is within about 1.6% of the true value. Fixed size, no allocation.
class LatencyHistogram {
public:
    void record(std::uint64_t v) {
        if (v > kMaxValue) v = kMaxValue;
        ++counts_[index(v)];
        ++total_;
        if (v > max_) max_ = v;
    }

    // Upper edge of the bucket holding the p-th percentile (0 < p <= 1).
    std::uint64_t percentile(double p) const {
        if (total_ == 0) return 0;
        auto rank = std::uint64_t(p * double(total_));
        if (rank == 0) rank = 1;
        std::uint64_t seen = 0;
        for (std::size_t i = 0; i < counts_.size(); ++i) {
            seen += counts_[i];
            if (seen >= rank) return std::min(upper(i), max_);
        }
        return max_;
    }

    std::uint64_t count() const { return total_; }
    std::uint64_t max() const { return max_; }

    void reset() {
        counts_.fill(0);
        total_ = 0;
        max_ = 0;
    }

private:
    static constexpr std::uint64_t kMaxValue = (std::uint64_t{1} << 40) - 1;  // ~18 minutes in ns
    static constexpr std::size_t kBuckets = 128 + 34 * 64;

    static std::size_t index(std::uint64_t v) {
        if (v < 128) return std::size_t(v);
        unsigned e = unsigned(63 - std::countl_zero(v)) - 6;  // v >> e is in [64, 128)
        return 128 + (e - 1) * 64 + std::size_t((v >> e) - 64);
    }

    static std::uint64_t upper(std::size_t i) {
        if (i < 128) return i;
        std::size_t k = i - 128;
        unsigned e = unsigned(k / 64) + 1;
        std::uint64_t sub = k % 64 + 64;
        return ((sub + 1) << e) - 1;
    }

    std::array<std::uint64_t, kBuckets> counts_{};
    std::uint64_t total_ = 0;
    std::uint64_t max_ = 0;
};

}  // namespace ticker
