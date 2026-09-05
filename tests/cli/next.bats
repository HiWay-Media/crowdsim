#!/usr/bin/env bats
#
# `crowdsim next` — where you are, and the one command to run next.
#
# The reason this is tested rather than eyeballed: it is the step where the tool loses people, and it is
# also the one step where guessing on their behalf is forbidden. The two safety keys are left empty by
# `init` on purpose, and this command must report them as decisions — never fill one in, never suggest a
# value, and never turn into a wizard. Those are the assertions below that are not about wording.

load helper

setup() {
  crowdsim_setup
  WORK="$BATS_TEST_TMPDIR/work"
  mkdir -p "$WORK/out" "$WORK/profiles"
  export CROWDSIM_OUT="$WORK/out"
  export CROWDSIM_PROFILES="$WORK/profiles"
}

ready_profile() {
  cat > "$CROWDSIM_PROFILES/site.json" <<'JSON'
{ "name": "site",
  "targets": { "default": "edge", "list": { "edge": { "base_url": "https://www.example.test" } } },
  "safety": { "allow_hosts": ["www.example.test"], "safe_peak_rps": 150 },
  "pools": { "pages": ["/"] },
  "classes": [ { "name": "html", "kind": "plain", "pool": "pages", "weight": 100 } ] }
JSON
}

draft_profile() {
  cat > "$CROWDSIM_PROFILES/site.json" <<'JSON'
{ "name": "site",
  "targets": { "default": "edge", "list": { "edge": { "base_url": "https://www.example.test" } } },
  "safety": { "allow_hosts": [], "safe_peak_rps": null },
  "pools": { "pages": ["/"] },
  "classes": [ { "name": "html", "kind": "plain", "pool": "pages", "weight": "TODO" } ] }
JSON
}

@test "with nothing at all it says so, and the next step is a profile to point at" {
  run "$CROWDSIM" next
  [ "$status" -eq 0 ]
  [[ "$output" == *"where you are"* ]]
  [[ "$output" == *"nothing yet"* ]]
  [[ "$output" == *"none yet"* ]]
  [[ "$output" == *"cp profiles/example.json"* ]]
}

@test "a draft profile is named as a draft, with the two decisions spelled out and NOT made" {
  draft_profile
  run "$CROWDSIM" next
  [ "$status" -eq 0 ]
  [[ "$output" == *"draft"* ]]
  [[ "$output" == *"safety.allow_hosts"* ]]
  [[ "$output" == *"safety.safe_peak_rps"* ]]
  [[ "$output" == *"not things this tool"* ]]
  # It must not propose a value for either. A suggested safe peak is a safe peak somebody accepts.
  [[ "$output" != *"safe_peak_rps: 1"* ]]
  [[ "$output" != *'"allow_hosts": ['* ]]
}

@test "it changes no profile and writes nothing, which is the whole reason it can be run blind" {
  draft_profile
  local before after
  before="$(cat "$CROWDSIM_PROFILES/site.json")"
  run "$CROWDSIM" next
  after="$(cat "$CROWDSIM_PROFILES/site.json")"
  [ "$before" = "$after" ]
  [ -z "$(ls -A "$CROWDSIM_OUT")" ]
  [[ "$output" == *"generated no traffic, wrote nothing and changed no profile"* ]]
}

@test "there is no prompt and no wizard: it runs identically with no stdin at all" {
  ready_profile
  run bash -c "'$CROWDSIM' next < /dev/null"
  [ "$status" -eq 0 ]
  [[ "$output" != *"[y/N]"* ]]
  [[ "$output" != *"Press"* ]]
  [[ "$output" != *"continue?"* ]]
}

@test "a usable profile with nothing measured is sent to discover" {
  ready_profile
  run "$CROWDSIM" next
  [[ "$output" == *"allowlist and safe peak set"* ]]
  [[ "$output" == *"crowdsim discover --profile"* ]]
  [[ "$output" == *"--verify"* ]]
}

@test "with a pool but no preflight it is sent to probe" {
  ready_profile
  echo '{"base_url":"https://www.example.test"}' > "$CROWDSIM_OUT/discover-20260901T101500Z.json"
  run "$CROWDSIM" next
  [[ "$output" == *"crowdsim probe --profile"* ]]
}

@test "with everything measured it names validate and then the run, and how to read it" {
  ready_profile
  echo '{"base_url":"https://www.example.test"}' > "$CROWDSIM_OUT/discover-20260901T101500Z.json"
  echo '{"base_url":"https://www.example.test"}' > "$CROWDSIM_OUT/probe-20260901T101500Z.json"
  run "$CROWDSIM" next
  [[ "$output" == *"crowdsim validate"* ]]
  [[ "$output" == *"crowdsim load --profile"* ]]
  [[ "$output" == *"crowdsim report latest"* ]]
}

@test "a profile that is not readable JSON is reported, not skipped in silence" {
  echo 'not json at all' > "$CROWDSIM_PROFILES/broken.json"
  run "$CROWDSIM" next
  [ "$status" -eq 0 ]
  [[ "$output" == *"broken.json"* ]]
  [[ "$output" == *"not readable JSON"* ]]
}

@test "next answers --help for itself, like every other subcommand" {
  run "$CROWDSIM" next --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"crowdsim next"* ]]
  [[ "$output" == *"decides nothing"* || "$output" == *"fills nothing in"* ]]
}

@test "it does not walk the whole working directory looking for a journey" {
  # A recursive `**` glob over a checkout with node_modules in it takes minutes, and this command's whole
  # value is that it answers immediately — it was doing exactly that, and it turned `make test` from one
  # minute into thirty. So: two conventional places, one level deep, and a journey buried somewhere else
  # is simply not found.
  ready_profile
  mkdir -p "$WORK/deep/a/b/c" "$WORK/journeys"
  echo '{}' > "$WORK/deep/a/b/c/browse-journey.json"
  echo '{}' > "$WORK/journeys/browse.json"

  cd "$WORK"
  run "$CROWDSIM" next
  [ "$status" -eq 0 ]
  [[ "$output" == *"journeys/browse.json"* ]]
  [[ "$output" != *"deep/a/b/c"* ]]
}
