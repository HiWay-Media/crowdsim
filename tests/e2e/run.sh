#!/usr/bin/env bash
#
# The only suite that generates load. Two containers on loopback, two legs, a few hundred requests total.
#
#   leg 1 — a fast static nginx: the whole chain works and a healthy target does NOT trip the brake.
#           Profile resolution, the k6 scenarios, the mix proportions, the cache classification, the
#           summary, the history row, and the GUI reading them back.
#   leg 2 — a slow origin with one worker: the brake DOES abort a run. Nothing else in the test suite can
#           prove that. The brake is a k6 threshold with abortOnFail; a typo in a threshold expression, or
#           a metric renamed by a k6 upgrade, produces a run that no longer stops — and the first person
#           to notice would be whoever is watching the outage it existed to cut short.
#
# What it does not prove: that any number means anything. These targets are models, not systems.
#
# Needs docker and k6. Missing either is a SKIP (exit 0), not a failure: the suite is legitimately skipped
# on most machines, and a red run that means "you don't have docker" teaches people to ignore red runs.
# A failed assertion is still a failure (exit 1).
set -eo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/.out"
FAST_PROFILE="$HERE/profile.json"
SLOW_PROFILE="$HERE/profile-slow.json"
FAST="http://127.0.0.1:18080"
SLOW="http://127.0.0.1:18081"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
die()  { printf '❌ %s\n' "$*" >&2; exit 1; }
skip() { printf '⏭  SKIPPED: %s\n' "$*"; exit 0; }

command -v docker >/dev/null 2>&1 || skip "docker is not available (the targets are containers)"
docker info >/dev/null 2>&1       || skip "the docker daemon is not running"
command -v k6 >/dev/null 2>&1     || skip "k6 is not installed — see: crowdsim doctor"

cleanup() { ( cd "$HERE" && docker compose down --remove-orphans >/dev/null 2>&1 ) || true; }
trap cleanup EXIT

rm -rf "$OUT"; mkdir -p "$OUT"

say "▶ bringing up the local targets"
( cd "$HERE" && docker compose up -d --force-recreate >/dev/null )

wait_for() {
  local url="$1" name="$2" i
  for i in $(seq 1 30); do
    curl -fsS --max-time 2 "$url/" >/dev/null 2>&1 && { ok "$name answering on $url"; return 0; }
    sleep 1
  done
  die "$name never came up on $url"
}
wait_for "$FAST" "fast target"
wait_for "$SLOW" "slow target"

# ─────────────────────────────── leg 1: the chain works ─────────────────────────────────────────────
say ""
say "▶ leg 1 — probe"
CROWDSIM_OUT="$OUT" "$ROOT/bin/crowdsim" probe --profile "$FAST_PROFILE" >/dev/null \
  || die "probe failed against a target that answers curl"
grep -qi 'x-proxy-cache' "$OUT"/probe-*.log || die "probe did not capture the cache header"
ok "probe saw the cache headers"

# Small and short on purpose: this suite must be safe to run anywhere, including CI on a laptop.
say "▶ leg 1 — load (peak 12 req/s, ~20s)"
CROWDSIM_OUT="$OUT" "$ROOT/bin/crowdsim" load --profile "$FAST_PROFILE" \
  --peak 12 --start 6 --steps 2 --step-dur 5s --hold 8s > "$OUT/fast.log" 2>&1 \
  || die "the load command exited non-zero (see $OUT/fast.log)"

FAST_SUMMARY="$(ls -1 "$OUT"/summary-*.json 2>/dev/null | tail -1)"
[ -n "$FAST_SUMMARY" ] || die "no summary was written (see $OUT/fast.log)"
ok "summary written: $(basename "$FAST_SUMMARY")"

python3 - "$FAST_SUMMARY" "$OUT/history.tsv" <<'PY'
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

# every class in the mix must have produced requests: a class silently generating nothing is the bug that
# makes a load test measure a mix other than the one in the profile
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
    print('\n'.join('  ❌ ' + f for f in fail)); sys.exit(1)
print('  ✅ summary, mix, cache classification and history all consistent')
PY

