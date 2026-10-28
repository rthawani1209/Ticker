# Benchmarks

**Numbers to quote** come only from the results files in [`results/`](results), written by `scripts/bench.sh` with the date, machine and command inside. [CLAIMS.md](CLAIMS.md) and the README quote the latest one: [`engine-bench-2026-10-28.json`](results/engine-bench-2026-10-28.json), p50 143 ns, p99 1.6 µs, 7.6M commands/sec on a 4 vCPU cloud VM (Xeon @ 2.80GHz, g++ 13.3).

The write-up further down is from the very first run on 2026-10-23, before `scripts/bench.sh` existed. It has no results file, so **don't quote its numbers** (they came out faster: p50 125 ns, 8.3M cmd/s). It's kept because it explains what the benchmarks measure. Shared cloud VMs vary by 20-40% between runs, which is why every quoted number names its file.

Numbers from the engine's own tools. Re-run them yourself:

```bash
cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release
cmake --build engine/build -j
engine/build/latency            # per-order latency percentiles
engine/build/book_bench         # throughput vs the reference book
```

## 2026-10-23: matching core (first run, historical, not quoted)

Machine: 4 vCPU cloud VM (Intel Xeon @ 2.80GHz), g++ 13.3, Release build (`-O3`). One symbol, one thread.

### Latency per command (`latency`, 2M commands of mixed order flow)

This is time spent inside the order book only. No network, no queues.

| | ns |
|---|---|
| p50 | 125 |
| p90 | 310 |
| p99 | 1,542 |
| p99.9 | 4,063 |
| mean | 202 |

The flow is about 70% new orders (limit, market, IOC, FOK, stops), 18% cancels and 12% replaces, clustered around a drifting price. 854k trades happened over the run.

The max (about 2 ms) is a one-off stall from the VM, not the book. The tail between p99 and p99.9 is mostly large orders sweeping several price levels and stop cascades.

### Throughput (`book_bench`)

The baseline is the reference book used by the tests: `std::map` price levels, `std::list` queues, linear search to cancel. It is meant to be easy to read, not fast, so this shows what the data structures buy rather than a fair race.

| Benchmark | fast | reference |
|---|---|---|
| Mixed flow, 200k commands | 24.3 ms (8.3M cmd/s) | 443 ms (0.46M cmd/s) |
| Add + cancel, 100 resting orders | 141 ns | 632 ns |
| Add + cancel, 10,000 resting orders | 183 ns | 38,963 ns |
| Take one order + refill | 128 ns | 516 ns |

Add + cancel barely changes between 100 and 10,000 resting orders. That's the O(1) cancel (hash map from id to order node, intrusive list unlink) working as intended.

### Allocation

`alloc_test` replaces the global `operator new` and runs 300k commands through a warmed-up book: zero heap allocations.
