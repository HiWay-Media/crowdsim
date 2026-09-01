#!/usr/bin/env bash
#
# The only suite that generates load. Two containers on loopback, three legs, a few hundred requests total.
#
#   leg 1 — a fast static nginx: the whole chain works and a healthy target does NOT trip the brake.
#           Profile resolution, the k6 scenarios, the mix proportions, the cache classification, the
#           summary, the history row, and the GUI reading them back.
#   leg 2 — a slow origin with one worker: the brake DOES abort a run. Nothing else in the test suite can
#           prove that. The brake is a k6 threshold with abortOnFail; a typo in a threshold expression, or
#           a metric renamed by a k6 upgrade, produces a run that no longer stops — and the first person
#           to notice would be whoever is watching the outage it existed to cut short.
#   leg 3 — a target that never answers: reported as CONNECTIVITY, not as capacity. It uses an example
#           domain (www.example.test, reserved by RFC 6761) and does not resolve it — the profile's bypass
#           points the connection at a loopback port where nothing listens, so a resolver that hijacks
#           NXDOMAIN cannot turn this test into load against a stranger.
#
# The three legs are the three conclusions the tool exists to produce. What none of them proves is that any
# number means anything: these targets are models, not systems.
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
# A part of the suite that cannot run here, without failing the rest. `skip` exits; this does not — and it
# was missing until CI ran a branch this machine never takes, which is the whole reason it now exists.
warn() { printf '⚠️  %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || skip "docker is not available (the targets are containers)"
docker info >/dev/null 2>&1       || skip "the docker daemon is not running"
command -v k6 >/dev/null 2>&1     || skip "k6 is not installed — see: crowdsim doctor"

cleanup() { ( cd "$HERE" && docker compose down --remove-orphans >/dev/null 2>&1 ) || true; }
trap cleanup EXIT

rm -rf "$OUT"; mkdir -p "$OUT"

# WHICH k6 produced these numbers. The image pins one version and this suite runs whatever is installed, so
# a result has to carry its generator's version or it cannot be attributed later — and the gap between the
# two is exactly what the pinned job in .github/workflows/e2e.yml exists to close.
K6_VERSION="$(k6 version 2>/dev/null | head -1)"
PINNED_K6="$(grep -oE 'grafana/k6:[0-9]+\.[0-9]+\.[0-9]+' "$ROOT/Dockerfile" | head -1 | cut -d: -f2)"
printf '%s\n' "$K6_VERSION" > "$OUT/k6-version.txt"
say "▶ generator: $K6_VERSION"
case "$K6_VERSION" in
  *"v$PINNED_K6"*) ok "this is the version the image ships ($PINNED_K6)" ;;
  *) warn "the image ships k6 $PINNED_K6 — these results come from a different generator" ;;
esac

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

# The same measurement as data, which is what the GUI shows and what `load` reads back. nginx here declares
# X-Proxy-Cache on every response and never X-Cache, so this leg pins down all three answers a layer can
# give — hit, miss, and never spoke — against a real response rather than a fixture.
python3 - "$(ls -1 "$OUT"/probe-*.json | tail -1)" <<'PY' || die "the probe JSON does not classify the layers"
import json, sys
d = json.load(open(sys.argv[1]))
assert d['status'] == 200, d
assert d['bytes'] > 0, 'the page weight is what a peak gets multiplied by'
layers = {l['label']: l for l in d['layers']}
assert layers['proxy']['hit'] is True, layers['proxy']
assert layers['cdn']['hit'] is None, ('a header that never appeared must be unknown, never a miss',
                                      layers['cdn'])
assert 'set-cookie' not in d['headers'], 'a run archive is not the place for somebody\'s session'
print('  ✅ probe JSON: proxy HIT, cdn unknown (header absent), page weight recorded')
PY

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

