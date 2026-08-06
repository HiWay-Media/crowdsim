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
  # 380 × 46231 B = 17.57 MB/s = 140.54 Mbit/s, which prints as 141. The expectation said 140 — written by
  # hand rather than read off a run, and macOS bash 3.2 could not fail a [[ ]] to say so. See
  # tests/cli/00-environment.bats.
  [[ "$output" == *"141 Mbit/s"* ]]
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

@test "with no declared generator_mbps the estimate falls back to a measured ceiling, labelled as one" {
  # #28: the warning that predicts generator_ok:false used to rest entirely on a number typed by hand. A
  # measurement is better than silence — and worse than a value somebody chose knowing the uplink, which is
  # why it is never presented as a declaration.
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
json.dump({'run_id': '20260805T120000Z', 'base_url': 'http://127.0.0.1:8099', 'path': '/', 'status': 200,
           'ttfb_s': 0.18, 'bytes': 46231},
          open(os.path.join(out, 'probe-20260805T120000Z.json'), 'w'))
json.dump({'measured_at': '20260805T120500Z', 'req_per_second': 1000.0,
           'mbytes_per_second': 12.5, 'mbits_per_second': 100.0, 'failed_rate': 0.0},
          open(os.path.join(out, 'bench-20260805T120500Z.json'), 'w'))
PY
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 380 --safe-peak 400 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"no safety.generator_mbps declared; using the loopback ceiling measured on this machine"* ]]
  [[ "$output" == *"100 Mbit/s"* ]]
  [[ "$output" == *"UPPER BOUND"* ]]
  # 141 Mbit/s needed against a measured 100: loud, and it does not claim the number was declared.
  [[ "$output" == *"WAS MEASURED DOING ON LOOPBACK"* ]]
  [[ "$output" != *"IS DECLARED TO SUSTAIN"* ]]
}

@test "a declared generator_mbps still wins over a measurement" {
  # Somebody who knows the uplink is 50 Mbit/s is right; loopback is not evidence about their network.
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
json.dump({'run_id': '20260805T120000Z', 'base_url': 'http://127.0.0.1:8099', 'path': '/', 'status': 200,
           'ttfb_s': 0.18, 'bytes': 46231},
          open(os.path.join(out, 'probe-20260805T120000Z.json'), 'w'))
json.dump({'measured_at': '20260805T120500Z', 'mbits_per_second': 16000.0},
          open(os.path.join(out, 'bench-20260805T120500Z.json'), 'w'))
PY
  python3 - "$FIXTURES/minimal.json" "$BATS_TEST_TMPDIR/slow.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['safety']['generator_mbps'] = 50
json.dump(d, open(sys.argv[2], 'w'))
PY
  run "$CROWDSIM" load --profile "$BATS_TEST_TMPDIR/slow.json" --peak 380 --safe-peak 400 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"MORE THAN THE 50 Mbit/s THIS GENERATOR IS DECLARED TO SUSTAIN"* ]]
  [[ "$output" != *"loopback ceiling"* ]]
}

@test "with neither a declaration nor a measurement, it says how to get one" {
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT/probe-20260805T120000Z.json" <<'PY'
import json, sys
json.dump({'run_id': '20260805T120000Z', 'base_url': 'http://127.0.0.1:8099', 'path': '/', 'status': 200,
           'ttfb_s': 0.18, 'bytes': 46231}, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 380 --safe-peak 400 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"crowdsim doctor --bench"* ]]
}

@test "doctor --bench without k6 exits 5 and says what it is for" {
  PATH="$(path_without_k6)" run "$CROWDSIM" doctor --bench
  [ "$status" -eq 5 ]
  [[ "$output" == *"needs k6"* ]]
  [[ "$output" == *"what k6 can push on this machine"* ]]
}

@test "plain doctor does not benchmark: a report must not become a load generator" {
  run "$CROWDSIM" doctor
  [ "$status" -eq 0 ]
  [[ "$output" != *"measuring what this machine can generate"* ]]
  [ -z "$(ls "$CROWDSIM_OUT"/bench-*.json 2>/dev/null)" ]
}

@test "a generator in a container inside a VM says so before it generates anything" {
  # #30: measured — on macOS/Windows the Docker network layer saturates before the target does, and the run
  # comes back generator_ok: false after the window is gone. The container is detectable, and so is the VM
  # kernel Docker Desktop and WSL2 boot.
  mkdir -p "$CROWDSIM_OUT"
  touch "$BATS_TEST_TMPDIR/dockerenv"
  cat > "$BATS_TEST_TMPDIR/stub/uname" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-r" ]; then echo "6.3.13-linuxkit"; else /usr/bin/uname "$@"; fi
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/uname"

  CROWDSIM_CONTAINER_MARKER="$BATS_TEST_TMPDIR/dockerenv" \
    run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 40 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"CONTAINER INSIDE A VM"* ]]
  [[ "$output" == *"run k6 natively"* ]]
  [[ "$output" == *"a page, not a generator"* ]]
}

