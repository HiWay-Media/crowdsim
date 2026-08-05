#!/usr/bin/env bats
#
# `cache-ab`: the optional third leg.
#
# The third leg is normally the NARROW SUBSET of a fix — the version that can actually ship this week —
# measured in the same window as the full change, so you learn what the narrow one is worth. It used to cost
# a hand-edit of docker-compose.yml, which is how a comparison stops being made.
#
# What is tested here is not that nginx starts (that needs docker, and belongs to e2e). It is the two
# refusals, which are about the RESULT being readable rather than about containers: a leg template that lost
# the candidate's warning, and a leg that still calls itself "candidate" in the header the comparison is read
# from. Both are what happens when a file is copied.
#
# docker is a stub that records what it was asked to do: no containers, no traffic.

load helper.bash

setup() {
  crowdsim_setup
  PROFILE="$FIXTURES/minimal.json"
  LEG="$BATS_TEST_TMPDIR/narrow-fix.conf.template"

  # A docker that records its invocation instead of starting anything.
  DOCKER_LOG="$BATS_TEST_TMPDIR/docker.log"
  cat > "$BATS_TEST_TMPDIR/stub/docker" <<'STUB'
#!/usr/bin/env bash
printf 'argv: %s\n' "$*" >> "$DOCKER_LOG"
printf 'THIRD_TEMPLATE=%s\n' "${THIRD_TEMPLATE:-}" >> "$DOCKER_LOG"
exit 0
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/docker"
  export DOCKER_LOG
  # No CROWDSIM_ALLOW_TARGETS here: minimal.json allowlists its own target, and an env value would OVERRIDE
  # the profile's — refusing the run at the gate before any of this is reached. That is the gate working, and
  # it is asserted on purpose in the last test.
}

@test "--new-leg scaffolds a leg that carries the warning, under its own name" {
  run "$CROWDSIM" cache-ab --new-leg "$LEG"
  [ "$status" -eq 0 ]
  [ -f "$LEG" ]

  # The warning is the paragraph that separates a measurement from an outage, and a copy is exactly where it
  # goes missing.
  grep -q 'READ THIS BEFORE COPYING IT TO PRODUCTION' "$LEG"
  grep -q 'PERSONALISED RESPONSES' "$LEG"

  # Renamed, or the third leg's responses cannot be told from the candidate's in the results.
  grep -qE 'X-AB-Leg[[:space:]]+"narrow-fix"' "$LEG"
  ! grep -qE 'X-AB-Leg[[:space:]]+"candidate"' "$LEG"
}

@test "the scaffold differs from the candidate ONLY by the leg name" {
  run "$CROWDSIM" cache-ab --new-leg "$LEG"
  [ "$status" -eq 0 ]
  run diff <(sed 's/"narrow-fix"/"candidate"/' "$LEG") "$CROWDSIM_ROOT/cache-ab/candidate.conf.template"
  [ "$status" -eq 0 ]
}

@test "--new-leg does not overwrite a leg somebody has already written" {
  run "$CROWDSIM" cache-ab --new-leg "$LEG"
  [ "$status" -eq 0 ]
  echo "# my edits" >> "$LEG"
  run "$CROWDSIM" cache-ab --new-leg "$LEG"
  [ "$status" -eq 2 ]
  [[ "$output" == *"already exists"* ]]
  grep -q '# my edits' "$LEG"
}

@test "a leg may not be called asis or candidate" {
  run "$CROWDSIM" cache-ab --new-leg "$BATS_TEST_TMPDIR/candidate.conf.template"
  [ "$status" -eq 2 ]
  [[ "$output" == *"not 'asis' or 'candidate'"* ]]
  [ ! -f "$BATS_TEST_TMPDIR/candidate.conf.template" ]
}

@test "--third starts three legs without anyone editing the compose file" {
  run "$CROWDSIM" cache-ab --new-leg "$LEG"
  [ "$status" -eq 0 ]
  run "$CROWDSIM" cache-ab --profile "$PROFILE" --third "$LEG" --ttl 30
  [ "$status" -eq 0 ]

  # The compose profile is what keeps the third leg out of the default two-leg run.
  grep -q -- '--profile third up -d --force-recreate' "$DOCKER_LOG"
  # An absolute path: compose resolves a relative one against cache-ab/, and the leg is somewhere else.
  grep -q "THIRD_TEMPLATE=$LEG" "$DOCKER_LOG"
  [[ "$output" == *"http://127.0.0.1:8083"* ]]
}

