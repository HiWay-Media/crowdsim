#!/usr/bin/env bats
#
# `report`: the result, with its caveats attached.
#
# Every run ends up in a document — an incident write-up, a ticket, a message to whoever asked — and today
# that means retyping numbers out of a terminal. The caveats are exactly what does not survive the retyping:
# generator_ok, that the pool was synthetic and colder than real traffic, that only the delta is defensible,
# that a brake abort is a result and not a failure.
#
# So what is asserted here is not the layout. It is that the report cannot be read as more than it is.

load helper.bash

setup() {
  crowdsim_setup
  mkdir -p "$CROWDSIM_OUT"
  RUN=20260805T090000Z
  write_summary "$RUN" 1 0
}

# write_summary <run_id> <generator_ok:1|0> <aborted:1|0>
write_summary() {
  python3 - "$CROWDSIM_OUT" "$1" "$2" "$3" <<'PY'
import json, os, sys
out, run_id, gen_ok, aborted = sys.argv[1:5]
json.dump({
    'run_id': run_id, 'profile': 'live-event', 'shape': 'mix',
    'base_url': 'https://www.example.test', 'rsc_mode': 'repeat',
    'peak_rps_user_target': 380, 'aborted': aborted == '1',
    'aborted_by': ({'metric': 'http_req_duration', 'class': 'rsc_page',
                    'threshold': 'p(95)<800', 'value': 1204.4} if aborted == '1' else None),
    'requests': 41234, 'rps_avg': 372.5, 'failed_rate': 0.0012,
    'dur': {'p50': 120, 'p95': 481, 'p99': 902, 'max': 3011},
    'guillotine_ms': 5000, 'over_guillotine_rate': 0.0004, 'dropped_iterations': 3,
    'e504': 2, 'e502': 0, 'e5xx': 5, 'e404': 0,
    'cache': {'proxy': 0.61, 'cdn': None},
    'per_class': {'html': {'p95': 481, 'p99': 902, 'med': 120, 'failed': 0.001,
                           'over_guillotine': 0.0, 'cache': {'proxy': 0.61, 'cdn': None},
                           'reqs': 20000, 'rps_target': 190.0}},
    'mix_target': {'html': 190.0},
    'warmup': None, 'is_warmup': False,
    'generator_ok': gen_ok == '1', 'target_unreachable': False,
}, open(os.path.join(out, f'summary-{run_id}.json'), 'w'), indent=1)
PY
}

# add_knee <run_id> — the knee a completed ramp produces
add_knee() {
  python3 - "$CROWDSIM_OUT/summary-$1.json" <<'PY'
import json, sys
f = sys.argv[1]
d = json.load(open(f))
d['per_step'] = [
    {'step': 's1', 'index': 1, 'is_hold': False, 'sustained': False, 'from_rps': 60,
     'requested_rps': 90, 'achieved_rps': 75.0, 'requests': 4500, 'p50': 90, 'p95': 400,
     'p99': 600, 'failed_rate': 0.0, 'over_guillotine_rate': 0.0, 'partial': False, 'per_class': {}},
    {'step': 's2', 'index': 2, 'is_hold': False, 'sustained': False, 'from_rps': 90,
     'requested_rps': 120, 'achieved_rps': 105.0, 'requests': 6300, 'p50': 300, 'p95': 4200,
     'p99': 9000, 'failed_rate': 0.04, 'over_guillotine_rate': 0.12, 'partial': False, 'per_class': {}},
]
d['knee'] = {
    'clean': {'step': 's1', 'requested_rps': 90, 'from_rps': 60, 'achieved_rps': 75.0, 'p95': 400,
              'failed_rate': 0.0, 'sustained': False,
              'caveat': 'this rate was swept through on the way up, not sustained: only the --hold step '
                        'holds a rate'},
    'crossed': {'step': 's2', 'requested_rps': 120, 'from_rps': 90, 'achieved_rps': 105.0, 'p95': 4200,
                'failed_rate': 0.04, 'partial': False, 'class': None,
                'why': 'p95 4200 ms crossed the SLO of 2500 ms'},
    'summary': 'clean up to 90 req/s (swept, not sustained), crossed at 120 req/s — p95 4200 ms crossed '
               'the SLO of 2500 ms.',
}
json.dump(d, open(f, 'w'), indent=1)
PY
}

# refuse_knee <run_id> — a ramp that cannot support a knee
refuse_knee() {
  python3 - "$CROWDSIM_OUT/summary-$1.json" <<'PY'
import json, sys
f = sys.argv[1]
d = json.load(open(f))
d['per_step'] = []
d['knee'] = {'refused': True,
             'reason': 'only one step ran to completion: one point is not a curve, and a knee from it '
                       'would be a straight line through a single measurement.',
             'fix': 'Give the ramp more room below the knee: a lower --start, more --steps, or a longer '
                    '--step-dur.'}
json.dump(d, open(f, 'w'), indent=1)
PY
}

@test "report needs a run id, and says where to find one" {
  run "$CROWDSIM" report
  [ "$status" -eq 2 ]
  [[ "$output" == *"crowdsim history"* ]]
  run "$CROWDSIM" report 20260101T000000Z
  [ "$status" -eq 2 ]
  [[ "$output" == *"no summary"* ]]
}

