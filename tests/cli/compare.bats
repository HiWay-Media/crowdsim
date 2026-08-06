#!/usr/bin/env bats
#
# `compare`: the delta between two runs.
#
# The point of this command is what it REFUSES. crowdsim measures deltas honestly and absolutes
# optimistically, so a comparison is the claim people actually make — and a comparison between two runs that
# were not the same experiment is a confident number with nothing behind it. Worse than no comparison, because
# it looks like an answer.
#
# No traffic here: two summary files and two resolved profiles on disk are the whole input.

load helper.bash

setup() {
  crowdsim_setup
  mkdir -p "$CROWDSIM_OUT"
  A=20260805T090000Z
  B=20260805T093000Z
  write_run "$A" 1 200 0.0 100
  write_run "$B" 1 140 0.0 100
}

# write_run <run_id> <generator_ok:1|0> <p95_ms> <failed_rate> <proxy_hit_pct>
write_run() {
  python3 - "$CROWDSIM_OUT" "$1" "$2" "$3" "$4" "$5" <<'PY'
import json, os, sys
out, run_id, gen_ok, p95, failed, hit = sys.argv[1:7]
summary = {
    'run_id': run_id, 'profile': 'live-event', 'shape': 'mix',
    'base_url': 'https://www.example.test', 'rsc_mode': 'repeat',
    'peak_rps_user_target': 60, 'aborted': False,
    'requests': 4000, 'rps_avg': 59.4, 'failed_rate': float(failed),
    'dur': {'p50': float(p95) / 2, 'p95': float(p95), 'p99': float(p95) * 1.4, 'max': float(p95) * 3},
    'guillotine_ms': 5000, 'over_guillotine_rate': 0.0, 'dropped_iterations': 0,
    'e504': 0, 'e502': 0, 'e5xx': 0, 'e404': 0,
    'cache': {'proxy': float(hit) / 100, 'cdn': None},
    'per_class': {
        'html': {'p95': float(p95), 'p99': float(p95) * 1.3, 'med': float(p95) / 2,
                 'failed': float(failed), 'over_guillotine': 0.0,
                 'cache': {'proxy': float(hit) / 100, 'cdn': None},
                 'reqs': 2000, 'rps_target': 30.0},
        'static': {'p95': float(p95) / 4, 'p99': float(p95) / 3, 'med': float(p95) / 5,
                   'failed': 0.0, 'over_guillotine': 0.0,
                   'cache': {'proxy': 1.0, 'cdn': None},
                   'reqs': 2000, 'rps_target': 30.0},
    },
    'mix_target': {'html': 30.0, 'static': 30.0},
    'generator_ok': gen_ok == '1', 'target_unreachable': False,
}
json.dump(summary, open(os.path.join(out, f'summary-{run_id}.json'), 'w'), indent=1)
json.dump({'name': 'live-event', 'pools': {'pages': ['/', '/news'], 'assets': ['/a.css']}},
          open(os.path.join(out, f'profile-{run_id}.json'), 'w'), indent=1)
PY
}

@test "compare needs two run ids" {
  run "$CROWDSIM" compare
  [ "$status" -eq 2 ]
  [[ "$output" == *"two run ids"* ]]
  run "$CROWDSIM" compare "$A"
  [ "$status" -eq 2 ]
}

@test "a run id with no summary is an error naming the run, not an empty report" {
  run "$CROWDSIM" compare "$A" 20260101T000000Z
  [ "$status" -eq 2 ]
  [[ "$output" == *"no summary for 20260101T000000Z"* ]]
  [[ "$output" == *"crowdsim history"* ]]
}

@test "the delta is reported per class as well as overall, and labelled as the honest part" {
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 0 ]
  [[ "$output" == *"200 ms"* ]]
  [[ "$output" == *"140 ms"* ]]
  [[ "$output" == *"-60 ms (-30%)"* ]]
  [[ "$output" == *"per class"* ]]
  [[ "$output" == *"html"* ]]
  [[ "$output" == *"Deltas are the honest part"* ]]
}

