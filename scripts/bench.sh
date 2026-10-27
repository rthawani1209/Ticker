#!/usr/bin/env bash
# Runs the engine benchmarks on a Release build and saves the numbers to
# docs/results/engine-bench-<date>.json. Every number in docs/CLAIMS.md comes from
# one of these files.
# Usage: scripts/bench.sh [runs]   (default 3 latency runs; the median run is reported)
set -euo pipefail
cd "$(dirname "$0")/.."
runs=${1:-3}
dir=engine/build-bench
cmake -S engine -B "$dir" -DCMAKE_BUILD_TYPE=Release -DTICKER_BUILD_TESTS=OFF > /dev/null
cmake --build "$dir" -j --target latency book_bench > /dev/null

tmp=$(mktemp -d)
for i in $(seq "$runs"); do "$dir/latency" > "$tmp/latency-$i.txt"; done
"$dir/book_bench" --benchmark_min_time=0.5s --benchmark_repetitions=3 \
  --benchmark_report_aggregates_only=true --benchmark_out="$tmp/book.json" --benchmark_out_format=json > /dev/null

out="docs/results/engine-bench-$(date -u +%F).json"
python3 - "$tmp" "$runs" "$out" <<'PY'
import glob, json, platform, re, subprocess, sys, datetime
tmp, runs, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]

def parse(path):
    d = {}
    for line in open(path):
        m = re.match(r"(\w+(?:\.\d)?)\s+(\d+)", line)
        if m:
            d[m.group(1)] = int(m.group(2))
    return d

lat = sorted((parse(p) for p in glob.glob(f"{tmp}/latency-*.txt")), key=lambda d: d["p50"])
median = lat[len(lat) // 2]
book = json.load(open(f"{tmp}/book.json"))
cpu = next((l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name")), "unknown")
result = {
    "date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "machine": {"cpu": cpu, "cores": book["context"]["num_cpus"], "os": platform.platform(),
                "compiler": subprocess.run(["c++", "--version"], capture_output=True, text=True).stdout.splitlines()[0]},
    "command": f"scripts/bench.sh {runs}",
    "latency_ns": {"runs": lat, "reported": median,
                   "note": "time inside the order book per command, 2M commands of mixed flow; median run by p50"},
    "throughput": {b["run_name"]: {"real_time": round(b["real_time"], 1), "time_unit": b["time_unit"],
                                   "items_per_second": round(b.get("items_per_second", 0))}
                   for b in book["benchmarks"] if b.get("aggregate_name") == "median"},
}
json.dump(result, open(out, "w"), indent=2)
print(out)
PY
rm -rf "$tmp"
