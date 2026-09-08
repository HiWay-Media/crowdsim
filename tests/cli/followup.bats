#!/usr/bin/env bats
#
# `--recalibrate` and `--certify`: the two follow-up runs the tool can start by itself.
#
# These are the most safety-sensitive flags in the tool, because they are the only ones under which
# crowdsim generates load nobody typed a command for. So what is asserted here is mostly what does NOT
# happen: off by default, refused when the failure is not the one they address, and every follow-up
# re-entering through both gates rather than inheriting them.
#
# No traffic: the stub k6 writes a prepared summary, which is what drives the decision. That also lets a
# single test cover a case a real run would take minutes to produce.

load helper

setup() {
  crowdsim_setup
  P="$FIXTURES/minimal.json"
  export CROWDSIM_ALLOW_TARGETS='127.0.0.1'
  # A stub that leaves behind whichever summary this test needs. `load` refuses (exit 4) when no summary
  # is produced, so every one of these tests needs one.
  cat > "$BATS_TEST_TMPDIR/stub/k6" <<'STUB'
#!/usr/bin/env bash
printf 'STUB-K6 %s\n' "$*"
out=""
for a in "$@"; do case "$a" in SUMMARY_OUT=*) out="${a#SUMMARY_OUT=}";; esac; done
# A follow-up run gets the SECOND summary, so a test can assert what the chain does next.
if [ -n "${CROWDSIM_FOLLOWUP_ATTEMPT:-}" ] && [ -n "${STUB_SUMMARY_NEXT:-}" ]; then
  cp "$STUB_SUMMARY_NEXT" "$out"
elif [ -n "$out" ]; then
  cp "$STUB_SUMMARY" "$out"
fi
exit 0
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/k6"
  export STUB_SUMMARY="$FIXTURES/summary-good.json"
}

# ── off by default ───────────────────────────────────────────────────────────────────────────────────

@test "without the flags nothing follows: one command is one run" {
  export STUB_SUMMARY="$FIXTURES/summary-first-step-died.json"
  run "$CROWDSIM" load --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s
  [ "$status" -eq 0 ]
  [[ "$output" != *"follow-up run"* ]]
  # exactly one run in the archive
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
}

# ── recalibrate ──────────────────────────────────────────────────────────────────────────────────────

@test "a first step that did not survive is retried at half the rate, as its own run" {
  export STUB_SUMMARY="$FIXTURES/summary-first-step-died.json"
  export STUB_SUMMARY_NEXT="$FIXTURES/summary-good.json"
  run "$CROWDSIM" load --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s --recalibrate
  [ "$status" -eq 0 ]
  [[ "$output" == *"follow-up run"* ]]
  [[ "$output" == *"--start 2 --peak 4"* ]]
  [[ "$output" == *"Attempt 2 of 3"* ]]
  # two runs, two summaries, two history rows: the failed attempt is evidence and is kept
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 2 ]
  [ "$(grep -c . "$CROWDSIM_OUT/history.tsv")" -eq 3 ]
}

@test "the ramp keeps its shape, so the retry is still a ramp" {
  export STUB_SUMMARY="$FIXTURES/summary-first-step-died.json"
  export STUB_SUMMARY_NEXT="$FIXTURES/summary-good.json"
  run "$CROWDSIM" load --profile "$P" --peak 12 --start 4 --steps 2 --step-dur 5s --hold 0s --recalibrate
  # 4:12 in, 2:6 out — the same start:peak ratio, not a lower start under the same peak
  [[ "$output" == *"--start 2 --peak 6"* ]]
}

