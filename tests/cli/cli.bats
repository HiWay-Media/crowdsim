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

@test "the whole comment header reaches --help, and the shebang does not" {
  # usage() used to be `sed -n '1,60p' | grep '^#'`, which had two silent failure modes: it printed the
  # shebang stripped of its `#` as the FIRST line of --help, and it truncated the help the moment the header
  # grew past sixty lines. It is now extracted by structure — line 2 to the first non-comment line — so both
  # ends are asserted here rather than a line count nobody would notice breaking.
  run "$CROWDSIM" --help
  [ "$status" -eq 0 ]
  case "$output" in
    *"/usr/bin/env bash"*) printf 'the shebang is being printed as help\n' >&2; return 1;;
  esac
  # the last line of the header, whatever line number it now lives on
  case "$output" in
    *"Requires: k6, curl, python3"*) ;;
    *) printf 'the help stops before the end of the header\n' >&2; return 1;;
  esac
  # and every subcommand the dispatcher accepts is named in it: a subcommand missing from --help does not
  # exist as far as anyone reading the tool is concerned
  local sub
  for sub in doctor discover probe load cache-ab history compare report weights init record validate serve; do
    case "$output" in
      *"$sub"*) ;;
      *) printf '%s is dispatched but not in the header\n' "$sub" >&2; return 1;;
    esac
  done
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

@test "doctor surfaces a broken profile but still exits 0: it is a report, not a gate" {
  # `validate` and `load` are the gates (exit 2). doctor's job is to tell you what it found, and a report
  # that exits non-zero gets wrapped in `|| true` by the first person who scripts it.
  run "$CROWDSIM" doctor --profile "$FIXTURES/unknown-pool.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"unknown pool"* ]]
}

@test "CROWDSIM_ROOT relocates the generator, so the image can split the script from the tool" {
  # In the container the driver is in /usr/local/bin and everything else in /crowdsim: deriving the root
  # from the script's own path would resolve to /usr/local and break `serve` and `cache-ab` silently.
  CROWDSIM_ROOT=/opt/elsewhere run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"/opt/elsewhere/k6/live-event.js"* ]]
}

@test "CROWDSIM_K6_SCRIPT still wins over the root, for a generator kept elsewhere" {
  CROWDSIM_ROOT=/opt/elsewhere CROWDSIM_K6_SCRIPT=/tmp/custom.js \
    run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"/tmp/custom.js"* ]]
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

@test "history still prints where there is no column(1) — which is the published image" {
  # `column` ships with util-linux; busybox does not have it, and the image is alpine-based. So the one
  # subcommand whose whole job is to print a file was the one that could not run in the container.
  mkdir -p "$CROWDSIM_OUT"
  printf 'run_id\tpeak\tgen_ok\n20260805T090000Z\t60\tTrue\n' > "$CROWDSIM_OUT/history.tsv"
  run env PATH="$(path_without_column)" "$CROWDSIM" history
  [ "$status" -eq 0 ]
  [[ "$output" == *"20260805T090000Z"* ]]
  [[ "$output" == *"run_id"* ]]
}

@test "the history columns line up, so a long run id does not shift the row" {
  mkdir -p "$CROWDSIM_OUT"
  # the peak values are chosen not to occur inside the run ids, so index() finds the column, not a digit
  printf 'run_id\tprofile\tpeak\n20260805T090000Z\tp\t77\nshort\tp\t488\n' > "$CROWDSIM_OUT/history.tsv"
  run "$CROWDSIM" history
  [ "$status" -eq 0 ]
  # the second column starts at the same offset on both rows. Since 1.26.0 every row carries a
  # two-character margin (where a discard is marked), so the anchor is the run id, not the line start.
  a="$(echo "$output" | awk '/20260805T090000Z/ {print index($0, "77")}')"
  b="$(echo "$output" | awk '/ short / {print index($0, "488")}')"
  [ -n "$a" ] && [ "$a" = "$b" ]
}