# the ramp, step by step (#50). This is the only suite with a real ramp, so it is the only place the step
# attribution can be checked against requests that actually happened rather than a metric tree by hand.
steps = d.get('per_step')
check(isinstance(steps, list) and len(steps) >= 2, f"per_step has {steps and len(steps)} rows for a 2-step ramp + hold")
if isinstance(steps, list) and steps:
    check(sum(r['requests'] for r in steps) <= d['requests'],
          "the steps claim more requests than the run made")
    # A generous share, not equality: requests in flight when the last stage ends carry no step tag, by
    # design — crediting them to the peak would move the slowest requests of the run into the quoted step.
    check(sum(r['requests'] for r in steps) > 0.8 * d['requests'],
          f"only {sum(r['requests'] for r in steps)} of {d['requests']} requests were attributed to a step")
    check([r for r in steps if r['is_hold']], "the hold is not its own step")
    hold = [r for r in steps if r['is_hold']][0]
    check(hold['sustained'] is True and hold['from_rps'] == hold['requested_rps'],
          "the hold must be the one step at a single sustained rate")
    check(all(not r['partial'] for r in steps), "a completed run reported a partial step")
    # achieved must be over the STEP's window, not the run's: k6's own rate field divides by the whole test
    # duration and would report ~1.7 req/s for a step that delivered 7.5.
    check(hold['achieved_rps'] > 0.5 * hold['requested_rps'],
          f"the hold achieved {hold['achieved_rps']} of {hold['requested_rps']} req/s asked")

rows = [l for l in open(sys.argv[2]).read().split('\n') if l.strip()]
check(len(rows) == 2, f"history.tsv has {len(rows)} lines, expected header + 1 run")
check(d['run_id'] in rows[-1], "the history row does not reference this run")

if fail:
    print('\n'.join('  ❌ ' + f for f in fail)); sys.exit(1)
print('  ✅ summary, mix, cache classification, per-step ramp and history all consistent')
PY

# ─────────────────────────────── leg 1b: discover --verify ──────────────────────────────────────────
# The nginx sitemap advertises five paths, two of which must not survive: /gone 404s and /moved redirects.
# A pool full of either yields a flattering capacity number for a load that never reached the renderer —
# and verifying 400 URLs by hand, which the README used to suggest, is something nobody does.
#
# This leg also exists because `discover` wrote an EMPTY pool from 1.0.0 to 1.6.0 and no test called it.
say ""
say "▶ leg 1b — discover --verify keeps only what renders"
CROWDSIM_OUT="$OUT" "$ROOT/bin/crowdsim" discover --profile "$FAST_PROFILE" --verify \
  > "$OUT/discover.log" 2>&1 || die "discover --verify failed (see $OUT/discover.log)"

POOL="$(ls -1 "$OUT"/pool-*.json | tail -1)"
REPORT="${POOL%.json}.report.txt"
python3 - "$POOL" "$REPORT" "$OUT/discover.log" <<'PY'
import json, sys
paths = json.load(open(sys.argv[1]))
report = open(sys.argv[2]).read()
log = open(sys.argv[3]).read()
fail = []
def check(cond, msg):
    if not cond: fail.append(msg)

check(len(paths) == 3, f"kept {len(paths)} paths, expected 3 (/, /news, /news/latest)")
check('/gone' not in paths, "a 404 survived verification")
check('/moved' not in paths, "a redirect survived verification")
check('404' in report and '/gone' in report, "the report does not say why /gone was dropped")
check('redirect' in report and '/moved' in report, "the report does not record the redirect")
check('verified_at=' in report, "the report does not record when it was verified")
check('3 of 5 render' in log, "the summary line does not say how many were kept")

if fail:
    print('\n'.join('  ❌ ' + f for f in fail)); sys.exit(1)
print('  ✅ 5 discovered, 3 kept, the 404 and the redirect dropped with reasons')
PY

# The JSON report carries the same verdicts as the text one. Two readers, one measurement: if these ever
# disagree, the GUI is showing a table that the next run will not act on.
python3 - "$(ls -1 "$OUT"/discover-*.json | tail -1)" <<'PY' || die "the discover JSON report does not match the run"
import json, sys
d = json.load(open(sys.argv[1]))
assert d['verified'] is True, d
assert d['loc_entries'] == 5 and d['distinct'] == 5, d
assert d['kept'] == 3, d
by_path = {x['path']: x for x in d['dropped']}
assert by_path['/gone']['reason'] == 'status' and by_path['/gone']['status'] == 404, by_path
assert by_path['/moved']['reason'] == 'redirect', by_path
print('  ✅ discover JSON: verified, 3 kept, /gone 404 and /moved redirect recorded as data')
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

