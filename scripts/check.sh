#!/usr/bin/env bash
# Run the same builds and tests as CI before pushing.
# Usage: scripts/check.sh [--fuzz]   (--fuzz adds the 1M-command differential run)
# clang sanitizer builds need libclang-rt-18-dev (apt install libclang-rt-18-dev); market-sim needs pytest; backend needs
# Node 20+, Postgres and Redis running locally.
set -euo pipefail
cd "$(dirname "$0")/.."

run() {
  local cxx=$1 type=$2 san=${3:-}
  local dir="engine/build-check/${cxx}-${san:-release}"
  echo "== $cxx ${san:-release}"
  cmake -S engine -B "$dir" -DCMAKE_CXX_COMPILER="$cxx" -DCMAKE_BUILD_TYPE="$type" \
    -DTICKER_SANITIZE="$san" > /dev/null
  cmake --build "$dir" -j > /dev/null
  if ! UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
    ctest --test-dir "$dir" --output-on-failure -j --timeout 120 > "$dir/ctest.log" 2>&1; then
    tail -50 "$dir/ctest.log"
    exit 1
  fi
}

run g++ RelWithDebInfo
run clang++ RelWithDebInfo
run clang++ Debug address,undefined
run clang++ RelWithDebInfo thread

echo "== market-sim"
(cd market-sim && TICKER_ENGINE=../engine/build-check/g++-release/ticker-engine \
  python3 -m pytest -q > ../engine/build-check/pytest.log 2>&1) || { tail -50 engine/build-check/pytest.log; exit 1; }

echo "== backend"
# Needs Postgres (ticker/ticker, database ticker_test) and Redis on localhost, like CI.
(
  cd backend
  [ -d node_modules ] || npm ci --silent
  npm run -s typecheck && npm run -s build && rm -rf dist &&
    TICKER_ENGINE=../engine/build-check/g++-release/ticker-engine REDIS_URL=${REDIS_URL:-redis://localhost:6379} \
    npx vitest run > ../engine/build-check/vitest.log 2>&1
) || { tail -60 engine/build-check/vitest.log; exit 1; }

if [ "${1:-}" = "--fuzz" ]; then
  echo "== differential fuzz (1M commands per seed)"
  TICKER_FUZZ_COMMANDS=1000000 engine/build-check/g++-release/engine_tests \
    --gtest_filter='Differential*' > /dev/null
fi

echo "all checks passed"
