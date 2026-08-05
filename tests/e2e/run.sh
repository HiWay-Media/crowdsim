#!/usr/bin/env bash
#
# The only suite that generates load. It brings up an nginx container on loopback, runs a short, small
# load against it, and asserts on the summary the driver wrote.
#
# What it proves: the whole chain works against a real socket — profile resolution, the k6 scenarios, the
# cache classification, the summary, the history row, and the GUI reading them back.
# What it does NOT prove: that any number means anything. Nothing here queues, so there is no knee to
# find; a capacity result needs a system that can actually saturate.
#
# Needs docker and k6. Exits 0 only if every assertion holds.
set -eo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/.out"
PROFILE="$HERE/profile.json"
BASE="http://127.0.0.1:18080"

say() { printf '%s\n' "$*"; }
ok()  { printf '  ✅ %s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "e2e needs docker (the target is a container)"
command -v k6     >/dev/null 2>&1 || die "e2e needs k6 natively — see: crowdsim doctor"

cleanup() {
  ( cd "$HERE" && docker compose down --remove-orphans >/dev/null 2>&1 ) || true
}
trap cleanup EXIT

rm -rf "$OUT"
mkdir -p "$OUT"

say "▶ bringing up the local target"
( cd "$HERE" && docker compose up -d --force-recreate >/dev/null )

for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "$BASE/" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = "30" ] && die "the target never came up on $BASE"
done
ok "target answering on $BASE"

say "▶ probe"
CROWDSIM_OUT="$OUT" "$ROOT/bin/crowdsim" probe --profile "$PROFILE" >/dev/null \
  || die "probe failed against a target that answers curl"
grep -qi 'x-proxy-cache' "$OUT"/probe-*.log || die "probe did not capture the cache header"
ok "probe saw the cache headers"

# Small and short on purpose: this suite must be safe to run anywhere, including in CI on a laptop.
say "▶ load (peak 12 req/s, ~20s)"
CROWDSIM_OUT="$OUT" "$ROOT/bin/crowdsim" load --profile "$PROFILE" \
  --peak 12 --start 6 --steps 2 --step-dur 5s --hold 8s > "$OUT/run.log" 2>&1 \
  || die "the load command exited non-zero (see $OUT/run.log)"

SUMMARY="$(ls -1 "$OUT"/summary-*.json 2>/dev/null | tail -1)"
[ -n "$SUMMARY" ] || die "no summary was written (see $OUT/run.log)"
ok "summary written: $(basename "$SUMMARY")"

python3 - "$SUMMARY" "$OUT/history.tsv" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
fail = []

def check(cond, msg):
    if not cond: fail.append(msg)

check(d['requests'] > 50, f"only {d['requests']} requests in ~20s at 12 req/s")
check(d['generator_ok'] is True, f"generator did not hold the rate: {d['dropped_iterations']} dropped")
check(d['target_unreachable'] is False, "the target was reported unreachable")
check(d['aborted'] is False, "the brake tripped against a static nginx: the SLO or the ramp is wrong")
check(d['failed_rate'] < 0.01, f"failed rate {d['failed_rate']} against a static nginx")
check(d['e504'] == 0 and d['e502'] == 0, f"5xx from nginx: 504={d['e504']} 502={d['e502']}")
check(d['dur']['p95'] is not None and d['dur']['p95'] < 2000, f"p95 {d['dur']['p95']} ms on loopback")

# every class in the mix must have produced requests: a class silently generating nothing is the bug
# that makes a load test measure a mix other than the one in the profile
for cls in ('rsc_page', 'html', 'static'):
    pc = d['per_class'].get(cls) or {}
    check(pc.get('reqs', 0) > 0, f"class {cls} generated nothing")

# the mix must be roughly the declared 50/30/20, not a uniform split
total = sum(d['per_class'][c]['reqs'] for c in ('rsc_page', 'html', 'static'))
share = d['per_class']['rsc_page']['reqs'] / max(1, total)
check(0.35 < share < 0.65, f"rsc_page got {share:.0%} of requests, expected ~50%")

# classification: nginx declares X-Proxy-Cache on every response and never X-Cache
check(d['cache'].get('proxy') == 1.0, f"proxy hit ratio {d['cache'].get('proxy')}, expected 1.0")
check(d['cache'].get('cdn') is None, "a layer whose header never appeared must be null, not 0")

rows = [l for l in open(sys.argv[2]).read().split('\n') if l.strip()]
check(len(rows) == 2, f"history.tsv has {len(rows)} lines, expected header + 1 run")
check(d['run_id'] in rows[-1], "the history row does not reference this run")

if fail:
    print('\n'.join('  ❌ ' + f for f in fail))
    sys.exit(1)
print('  ✅ summary, mix, cache classification and history all consistent')
PY

say "▶ GUI reads the same archive"
CROWDSIM_OUT="$OUT" CROWDSIM_PROFILES="$HERE" CROWDSIM_GUI_PORT=18787 \
  node "$ROOT/gui/server/index.js" > "$OUT/gui.log" 2>&1 &
GUI_PID=$!
disown "$GUI_PID" 2>/dev/null || true      # otherwise bash prints "Terminated" when the trap kills it
trap 'kill "$GUI_PID" 2>/dev/null || true; cleanup' EXIT
for i in $(seq 1 20); do
  curl -fsS --max-time 2 http://127.0.0.1:18787/api/env >/dev/null 2>&1 && break
  sleep 0.5
  [ "$i" = "20" ] && die "the GUI server did not start (see $OUT/gui.log)"
done
curl -fsS http://127.0.0.1:18787/api/history \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["runs"], "GUI history is empty"; print("  ✅ GUI lists", len(d["runs"]), "run(s)")'

say ""
ok "end-to-end suite passed"
