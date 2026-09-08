#!/usr/bin/env bats
#
# The two drawn pages that read the archive rather than one run: `history --html` (#87) and
# `compare --html` (#88).
#
# What is asserted here is mostly the refusals, because that is the whole reason these pages are allowed
# to exist. `report --html` declines to draw two runs on one pair of axes, and it is right for the reason
# it gives — without compare's refusals it is a picture of two different experiments.

load helper

setup() {
  crowdsim_setup
  mkdir -p "$CROWDSIM_OUT"
  H="$CROWDSIM_OUT/history.tsv"
  {
    printf 'run_id\tprofile\tbase_url\tshape\tpeak\taborted\treqs\trps\tfailed\tp95\te504\tgen_ok\tknee_clean\tknee_crossed\tknee_clean_del\tknee_crossed_del\tfan_out\n'
    printf '20260901T100000Z\tsite\thttps://a.test\tmix\t60\tTrue\t9000\t58\t0.01\t400\t0\tTrue\t40\t60\t50\t75\t1.25\n'
    printf '20260902T100000Z\tsite\thttps://a.test\tmix\t80\tTrue\t9000\t78\t0.01\t420\t0\tTrue\t60\t80\t75\t99\t1.25\n'
    printf '20260903T100000Z\tsite\thttps://a.test\tmix\t80\tFalse\t900\t20\t0.01\t420\t0\tFalse\t\t\t\t\t\n'
    printf '20260904T100000Z\tother\thttps://b.test\tmix\t40\tTrue\t9000\t39\t0.01\t300\t0\tTrue\t20\t40\t25\t50\t1.25\n'
  } > "$H"
}

# ── history --html ───────────────────────────────────────────────────────────────────────────────────

@test "history --html writes a self-contained page and says where" {
  run "$CROWDSIM" history --html
  [ "$status" -eq 0 ]
  [[ "$output" == *"wrote"* ]]
  local page; page="$(ls "$CROWDSIM_OUT"/trend-*.html | head -1)"
  [ -f "$page" ]
  run grep -c '<script' "$page"
  [ "$output" -eq 0 ]
}

@test "runs at a different profile or target are separated, not averaged onto one line" {
  run "$CROWDSIM" history --html
  local page; page="$(ls "$CROWDSIM_OUT"/trend-*.html | head -1)"
  run grep -c 'https://a.test' "$page"
  [ "$output" -ge 1 ]
  run grep -c 'https://b.test' "$page"
  [ "$output" -ge 1 ]
  # the single-run experiment refuses to become a line
  run grep -c 'One run is not a trend' "$page"
  [ "$output" -ge 1 ]
}

@test "a discard is left out, and the page says which run and why" {
  run "$CROWDSIM" history --html
  local page; page="$(ls "$CROWDSIM_OUT"/trend-*.html | head -1)"
  run grep -c '20260903T100000Z' "$page"
  [ "$output" -ge 1 ]
  run grep -ci 'generator did not hold' "$page"
  [ "$output" -ge 1 ]
}

@test "--out puts the page where it is asked to" {
  run "$CROWDSIM" history --html --out "$BATS_TEST_TMPDIR/trend.html"
  [ "$status" -eq 0 ]
  [ -f "$BATS_TEST_TMPDIR/trend.html" ]
}

@test "history --html without node exits 5 and says the table still works" {
  run env PATH="$(path_without_node)" "$CROWDSIM" history --html
  [ "$status" -eq 5 ]
  [[ "$output" == *"needs node"* ]]
  [[ "$output" == *"still prints the table"* ]]
}

@test "an empty archive draws no chart and says so" {
  printf 'run_id\tprofile\n' > "$H"
  run "$CROWDSIM" history --html
  [ "$status" -eq 0 ]
  local page; page="$(ls "$CROWDSIM_OUT"/trend-*.html | head -1)"
  run grep -ci 'no runs' "$page"
  [ "$output" -ge 1 ]
}

# ── compare --html ───────────────────────────────────────────────────────────────────────────────────

two_summaries() {
  python3 - "$CROWDSIM_OUT" "$FIXTURES/summary-good.json" <<'PY'
import copy, json, sys
base = json.load(open(sys.argv[2]))
for rid, p95 in (('20260901T100000Z', 200), ('20260902T100000Z', 320)):
    d = copy.deepcopy(base)
    d['run_id'] = rid
    d['dur']['p95'] = p95
    json.dump(d, open('%s/summary-%s.json' % (sys.argv[1], rid), 'w'), indent=1)
PY
}

@test "compare --html draws the delta, and names the baseline" {
  two_summaries
  run "$CROWDSIM" compare 20260901T100000Z 20260902T100000Z --html
  [ "$status" -eq 0 ]
  local page; page="$(ls "$CROWDSIM_OUT"/compare-*.html | head -1)"
  run grep -ci 'baseline' "$page"
  [ "$output" -ge 1 ]
  run grep -c '<svg' "$page"
  [ "$output" -ge 1 ]
  run grep -c '<script' "$page"
  [ "$output" -eq 0 ]
}

@test "a refusal from compare stops the drawing: the picture has no second opinion" {
  # The point of drawing this at all. compare refuses a generator-bound run; the page must not draw one.
  two_summaries
  cp "$FIXTURES/summary-invalid.json" "$CROWDSIM_OUT/summary-20260905T100000Z.json"
  python3 -c "
import json,sys
p='$CROWDSIM_OUT/summary-20260905T100000Z.json'
d=json.load(open(p)); d['run_id']='20260905T100000Z'; json.dump(d, open(p,'w'))"
  run "$CROWDSIM" compare 20260901T100000Z 20260905T100000Z --html
  local page; page="$(ls -t "$CROWDSIM_OUT"/compare-*.html | head -1)"
  run grep -ci 'not comparable' "$page"
  [ "$output" -ge 1 ]
  run grep -c '<svg' "$page"
  [ "$output" -eq 0 ]
}

@test "report --html still refuses two runs, and now says where to draw them" {
  two_summaries
  run "$CROWDSIM" report 20260901T100000Z --compare 20260902T100000Z --html
  [ "$status" -eq 2 ]
  [[ "$output" == *"--html reports one run"* ]]
  [[ "$output" == *"compare"* ]]
  [[ "$output" == *"--html"* ]]
}

@test "compare --html without node exits 5 and says the delta still prints" {
  two_summaries
  run env PATH="$(path_without_node)" "$CROWDSIM" compare 20260901T100000Z 20260902T100000Z --html
  [ "$status" -eq 5 ]
  [[ "$output" == *"needs node"* ]]
  [[ "$output" == *"still prints the delta"* ]]
}