# leg 1 probed, so the page weight is on disk: a run must now say what bandwidth its peak implies. The
# point of that line is to be there BEFORE the run, not to be reconstructed from generator_ok afterwards.
grep -q 'bandwidth:' "$OUT/slow.log" || die "the run did not state the bandwidth its peak implies"
ok "the run stated its bandwidth requirement up front"

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

# The run that aborted is the one that proves the partial-step rule: it died inside a step, and that step's
# numbers are a fraction of it — usually its worst part, since the brake fires while latency is climbing.
# Reported, and marked, never quoted as that rate's result.
steps = d.get('per_step') or []
check(len(steps) >= 1, "an aborted run reported no steps at all")
if steps:
    check(steps[-1]['partial'] is True, "the step the run died inside is not marked partial")
    check('partial' in (steps[-1].get('note') or ''), "the partial step carries no explanation")
    check(all(not r['partial'] for r in steps[:-1]), "a step that completed was marked partial")
    # And the point of the whole thing: the last clean step is a rate this system survived, and it is lower
    # than the peak that was asked for.
    clean = [r for r in steps if not r['partial']]
    if clean:
        check(clean[-1]['requested_rps'] <= d['peak_rps_user_target'],
              "the last clean step claims a rate above the requested peak")

rows = [l for l in open(sys.argv[3]).read().split('\n') if l.strip()]
check(len(rows) == 3, f"history.tsv has {len(rows)} lines, expected header + 2 runs")
check(d['run_id'] in rows[-1], "the aborted run has no history row")
check('True' in rows[-1], "the history row does not record the run as aborted")

if fail:
    print('\n'.join('  ❌ ' + f for f in fail)); sys.exit(1)
print(f"  ✅ aborted at p95 {round(brake['p95'])} ms against an SLO of {slo['max_p95_ms']} ms, "
      f"inside step {steps[-1]['step'] if steps else '?'} (marked partial), generator held, history recorded")
PY

# ─────────────────────────────── leg 3: a target that never answers ─────────────────────────────────
# The other honest failure mode. A run against something that does not answer must be reported as
# CONNECTIVITY, never as capacity — near-total failure at near-zero latency is a refused connection, and a
# saturated system is slow before it errors. Nothing else in the suite exercises that path.
#
# It uses an example domain, as one would, but it does not resolve it: `.test` is reserved and guaranteed
# absent from the global DNS (RFC 6761), yet a resolver that hijacks NXDOMAIN would hand us a stranger's
# address — and then this test would generate load against them. The profile's bypass removes DNS from the
# question: the host stays www.example.test for SNI, Host and the allowlist, while the connection goes to
# 127.0.0.1:9, where nothing listens.
say ""
say "▶ leg 3 — an unreachable target must read as connectivity, not capacity"
set +e
CROWDSIM_OUT="$OUT" "$ROOT/bin/crowdsim" load --profile "$HERE/profile-unreachable.json" \
  --peak 4 --start 2 --steps 1 --step-dur 5s --hold 3s > "$OUT/unreachable.log" 2>&1
RC=$?
set -e
[ "$RC" = "0" ] || die "the driver exited $RC on an unreachable target (see $OUT/unreachable.log)"
ok "the driver exited 0"

grep -q 'THE TARGET NEVER ANSWERED' "$OUT/unreachable.log" \
  || die "the wrapper did not warn that the target never answered"
grep -q "crowdsim probe" "$OUT/unreachable.log" \
  || die "the warning does not say to probe the target first"
ok "the wrapper says it is connectivity, and what to do next"

UNREACH_SUMMARY="$(ls -1 "$OUT"/summary-*.json | tail -1)"
python3 - "$UNREACH_SUMMARY" "$OUT/unreachable.log" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
log = open(sys.argv[2]).read()
fail = []
def check(cond, msg):
    if not cond: fail.append(msg)