# ─────────────────────────────── leg 2: the brake aborts ────────────────────────────────────────────
# One worker at 300 ms means ~3.3 req/s of capacity; asking for 4 makes the queue grow, so latency crosses
# the profile's 700 ms p95 SLO within a few seconds while requests still complete. That distinction is the
# point: this is an unambiguous knee (the generator holds the rate, nothing times out), not a target that
# stopped answering.
say ""
say "▶ leg 2 — the brake must abort (peak 4 req/s against one 300 ms worker)"
PLANNED=30                      # 1 step × 15s + 15s hold
START_TS=$(date +%s)
set +e
CROWDSIM_OUT="$OUT" "$ROOT/bin/crowdsim" load --profile "$SLOW_PROFILE" \
  --peak 4 --start 3 --steps 1 --step-dur 15s --hold 15s --abort-delay 5s > "$OUT/slow.log" 2>&1
RC=$?
set -e
ELAPSED=$(( $(date +%s) - START_TS ))

# The brake tripping makes k6 exit non-zero; the driver must still exit 0, because finding the knee is an
# outcome and a scheduler must not file a successful experiment as a failed job.
[ "$RC" = "0" ] || die "the driver exited $RC when the brake tripped — it must exit 0 (see $OUT/slow.log)"
ok "the driver exited 0 with the brake tripped"

# The run must have stopped EARLY. Without this, a brake that never fires passes by simply finishing.
[ "$ELAPSED" -lt "$PLANNED" ] \
  || die "the run took ${ELAPSED}s of a planned ${PLANNED}s: the brake did not stop it early"
ok "stopped after ${ELAPSED}s of a planned ${PLANNED}s"

SLOW_SUMMARY="$(ls -1 "$OUT"/summary-*.json | tail -1)"
[ "$SLOW_SUMMARY" != "$FAST_SUMMARY" ] || die "the brake leg wrote no summary of its own"

python3 - "$SLOW_SUMMARY" "$SLOW_PROFILE" "$OUT/history.tsv" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
slo = json.load(open(sys.argv[2]))['slo']
fail = []
def check(cond, msg):
    if not cond: fail.append(msg)

check(d['aborted'] is True, "the brake did not trip against a target well past its capacity")

# An unambiguous knee: the generator held the rate and the target kept answering. Without these two, an
# abort could equally mean "the generator collapsed" or "the target stopped talking to us".
check(d['generator_ok'] is True, f"{d['dropped_iterations']} dropped iterations: the abort is ambiguous")
check(d['target_unreachable'] is False, "reported unreachable: a refused connection is not a knee")

# The brake condition itself: the brake class crossed its p95 SLO.
brake = d['per_class'][slo['brake_class']]
check(brake['p95'] is not None and brake['p95'] > slo['max_p95_ms'],
      f"{slo['brake_class']} p95 {brake['p95']} did not cross the SLO of {slo['max_p95_ms']} ms")

# Present, but not asserted above zero: at the moment the brake fires, the share past the read timeout is
# stochastic (it was 0% and 6.7% on two consecutive runs). Asserting a value would make this flaky, and the
# condition that actually stopped the run is the p95 above.
check(d['over_guillotine_rate'] is not None, "over_guillotine_rate missing from the summary")
check(d['requests'] > 0, "the aborted run recorded no requests at all")

rows = [l for l in open(sys.argv[3]).read().split('\n') if l.strip()]
check(len(rows) == 3, f"history.tsv has {len(rows)} lines, expected header + 2 runs")
check(d['run_id'] in rows[-1], "the aborted run has no history row")
check('True' in rows[-1], "the history row does not record the run as aborted")

if fail:
    print('\n'.join('  ❌ ' + f for f in fail)); sys.exit(1)
print(f"  ✅ aborted at p95 {round(brake['p95'])} ms against an SLO of {slo['max_p95_ms']} ms, "
      "generator held, target reachable, history recorded")
PY

# ─────────────────────────────── the GUI reads the same archive ─────────────────────────────────────
say ""
say "▶ the GUI reads the same archive"
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
curl -fsS http://127.0.0.1:18787/api/history | python3 -c '
import json, sys
runs = json.load(sys.stdin)["runs"]
assert len(runs) == 2, f"the GUI lists {len(runs)} runs, expected 2"
aborted = [r for r in runs if r["aborted"]]
assert len(aborted) == 1, "the GUI does not distinguish the aborted run"
print(f"  ✅ GUI lists {len(runs)} runs, one of them aborted")'

say ""
ok "end-to-end suite passed"
