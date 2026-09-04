#!/usr/bin/env bats
#
# `weights`: the class mix, counted on the operator's own access log.
#
# The mix is the one input this tool insists must be measured, and the one it used to refuse to help
# measure. What is asserted here is mostly what the command refuses to do: guess a class from the shape of a
# URL, fold what it could not classify into what it could, compute a mix from a log it mostly failed to
# parse, or write anything anywhere — an access log holds URLs, addresses and user agents, and out/ is a
# directory people copy from.
#
# The rules themselves are unit-tested in tests/unit/weights.test.js; this is the driver's side of them.

load helper.bash

setup() {
  crowdsim_setup
  PROFILE="$BATS_TEST_TMPDIR/p.json"
  cat > "$PROFILE" <<'JSON'
{
  "name": "weights-fixture",
  "targets": { "default": "edge", "list": { "edge": { "base_url": "https://www.example.test" } } },
  "classes": [
    { "name": "rsc_page", "weight": 45, "kind": "rsc", "pool": "pages" },
    { "name": "html", "weight": 40, "pool": "pages" },
    { "name": "static", "weight": 15, "pool": "assets", "log_match": ["/_next/static/*"] }
  ],
  "pools": { "pages": ["/", "/news"], "assets": [] },
  "rsc": { "param": "_rsc" },
  "slo": { "max_p95_ms": 5000, "max_failed_rate": 0.05, "guillotine_ms": 7000, "brake_class": "html" },
  "safety": { "allow_hosts": ["www.example.test"], "safe_peak_rps": 150 }
}
JSON

  LOG="$BATS_TEST_TMPDIR/access.log"
  {
    for i in 1 2 3 4; do
      printf '203.0.113.10 - - [01/Sep/2026:12:0%s:00 +0000] "GET /news HTTP/1.1" 200 5120 "-" "UA"\n' "$i"
    done
    for i in 1 2 3 4 5 6; do
      printf '203.0.113.11 - - [01/Sep/2026:12:1%s:00 +0000] "GET /news?_rsc=1dxlt HTTP/1.1" 200 812 "-" "UA"\n' "$i"
    done
    printf '203.0.113.12 - - [01/Sep/2026:12:20:00 +0000] "GET /_next/static/chunks/app.js HTTP/1.1" 200 91200 "-" "UA"\n'
    printf '203.0.113.13 - - [01/Sep/2026:12:21:00 +0000] "GET /favicon.ico HTTP/1.1" 200 512 "-" "UA"\n'
    printf '203.0.113.14 - - [01/Sep/2026:12:22:00 +0000] "POST /api/subscribe HTTP/1.1" 201 12 "-" "UA"\n'
  } > "$LOG"
}

@test "weights counts a combined-format log into a mix, with the weights to paste" {
  run "$CROWDSIM" weights "$LOG" --profile "$PROFILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"12 GET requests counted"* ]]
  # 4 html + 6 rsc + 1 static classified; the POST is excluded, the favicon unclassified
  [[ "$output" == *"html"* ]]
  [[ "$output" == *"rsc_page"* ]]
  [[ "$output" == *'"classes": ['* ]]
  [[ "$output" == *"non-GET excluded"* ]]
}

@test "the same path is two classes with and without the navigation parameter" {
  run "$CROWDSIM" weights "$LOG" --profile "$PROFILE" --json
  [ "$status" -eq 0 ]
  python3 - <<PY
import json
d = json.loads('''$output''')
by = {c['name']: c for c in d['classes']}
assert by['html']['count'] == 4, d['classes']
assert by['rsc_page']['count'] == 6, d['classes']
assert by['static']['count'] == 1, d['classes']
assert d['skipped']['method'] == 1, d['skipped']
PY
}

@test "what it could not classify is a share, not a rounding error" {
  run "$CROWDSIM" weights "$LOG" --profile "$PROFILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"unclassified"* ]]
  [[ "$output" == *"/favicon.ico"* ]]
  [[ "$output" == *"log_match"* ]]
}

@test "nothing is inferred from the shape of a URL: an asset with no rule stays unclassified" {
  # /favicon.ico is obviously an asset. The command still refuses to file it under `static`, because a
  # guessed class is a made-up mix — which is the thing this command exists to replace.
  run "$CROWDSIM" weights "$LOG" --profile "$PROFILE" --json
  [ "$status" -eq 0 ]
  python3 - <<PY
import json
d = json.loads('''$output''')
assert d['unclassified']['count'] == 1, d['unclassified']
assert d['counted'] == 12 and d['classified'] == 11, d
PY
}