check(d['target_unreachable'] is True, "a target that refused every connection was not flagged unreachable")
check(d['failed_rate'] > 0.9, f"failed rate {d['failed_rate']}: the target apparently answered something")
check(d['dur']['p95'] is not None and d['dur']['p95'] < 50,
      f"p95 {d['dur']['p95']} ms: refused connections should return instantly")
check(d['requests'] > 0, "no requests were attempted at all")
check(d['generator_ok'] is True, "the generator did not hold the rate against a refusing target")

# The precedence that matters. A failed rate of exactly 1.0 is not < 1.0, so the brake DOES trip here —
# and the report must still refuse to call it a knee. Both flags set, one honest conclusion.
check(d['aborted'] is True, "expected the brake to trip at a 100% failed rate")
check('TARGET NEVER ANSWERED' in log, "the report does not lead with the unreachable verdict")
check('ABORTED by the brake' not in log,
      "the report presents an unreachable target as a knee — the one thing it must never do")

if fail:
    print('\n'.join('  ❌ ' + f for f in fail)); sys.exit(1)
print('  ✅ unreachable, not a knee: flagged, explained, and never dressed up as capacity')
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
assert len(runs) == 3, f"the GUI lists {len(runs)} runs, expected 3"
aborted = [r for r in runs if r["aborted"]]
assert len(aborted) == 2, "the GUI does not distinguish the aborted runs"
# The knee has to survive the trip through history.tsv (#51). A refused knee must arrive as null: reading it
# as 0 would put a knee at zero req/s on the page, for a run that measured nothing of the sort.
for r in runs:
    for k in ("knee_clean", "knee_crossed"):
        assert k in r, f"the GUI history row has no {k}: the knee stops at the driver"
        assert r[k] is None or isinstance(r[k], (int, float)), f"{k} came through as {r[k]!r}"
print(f"  ✅ GUI lists {len(runs)} runs, {len(aborted)} of them aborted, knee carried per run")'

# ── the report, handed over BY the GUI (#53) ─────────────────────────────────────────────────────────
# The page can now produce the artefact somebody reading a finished run wants next. It must be the CLI's
# own document — caveats attached — and not markdown rendered a second time by the server.
FIRST_RUN="$(curl -fsS http://127.0.0.1:18787/api/history \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["runs"][0]["run_id"])')"
curl -fsS -D "$OUT/report.head" "http://127.0.0.1:18787/api/history/$FIRST_RUN/report" > "$OUT/report.md" \
  || die "the GUI could not produce a report for $FIRST_RUN"
python3 - "$OUT/report.head" "$OUT/report.md" "$OUT/report-$FIRST_RUN.md" <<'PY'
import os, sys
head = open(sys.argv[1], encoding='utf-8', errors='replace').read()
body = open(sys.argv[2], encoding='utf-8').read()
fail = []
def check(c, m):
    if not c: fail.append(m)

check('text/markdown' in head.lower(), 'the report did not come back as markdown')
check('attachment' in head.lower(), 'the report is not offered as a file to save')
check('crowdsim' in body.lower(), 'the report body does not look like a crowdsim report')
# The caveats are the reason this document exists: a report without them is a number in a ticket.
check('caveat' in body.lower() or 'colder than real traffic' in body.lower() or 'pool' in body.lower(),
      'the report carries no caveats — the part that does not survive retyping')
# Written by the CLI, at the CLI's own path, rather than rendered by the server.
check(os.path.exists(sys.argv[3]), 'crowdsim report did not write its file: the server rendered its own')
if fail:
    print('\n'.join('  ❌ ' + f for f in fail)); sys.exit(1)
print(f'  ✅ the GUI hands over the CLI\'s own report ({len(body)} bytes), caveats included')
PY

