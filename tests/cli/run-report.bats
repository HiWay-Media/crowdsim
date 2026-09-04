#!/usr/bin/env bats
#
# What the wrapper does with a finished run. The generator is a stub that writes a canned summary, so the
# assertions are about the reporting contract: a run whose result is invalid must SAY so, the brake
# tripping must not look like a tool failure, and history must accumulate.

load helper.bash

setup() {
  crowdsim_setup
  # Stub that behaves like k6: writes the summary it was told to write, and can exit non-zero the way k6
  # does when a threshold with abortOnFail trips.
  cat > "$BATS_TEST_TMPDIR/stub/k6" <<'STUB'
#!/usr/bin/env bash
out=""
for a in "$@"; do case "$a" in SUMMARY_OUT=*) out="${a#SUMMARY_OUT=}";; esac; done
if [ -n "$out" ] && [ -n "${FAKE_SUMMARY:-}" ]; then cp "$FAKE_SUMMARY" "$out"; fi
echo "STUB-K6 ran"
exit "${FAKE_K6_RC:-0}"
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/k6"
}

load_run() {
  FAKE_SUMMARY="$FIXTURES/$1" FAKE_K6_RC="${2:-0}" \
    "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 40
}

@test "a completed run writes a summary and one history row" {
  run load_run summary-good.json
  [ "$status" -eq 0 ]
  [[ "$output" == *"summary:"* ]]
  [ -f "$CROWDSIM_OUT/history.tsv" ]
  run cat "$CROWDSIM_OUT/history.tsv"
  [[ "${lines[0]}" == *"run_id"* ]]
  [[ "${lines[1]}" == *"20260805T101112Z"* ]]
  [[ "${lines[1]}" == *"True"* ]]
}

@test "history accumulates instead of being overwritten: that is how you see the knee move" {
  load_run summary-good.json
  load_run summary-aborted.json
  run bash -c "wc -l < '$CROWDSIM_OUT/history.tsv'"
  [ "$output" -eq 3 ]      # header + 2 runs
}

@test "the brake tripping exits 0: finding the knee is an outcome, not a tool failure" {
  # k6 exits non-zero when an abortOnFail threshold trips. If the wrapper propagated that, every
  # scheduler would file a successful experiment as a failed job.
  run load_run summary-aborted.json 99
  [ "$status" -eq 0 ]
  [ -f "$CROWDSIM_OUT/history.tsv" ]
}

@test "a generator-bound run is flagged as unusable, in words" {
  run load_run summary-invalid.json
  [ "$status" -eq 0 ]
  [[ "$output" == *"THE GENERATOR DID NOT HOLD THE RATE"* ]]
  [[ "$output" == *"discard this run"* ]]
}

@test "a target that never answered is reported as connectivity, not as capacity" {
  run load_run summary-unreachable.json
  [ "$status" -eq 0 ]
  [[ "$output" == *"THE TARGET NEVER ANSWERED"* ]]
  [[ "$output" == *"crowdsim probe"* ]]
}

@test "no summary at all is reported rather than silently succeeding" {
  # Exit 4, not 0: a scheduler that reads 0 files a run that never happened as executed.
  run bash -c "FAKE_K6_RC=1 '$CROWDSIM' load --profile '$FIXTURES/minimal.json' --peak 40"
  [ "$status" -eq 4 ]
  [[ "$output" == *"no summary produced"* ]]
}

@test "--slack without a webhook warns instead of failing the run" {
  run bash -c "FAKE_SUMMARY='$FIXTURES/summary-good.json' '$CROWDSIM' load \
    --profile '$FIXTURES/minimal.json' --peak 40 --slack"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CROWDSIM_SLACK_WEBHOOK is unset"* ]]
}

@test "the run log is kept next to the summary" {
  load_run summary-good.json
  run bash -c "ls '$CROWDSIM_OUT' | grep -c '^load-'"
  [ "$output" -eq 1 ]
}
