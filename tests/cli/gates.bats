#!/usr/bin/env bats
#
# The safety gates. These are the tests that matter most in this repo: everything else produces a bad
# measurement, a broken gate produces load against something that was never authorised.

load helper.bash
setup() { crowdsim_setup; }

@test "gate 1: with no allowlist anywhere, the run is refused (exit 3)" {
  run "$CROWDSIM" load --profile "$FIXTURES/no-allowlist.json" --peak 10 --dry-run
  [ "$status" -eq 3 ]
  [[ "$output" == *"no target allowlist"* ]]
  [[ "$output" == *"indistinguishable from an attack"* ]]
}

@test "gate 1: a host outside the allowlist is refused (exit 3)" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --target elsewhere --peak 10 --dry-run
  [ "$status" -eq 3 ]
  [[ "$output" == *"not-allowed.test"* ]]
  [[ "$output" == *"not in the allowlist"* ]]
}

@test "gate 1: a host listed in the profile is authorised" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"allowlist: '127.0.0.1' authorised"* ]]
}

@test "gate 1: allow_hosts globs match, so a whole internal range can be allowed" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --target hostheader --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"allowlist: '10.0.0.11' authorised"* ]]
}

@test "gate 1: CROWDSIM_ALLOW_TARGETS overrides the profile — and can narrow it to nothing useful" {
  CROWDSIM_ALLOW_TARGETS='www.example.test' run "$CROWDSIM" load \
    --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 3 ]
  [[ "$output" == *"not in the allowlist (www.example.test)"* ]]
}

@test "gate 1: the allowlist applies to --base-url too, not just to named targets" {
  # --base-url skips target resolution entirely. If the gate lived in resolve_target, a stale copy-pasted
  # --base-url would fire at anything.
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" \
    --base-url https://someone-elses.test --peak 10 --dry-run
  [ "$status" -eq 3 ]
  [[ "$output" == *"someone-elses.test"* ]]
}

@test "gate 1: the port is not part of the host being matched" {
  CROWDSIM_ALLOW_TARGETS='127.0.0.1' run "$CROWDSIM" load \
    --profile "$FIXTURES/minimal.json" --base-url http://127.0.0.1:8081 --peak 10 --dry-run
  [ "$status" -eq 0 ]
}

@test "gate 2: above the profile's safe peak the run is refused (exit 3)" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 500 --dry-run
  [ "$status" -eq 3 ]
  [[ "$output" == *"above the safe ceiling (50 req/s)"* ]]
  [[ "$output" == *"--i-know-this-breaks-production"* ]]
}

@test "gate 2: exactly at the safe peak is allowed" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 50 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"within the safe ceiling (50)"* ]]
}

@test "gate 2: the override lets it through, loudly" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 500 --dry-run \
    --i-know-this-breaks-production
  [ "$status" -eq 0 ]
  [[ "$output" == *"ABOVE the safe ceiling"* ]]
  [[ "$output" == *"this will hurt"* ]]
}

@test "gate 2: --safe-peak can only be used to raise the bar in the run, not to skip the gate" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 120 --safe-peak 100 --dry-run
  [ "$status" -eq 3 ]
  [[ "$output" == *"above the safe ceiling (100 req/s)"* ]]
}

@test "gate 2: a non-numeric peak is refused rather than silently treated as 0" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak lots --dry-run
  [ "$status" -eq 3 ]
}

@test "the gates also guard discover and probe, which talk to the target too" {
  run "$CROWDSIM" discover --profile "$FIXTURES/no-allowlist.json"
  [ "$status" -eq 3 ]
  run "$CROWDSIM" probe --profile "$FIXTURES/no-allowlist.json"
  [ "$status" -eq 3 ]
}

@test "no interactive confirmation is ever emitted: the gates must hold on a scheduler" {
  # A prompt on a scheduler either hangs the run or gets auto-answered. Closing stdin must change nothing.
  run bash -c "'$CROWDSIM' load --profile '$FIXTURES/minimal.json' --peak 500 --dry-run </dev/null"
  [ "$status" -eq 3 ]
  [[ "$output" != *"[y/N]"* ]]
  [[ "$output" != *"are you sure"* ]]
}