# ── the same run, drawn (charts) ─────────────────────────────────────────────────────────────────────
# The page with charts is generated from a REAL summary here, which is the only place its geometry meets
# real data: a scale that collapses when every step has the same p95, an axis with one point, a knee band
# whose ends are the same step. The unit tests cover the arithmetic; this covers the data.
# Every run in the archive, not just the newest: this suite deliberately produces one clean run, one the
# brake aborted and one against a target that never answered, and the RULE differs per run — a run whose
# numbers mean nothing must NOT get a latency curve. Asserting only the newest tested whichever leg
# happened to run last, and the first version of this check failed for exactly that reason.
for run in $(curl -fsS http://127.0.0.1:18787/api/history \
  | python3 -c 'import json,sys; print(" ".join(r["run_id"] for r in json.load(sys.stdin)["runs"]))'); do
  curl -fsS -D "$OUT/report-html-$run.head" \
    "http://127.0.0.1:18787/api/history/$run/report?format=html" > "$OUT/report-$run.page.html" \
    || die "the GUI could not draw a report for $run"
done
python3 - "$OUT" <<'PY'
import glob, os, re, sys
out = sys.argv[1]
fail, plotted = [], 0
def check(c, m):
    if not c: fail.append(m)

pages = sorted(glob.glob(os.path.join(out, 'report-*.page.html')))
check(len(pages) == 3, f'{len(pages)} pages drawn, expected one per run in the archive')
for page in pages:
    run = os.path.basename(page)[len('report-'):-len('.page.html')]
    html = open(page, encoding='utf-8').read()
    head = open(os.path.join(out, f'report-html-{run}.head'), encoding='utf-8', errors='replace').read()
    check('text/html' in head.lower(), f'{run}: did not come back as HTML')
    check(html.startswith('<!doctype html>'), f'{run}: not a complete document')
    check(os.path.exists(os.path.join(out, f'report-{run}.html')),
          f'{run}: crowdsim report --html did not write its own file')
    # Self-contained: a report that needs the network is not an attachment.
    for pattern in (r'<script', r'<link', r'@import', r'\ssrc='):
        check(not re.search(pattern, html, re.I), f'{run}: the page fetches or runs something: {pattern}')
    # Every coordinate must be a number. A NaN in an attribute renders as an empty chart and throws
    # nothing — exactly the silent failure this suite exists for.
    check('NaN' not in html, f'{run}: a chart coordinate is NaN, so a chart renders empty')
    check('>undefined<' not in html, f'{run}: an undefined value reached the page')
    check('<svg' in html, f'{run}: no chart at all')
    # The rule, per run: a run whose numbers mean nothing gets no latency curve, and says why.
    voided = 'DISCARD THIS RUN' in html or 'The target never answered' in html
    curve = 'p95 latency per ramp step' in html
    if voided:
        check(not curve, f'{run}: a run with no valid numbers was given a latency curve anyway')
    elif curve:
        plotted += 1
        check(html.count('<circle') >= 1, f'{run}: the ramp is not plotted as points')
        check('the knee is in here' in html or 'No knee from this run' in html,
              f'{run}: neither a knee band nor a reason there is none')
check(plotted >= 1, 'no run in the archive was drawn as a curve, so the chart path never ran')
if fail:
    print('\n'.join('  ❌ ' + f for f in fail)); sys.exit(1)
print(f'  ✅ {len(pages)} runs drawn from real data, {plotted} as a curve, the voided ones without one')
PY

# ── the page itself, in a real browser ───────────────────────────────────────────────────────────────
# tests/ui asserts the front end's decisions as plain modules, which is fast and covers the reasoning — and
# cannot prove that a component renders any of it. This does: one real browser, the real bundle, the real
# server, asserting the things whose absence would be silent.
#
# Skipped, loudly, when there is no browser: a check that quietly disappears is worse than one that is
# missing on purpose.
# CROWDSIM_CHROME lets a runner name its browser instead of being guessed at. When it is set and unusable
# the check is skipped rather than quietly falling back to another browser: somebody who names one wants
# that one, and a silent substitution is how a check ends up measuring a thing nobody chose. It is also what
# makes the no-browser branch reachable on a machine that has a browser — the branch CI hit first, and this
# suite could not.
CHROME=""
if [ -n "${CROWDSIM_CHROME:-}" ]; then
  if [ -x "$CROWDSIM_CHROME" ] || command -v "$CROWDSIM_CHROME" >/dev/null 2>&1; then
    CHROME="$CROWDSIM_CHROME"
  else
    warn "CROWDSIM_CHROME is set to '$CROWDSIM_CHROME', which is not runnable — not falling back to another"
  fi