@test "it is a warning, not a gate: a detection that can be wrong must not stop a run" {
  # Colima and friends do not brand their kernel, so the check has false negatives — and Docker Desktop on a
  # LINUX host is a false positive where the warning happens to still be right. Neither justifies refusing.
  touch "$BATS_TEST_TMPDIR/dockerenv"
  cat > "$BATS_TEST_TMPDIR/stub/uname" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-r" ]; then echo "6.3.13-linuxkit"; else /usr/bin/uname "$@"; fi
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/uname"
  CROWDSIM_CONTAINER_MARKER="$BATS_TEST_TMPDIR/dockerenv" \
    run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 40 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"(dry run) k6 run"* ]]
}

@test "a container on a Linux host is the intended way to run it, and says nothing" {
  touch "$BATS_TEST_TMPDIR/dockerenv"
  cat > "$BATS_TEST_TMPDIR/stub/uname" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-r" ]; then echo "6.8.0-51-generic"; else /usr/bin/uname "$@"; fi
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/uname"
  CROWDSIM_CONTAINER_MARKER="$BATS_TEST_TMPDIR/dockerenv" \
    run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 40 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" != *"CONTAINER INSIDE A VM"* ]]
}

@test "not in a container: nothing to warn about, whatever the kernel says" {
  cat > "$BATS_TEST_TMPDIR/stub/uname" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-r" ]; then echo "6.3.13-linuxkit"; else /usr/bin/uname "$@"; fi
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/uname"
  CROWDSIM_CONTAINER_MARKER="$BATS_TEST_TMPDIR/definitely-not-here" \
    run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 40 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" != *"CONTAINER INSIDE A VM"* ]]
}

@test "a ceiling measured inside a VM is not used as reassurance" {
  # The trap this closes: doctor --bench inside Docker Desktop measures loopback INSIDE the VM — 16 Gbit/s
  # on the machine that wrote this test — and the estimate then compares a real peak against it and says
  # nothing. That is silence bought with a number from the one environment #30 exists to warn about.
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
json.dump({'run_id': '20260805T120000Z', 'base_url': 'http://127.0.0.1:8099', 'path': '/', 'status': 200,
           'ttfb_s': 0.18, 'bytes': 46231},
          open(os.path.join(out, 'probe-20260805T120000Z.json'), 'w'))
json.dump({'measured_at': '20260805T120500Z', 'req_per_second': 45000.0,
           'mbits_per_second': 16640.0, 'failed_rate': 0.0,
           'in_container': True, 'kernel': '6.3.13-linuxkit', 'virtualised': True},
          open(os.path.join(out, 'bench-20260805T120500Z.json'), 'w'))
PY
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 380 --safe-peak 400 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"measured inside a container in a VM"* ]]
  [[ "$output" == *"says nothing about the path to a real target"* ]]
  # It must not present that ceiling as a comparison that passed.
  [[ "$output" != *"16640 Mbit/s"* ]]
  [[ "$output" == *"safety.generator_mbps"* ]]     # back to asking for the number that would mean something
}

@test "a ceiling measured on the host itself is used, as before" {
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
json.dump({'run_id': '20260805T120000Z', 'base_url': 'http://127.0.0.1:8099', 'path': '/', 'status': 200,
           'ttfb_s': 0.18, 'bytes': 46231},
          open(os.path.join(out, 'probe-20260805T120000Z.json'), 'w'))
json.dump({'measured_at': '20260805T120500Z', 'mbits_per_second': 100.0,
           'in_container': False, 'kernel': '6.8.0-51-generic', 'virtualised': False},
          open(os.path.join(out, 'bench-20260805T120500Z.json'), 'w'))
PY
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 380 --safe-peak 400 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"loopback ceiling measured on this machine"* ]]
  [[ "$output" == *"WAS MEASURED DOING ON LOOPBACK"* ]]
}

@test "the benchmark records where it was measured, not just what it measured" {
  # A number read back next month has to carry its own context: the artefact says whether it was taken
  # inside a container, and on which kernel.
  skip_unless_k6
  CROWDSIM_BENCH_DUR=2s CROWDSIM_BENCH_VUS=4 run "$CROWDSIM" doctor --bench
  [ "$status" -eq 0 ]
  python3 - "$(echo "$CROWDSIM_OUT"/bench-*.json)" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k in ('in_container', 'kernel', 'virtualised'):
    assert k in d, f'the artefact does not record {k}: {list(d)}'
assert isinstance(d['virtualised'], bool), d
PY
}
