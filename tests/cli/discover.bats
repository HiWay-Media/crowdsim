#!/usr/bin/env bats
#
# `discover`: turning a sitemap into a pool.
#
# The sitemap is read through a file:// URL, so these tests parse a real document without sending a single
# request — which is what makes them part of `make test`. Verifying that the discovered URLs actually render
# is inherently traffic, so it lives in the e2e suite instead.
#
# There is a specific reason this file exists. `discover` wrote an EMPTY pool from 1.0.0 until 1.6.0:
# `python3 - args <<'PY'` takes the program from stdin, so the curl output piped into it was discarded and
# `sys.stdin.read()` returned "". Nothing failed, and no test ever called the command.

load helper.bash

setup() {
  crowdsim_setup
  PROFILE="$BATS_TEST_TMPDIR/discover.json"
  python3 - "$FIXTURES/minimal.json" "$FIXTURES/sitemap.xml" "$PROFILE" <<'PY'
import json, os, sys
d = json.load(open(sys.argv[1]))
d['discover'] = {'sitemap': 'file://' + os.path.abspath(sys.argv[2])}
json.dump(d, open(sys.argv[3], 'w'))
PY
}

pool() { cat "$CROWDSIM_OUT"/pool-*.json; }

@test "a sitemap becomes a pool of distinct paths" {
  run "$CROWDSIM" discover --profile "$PROFILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"6 <loc> entries → 5 distinct paths"* ]]
  [[ "$(pool)" == *'"/news"'* ]]
  # the duplicate is gone, and the host is stripped: pools are paths, not URLs
  [ "$(pool | grep -c '"/news"')" -eq 1 ]
  [[ "$(pool)" != *"www.example.test"* ]]
}

@test "the pool is not empty — the failure this command shipped with for six releases" {
  run "$CROWDSIM" discover --profile "$PROFILE"
  [ "$status" -eq 0 ]
  [ "$(pool | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" -eq 5 ]
}

@test "strip_prefix_regex removes the locale prefixes the site would redirect" {
  # Testing a 307 measures the redirect, not the render.
  python3 - "$PROFILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['discover']['strip_prefix_regex'] = '^/(en|es)(?=/)'
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" discover --profile "$PROFILE"
  [ "$status" -eq 0 ]
  [[ "$(pool)" == *'"/teams"'* ]]
  [[ "$(pool)" != *'"/en/teams"'* ]]
  # /en/teams and /es/teams collapse onto one path
  [[ "$output" == *"→ 4 distinct paths"* ]]
}

@test "--limit truncates the pool" {
  run "$CROWDSIM" discover --profile "$PROFILE" --limit 2
  [ "$status" -eq 0 ]
  [ "$(pool | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" -eq 2 ]
}

@test "a document with no <loc> entries fails loudly instead of writing an empty pool" {
  # An empty pool surfaces much later as "every class was dropped for want of a non-empty pool", which
  # sends you looking in entirely the wrong place.
  python3 - "$PROFILE" "$FIXTURES/not-a-sitemap.xml" <<'PY'
import json, os, sys
d = json.load(open(sys.argv[1]))
d['discover']['sitemap'] = 'file://' + os.path.abspath(sys.argv[2])
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" discover --profile "$PROFILE"
  [ "$status" -ne 0 ]
  [[ "$output" == *"no <loc> entries"* ]]
  [[ "$output" == *"really a sitemap"* ]]
}

@test "a sitemap that does not answer exits 4" {
  python3 - "$PROFILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['discover']['sitemap'] = 'file:///nonexistent/sitemap.xml'
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" discover --profile "$PROFILE"
  [ "$status" -eq 4 ]
  [[ "$output" == *"sitemap did not answer"* ]]
}

@test "discover still passes the allowlist gate first" {
  run "$CROWDSIM" discover --profile "$FIXTURES/no-allowlist.json"
  [ "$status" -eq 3 ]
}

@test "--verify is a known flag" {
  # What it does needs traffic, so the behaviour is asserted in tests/e2e. Here: it parses.
  run "$CROWDSIM" discover --profile "$FIXTURES/no-allowlist.json" --verify
  [ "$status" -eq 3 ]
  [[ "$output" != *"unknown option"* ]]
}

@test "the result is written as data as well as prose, and the run id is announced so it can be found" {
  # The GUI (and anything else reading afterwards) needs both: the run id in the output, and a report it can
  # parse. Without the run id, discover-<run>.json exists and nothing knows its name — which is exactly the
  # state this command was in until the GUI tried to read it.
  run "$CROWDSIM" discover --profile "$PROFILE"
  [ "$status" -eq 0 ]
  [[ "$output" =~ run:\ [0-9]{8}T[0-9]{6}Z ]]

  local report
  report="$(echo "$CROWDSIM_OUT"/discover-*.json)"
  [ -f "$report" ]
  python3 - "$report" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['loc_entries'] == 6, d
assert d['distinct'] == 5, d
# Unverified must say so: nobody has asked these paths whether they render, and a pool of 404s measures
# the app tier's error page at full speed.
assert d['verified'] is False, d
assert d['kept'] is None, d
assert d['dropped'] == [], d
assert d['pool_path'].endswith('.json'), d
PY
}

@test "--limit is recorded in the report, so a truncated pool cannot look complete" {
  run "$CROWDSIM" discover --profile "$PROFILE" --limit 2
  [ "$status" -eq 0 ]
  python3 - "$(echo "$CROWDSIM_OUT"/discover-*.json)" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['limit'] == 2, d
assert d['distinct'] == 2, d
assert d['loc_entries'] == 6, d   # what the sitemap offered is kept: 2 of 6 is the honest reading
PY
}
