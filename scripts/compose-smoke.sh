#!/usr/bin/env bash
# Starts the whole stack with Docker Compose and checks it works end to end:
# the backend is healthy, the simulated market trades, a person can sign up and
# place an order, and the web app serves pages with its security policy.
set -euo pipefail
cd "$(dirname "$0")/.."

cleanup() {
  if [ "${1:-0}" != 0 ]; then docker compose logs --tail 80; fi
  docker compose down -v
}
trap 'cleanup $?' EXIT

docker compose up -d --build

echo "waiting for the backend"
for _ in $(seq 90); do
  curl -sf localhost:8080/health > /dev/null && break
  sleep 2
done
curl -sf localhost:8080/health

echo "waiting for the simulated market to trade"
for _ in $(seq 60); do
  volume=$(curl -sf localhost:8080/v1/symbols | python3 -c "import json,sys; print(sum(s['volume'] for s in json.load(sys.stdin)))")
  [ "$volume" -gt 0 ] && break
  sleep 2
done
echo "volume: $volume"
[ "$volume" -gt 0 ]

echo "signing up and placing an order"
token=$(curl -sf localhost:8080/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","username":"smoke","password":"correct horse battery"}' |
  python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])")
quote=$(curl -sf localhost:8080/v1/market/NOVA | python3 -c "import json,sys; q=json.load(sys.stdin); print(q['bid'] or q['last'])")
curl -sf localhost:8080/v1/orders -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d "{\"symbol\":\"NOVA\",\"side\":\"buy\",\"price\":$quote,\"qty\":1}" | grep -q '"status"'

echo "checking the web app"
for _ in $(seq 30); do
  curl -sf -o /dev/null localhost:3000/ && break
  sleep 2
done
curl -sfI localhost:3000/ | grep -qi "content-security-policy: default-src 'self'"
curl -sf localhost:3000/trade | grep -q "TICKER\|Ticker"
echo "compose smoke test passed"
