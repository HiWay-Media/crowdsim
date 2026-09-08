#!/usr/bin/env bats
#
# `--server-metrics`: a series handed to a run, read against the run's own steps.
#
# crowdsim measures from outside, which is the right place to measure what users experience and the wrong
# place to answer why. The scope decision is in INTENT.md and is the same one as the access log: a series
# is HANDED to a run. What is asserted here is that it never fetches, never fails a completed run, and
# never turns a correlation into a cause.

load helper

setup() {
  crowdsim_setup
  P="$FIXTURES/minimal.json"
  export CROWDSIM_ALLOW_TARGETS='127.0.0.1'
  SERIES="$BATS_TEST_TMPDIR/series.csv"
  # summary-good.json's run_id anchors the window; its per_step rows carry the offsets.
  RUN_ID="$(python3 -c "import json;print(json.load(open('$FIXTURES/summary-good.json'))['run_id'])")"
  T0="$(python3 -c "
import calendar, time
r = '$RUN_ID'
print(calendar.timegm(time.strptime(r, '%Y%m%dT%H%M%SZ')))")"
  cat > "$BATS_TEST_TMPDIR/stub/k6" <<'STUB'
#!/usr/bin/env bash
printf 'STUB-K6 %s\n' "$*"
for a in "$@"; do case "$a" in SUMMARY_OUT=*) out="${a#SUMMARY_OUT=}";; esac; done
[ -n "${out:-}" ] && cp "$STUB_SUMMARY" "$out"
exit 0
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/k6"
  export STUB_SUMMARY="$FIXTURES/summary-good.json"
}

series_over_the_run() {
  : > "$SERIES"
  local i
  for i in 0 20 40 60 80 100 120 140 160; do
    printf '%s,%s\n' "$((T0 + i))" "$((i))" >> "$SERIES"
  done
}

load_with() {
  run "$CROWDSIM" load --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s "$@"
}

@test "a series that overlaps the run is aligned per step, and writes one artefact" {
  series_over_the_run
  load_with --server-metrics "$SERIES" --server-metrics-label cpu_throttled_periods
  [ "$status" -eq 0 ]
  [[ "$output" == *"cpu_throttled_periods, per step"* ]]
  [[ "$output" == *"handed to this run, not collected"* ]]
  [ -f "$CROWDSIM_OUT/server-side-$RUN_ID.json" ]
}

@test "what it produces is a correlation, and says so in those words" {
  series_over_the_run
  load_with --server-metrics "$SERIES" --server-metrics-label cpu_throttled_periods
  [[ "$output" == *"correlation and not a cause"* ]]
  # and never the words that would make it a claim
  [[ "$output" != *"caused by"* ]]
  [[ "$output" != *"explains"* ]]
}

@test "a series with no label is refused, and the run is still complete" {
  series_over_the_run
  load_with --server-metrics "$SERIES"
  [ "$status" -eq 0 ]
  [[ "$output" == *"needs --server-metrics-label"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
  [ ! -f "$CROWDSIM_OUT/server-side-$RUN_ID.json" ]
}

@test "a series from another time is refused rather than reported as flat" {
  # Aligning to the wrong window would produce a table of zeroes that reads as "the server was idle".
  printf '%s,5\n%s,7\n' "$((T0 - 86400))" "$((T0 + 86400))" > "$SERIES"
  load_with --server-metrics "$SERIES" --server-metrics-label x
  [ "$status" -eq 0 ]
  [[ "$output" == *"outside this run"* ]]
  [ ! -f "$CROWDSIM_OUT/server-side-$RUN_ID.json" ]
}

@test "a missing series file never fails a run that already happened" {
  load_with --server-metrics "$BATS_TEST_TMPDIR/nope.csv" --server-metrics-label x
  [ "$status" -eq 0 ]
  [[ "$output" == *"not found"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
}

@test "timestamps in seconds and in milliseconds both work, and are not guessed between" {
  series_over_the_run
  load_with --server-metrics "$SERIES" --server-metrics-label secs
  [[ "$output" == *"secs, per step"* ]]

  : > "$SERIES"
  for i in 0 20000 40000 60000 80000; do
    printf '%s,%s\n' "$(( (T0 * 1000) + i ))" "$i" >> "$SERIES"
  done
  rm -f "$CROWDSIM_OUT/server-side-$RUN_ID.json"
  load_with --server-metrics "$SERIES" --server-metrics-label millis
  [[ "$output" == *"millis, per step"* ]]
}

@test "a JSON array is accepted as well as two columns" {
  python3 -c "
import json
t = $T0 * 1000
json.dump([{'t': t + i * 1000, 'v': i} for i in range(0, 160, 20)], open('$SERIES.json', 'w'))"
  load_with --server-metrics "$SERIES.json" --server-metrics-label from_json
  [[ "$output" == *"from_json, per step"* ]]
}

@test "a header row is skipped rather than parsed as a sample" {
  { printf 'timestamp,value\n'; cat /dev/null; } > "$SERIES"
  local i
  for i in 0 20 40 60 80; do printf '%s,%s\n' "$((T0 + i))" "$i" >> "$SERIES"; done
  load_with --server-metrics "$SERIES" --server-metrics-label with_header
  [ "$status" -eq 0 ]
  [[ "$output" == *"with_header, per step"* ]]
}

@test "without node the run is archived and the series is simply not read" {
  series_over_the_run
  run env PATH="$(path_without_node)" CROWDSIM_ALLOW_TARGETS='127.0.0.1' "$CROWDSIM" load \
    --profile "$P" --peak 8 --start 4 --steps 2 --step-dur 5s --hold 0s \
    --server-metrics "$SERIES" --server-metrics-label x
  [ "$status" -eq 0 ]
  [[ "$output" == *"needs node"* ]]
  [ "$(ls "$CROWDSIM_OUT" | grep -c '^summary-')" -eq 1 ]
}

@test "nothing is fetched: the flag takes a path, and no network name" {
  # The scope decision, asserted against the source rather than trusted: no URL scheme reaches the
  # series reader, and the driver's own help says so.
  run grep -c 'http' "$CROWDSIM_ROOT/lib/server-metrics-cli.mjs"
  [ "$output" -eq 0 ]
  run "$CROWDSIM" load --help
  [[ "$output" == *"never fetches one"* ]]
}
