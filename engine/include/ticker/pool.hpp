#pragma once

#include <cstddef>
#include <memory>

namespace ticker {

// Fixed-capacity free list. All memory is allocated in the constructor, so acquire()
// and release() never touch the heap. T must have a `T* next` member.
template <typename T>
class Pool {
public:
    explicit Pool(std::size_t capacity) : storage_(std::make_unique<T[]>(capacity)), capacity_(capacity) {
        for (std::size_t i = 0; i < capacity; ++i) storage_[i].next = i + 1 < capacity ? &storage_[i + 1] : nullptr;
        free_ = capacity ? &storage_[0] : nullptr;
    }

    Pool(const Pool&) = delete;
    Pool& operator=(const Pool&) = delete;

    // Returns nullptr when the pool is exhausted.
    T* acquire() {
        T* t = free_;
        if (t) {
            free_ = t->next;
            ++in_use_;
        }
        return t;
    }

    void release(T* t) {
        t->next = free_;
        free_ = t;
        --in_use_;
    }

    std::size_t in_use() const { return in_use_; }
    std::size_t capacity() const { return capacity_; }

private:
    std::unique_ptr<T[]> storage_;
    std::size_t capacity_;
    T* free_ = nullptr;
    std::size_t in_use_ = 0;
};

}  // namespace ticker