@test "it stops at the floor instead of converging on zero" {
  export STUB_SUMMARY="$FIXTURES/summary-first-step-died.json"
  run "$CROWDSIM" load --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s \
    --recalibrate --recalibrate-floor 4
  [ "$status" -eq 0 ]
  [[ "$output" == *"no follow-up run"* ]]
  [[ "$output" == *"floor"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
}

@test "404s are not a capacity problem: the same run at half the rate is the same 404s" {
  export STUB_SUMMARY="$FIXTURES/summary-first-step-404.json"
  run "$CROWDSIM" load --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s --recalibrate
  [ "$status" -eq 0 ]
  [[ "$output" == *"no follow-up run"* ]]
  [[ "$output" == *"404"* ]]
  [[ "$output" == *"discover --verify"* || "$output" == *"pool"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
}

@test "a generator-bound run is not retried lower" {
  export STUB_SUMMARY="$FIXTURES/summary-invalid.json"
  run "$CROWDSIM" load --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s --recalibrate
  [ "$status" -eq 0 ]
  [[ "$output" == *"no follow-up run"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
}

@test "a run with a knee is never retried: it has a curve to read" {
  export STUB_SUMMARY="$FIXTURES/summary-good.json"
  run "$CROWDSIM" load --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s --recalibrate
  [ "$status" -eq 0 ]
  [[ "$output" == *"no follow-up run"* ]]
}

# ── certify ──────────────────────────────────────────────────────────────────────────────────────────

@test "a swept knee is followed by one hold at that rate, as a separate run" {
  export STUB_SUMMARY="$FIXTURES/summary-swept-knee.json"
  export STUB_SUMMARY_NEXT="$FIXTURES/summary-good.json"
  run "$CROWDSIM" load --profile "$P" --peak 40 --start 10 --steps 4 --step-dur 5s --hold 0s --certify
  [ "$status" -eq 0 ]
  [[ "$output" == *"follow-up run"* ]]
  [[ "$output" == *"--start 40 --peak 40 --steps 1 --hold 60s"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 2 ]
}

@test "--certify-hold sets how long the hold lasts" {
  export STUB_SUMMARY="$FIXTURES/summary-swept-knee.json"
  export STUB_SUMMARY_NEXT="$FIXTURES/summary-good.json"
  run "$CROWDSIM" load --profile "$P" --peak 40 --start 10 --steps 4 --step-dur 5s --hold 0s \
    --certify --certify-hold 3m
  [[ "$output" == *"--hold 3m"* ]]
}

@test "one hold, not a chain: the certification does not certify itself" {
  export STUB_SUMMARY="$FIXTURES/summary-swept-knee.json"
  export STUB_SUMMARY_NEXT="$FIXTURES/summary-swept-knee.json"
  run "$CROWDSIM" load --profile "$P" --peak 40 --start 10 --steps 4 --step-dur 5s --hold 0s --certify
  [ "$status" -eq 0 ]
  # two runs, and the second does not start a third even though its summary is swept as well
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 2 ]
}

@test "a refused knee is not certified: a hold must not make a qualified knee unqualified" {
  export STUB_SUMMARY="$FIXTURES/summary-first-step-died.json"
  run "$CROWDSIM" load --profile "$P" --peak 40 --start 10 --steps 4 --step-dur 5s --hold 0s --certify
  [ "$status" -eq 0 ]
  [[ "$output" == *"no follow-up run"* ]]
  [[ "$output" == *"refused"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
}

@test "the safe-peak override does not carry into the follow-up run" {
  # The case that matters. Sweeping past the ceiling takes --i-know-this-breaks-production on the command
  # line; HOLDING that rate for minutes is a larger authorisation than passing through it, and a loop must
  # not inherit a decision somebody took once. So the sweep is allowed and the certification is refused.
  export STUB_SUMMARY="$FIXTURES/summary-swept-knee.json"
  run "$CROWDSIM" load --profile "$P" --peak 40 --start 10 --steps 4 --step-dur 5s --hold 0s \
    --safe-peak 20 --i-know-this-breaks-production --certify
  [ "$status" -eq 0 ]
  [[ "$output" == *"no follow-up run"* ]]
  [[ "$output" == *"safe peak"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
}

# ── the gates, per attempt ───────────────────────────────────────────────────────────────────────────

@test "a follow-up run goes through the allowlist gate like any other run" {
  # The safety property of this whole feature: the follow-up is this driver invoked again, so the gate is
  # re-checked by construction. Asserted by taking the allowlist away for the follow-up only.
  export STUB_SUMMARY="$FIXTURES/summary-first-step-died.json"
  export STUB_SUMMARY_NEXT="$FIXTURES/summary-good.json"
  run env CROWDSIM_ALLOW_TARGETS='127.0.0.1' "$CROWDSIM" load --profile "$FIXTURES/no-allowlist.json" \
    --base-url 'http://127.0.0.1:8099' --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s --recalibrate
  [ "$status" -eq 0 ]
  # and with no allowlist at all, the FIRST run never happens — which is the gate, unchanged
  run env -u CROWDSIM_ALLOW_TARGETS "$CROWDSIM" load --profile "$FIXTURES/no-allowlist.json" \
    --base-url 'http://127.0.0.1:8099' --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s --recalibrate
  [ "$status" -eq 3 ]
}

@test "the follow-up forwards every other flag it was given" {
  # Rebuilding an argv from resolved state would drop whatever the code forgot; a run that is not the run
  # somebody asked for is the class of wrong answer this tool exists to avoid.
  export STUB_SUMMARY="$FIXTURES/summary-first-step-died.json"
  export STUB_SUMMARY_NEXT="$FIXTURES/summary-good.json"
  run "$CROWDSIM" load --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s \
    --rsc-mode random --insecure --recalibrate
  [ "$status" -eq 0 ]
  # both k6 invocations carry the forwarded flags
  [ "$(printf '%s\n' "$output" | grep -c 'RSC_MODE=random')" -eq 2 ]
  [ "$(printf '%s\n' "$output" | grep -c 'INSECURE=1')" -eq 2 ]
}

@test "without node the follow-up is not attempted, and the run is still archived" {
  export STUB_SUMMARY="$FIXTURES/summary-first-step-died.json"
  run env PATH="$(path_without_node)" CROWDSIM_ALLOW_TARGETS='127.0.0.1' "$CROWDSIM" load \
    --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s --recalibrate
  [ "$status" -eq 0 ]
  [[ "$output" == *"needs node"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
}
