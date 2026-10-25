# market-sim

Trading bots and a news engine that keep the Ticker market moving, so the demo works with nobody logged in. Written in Python with no dependencies outside the standard library.

The simulator logs on to `ticker-engine` as one proxy session and trades for every bot, each with its own account. It talks the engine's binary protocol directly ([docs/protocol.md](../docs/protocol.md)).

## Bots

| Bot | What it does |
|-----|--------------|
| Market maker | Keeps a ladder of bids and asks around its estimate of fair value. Leans its quotes against its inventory and quotes wider right after news. |
| Momentum | Buys when the short-term average price climbs above the long-term one, sells on the way down, and protects each position with a stop order. |
| Noise | Small random orders, mostly resting, some crossing the spread. Stands in for the casual crowd. |
| News trader | Reads each headline, waits a human-ish reaction time, trades in its direction, then takes profit a minute or so later. |

Each company has a hidden "true" value that drifts randomly and jumps on news. Market makers follow it with a lag, which is what lets news traders profit and makes prices move in steps rather than all at once.

## News and scenarios

The news engine produces company headlines (earnings, FDA decisions, contract wins, lawsuits...) and market-wide ones (rate moves, jobs reports) that move each sector differently.

Scenario cases live in [`scenarios/`](scenarios) as TOML files: how many bots of each kind, how noisy the market is, and scripted events.

| Scenario | What happens |
|----------|--------------|
| `calm` | An ordinary day. |
| `earnings-season` | A headline every 20 seconds, mostly results and analyst calls. |
| `flash-crash` | Fraud allegation hits ORBT; market makers pull back and the drop trips the circuit breaker. |
| `meme-rally` | Good news and momentum traders push a $12 stock up until a takeover rumor trips the breaker. |
| `rate-shock` | A surprise rate hike moves every stock at once. |

## Running it

```bash
# terminal 1: the exchange
engine/build/ticker-engine --port 9100 --token 1234

# terminal 2: the bots
cd market-sim
python -m ticker_sim --token 1234 --scenario flash-crash --news-out news.jsonl
python -m ticker_sim --list
```

Every 10 seconds it prints orders sent, trades, rejects and the latest prices.

## Tests

```bash
cd market-sim
pip install pytest
python -m pytest
```

The unit tests drive each bot against a fake engine. `test_engine_integration.py` starts a real `ticker-engine` (build it first) and checks that a calm market trades with tight books and that a crash trips the circuit breaker.
