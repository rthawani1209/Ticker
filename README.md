# Ticker

[![engine](https://github.com/rthawani1209/Ticker/actions/workflows/engine.yml/badge.svg)](https://github.com/rthawani1209/Ticker/actions/workflows/engine.yml)

Stock market simulator for student trading competitions, powered by a C++ matching engine.

Students get fake money and trade against each other and against bots on a real order book, so their orders actually move prices. Clubs and classes can run leagues with live leaderboards.

> Work in progress. The matching engine is being built first; the web app, bots and league features follow.

## Engine

The exchange core is in [`engine/`](engine). It is a C++20 limit order book with price-time priority:

- limit and market orders, GTC / IOC / FOK
- cancel and cancel/replace (shrinking an order keeps its place in line)
- self-trade prevention and price bands around the last trade
- O(1) cancel via an open-addressing id map, O(1) best-price lookup via a 3-level bitmap
- no heap allocation while matching (orders come from a pre-allocated pool)

Every change is checked against a small, obviously-correct reference book: the tests feed both the same random order flow and require identical output.

```bash
cmake -S engine -B engine/build
cmake --build engine/build -j
ctest --test-dir engine/build --output-on-failure
```

Run the differential test longer with `TICKER_FUZZ_COMMANDS=1000000 engine/build/engine_tests --gtest_filter='Differential*'`.
