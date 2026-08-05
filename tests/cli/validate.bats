#!/usr/bin/env bats
#
# `crowdsim validate`, and the same rules reused by `doctor` and `load`.
#
# The rules themselves are unit-tested in tests/gui/validate.test.js against lib/validate.js — the one
# implementation both entry points use. What is asserted here is the wiring: that the CLI reaches them, that
# `load` refuses a broken profile before generating anything, that `doctor` reports without failing, and
# that a machine without node degrades honestly instead of pretending everything is fine.

load helper.bash
setup() {
  crowdsim_setup
  BROKEN="$BATS_TEST_TMPDIR/broken.json"
  python3 - "$FIXTURES/minimal.json" "$BROKEN" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['classes'][0]['pool'] = 'nowhere'           # error: unknown pool
d['slo']['brake_class'] = 'gone'              # error: nothing would abort the run
d['safety']['allow_hosts'] = ['*']            # error: not an allowlist
json.dump(d, open(sys.argv[2], 'w'))
PY
  # Same profile, one error only — and one that no structural check can see.
  NOBRAKE="$BATS_TEST_TMPDIR/nobrake.json"
  python3 - "$FIXTURES/minimal.json" "$NOBRAKE" <<'PY2'
import json, sys
d = json.load(open(sys.argv[1]))
d['slo']['brake_class'] = 'gone'
json.dump(d, open(sys.argv[2], 'w'))
PY2
}

@test "validate accepts the shipped example profile — it is the documentation" {
  run "$CROWDSIM" validate "$CROWDSIM_ROOT/profiles/example.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"validating"* ]]
}

@test "validate takes the profile as a positional argument, or with --profile" {
  run "$CROWDSIM" validate "$FIXTURES/minimal.json"
  [ "$status" -eq 0 ]
  run "$CROWDSIM" validate --profile "$FIXTURES/minimal.json"
  [ "$status" -eq 0 ]
}

@test "validate reports every problem at once, not the first" {
  # A validator that stops at the first problem turns one fix into a sequence of round trips, each of which
  # is another chance to give up and just run the thing.
  run "$CROWDSIM" validate "$BROKEN"
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown pool \"nowhere\""* ]]
  [[ "$output" == *"nothing would abort the run"* ]]
  [[ "$output" == *"not an allowlist"* ]]
  [[ "$output" == *"3 errors"* ]]
}

@test "validate separates errors from warnings: warnings alone still exit 0" {
  run "$CROWDSIM" validate "$FIXTURES/empty-pool.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"will be dropped"* ]]
  [[ "$output" != *"❌"* ]]
}

@test "validate on unparseable JSON says so, instead of listing rule violations" {
  printf '{ nope' > "$BATS_TEST_TMPDIR/bad.json"
  run "$CROWDSIM" validate "$BATS_TEST_TMPDIR/bad.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"not valid JSON"* ]]
}

@test "validate needs a profile, and a missing file exits 2" {
  run "$CROWDSIM" validate
  [ "$status" -eq 2 ]
  run "$CROWDSIM" validate "$BATS_TEST_TMPDIR/ghost.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"profile not found"* ]]
}

@test "load refuses a profile with errors before generating anything" {
  run "$CROWDSIM" load --profile "$BROKEN" --peak 10 --dry-run
  [ "$status" -eq 2 ]
  [[ "$output" == *"the profile has errors"* ]]
  [[ "$output" == *"crowdsim validate"* ]]
  [[ "$output" != *"STUB-K6"* ]]
}

@test "load refuses before the safety gates, so a bad profile cannot even reach the allowlist" {
  # Order matters for the error message the operator sees first: fix the profile, then argue about hosts.
  run "$CROWDSIM" load --profile "$BROKEN" --base-url https://not-allowed.test --peak 10 --dry-run
  [ "$status" -eq 2 ]
  [[ "$output" == *"the profile has errors"* ]]
}

@test "load prints the warnings but runs a profile that only has warnings" {
  run "$CROWDSIM" load --profile "$FIXTURES/empty-pool.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"will be dropped"* ]]
  [[ "$output" == *"(dry run) k6 run"* ]]
}

@test "doctor reports the errors and still exits 0: it is a report, not a gate" {
  run "$CROWDSIM" doctor --profile "$BROKEN"
  [ "$status" -eq 0 ]
  [[ "$output" == *"not an allowlist"* ]]
}