else
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           google-chrome-stable google-chrome chromium; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi
if [ -z "$CHROME" ]; then
  warn "SKIPPED: the rendered-page check needs Chrome or Chromium, and neither is on this machine"
else
  say ""
  say "▶ the page renders what the archive says"
  if [ ! -f "$ROOT/gui/ui/dist/index.html" ]; then
    warn "SKIPPED: gui/ui/dist is missing — run: npm run gui:build"
  else
    "$CHROME" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=6000 \
      --dump-dom "http://127.0.0.1:18787/#history" > "$OUT/page.html" 2>/dev/null || true
    # The same page with one run open, by address (#53): a result is the thing people hand to each other,
    # and its report is a button on that card. Without the fragment nothing is selected and the card — the
    # place the report is offered from — is not on the page at all.
    "$CHROME" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=6000 \
      --dump-dom "http://127.0.0.1:18787/#history=$FIRST_RUN" > "$OUT/page-run.html" 2>/dev/null || true
    python3 - "$OUT/page.html" "$OUT/page-run.html" <<'PY2' || die "the rendered page is not showing the archive (see $OUT/page.html)"
import re, sys
html = open(sys.argv[1], encoding='utf-8', errors='replace').read()
one = open(sys.argv[2], encoding='utf-8', errors='replace').read()
fail = []
def check(cond, msg):
    if not cond: fail.append(msg)

check(len(html) > 4000, "the page rendered almost nothing: the bundle or the server is broken")
check('crowdsim' in html, "the page did not render the application shell")
# One row per run in the archive, rendered — not just served as JSON.
ids = set(re.findall(r'\b\d{8}T\d{6}Z\b', html))
check(len(ids) >= 3, f"the page shows {len(ids)} run ids, expected the 3 in the archive")
# The outcome must be visible where somebody reads it, not only in the file. This suite produces one clean
# run and two the brake aborted, so the page has to distinguish them — an archive rendered as three
# identical rows is the failure this assertion exists for. (The first version of this check looked for
# "invalid" and failed: nothing here is generator-bound. The page was right and the assertion was wrong.)
check('>clean<' in html, "no run is marked clean, though leg 1 completed without crossing the SLO")
check('>knee<' in html, "no run is marked as a knee, though the brake aborted two of them")

# Reachable without a mouse. tests/ui can assert that Enter activates; only a rendered page can show that
# there is something to put focus on in the first place.
rows = re.findall(r'<tr[^>]*>', html)
focusable = [r for r in rows if 'tabindex' in r.lower()]
check(len(focusable) >= 3, f"{len(focusable)} of {len(rows)} run rows are focusable: the archive is mouse-only")
check('role="button"' in html, "the focusable rows do not announce themselves as activatable")
points = re.findall(r'<circle[^>]*class="pt[^>]*>', html)
check(not points or all('tabindex' in p.lower() for p in points),
      "the knee-plot points are clickable but not reachable")

# The knee column (#51). Every run in this archive either has a measured band or is a refusal, and the page
# must show which — a blank column reads as "no knee found", after which somebody quotes the requested peak.
check('<th>knee</th>' in html, "the archive table has no knee column")

# A run opened by address, and the report offered from it (#53). tests/gui proves the endpoint; only the
# rendered page shows there is something to click.
check('Result' in one, "#history=<run-id> did not open that run's result")
check('Report (.md)' in one, "the result view offers no way to hand the run over as a report")
check('Report with charts' in one, "the result view does not offer the drawn report")
check('caveats' in one, "the report button does not say what the document is for")
if fail:
    print("\n".join("  ❌ " + f for f in fail)); sys.exit(1)
print(f"  ✅ the page rendered {len(ids)} runs from the archive, clean and knee told apart, knee column present")
PY2
  fi
fi

say ""
ok "end-to-end suite passed"
