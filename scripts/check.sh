#!/usr/bin/env bash
# Run the same builds and tests as CI before pushing.
# Usage: scripts/check.sh [--fuzz]   (--fuzz adds the 1M-command differential run)
# clang sanitizer builds need libclang-rt-18-dev (apt install libclang-rt-18-dev).
set -euo pipefail
cd "$(dirname "$0")/.."

run() {
  local cxx=$1 type=$2 san=${3:-}
  local dir="engine/build-check/${cxx}-${san:-release}"
  echo "== $cxx ${san:-release}"
  cmake -S engine -B "$dir" -DCMAKE_CXX_COMPILER="$cxx" -DCMAKE_BUILD_TYPE="$type" \
    -DTICKER_SANITIZE="$san" > /dev/null
  cmake --build "$dir" -j > /dev/null
  UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
    ctest --test-dir "$dir" --output-on-failure -j > /dev/null
}

run g++ RelWithDebInfo
run clang++ RelWithDebInfo
run clang++ Debug address,undefined
run clang++ RelWithDebInfo thread

if [ "${1:-}" = "--fuzz" ]; then
  echo "== differential fuzz (1M commands per seed)"
  TICKER_FUZZ_COMMANDS=1000000 engine/build-check/g++-release/engine_tests \
    --gtest_filter='Differential*' > /dev/null
fi

echo "all checks passed"
