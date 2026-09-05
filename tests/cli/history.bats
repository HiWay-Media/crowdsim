#!/usr/bin/env bats
#
# `history` used to print all fourteen columns of every run ever recorded and accept no arguments at all:
# `--last 5` was `unknown option`. It is the one subcommand whose entire job is to let somebody see
# whether the knee moves over time, and after a few dozen runs it was a wall that wraps.
#
# Two of these tests are not about formatting:
#   · a filtered or truncated view must SAY so, with the total. A subset of runs that looks like all of
#     them is the same class of mistake as a p95 quoted for a rate that never happened.
#   · a run with generator_ok: false must be visible without knowing which column to read.

load helper

setup() {
  crowdsim_setup
  mkdir -p "$CROWDSIM_OUT"
  H="$CROWDSIM_OUT/history.tsv"
  {
    printf 'run_id\tprofile\tbase_url\tshape\tpeak\taborted\treqs\trps\tfailed\tp95\te504\tgen_ok\tknee_clean\tknee_crossed\n'
    printf '20260901T101500Z\tsite-a\thttps://a.test\tmix\t40\tFalse\t1000\t39.8\t0.001\t210\t0\tTrue\t30\t40\n'
    printf '20260901T111500Z\tsite-b\thttps://b.test\tmix\t60\tTrue\t900\t55.1\t0.06\t5100\t12\tTrue\t40\t50\n'
    printf '20260901T121500Z\tsite-a\thttps://a.test\tmix\t80\tFalse\t400\t20.0\t0.002\t300\t0\tFalse\t\t\n'
  } > "$H"
}

@test "the default view is newest first, and does not print all fourteen columns" {
  run "$CROWDSIM" history
  [ "$status" -eq 0 ]
  [[ "${lines[1]}" == *"20260901T121500Z"* ]]
  # the columns that must never be dropped
  [[ "$output" == *"run_id"* ]]
  [[ "$output" == *"knee_clean"* ]]
  # and one that the default view leaves out
  [[ "$output" != *"base_url"* ]]
}

@test "a discard is marked in the margin, not hidden in a column somebody has to know to read" {
  run "$CROWDSIM" history
  [[ "$output" == *"⛔ 20260901T121500Z"* ]]
  [[ "$output" == *"the generator did not hold the requested rate"* ]]
  [[ "$output" == *"Not comparable, not quotable."* ]]
}

@test "--last truncates and says so, with the total" {
  run "$CROWDSIM" history --last 2
  [ "$status" -eq 0 ]
  [[ "$output" == *"20260901T121500Z"* ]]
  [[ "$output" != *"20260901T101500Z"* ]]
  [[ "$output" == *"showing 2 of 3 runs"* ]]
}

@test "--last that is not a number is a usage error, not an empty table" {
  run "$CROWDSIM" history --last banana
  [ "$status" -eq 2 ]
  run "$CROWDSIM" history --last 0
  [ "$status" -eq 2 ]
}

@test "--profile and --target filter, and both say what they filtered by" {
  run "$CROWDSIM" history --profile site-a
  [ "$status" -eq 0 ]
  [[ "$output" != *"20260901T111500Z"* ]]
  [[ "$output" == *"showing 2 of 3 runs"* ]]
  [[ "$output" == *"profile site-a"* ]]

  run "$CROWDSIM" history --target b.test
  [ "$status" -eq 0 ]
  [[ "$output" == *"20260901T111500Z"* ]]
  [[ "$output" != *"20260901T101500Z"* ]]
  [[ "$output" == *"target ~ b.test"* ]]
}

@test "a filter that matches nothing says how many runs there were" {
  run "$CROWDSIM" history --profile nope
  [ "$status" -eq 0 ]
  [[ "$output" == *"no runs match"* ]]
  [[ "$output" == *"of 3"* ]]
}

@test "--cols picks columns, and never drops the run id" {
  run "$CROWDSIM" history --cols peak,p95
  [ "$status" -eq 0 ]
  [[ "$output" == *"run_id"* ]]
  [[ "$output" == *"peak"* ]]
  [[ "$output" != *"shape"* ]]
}

@test "--cols with a column that does not exist is a usage error that lists the real ones" {
  run "$CROWDSIM" history --cols nope
  [ "$status" -eq 2 ]
  [[ "$output" == *"no such column"* ]]
  [[ "$output" == *"knee_crossed"* ]]
}

@test "a row written before a column existed still prints, with an empty cell and not a zero" {
  # A knee of 0 req/s is a claim. "This run predates the knee" is not the same statement.
  printf '20260801T101500Z\told\thttps://a.test\tmix\t20\tFalse\t100\t19\t0\t150\t0\tTrue\n' >> "$H"
  run "$CROWDSIM" history
  [ "$status" -eq 0 ]
  [[ "$output" == *"20260801T101500Z"* ]]
  run "$CROWDSIM" history --json
  [[ "$output" == *'"knee_clean": null'* ]]
}

@test "--json carries the same record shape the GUI's history endpoint returns" {
  run "$CROWDSIM" history --json --last 1
  [ "$status" -eq 0 ]
  for key in run_id profile base_url shape peak aborted requests rps failed p95 e504 generator_ok knee_clean knee_crossed; do
    [[ "$output" == *"\"$key\""* ]] || { echo "missing key $key"; return 1; }
  done
  # types, not just names: the page reads these as numbers and booleans
  [[ "$output" == *'"generator_ok": false'* ]]
  [[ "$output" == *'"peak": 80'* ]]
}

@test "no history file at all is not an error" {
  rm -f "$H"
  run "$CROWDSIM" history
  [ "$status" -eq 0 ]
  [[ "$output" == *"no runs yet"* ]]
}