@test "without --third the third leg does not start, and nothing changes for the two-leg run" {
  run "$CROWDSIM" cache-ab --profile "$PROFILE"
  [ "$status" -eq 0 ]
  grep -q 'argv: compose up -d --force-recreate' "$DOCKER_LOG"
  ! grep -q -- '--profile third' "$DOCKER_LOG"
  [[ "$output" != *"8083"* ]]
}

@test "a leg template that lost the warning is refused" {
  # The realistic accident: someone writes a leg from scratch, or trims the header comment.
  printf 'server { listen 8080; add_header X-AB-Leg "narrow"; }\n' > "$LEG"
  run "$CROWDSIM" cache-ab --profile "$PROFILE" --third "$LEG"
  [ "$status" -eq 2 ]
  [[ "$output" == *"does not carry the candidate template's warning"* ]]
  [[ "$output" == *"crowdsim cache-ab --new-leg"* ]]
  [ ! -f "$DOCKER_LOG" ]                      # nothing was started
}

@test "a leg that still calls itself candidate is refused: the results could not be told apart" {
  cp "$CROWDSIM_ROOT/cache-ab/candidate.conf.template" "$LEG"
  run "$CROWDSIM" cache-ab --profile "$PROFILE" --third "$LEG"
  [ "$status" -eq 2 ]
  [[ "$output" == *"still identifies itself as \"candidate\""* ]]
  [ ! -f "$DOCKER_LOG" ]
}

@test "--third with a missing file says how to create one" {
  run "$CROWDSIM" cache-ab --profile "$PROFILE" --third "$BATS_TEST_TMPDIR/nope.template"
  [ "$status" -eq 2 ]
  [[ "$output" == *"no such leg template"* ]]
  [[ "$output" == *"--new-leg"* ]]
}

@test "the third leg still goes through the allowlist gate, like every other target" {
  run "$CROWDSIM" cache-ab --new-leg "$LEG"
  [ "$status" -eq 0 ]
  run env -u CROWDSIM_ALLOW_TARGETS "$CROWDSIM" cache-ab --profile "$FIXTURES/no-allowlist.json" --third "$LEG"
  [ "$status" -eq 3 ]
  [ ! -f "$DOCKER_LOG" ]
}

@test "--run refuses when loopback is not allowlisted, before a container starts" {
  # The realistic case: a profile that allowlists the real site, which is exactly the profile somebody points
  # at cache-ab. The legs are on 127.0.0.1, and this command does NOT grant itself that host — the moment a
  # subcommand can authorise a host on your behalf, the gate is a suggestion.
  run env CROWDSIM_ALLOW_TARGETS='www.example.test' \
    "$CROWDSIM" cache-ab --profile "$FIXTURES/minimal.json" --base-url https://www.example.test --run
  [ "$status" -eq 3 ]
  [[ "$output" == *"--run loads the legs on 127.0.0.1"* ]]
  [[ "$output" == *"grants no allowlist to itself"* ]]
  [ ! -f "$DOCKER_LOG" ]
}

@test "--run loads each leg in turn and then compares them" {
  run "$CROWDSIM" cache-ab --profile "$FIXTURES/minimal.json" --run --peak 12
  [ "$status" -eq 0 ]

  # Both legs, in order, at the same peak — and sequential, because two generators on one host measure the
  # host rather than the legs.
  [[ "$output" == *"leg asis (http://127.0.0.1:8081)"* ]]
  [[ "$output" == *"leg candidate (http://127.0.0.1:8082)"* ]]
  [[ "$output" == *"sequential on purpose"* ]]
  [[ "$output" == *"the delta between the legs"* ]]

  # What it does NOT claim: that the two runs happened in the same second.
  [[ "$output" == *"minutes apart — not the same second"* ]]
}

@test "--run with a third leg compares that one too" {
  run "$CROWDSIM" cache-ab --new-leg "$LEG"
  [ "$status" -eq 0 ]
  run "$CROWDSIM" cache-ab --profile "$FIXTURES/minimal.json" --run --third "$LEG" --peak 12
  [ "$status" -eq 0 ]
  [[ "$output" == *"leg third (http://127.0.0.1:8083)"* ]]
  [[ "$output" == *"asis → candidate"* ]]
  [[ "$output" == *"asis → third"* ]]
}
