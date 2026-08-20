#!/usr/bin/env bats
#
# `init`: the first profile, assembled from what the tool already measured.
#
# Writing the first profile is the highest step in this tool, and most of it has already been measured by
# the time somebody asks: probe knows the page weight and which cache layers answered, discover --verify has
# a pool of URLs that render, record has a real fan-out. Those artefacts sit in out/ and nothing assembled
# them.
#
# What is asserted here is mostly what init REFUSES to do: invent an allowlist, invent a ceiling, invent a
# traffic mix, or overwrite somebody's file.

load helper.bash

setup() {
  crowdsim_setup
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
json.dump({'run_id': '20260805T120000Z', 'base_url': 'https://www.example.test', 'path': '/',
           'status': 200, 'ttfb_s': 0.18, 'bytes': 46231,
           'headers': {'x-proxy-cache': 'HIT'},
           'layers': [{'label': 'proxy', 'header': 'X-Proxy-Cache', 'hit_pattern': 'HIT',
                       'value': 'HIT', 'hit': True},
                      {'label': 'cdn', 'header': 'X-Cache', 'hit_pattern': 'Hit',
                       'value': None, 'hit': None}]},
          open(os.path.join(out, 'probe-20260805T120000Z.json'), 'w'))
json.dump({'run_id': '20260805T121000Z', 'base_url': 'https://www.example.test',
           'sitemap': 'https://www.example.test/sitemap.xml',
           'pool_path': os.path.join(out, 'pool-20260805T121000Z.json'),
           'limit': 400, 'loc_entries': 512, 'distinct': 400, 'verified': True, 'kept': 383,
           'dropped': [{'path': '/gone', 'reason': 'status', 'status': 404}]},
          open(os.path.join(out, 'discover-20260805T121000Z.json'), 'w'))
json.dump(['/', '/news'], open(os.path.join(out, 'pool-20260805T121000Z.json'), 'w'))
PY
  OUTFILE="$BATS_TEST_TMPDIR/first.json"
}

@test "init assembles a profile from the artefacts, and says where each part came from" {
  run "$CROWDSIM" init --out "$OUTFILE"
  [ "$status" -eq 0 ]
  [ -f "$OUTFILE" ]
  python3 - "$OUTFILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
# the target and the page weight came from the probe; the pool from discover
assert d['targets']['list']['edge']['base_url'] == 'https://www.example.test', d['targets']
assert d['pools']['pages'].startswith('@pool-'), d['pools']
# provenance: a profile whose parts came from nowhere is a profile nobody can defend
blob = json.dumps(d)
assert '20260805T120000Z' in blob, 'the probe run is not named anywhere'
assert '20260805T121000Z' in blob, 'the discover run is not named anywhere'
# the layer that never answered is offered as a declared header, since that is what a profile declares
labels = [l['label'] for l in d['cache_headers']]
assert 'proxy' in labels and 'cdn' in labels, labels
PY
}

@test "the two safety fields are left empty, and validate refuses the file until they are filled in" {
  # A generated allowlist would be the tool authorising a host on your behalf, which is the one thing it
  # never does; a generated ceiling would be it deciding how much of somebody's production may be bent.
  run "$CROWDSIM" init --out "$OUTFILE"
  [ "$status" -eq 0 ]
  python3 - "$OUTFILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['safety']['allow_hosts'] == [], d['safety']
assert d['safety']['safe_peak_rps'] in (None, 0), d['safety']
PY
  run "$CROWDSIM" validate "$OUTFILE"
  [ "$status" -eq 2 ]
  [[ "$output" == *"allow_hosts"* ]]

  # And the generated file says why it is like that, in the file itself.
  grep -q "TODO" "$OUTFILE"
  grep -qi "allowlist" "$OUTFILE"
}

@test "the class weights are presented as a starting point, not as a measurement" {
  # The tool does not read edge logs — a decision, not an omission — so a mix nobody measured is a guess
  # wearing a number.
  run "$CROWDSIM" init --out "$OUTFILE"
  grep -qi "edge log" "$OUTFILE"
  grep -qi "TODO" "$OUTFILE"
}

@test "init never overwrites a profile somebody has already written" {
  echo '{"name":"mine"}' > "$OUTFILE"
  run "$CROWDSIM" init --out "$OUTFILE"
  [ "$status" -eq 2 ]
  [[ "$output" == *"already exists"* ]]
  grep -q '"mine"' "$OUTFILE"
}

@test "init refuses to write into the profile directory unless told to" {
  # A profile is a map of somebody's infrastructure, and the profile directory is the one that gets
  # committed. Same rule as `record`.
  run env CROWDSIM_PROFILES="$BATS_TEST_TMPDIR/profiles" \
    "$CROWDSIM" init --out "$BATS_TEST_TMPDIR/profiles/first.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"profile directory"* ]]
}

@test "with no artefacts at all it says what to run first, instead of writing a hollow profile" {
  rm -f "$CROWDSIM_OUT"/probe-*.json "$CROWDSIM_OUT"/discover-*.json
  run "$CROWDSIM" init --out "$OUTFILE"
  [ "$status" -eq 4 ]
  [[ "$output" == *"crowdsim probe"* ]]
  [ ! -f "$OUTFILE" ]
}

@test "an unverified pool is carried across with the warning attached" {
  python3 - "$CROWDSIM_OUT/discover-20260805T121000Z.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d['verified'] = False; d['kept'] = None
json.dump(d, open(sys.argv[1], 'w'))
PY
  run "$CROWDSIM" init --out "$OUTFILE"
  [ "$status" -eq 0 ]
  grep -qi "not verified" "$OUTFILE"
}