@test "the report is markdown, and leads with the verdict rather than the numbers" {
  run "$CROWDSIM" report "$RUN"
  [ "$status" -eq 0 ]
  local file="$CROWDSIM_OUT/report-$RUN.md"
  [ -f "$file" ]
  # reading-results.md prescribes the order: validity, then the brake, then the margin, then latency.
  local body; body="$(cat "$file")"
  [[ "$body" == *"# crowdsim run 20260805T090000Z"* ]]
  local valid_at margin_at
  valid_at=$(grep -n "generator" "$file" | head -1 | cut -d: -f1)
  margin_at=$(grep -n "5000 ms" "$file" | head -1 | cut -d: -f1)
  [ "$valid_at" -lt "$margin_at" ]
}

@test "the caveats are in the report, not in a footnote somebody deletes" {
  run "$CROWDSIM" report "$RUN"
  local body; body="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$body" == *"colder than real traffic"* ]]
  [[ "$body" == *"Quote the change"* ]]
  [[ "$body" == *"3 iterations were dropped"* ]]
}

@test "an invalid run produces a report that refuses to present its numbers" {
  write_summary "$RUN" 0 0
  run "$CROWDSIM" report "$RUN"
  [ "$status" -eq 0 ]
  local body; body="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$body" == *"DISCARD THIS RUN"* ]]
  [[ "$body" == *"generator_ok: false"* ]]
  # No table of latencies to copy out of: the numbers describe the generator, not the target.
  [[ "$body" != *"| p95 |"* ]]
}

@test "a brake abort is reported as a result, and says which class stopped it" {
  write_summary "$RUN" 1 1
  run "$CROWDSIM" report "$RUN"
  local body; body="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$body" == *"found the knee"* ]]
  [[ "$body" != *"failed"*"the tool"* ]]
  [[ "$body" == *"rsc_page"* ]]
  [[ "$body" == *"p(95)<800"* ]]
}

@test "a cache layer that never appeared stays n/a, and is never reported as 0%" {
  run "$CROWDSIM" report "$RUN"
  local body; body="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$body" == *"cdn"* ]]
  [[ "$body" == *"n/a"* ]]
  [[ "$body" == *"never appeared"* ]]
}

@test "nothing is invented: a field the archive does not have is absent, not estimated" {
  python3 - "$CROWDSIM_OUT/summary-$RUN.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['cache'] = {}
d.pop('over_guillotine_rate', None)
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" report "$RUN"
  [ "$status" -eq 0 ]
  local body; body="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$body" != *"0.00%"*"read timeout"* ]]
  [[ "$body" != *"Traceback"* ]]
}

@test "--compare reuses crowdsim compare instead of recomputing a delta" {
  local other=20260805T093000Z
  write_summary "$other" 1 0
  run "$CROWDSIM" report "$RUN" --compare "$other"
  [ "$status" -eq 0 ]
  local body; body="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$body" == *"Compared with $other"* ]]
  [[ "$body" == *"crowdsim compare"* ]]
}

@test "a comparison compare refuses is reported as a refusal, not omitted" {
  local other=20260805T093000Z
  write_summary "$other" 0 0                  # generator_ok: false → compare must refuse
  run "$CROWDSIM" report "$RUN" --compare "$other"
  [ "$status" -eq 0 ]
  local body; body="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$body" == *"refus"* ]]
  [[ "$body" == *"generator_ok: false"* ]]
}

@test "the report says the run describes your infrastructure, since it names your hosts" {
  run "$CROWDSIM" report "$RUN"
  local body; body="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$body" == *"www.example.test"* ]]
  [[ "$body" == *"names your hosts"* ]]
}

@test "the report leads with the knee, as the claim it is, and with what it is a knee of" {
  # This is the sentence that gets pasted into a capacity discussion. It has to arrive with the two things
  # that do not survive retyping: that a swept rate is not a sustained one, and that a knee measured at a
  # synthetic pool is harsher than one at real traffic.
  add_knee "$RUN"
  run "$CROWDSIM" report "$RUN"
  [ "$status" -eq 0 ]
  md="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$md" == *"90 req/s"* ]]
  [[ "$md" == *"120 req/s"* ]]
  [[ "$md" == *"pool"* ]]
  # and before the numbers table, since it is the answer and the table is the evidence
  knee_at=$(printf '%s' "$md" | grep -n "req/s" | head -1 | cut -d: -f1)
  tbl_at=$(printf '%s' "$md" | grep -n "^| metric" | head -1 | cut -d: -f1)
  [ "$knee_at" -lt "$tbl_at" ]
}

@test "a refused knee is reported as a refusal, not as an absent section" {
  # A missing knee section reads as "no knee found", and the reader quotes the peak — the one rate nobody
  # measured the system surviving.
  refuse_knee "$RUN"
  run "$CROWDSIM" report "$RUN"
  [ "$status" -eq 0 ]
  md="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$md" == *"knee"* ]]
  [[ "$md" == *"only one step"* ]]
  [[ "$md" == *"--step"* ]]
}

@test "a run from before per-step numbers existed produces a report with no knee section at all" {
  # Not a refusal: those runs cannot be judged, and inventing a refusal reason for them would be a
  # statement about a run that never had the data. The fixture written in setup() is exactly such a run.
  run "$CROWDSIM" report "$RUN"
  [ "$status" -eq 0 ]
  md="$(cat "$CROWDSIM_OUT/report-$RUN.md")"
  [[ "$md" != *"the knee"* ]]
}