@test "it reads stdin, which is how a log that cannot leave its host arrives" {
  run bash -c "cat '$LOG' | '$CROWDSIM' weights - --profile '$PROFILE'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"GET requests counted"* ]]
}

@test "a log it mostly cannot parse is refused, instead of a mix of whatever fitted" {
  printf 'this is not an access log\nnor is this\nnor this one\n' > "$BATS_TEST_TMPDIR/junk.log"
  run "$CROWDSIM" weights "$BATS_TEST_TMPDIR/junk.log" --profile "$PROFILE"
  [ "$status" -eq 2 ]
  [[ "$output" == *"did not parse"* ]]
  [[ "$output" == *"--format"* ]]
}

@test "--format reads the columns it was given" {
  printf '2026-09-01T12:00:00Z GET /news 200\n2026-09-01T12:00:01Z GET /news 200\n' > "$BATS_TEST_TMPDIR/custom.log"
  run "$CROWDSIM" weights "$BATS_TEST_TMPDIR/custom.log" --profile "$PROFILE" --format "time method path status"
  [ "$status" -eq 0 ]
  [[ "$output" == *"2 GET requests counted"* ]]
}

@test "--format with a field this command does not know is a usage error, not a guess" {
  run "$CROWDSIM" weights "$LOG" --profile "$PROFILE" --format "time verb url code"
  [ "$status" -eq 2 ]
  [[ "$output" == *"does not know the field"* ]]
}

@test "a log that parses but matches no class at all exits 4 and names the paths" {
  {
    printf '203.0.113.10 - - [01/Sep/2026:12:00:00 +0000] "GET /shop/cart HTTP/1.1" 200 512 "-" "UA"\n'
    printf '203.0.113.10 - - [01/Sep/2026:12:00:01 +0000] "GET /shop/item/1 HTTP/1.1" 200 512 "-" "UA"\n'
  } > "$BATS_TEST_TMPDIR/other.log"
  run "$CROWDSIM" weights "$BATS_TEST_TMPDIR/other.log" --profile "$PROFILE"
  [ "$status" -eq 4 ]
  [[ "$output" == *"none of them matched a class"* ]]
  [[ "$output" == *"/shop/"* ]]
}

@test "it writes nothing: not the profile, not an artefact in out/" {
  local before after
  before="$(cksum < "$PROFILE")"
  run "$CROWDSIM" weights "$LOG" --profile "$PROFILE"
  [ "$status" -eq 0 ]
  after="$(cksum < "$PROFILE")"
  [ "$before" = "$after" ]
  # out/ is created by the driver itself for every subcommand; what must not appear is anything about
  # this log. Nothing at all is written for a weights run.
  run bash -c "ls -1 '$CROWDSIM_OUT' 2>/dev/null | wc -l"
  [ "$(printf '%s' "$output" | tr -d '[:space:]')" = "0" ]
  [[ "$(cat "$LOG" | head -1)" == *"203.0.113.10"* ]]
}

@test "the output says which window the mix belongs to" {
  run "$CROWDSIM" weights "$LOG" --profile "$PROFILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"2026-09-01T12:01:00"* ]]
  [[ "$output" == *"quiet hour does not reproduce a spike"* ]]
}

@test "no profile is a usage error: there are no class rules without one" {
  run "$CROWDSIM" weights "$LOG"
  [ "$status" -eq 2 ]
  [[ "$output" == *"--profile"* ]]
}

@test "a log file that is not there is a usage error, not an empty mix" {
  run "$CROWDSIM" weights "$BATS_TEST_TMPDIR/nope.log" --profile "$PROFILE"
  [ "$status" -eq 2 ]
  [[ "$output" == *"no such file"* ]]
}

@test "without node it says so, with the exit code the other node subcommands use" {
  run env PATH="$(path_without_node)" "$CROWDSIM" weights "$LOG" --profile "$PROFILE"
  [ "$status" -eq 5 ]
  [[ "$output" == *"needs node"* ]]
  [[ "$output" == *"lib/weights.mjs"* ]]
}

