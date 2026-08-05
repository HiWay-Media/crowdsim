#!/usr/bin/env bats
#
# Argument handling, subcommand dispatch and exit-code contract. The exit codes are an API: the Nomad
# job, CI and the GUI all branch on them.

load helper.bash
setup() { crowdsim_setup; }

@test "--help prints the usage header and exits 0" {
  run "$CROWDSIM" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"crowdsim doctor"* ]]
  [[ "$output" == *"THIS TOOL GENERATES REAL LOAD"* ]]
}

@test "the usage header is inside the window usage() reads" {
  # usage() is `sed -n '1,60p' | grep '^#'`: comments pushed past line 60 vanish from --help silently.
  run bash -c "grep -n 'Requires: k6, curl, python3' '$CROWDSIM' | cut -d: -f1"
  [ "$status" -eq 0 ]
  [ "$output" -le 60 ]
}

@test "no subcommand prints usage and exits 2" {
  run "$CROWDSIM"
  [ "$status" -eq 2 ]
  [[ "$output" == *"crowdsim doctor"* ]]
}

@test "an unknown subcommand exits 2" {
  run "$CROWDSIM" stampede
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown subcommand: stampede"* ]]
}

@test "an unknown option exits 2 instead of being ignored" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peek 900
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown option: --peek"* ]]
}

@test "load without --profile exits 2 and points at the example" {
  run "$CROWDSIM" load
  [ "$status" -eq 2 ]
  [[ "$output" == *"profiles/example.json"* ]]
}

@test "a missing profile file exits 2" {
  run "$CROWDSIM" load --profile "$BATS_TEST_TMPDIR/nope.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"profile not found"* ]]
}

@test "k6 missing exits 5 with install instructions, and warns against Docker on a laptop" {
  PATH="$(path_without_k6)" run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 5 ]
  [[ "$output" == *"k6 not found"* ]]
  [[ "$output" == *"do NOT run the generator through Docker on a laptop"* ]]
}

@test "doctor reports the environment and exits 0 even when things are missing" {
  PATH="$(path_without_k6)" run "$CROWDSIM" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"k6 MISSING"* ]]
  [[ "$output" == *"CROWDSIM_ALLOW_TARGETS unset"* ]]
}

@test "doctor validates a profile when given one" {
  run "$CROWDSIM" doctor --profile "$FIXTURES/minimal.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"parses, pools resolved"* ]]
}

@test "doctor surfaces a broken profile instead of reporting it as fine" {
  run "$CROWDSIM" doctor --profile "$FIXTURES/unknown-pool.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown pool"* ]]
}

@test "history says so when there are no runs yet" {
  run "$CROWDSIM" history
  [ "$status" -eq 0 ]
  [[ "$output" == *"no runs yet"* ]]
}

@test "history prints the recorded runs" {
  mkdir -p "$CROWDSIM_OUT"
  printf 'run_id\tpeak\tgen_ok\n20260805T090000Z\t60\tTrue\n' > "$CROWDSIM_OUT/history.tsv"
  run "$CROWDSIM" history
  [ "$status" -eq 0 ]
  [[ "$output" == *"20260805T090000Z"* ]]
}

@test "cache-ab without docker exits 5 rather than half-starting a leg" {
  # The A/B harness is two containers: without docker there is nothing to fall back to.
  stub="$BATS_TEST_TMPDIR/stub"
  PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/usr/local/bin' | paste -sd: -)" \
    run env PATH="$stub:/usr/bin:/bin" "$CROWDSIM" cache-ab --profile "$FIXTURES/minimal.json"
  [ "$status" -eq 5 ]
  [[ "$output" == *"needs docker"* ]]
}