@test "cache-ab without docker exits 5 rather than half-starting a leg" {
  # The A/B harness is two containers: without docker there is nothing to fall back to.
  run env PATH="$(path_without_docker)" "$CROWDSIM" cache-ab --profile "$FIXTURES/minimal.json"
  [ "$status" -eq 5 ]
  [[ "$output" == *"needs docker"* ]]
}

@test "--version answers the question that gets asked during an incident" {
  # "Which version is this?" had no answer from the CLI at all, and inside the image not from the page
  # either: gui/server reads package.json, which the image does not contain, so /api/env said null. The one
  # place the question is asked is a container somebody pulled minutes ago.
  run "$CROWDSIM" --version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^crowdsim\ [0-9]+\.[0-9]+\.[0-9]+ ]]

  # It must be THIS checkout's version, not a string somebody typed twice.
  local pkg
  pkg="$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
  [[ "$output" == *"$pkg"* ]]
}

@test "-V is the same answer, since half the tools in a terminal use it" {
  run "$CROWDSIM" -V
  [ "$status" -eq 0 ]
  [[ "$output" == *"crowdsim "* ]]
}

@test "a packaged build reports the version it was built with, not a file it cannot read" {
  # In the image there is no package.json: the version is baked in at build time instead. Without this the
  # answer would be "unknown" precisely where it matters most.
  run env CROWDSIM_VERSION=9.9.9 "$CROWDSIM" --version
  [ "$status" -eq 0 ]
  [[ "$output" == *"9.9.9"* ]]
}

@test "when nothing knows the version it says so, rather than inventing one" {
  local nowhere="$BATS_TEST_TMPDIR/nowhere"
  mkdir -p "$nowhere"
  run env -u CROWDSIM_VERSION CROWDSIM_ROOT="$nowhere" "$CROWDSIM" --version
  [ "$status" -eq 0 ]
  [[ "$output" == *"unknown"* ]]
  [[ "$output" == *"not packaged"* ]]
}

# ── credentials for the authenticated classes ───────────────────────────────────────────────────────
# The driver's only job here is to hand the PATH to k6. The value is a file name, never a credential:
# whatever is inside it must not reach the command line, the logs or a summary.

@test "CROWDSIM_AUTH_USERS is handed to the generator as an env, not baked into a flag" {
  CROWDSIM_AUTH_USERS=/run/secrets/users.csv \
    run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"-e CROWDSIM_AUTH_USERS=/run/secrets/users.csv"* ]]
}

@test "with no credentials path the generator is not told about one" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" != *"CROWDSIM_AUTH_USERS"* ]]
}

@test "an empty credentials path is the same as none: no empty env for the generator" {
  CROWDSIM_AUTH_USERS= run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" != *"CROWDSIM_AUTH_USERS"* ]]
}

@test "the credentials path is documented in the usage, where people look for env" {
  run "$CROWDSIM" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"CROWDSIM_AUTH_USERS"* ]]
  [[ "$output" == *"username,password"* ]]
}

@test "a generator that produced no summary exits 4: a run that never happened is not a success" {
  # `0` means EXECUTED, and the brake tripping keeps 0 because that is an outcome. A generator that died
  # in its init context — a bad journey file, no accounts in the credentials CSV, an ESM breakage in the
  # image — produced nothing to interpret. Until 1.20.4 this printed a warning and returned 0, so a Nomad
  # batch and a CI job recorded it as a success. A scheduler cannot read a warning.
  cat > "$BATS_TEST_TMPDIR/stub/k6" <<'STUB'
#!/usr/bin/env bash
echo "ERRO[0000] could not initialize: the generator refused this profile"
exit 107
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/k6"
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10
  [ "$status" -eq 4 ]
  case "$output" in
    *"no summary produced"*) ;;
    *) printf 'the refusal does not say the run produced nothing:\n%s\n' "$output" >&2; return 1;;
  esac
  case "$output" in
    *"not a result"*) ;;
    *) printf 'it does not say this is not a result\n' >&2; return 1;;
  esac
}