@test "init --access-log measures the mix instead of drafting it as a TODO" {
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
json.dump({'run_id': '20260901T100000Z', 'base_url': 'https://www.example.test', 'bytes': 46231,
           'layers': []}, open(os.path.join(out, 'probe-20260901T100000Z.json'), 'w'))
json.dump({'run_id': '20260901T101000Z', 'base_url': 'https://www.example.test',
           'pool_path': os.path.join(out, 'pool-20260901T101000Z.json'),
           'distinct': 2, 'verified': True, 'kept': 2},
          open(os.path.join(out, 'discover-20260901T101000Z.json'), 'w'))
json.dump(['/', '/news'], open(os.path.join(out, 'pool-20260901T101000Z.json'), 'w'))
PY
  run "$CROWDSIM" init --out "$BATS_TEST_TMPDIR/measured.json" --access-log "$LOG"
  [ "$status" -eq 0 ]
  [[ "$output" == *"mix measured"* ]]
  python3 - "$BATS_TEST_TMPDIR/measured.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
by = {c['name']: c for c in d['classes']}
# 4 documents, 6 navigations, 1 asset: measured, and no longer the drafted 40/45/15
assert by['html']['weight'] == 36.4, by['html']
assert by['rsc_page']['weight'] == 54.5, by['rsc_page']
assert by['static']['weight'] == 9.1, by['static']
assert 'measured' in by['html']['_comment'], by['html']['_comment']
assert 'MEASURED' in d['_classes_comment'], d['_classes_comment']
# the window travels with the number, because a mix from a quiet hour is a mix of a quiet hour
assert '2026-09-01T12:01:00' in d['_classes_comment'], d['_classes_comment']
# the unclassified favicon is not folded into a class, and the gap is stated in the profile itself
assert 'matched no class' in d['_classes_comment'], d['_classes_comment']
PY
}

@test "a class the log never showed keeps its placeholder weight and says so, rather than vanishing" {
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT" <<'PY'
import json, os, sys
json.dump({'run_id': '20260901T100000Z', 'base_url': 'https://www.example.test', 'bytes': 1,
           'layers': []}, open(os.path.join(sys.argv[1], 'probe-20260901T100000Z.json'), 'w'))
PY
  # documents only: no navigation requests, no assets
  {
    printf '203.0.113.10 - - [01/Sep/2026:12:00:00 +0000] "GET /news HTTP/1.1" 200 5120 "-" "UA"\n'
    printf '203.0.113.10 - - [01/Sep/2026:12:00:01 +0000] "GET / HTTP/1.1" 200 5120 "-" "UA"\n'
  } > "$BATS_TEST_TMPDIR/docs-only.log"
  run "$CROWDSIM" init --out "$BATS_TEST_TMPDIR/m4.json" --access-log "$BATS_TEST_TMPDIR/docs-only.log"
  [ "$status" -eq 0 ]
  [[ "$output" == *"not once in this log"* ]]
  python3 - "$BATS_TEST_TMPDIR/m4.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
by = {c['name']: c for c in d['classes']}
assert 'rsc_page' in by and 'static' in by, list(by)
assert 'NOT ONCE' in by['rsc_page']['_comment'], by['rsc_page']['_comment']
assert by['rsc_page']['weight'] == 45, by['rsc_page']
assert by['html']['weight'] == 100.0, by['html']
PY
}

@test "init --access-log still refuses to fill in the two safety fields" {
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
json.dump({'run_id': '20260901T100000Z', 'base_url': 'https://www.example.test', 'bytes': 1,
           'layers': []}, open(os.path.join(out, 'probe-20260901T100000Z.json'), 'w'))
PY
  run "$CROWDSIM" init --out "$BATS_TEST_TMPDIR/m2.json" --access-log "$LOG"
  [ "$status" -eq 0 ]
  python3 - "$BATS_TEST_TMPDIR/m2.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['safety']['allow_hosts'] == [], d['safety']
assert d['safety']['safe_peak_rps'] in (None, 0), d['safety']
PY
  run "$CROWDSIM" validate "$BATS_TEST_TMPDIR/m2.json"
  [ "$status" -ne 0 ]
}

@test "init --access-log with an unreadable log keeps the draft and says the weights are still a guess" {
  mkdir -p "$CROWDSIM_OUT"
  python3 - "$CROWDSIM_OUT" <<'PY'
import json, os, sys
json.dump({'run_id': '20260901T100000Z', 'base_url': 'https://www.example.test', 'bytes': 1,
           'layers': []}, open(os.path.join(sys.argv[1], 'probe-20260901T100000Z.json'), 'w'))
PY
  printf 'not a log at all\nreally not\n' > "$BATS_TEST_TMPDIR/junk.log"
  run "$CROWDSIM" init --out "$BATS_TEST_TMPDIR/m3.json" --access-log "$BATS_TEST_TMPDIR/junk.log"
  [ "$status" -eq 2 ]
  [ -f "$BATS_TEST_TMPDIR/m3.json" ]
  [[ "$output" == *"placeholder weights"* ]]
}