@test "an improvement and a regression are not shown the same way" {
  run "$CROWDSIM" compare "$A" "$B"      # 200 ms → 140 ms: better
  [[ "$output" == *"-60 ms (-30%) ✅"* ]]
  run "$CROWDSIM" compare "$B" "$A"      # the other way round: worse
  [[ "$output" == *"+60 ms (+43%) ⚠️"* ]]
}

@test "a generator-bound run is refused, not compared: it has no numbers" {
  write_run "$B" 0 140 0.0 100
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 2 ]
  [[ "$output" == *"refusing to compare"* ]]
  [[ "$output" == *"generator_ok: false"* ]]
  [[ "$output" != *"per class"* ]]        # and it really did not print a report anyway
}

@test "two different URL pools are two different experiments" {
  python3 - "$CROWDSIM_OUT/profile-$B.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['pools']['pages'] = ['/', '/news', '/news/latest']
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 2 ]
  [[ "$output" == *"pool \"pages\" is not the same list of URLs"* ]]
  [[ "$output" == *"colder pool is a harder test"* ]]
}

@test "a pool that exists in only one of the runs is refused too" {
  python3 - "$CROWDSIM_OUT/profile-$B.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
del d['pools']['assets']
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 2 ]
  [[ "$output" == *"different pool names"* ]]
}

@test "a mix and a journey are not comparable" {
  python3 - "$CROWDSIM_OUT/summary-$B.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['shape'] = 'journey'
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 2 ]
  [[ "$output" == *"different shapes"* ]]
}

@test "a different target is allowed but stated: it is not a before/after of one target" {
  # This one is a legitimate question — what does the CDN add? — so refusing it would be wrong. What would
  # be wrong in the other direction is letting somebody read it as a regression on one target.
  python3 - "$CROWDSIM_OUT/summary-$B.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['base_url'] = 'https://cdn.example.test'
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 0 ]
  [[ "$output" == *"BETWEEN TWO TARGETS"* ]]
}

@test "a cache header that never appeared stays n/a in the delta, and is never called 0%" {
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 0 ]
  [[ "$output" == *"cdn"* ]]
  [[ "$output" == *"header never appeared in either run"* ]]
}

@test "an aborted run is compared, but the report says what its numbers describe" {
  python3 - "$CROWDSIM_OUT/summary-$B.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['aborted'] = True
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 0 ]
  [[ "$output" == *"aborted by the brake"* ]]
  [[ "$output" == *"the moment the SLO was crossed"* ]]
}

@test "a summary that predates the fields compare reads is refused, not a traceback" {
  # An archive is long-lived: out/ holds runs written by whatever version was installed at the time, and
  # `crowdsim history` will happily list one from before a field existed. Reading it must produce the same
  # kind of refusal as any other incomparable pair — never a Python traceback, and never exit 1, which is
  # not in the exit-code contract at all.
  python3 - "$CROWDSIM_OUT/summary-$B.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k in ('dur', 'over_guillotine_rate'):
    d.pop(k, None)
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 2 ]
  [[ "$output" != *"Traceback"* ]]
  [[ "$output" != *"KeyError"* ]]
  [[ "$output" == *"refusing to compare"* ]]
  [[ "$output" == *"$B"* ]]
  [[ "$output" == *"dur"* ]]
  [[ "$output" == *"written by an older crowdsim"* ]]
}

@test "the same refusal reaches the GUI as JSON, not as a broken response" {
  python3 - "$CROWDSIM_OUT/summary-$B.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d.pop('dur', None)
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" compare "$A" "$B" --json
  [ "$status" -eq 2 ]
  [[ "$output" != *"Traceback"* ]]
  python3 - <<PY
import json
d = json.loads('''$output''')
assert d['refused'], d
assert 'dur' in d['refused'][0]['reason'], d['refused']
assert 'overall' not in d, 'no numbers are computed for a summary that has none'
PY
}

@test "an unreadable summary is a usage error with the path, not a stack" {
  printf '{ this is not json' > "$CROWDSIM_OUT/summary-$B.json"
  run "$CROWDSIM" compare "$A" "$B"
  [ "$status" -eq 2 ]
  [[ "$output" != *"Traceback"* ]]
  [[ "$output" == *"does not parse"* ]]
  [[ "$output" == *"summary-$B.json"* ]]
}