@test "without node, validate exits 5 and says what still works" {
  PATH="$(path_without_node)" run "$CROWDSIM" validate "$FIXTURES/minimal.json"
  [ "$status" -eq 5 ]
  [[ "$output" == *"needs node"* ]]
  [[ "$output" == *"structural checks"* ]]
}

@test "without node, load says validation was partial instead of implying it passed" {
  # The honest failure mode: name the checks that did not run, rather than printing nothing and letting the
  # operator believe the profile was fully validated.
  #
  # NOBRAKE has a NON-structural error — a brake class that does not exist — so nothing else catches it:
  # resolve_profile only knows about pools. Without node, the single thing between the operator and a run
  # that can never abort is that sentence.
  run "$CROWDSIM" validate --profile "$NOBRAKE"
  [ "$status" -eq 2 ]
  [[ "$output" == *"nothing would abort the run"* ]]

  PATH="$(path_without_node)" run "$CROWDSIM" load --profile "$NOBRAKE" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"full profile validation needs node"* ]]
  [[ "$output" == *"only the structural checks ran"* ]]
}

@test "the bandwidth estimate appears, and warns when the declared link cannot sustain it" {
  # #19: generator_ok: false is diagnosed after the window is burned. probe measured a page; the estimate
  # is arithmetic that was available before the run and that nothing was doing.
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT/probe-20260805T120000Z.json" <<'PY2'
import json, sys
json.dump({'run_id': '20260805T120000Z', 'base_url': 'http://127.0.0.1:8099',
           'path': '/', 'status': 200, 'ttfb_s': 0.18, 'bytes': 46231}, open(sys.argv[1], 'w'))
PY2
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 380 --safe-peak 400 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"bandwidth: 380 req/s × 45 KB"* ]]
  [[ "$output" == *"17.6 MB/s"* ]]
  [[ "$output" == *"140 Mbit/s"* ]]
  [[ "$output" == *"safety.generator_mbps"* ]]      # not declared: says how to have it checked

  # declared, and not enough: loud, and it names the two honest fixes
  python3 - "$FIXTURES/minimal.json" "$BATS_TEST_TMPDIR/slow-link.json" <<'PY2'
import json, sys
d = json.load(open(sys.argv[1]))
d['safety']['generator_mbps'] = 100
json.dump(d, open(sys.argv[2], 'w'))
PY2
  run "$CROWDSIM" load --profile "$BATS_TEST_TMPDIR/slow-link.json" --peak 380 --safe-peak 400 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"MORE THAN THE 100 Mbit/s"* ]]
  [[ "$output" == *"generator_ok: false"* ]]
  [[ "$output" == *"do not lower the SLO"* ]]
}

@test "the estimate is a warning and never a gate: the run still goes ahead" {
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT/probe-20260805T120000Z.json" <<'PY2'
import json, sys
json.dump({'run_id': '20260805T120000Z', 'base_url': 'http://127.0.0.1:8099',
           'path': '/', 'status': 200, 'ttfb_s': 0.18, 'bytes': 999999}, open(sys.argv[1], 'w'))
PY2
  python3 - "$FIXTURES/minimal.json" "$BATS_TEST_TMPDIR/tiny-link.json" <<'PY2'
import json, sys
d = json.load(open(sys.argv[1]))
d['safety']['generator_mbps'] = 1
json.dump(d, open(sys.argv[2], 'w'))
PY2
  # A wrong estimate must never be able to stop a run somebody needs.
  run "$CROWDSIM" load --profile "$BATS_TEST_TMPDIR/tiny-link.json" --peak 40 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"MORE THAN"* ]]
  [[ "$output" == *"(dry run) k6 run"* ]]
}

@test "with no probe for this target, the estimate says it does not know" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 40 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"bandwidth: unknown"* ]]
  [[ "$output" == *"crowdsim probe"* ]]
}

@test "doctor states the requirement at the profile's own safe peak" {
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT/probe-20260805T120000Z.json" <<'PY2'
import json, sys
json.dump({'run_id': '20260805T120000Z', 'base_url': 'http://127.0.0.1:8099',
           'path': '/', 'status': 200, 'ttfb_s': 0.18, 'bytes': 46231}, open(sys.argv[1], 'w'))
PY2
  run "$CROWDSIM" doctor --profile "$FIXTURES/minimal.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"bandwidth: 50 req/s"* ]]        # the fixture's safe_peak_rps
}
