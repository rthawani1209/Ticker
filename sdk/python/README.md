# Ticker Python starter kit

Write a trading bot for the Ticker exchange. Standard library only: Python 3.10+, nothing to install.

## 1. Get a key

Sign in, then make a key (the app's API keys panel does the same):

```bash
curl -X POST https://YOUR-API/v1/keys -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "content-type: application/json" -d '{"name": "my bot", "maxOrderQty": 100, "ordersPerSecond": 5}'
```

The `key` in the reply (`tk_...`) is shown once. Keep it out of git. A key trades in one league (the
practice league unless you pass `"league": ID`), can't send more than `maxOrderQty` shares an order or
more than `ordersPerSecond` orders a second, and can only trade and read its own account.

## 2. Trade

```python
from ticker_sdk import Ticker

t = Ticker("https://YOUR-API", "tk_...")
q = t.quote("NOVA")            # last, bid, ask, mid and the book, in dollars
order = t.buy("NOVA", 10, price=q.bid)
print(order.status)            # "open", or "rejected" with order.reject_reason
t.cancel(order.id)
print(t.position("NOVA"), t.positions()["equity"])
```

Errors raise `TickerError` (`status`, `code`, `message`). Going over your key's rate raises
`RateLimited` with `retry_after` seconds. A 503 with code `bots_paused` means an admin has
paused all bots.

## 3. The sample market maker

`examples/market_maker.py` keeps a bid and an ask around the mid price and leans them against its
inventory, so it sells more readily when it's long and buys more readily when it's short. It stops
adding to a side at `--max-inventory`, and cancels its quotes when you stop it.

```bash
TICKER_URL=https://YOUR-API TICKER_KEY=tk_... python examples/market_maker.py NOVA --spread-bps 20
```

## Tests

```bash
python -m pytest
```

They run the client and the market maker against a small fake of the API.
