#!/usr/bin/env bats
#
# `record`: a HAR export becomes a journey file.
#
# The rules themselves (what counts as a page, what is third-party, which query parameters are per-request
# noise) live in lib/har.mjs and are unit-tested in tests/unit/har.test.js. What is tested here is the wiring
# and the two refusals that protect a repository rather than a measurement: a journey names real routes on a
# real site, so it must not land in profiles/, and it must not silently replace a recording that cost somebody
# a browser session.
#
# No traffic: the input is a file.

load helper.bash

setup() {
  crowdsim_setup
  HAR="$FIXTURES/session.har"
  mkdir -p "$CROWDSIM_OUT"
}

journey() { cat "$CROWDSIM_OUT"/journey-*.json; }

@test "record needs a HAR file, and says which one is missing" {
  run "$CROWDSIM" record
  [ "$status" -eq 2 ]
  [[ "$output" == *"needs a HAR file"* ]]

  run "$CROWDSIM" record /nope/session.har
  [ "$status" -eq 2 ]
  [[ "$output" == *"no such file"* ]]
}

@test "a browser recording becomes a journey next to the run output" {
  run "$CROWDSIM" record "$HAR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"2 pages"* ]]
  [[ "$output" == *"origin https://www.example.test"* ]]

  # The pages carry the fan-out, and the origin travels with the file.
  python3 - <<'PY' "$(echo "$CROWDSIM_OUT"/journey-*.json)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d['origin'] == 'https://www.example.test', d
paths = [p['path'] for p in d['pages']]
assert paths == ['/', '/news'], paths
home = d['pages'][0]
assert home['rsc'] == ['/news'], home
# the build hash is part of the URL a cache sees; the per-request buster is not
assert '/assets/app.css?build=9f2c1' in home['static'], home['static']
assert '/assets/poll.js' in home['static'], home['static']
assert not any('_=' in s for s in home['static']), home['static']
PY
}

@test "third-party hosts are dropped, and the output says whose they were" {
  # Generating that traffic would point load at somebody else's infrastructure, from a tool that refuses to
  # hit any host nobody allowlisted.
  run "$CROWDSIM" record "$HAR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"dropped 2 third-party"* ]]
  [[ "$output" == *"fonts.gstatic.com"* ]]
  [[ "$(journey)" != *"gstatic"* ]]
  [[ "$(journey)" != *"google-analytics"* ]]
}

@test "failures and writes are not recorded, and it says so" {
  run "$CROWDSIM" record "$HAR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"did not answer 2xx/3xx"* ]]
  [[ "$output" == *"non-GET"* ]]
  [[ "$(journey)" != *"missing.css"* ]]
  [[ "$(journey)" != *"subscribe"* ]]
}

@test "the output names the stripped parameters, so the normalisation is not invisible" {
  run "$CROWDSIM" record "$HAR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"stripped per-request query params"* ]]
  [[ "$output" == *"pool of unique cold URLs"* ]]
}

@test "it refuses to write a journey into the profile directory" {
  # A journey is data ABOUT a site, in the same category as a URL pool: real routes, on a real host. The
  # profile directory is the one that gets committed.
  run env CROWDSIM_PROFILES="$BATS_TEST_TMPDIR/profiles" \
    "$CROWDSIM" record "$HAR" --out "$BATS_TEST_TMPDIR/profiles/journey.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"refusing to write a journey into the profile directory"* ]]
  [ ! -f "$BATS_TEST_TMPDIR/profiles/journey.json" ]
}

@test "an existing journey is not silently replaced" {
  run "$CROWDSIM" record "$HAR" --out "$BATS_TEST_TMPDIR/j.json"
  [ "$status" -eq 0 ]
  run "$CROWDSIM" record "$HAR" --out "$BATS_TEST_TMPDIR/j.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"already exists"* ]]
  run "$CROWDSIM" record "$HAR" --out "$BATS_TEST_TMPDIR/j.json" --force
  [ "$status" -eq 0 ]
}

@test "a recording with nothing usable exits 4 and says what to record instead" {
  python3 - "$BATS_TEST_TMPDIR/api-only.har" <<'PY'
import json, sys
json.dump({'log': {'entries': [{
    'request': {'method': 'GET', 'url': 'https://api.example.test/v1/things'},
    'response': {'status': 200, 'content': {'mimeType': 'application/json'}}}]}},
    open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" record "$BATS_TEST_TMPDIR/api-only.har"
  [ "$status" -eq 4 ]
  [[ "$output" == *"No HTML document was recorded"* ]]
  [[ "$output" == *"Preserve log"* ]]
}

@test "a file that is not a HAR is a usage error that says where to get one" {
  echo 'not json' > "$BATS_TEST_TMPDIR/bad.har"
  run "$CROWDSIM" record "$BATS_TEST_TMPDIR/bad.har"
  [ "$status" -eq 2 ]
  [[ "$output" == *"cannot read"* ]]
  [[ "$output" == *"Export HAR"* ]]
}

@test "--origin picks the site under test when the recording spans several" {
  run "$CROWDSIM" record "$HAR" --origin https://fonts.gstatic.com --out "$BATS_TEST_TMPDIR/other.json"
  [ "$status" -eq 4 ]
  [[ "$output" == *"every request was dropped"* ]]
}

@test "without node it exits 5 and says why, instead of failing obscurely" {
  PATH="$(path_without_node)" run "$CROWDSIM" record "$HAR"
  [ "$status" -eq 5 ]
  [[ "$output" == *"needs node"* ]]
  [[ "$output" == *"lib/har.mjs"* ]]
}