@test "crowdsim --help does not open with the shebang, and names weights" {
  run "$CROWDSIM" --help
  [ "$status" -eq 0 ]
  [[ "$output" != *"/usr/bin/env bash"* ]]
  [[ "$output" == *"weights"* ]]
  # the header is extracted by structure now, so it must not stop at the sixtieth line either
  [[ "$output" == *"Requires: k6, curl, python3"* ]]
}

@test "a class that POSTs is reported as not countable, and never as a weight of zero" {
  # kind login/signup are writes; this command counts GETs. Reporting them as 0 sent people looking for a
  # login in a GET log — and before 1.20.4 a login class declared first even matched every document GET
  # and took them from the class that served them, producing a mix of 100% login.
  cat > "$BATS_TEST_TMPDIR/auth.json" <<'JSON'
{
  "name": "auth-mix",
  "targets": { "default": "edge", "list": { "edge": { "base_url": "https://www.example.test" } } },
  "classes": [
    { "name": "login", "kind": "login", "weight": 5, "pool": "pages" },
    { "name": "html", "kind": "plain", "weight": 95, "pool": "pages" }
  ],
  "pools": { "pages": ["/", "/news"] },
  "rsc": { "param": "_rsc" },
  "auth": { "token_url": "https://www.example.test/token", "mode": "form" },
  "slo": { "max_p95_ms": 2500, "max_failed_rate": 0.05, "guillotine_ms": 7000, "brake_class": "html" },
  "safety": { "allow_hosts": ["www.example.test"], "safe_peak_rps": 100 }
}
JSON
  run "$CROWDSIM" weights "$LOG" --profile "$BATS_TEST_TMPDIR/auth.json" --json
  [ "$status" -eq 0 ]
  python3 - <<PY
import json
d = json.loads('''$output''')
by = {c['name']: c for c in d['classes']}
assert by['login']['countable'] is False, by['login']
assert by['html']['countable'] is True, by['html']
assert d['uncountable'] == ['login'], d['uncountable']
# the document GETs belong to html, all of them
assert by['html']['count'] == 4, by['html']
assert by['login']['count'] == 0, by['login']
assert by['html']['weight'] == 100.0, by['html']
PY
}

@test "the human output says which classes it cannot count, and what to use instead" {
  cp "$BATS_TEST_TMPDIR/auth.json" "$BATS_TEST_TMPDIR/a2.json" 2>/dev/null || cat > "$BATS_TEST_TMPDIR/a2.json" <<'JSON'
{
  "name": "auth-mix",
  "targets": { "default": "edge", "list": { "edge": { "base_url": "https://www.example.test" } } },
  "classes": [
    { "name": "login", "kind": "login", "weight": 5, "pool": "pages" },
    { "name": "html", "kind": "plain", "weight": 95, "pool": "pages" }
  ],
  "pools": { "pages": ["/", "/news"] },
  "rsc": { "param": "_rsc" },
  "auth": { "token_url": "https://www.example.test/token", "mode": "form" },
  "slo": { "max_p95_ms": 2500, "max_failed_rate": 0.05, "guillotine_ms": 7000, "brake_class": "html" },
  "safety": { "allow_hosts": ["www.example.test"], "safe_peak_rps": 100 }
}
JSON
  run "$CROWDSIM" weights "$LOG" --profile "$BATS_TEST_TMPDIR/a2.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"not countable"* ]]
  [[ "$output" == *"Not countable from an access log: login"* ]]
  [[ "$output" == *"rate you measured yourself"* ]]
  [[ "$output" == *"<your measured login rate>"* ]]
}

# ── the accounts a signup run leaves behind (#65) ───────────────────────────────────────────────────

@test "a run with no signup class writes no manifest at all, not an empty one" {
  # An empty manifest would be a file somebody finds and reads as "nothing was created", which is a
  # different claim from "this run does not create accounts".
  run "$CROWDSIM" load --profile "$PROFILE" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  run bash -c "ls -1 '$CROWDSIM_OUT'/signups-*.json 2>/dev/null | wc -l"
  [ "$(printf '%s' "$output" | tr -d '[:space:]')" = "0" ]
}
