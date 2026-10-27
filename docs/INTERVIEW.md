# Interview notes

How to explain Ticker out loud. Each answer gives what it is, why it was done that way, the trade-off, and what breaks without it. The numbers are in [CLAIMS.md](CLAIMS.md).

## The 30-second version

"Ticker is a stock market simulator for student trading competitions. Most practice apps copy real prices, so your orders never move anything. I built a real exchange in C++ that matches orders in about 200 nanoseconds, plus bots and a news engine in Python so the market moves on its own, and a TypeScript gateway that handles logins and turns JSON orders into a compact binary protocol."

## Likely questions

**How does matching work?**
Best price first, then first come, first served at that price (price-time priority). Each price level keeps its orders in a linked list, oldest at the front. An incoming buy walks the sell side from the lowest price up, filling against the front of each list, until it's filled or the next price is too expensive.

**How do you cancel an order instantly among thousands?**
A hash map goes from order id straight to the order's node in its price level's doubly linked list. Removing a node from a doubly linked list is a couple of pointer updates. So cancel is O(1). In the benchmark, add-and-cancel takes about the same time with 100 resting orders as with 10,000. The simple reference book, which searches a list, goes from under a microsecond to about 47 µs.
*Follow-up: why "intrusive"?* The list pointers live inside the order struct itself, so there is no separate list node to allocate.

**How do you find the best price fast when the book is sparse?**
A three-level bitmap over all prices. The top 64-bit word says which blocks have anything, the next level which words, the bottom which prices. Finding the next set bit at each level is one CPU instruction (count leading/trailing zeros), so it's three steps whether the next price is 1 cent away or 500 dollars away.

**Why does the matching path never allocate memory?**
`malloc` can take a lock or occasionally take a long time, and that shows up as latency spikes. Orders come from a pool sized up front. There's a test that swaps out the global `new` and fails if matching ever calls it.
*Trade-off:* the pool has a fixed size. If it's full the engine cancels the incoming order (`BookFull`) instead of growing.

**How do you know matching is correct?**
Three ways. (1) Unit tests for every order type and rule. (2) A differential fuzzer: a deliberately simple reference engine (std::map and std::list, easy to check by reading) gets the same random orders as the fast one, and the outputs must match byte for byte. CI runs 20 million commands that way. When I broke the replace rule on purpose to test the tests, the fuzzer caught it. (3) AddressSanitizer, UndefinedBehaviorSanitizer and ThreadSanitizer jobs in CI.

**Why one thread for matching?**
No locks, no races, and the output depends only on the input order, which makes replay exact. One core can do millions of orders a second, far more than a student competition needs. To scale, you split symbols across threads ("shards"), and each shard is still single-threaded.

**How do the network thread and the matching thread talk?**
Through lock-free single-producer/single-consumer ring buffers. The producer only writes the tail, the consumer only writes the head, and each reads the other's with acquire ordering. Head and tail sit on separate cache lines so the two cores don't fight over one line (false sharing). ThreadSanitizer checks it in CI. Removing the release ordering makes the TSan test fail.

**What if the exchange crashes mid-day?**
Every command is written to a journal (with a checksum) before it's processed and before anyone gets an answer. On restart the engine replays the journal and ends up in exactly the same state, because matching only depends on the inputs, including the timestamps the gateway stamped on them. If the crash cut the last record in half, the checksum catches it and the record is dropped. Nobody was ever told it succeeded.

**Why a binary protocol instead of JSON between the gateway and the engine?**
Fixed-size structs need no parsing: check the header, then copy the bytes. The same bytes go to the journal, so replay reads exactly what the engine saw. JSON is fine at the edge for browsers. The gateway translates.
*Note:* a NewOrder message is 48 bytes.

**Why C++ for the engine and TypeScript/Python for the rest?**
Put the effort where latency matters. Matching is a hot loop where memory layout matters, so C++. The gateway is mostly I/O and validation, where Node is productive and has good libraries. The bots are research-style code where Python is quickest to change.

**How do logins stay secure?**
argon2id password hashes (slow on purpose, and memory-hard so GPU cracking is expensive). Short 15-minute access tokens, so a leaked one expires quickly. Refresh tokens are single-use and rotate. If an old one shows up again, the whole session family is revoked, because that means two parties hold the same token. Login attempts are rate limited per IP, and the limiter ignores `X-Forwarded-For` unless we're behind a known load balancer, so an attacker can't fake a new IP on every attempt.

**What happens if the gateway loses its connection to the engine?**
It reconnects with backoff and asks for fresh snapshots of every book. Orders that were waiting for an answer when the connection dropped are marked rejected after the timeout. If the engine did take one, its next fill carries our order id and the gateway reattaches it. The known gap: fills that happen while disconnected are missed. The fix is to number the engine's output and replay from the last number seen. That's on the plan.

## Do this yourself (about an hour)

1. Build and run the tests: `cmake -S engine -B engine/build && cmake --build engine/build -j && ctest --test-dir engine/build`.
2. Read `BookTest.PriceThenTimePriority` and `BookTest.ReplaceDownKeepsPriority` in `engine/tests/order_book_test.cpp`, then work through the same orders on paper.
3. Run `scripts/bench.sh` and compare your numbers with `docs/results/`.
4. Start the engine and the bots (`market-sim/README.md`), run the `flash-crash` scenario, and explain what the bots, the halt and the prices do.
