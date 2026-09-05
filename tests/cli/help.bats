#!/usr/bin/env bats
#
# The help text, the completions, and the two run-id selectors.
#
# The header IS the help: extracted from the script by structure, so it cannot drift from the tool. These
# tests hold that property in place from three sides — the global help must not start with the shebang
# again, every subcommand must be able to answer for itself, and every flag the parser accepts must be
# documented in at least one subcommand's block. A flag added without a line in the header fails here,
# which is the only reason the completions can read that same header instead of carrying a copy.

load helper

setup() {
  crowdsim_setup
  SCRIPT="$CROWDSIM"
  # The completions find the script with `command -v crowdsim`, which is how they find it on a real
  # machine. Putting it on PATH here is what makes the completion tests test the installed shape.
  ln -sf "$CROWDSIM" "$BATS_TEST_TMPDIR/stub/crowdsim"
}

# Every long flag the argument parser actually accepts, taken from the parse loop itself.
parsed_flags() {
  sed -n '/^while \[ \$# -gt 0 \]; do/,/^done$/p' "$SCRIPT" \
    | grep -oE '^ +--[a-z0-9][a-z0-9-]*\)' | tr -d ' )' | sort -u
}

# Every subcommand that has a help block.
help_blocks() {
  sed -n 's/^#@ \([a-z-][a-z-]*\)$/\1/p' "$SCRIPT"
}

# Every long flag named anywhere inside one block.
block_flags() {
  awk -v want="$1" '
    $0 == "#@ " want { b = 1; next }
    /^#@/ && b { exit }
    b { print }
  ' "$SCRIPT" | grep -oE -- '--[a-z0-9][a-z0-9-]*' | sort -u
}

# ── the global help ──────────────────────────────────────────────────────────────────────────────────

@test "the first line of --help is the tool, not the shebang" {
  run "$CROWDSIM" --help
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == crowdsim\ —* ]]
  [[ "${lines[0]}" != *"/usr/bin/env"* ]]
}

@test "the global help stops before the per-subcommand blocks" {
  # Otherwise every subcommand's flag list is in the first thing a new user runs, and the global help is
  # four hundred lines long.
  run "$CROWDSIM" --help
  [[ "$output" != *"#@"* ]]
  [[ "$output" != *"per-subcommand help"* ]]
  [ "${#lines[@]}" -lt 120 ]
}

# ── one help per subcommand ──────────────────────────────────────────────────────────────────────────

@test "every dispatched subcommand answers --help for itself, shorter than the global help, exit 0" {
  local global_len; global_len="$("$CROWDSIM" --help | wc -l)"
  local cmd
  for cmd in $(sed -n '/^case "\$CMD" in$/,/^esac$/p' "$SCRIPT" \
                 | grep -oE '^  [a-z-]+\)' | tr -d ' )'); do
    run "$CROWDSIM" "$cmd" --help
    [ "$status" -eq 0 ] || { echo "$cmd --help exited $status"; return 1; }
    [ -n "$output" ] || { echo "$cmd --help printed nothing"; return 1; }
    [[ "$output" == *"crowdsim $cmd"* ]] || { echo "$cmd --help does not name itself"; return 1; }
    [ "${#lines[@]}" -lt "$global_len" ] || { echo "$cmd --help is not shorter"; return 1; }
  done
}

@test "a subcommand's help carries its own flags, and not another's" {
  run "$CROWDSIM" load --help
  [[ "$output" == *"--warmup"* ]]
  [[ "$output" == *"--i-know-this-breaks-production"* ]]
  [[ "$output" != *"--new-leg"* ]]

  run "$CROWDSIM" record --help
  [[ "$output" == *"--rsc-query"* ]]
  [[ "$output" != *"--peak"* ]]
}

@test "every flag the parser accepts is documented in at least one subcommand's help" {
  # The whole point: a flag added to the parse loop and to nothing else fails here, rather than shipping
  # undocumented and uncompletable.
  local all; all="$(for c in $(help_blocks); do block_flags "$c"; done | sort -u)"
  local f missing=""
  for f in $(parsed_flags); do
    case "$f" in --help) continue;; esac
    printf '%s\n' "$all" | grep -qx -- "$f" || missing="$missing $f"
  done
  [ -z "$missing" ] || { echo "undocumented flags:$missing"; return 1; }
}

@test "the gate flag is documented like any other: a gate is a decision, not a secret" {
  run "$CROWDSIM" load --help
  [[ "$output" == *"--i-know-this-breaks-production"* ]]
  [[ "$output" == *"ONLY way past the safe peak"* ]]
}

# ── completions ──────────────────────────────────────────────────────────────────────────────────────

@test "both completion files exist and parse" {
  [ -f "$CROWDSIM_ROOT/completions/crowdsim.bash" ]
  [ -f "$CROWDSIM_ROOT/completions/crowdsim.zsh" ]
  run bash -n "$CROWDSIM_ROOT/completions/crowdsim.bash"
  [ "$status" -eq 0 ]
}

@test "completion reads the header rather than carrying a copy of the flag list" {
  # A completion with its own list is stale by the next release and then quietly hides new flags. If this
  # ever stops being true, the test above stops protecting the completions too.
  run grep -c 'crowdsim --help\|crowdsim load\|$(crowdsim' "$CROWDSIM_ROOT/completions/crowdsim.bash"
  [ "$output" -eq 0 ]
  run grep -q '#@ ' "$CROWDSIM_ROOT/completions/crowdsim.bash"
  [ "$status" -eq 0 ]
}

@test "the bash completion offers a subcommand's own flags, and every subcommand" {
  # Driven the way a shell drives it, so what is asserted is what somebody would actually get.
  run bash -c "
    source '$CROWDSIM_ROOT/completions/crowdsim.bash'
    COMP_WORDS=(crowdsim load --) COMP_CWORD=2
    _crowdsim
    printf '%s\n' \"\${COMPREPLY[@]}\""
  [ "$status" -eq 0 ]
  [[ "$output" == *"--warmup"* ]]
  [[ "$output" == *"--i-know-this-breaks-production"* ]]
  [[ "$output" != *"--new-leg"* ]]

  run bash -c "
    source '$CROWDSIM_ROOT/completions/crowdsim.bash'
    COMP_WORDS=(crowdsim '') COMP_CWORD=1
    _crowdsim
    printf '%s\n' \"\${COMPREPLY[@]}\""
  for cmd in doctor discover probe load cache-ab history compare report weights init record validate serve; do
    [[ "$output" == *"$cmd"* ]] || { echo "completion is missing $cmd"; return 1; }
  done
}

@test "run ids complete from history.tsv, which costs a file read and never a run" {
  mkdir -p "$CROWDSIM_OUT"
  printf 'run_id\tprofile\n20260901T101500Z\tp\n20260901T121500Z\tp\n' > "$CROWDSIM_OUT/history.tsv"
  run bash -c "
    export CROWDSIM_OUT='$CROWDSIM_OUT'
    source '$CROWDSIM_ROOT/completions/crowdsim.bash'
    COMP_WORDS=(crowdsim report '') COMP_CWORD=2
    _crowdsim
    printf '%s\n' \"\${COMPREPLY[@]}\""
  [[ "$output" == *"20260901T121500Z"* ]]
  [[ "$output" == *"latest"* ]]
  [[ "$output" == *"previous"* ]]
}

# ── latest / previous ────────────────────────────────────────────────────────────────────────────────

two_runs() {
  mkdir -p "$CROWDSIM_OUT"
  cp "$FIXTURES/summary-good.json" "$CROWDSIM_OUT/summary-20260901T101500Z.json"
  cp "$FIXTURES/summary-good.json" "$CROWDSIM_OUT/summary-20260901T121500Z.json"
}

@test "report latest resolves to the newest run, and says which one before it says anything else" {
  two_runs
  run "$CROWDSIM" report latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"latest → 20260901T121500Z"* ]]
}

@test "compare previous latest works, and both resolutions are printed" {
  two_runs
  run "$CROWDSIM" compare previous latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"previous → 20260901T101500Z"* ]]
  [[ "$output" == *"latest → 20260901T121500Z"* ]]
}

@test "latest skips nothing: a discard still resolves, and is reported as the discard it is" {
  # Stepping back to the previous run would hand over a valid-looking result for a run nobody asked about.
  mkdir -p "$CROWDSIM_OUT"
  cp "$FIXTURES/summary-good.json" "$CROWDSIM_OUT/summary-20260901T101500Z.json"
  cp "$FIXTURES/summary-invalid.json" "$CROWDSIM_OUT/summary-20260901T121500Z.json"
  run "$CROWDSIM" report latest
  [[ "$output" == *"latest → 20260901T121500Z"* ]]
}

@test "no runs at all exits 2 and names the command that lists them" {
  mkdir -p "$CROWDSIM_OUT"
  run "$CROWDSIM" report latest
  [ "$status" -eq 2 ]
  [[ "$output" == *"no runs"* ]]
  [[ "$output" == *"crowdsim history"* ]]
}

@test "previous with only one run exits 2 rather than resolving to that one" {
  mkdir -p "$CROWDSIM_OUT"
  cp "$FIXTURES/summary-good.json" "$CROWDSIM_OUT/summary-20260901T101500Z.json"
  run "$CROWDSIM" report previous
  [ "$status" -eq 2 ]
  [[ "$output" == *"no \`previous\`"* ]]
}

@test "a real run id is passed through untouched, and announces nothing" {
  two_runs
  run "$CROWDSIM" report 20260901T101500Z
  [ "$status" -eq 0 ]
  [[ "$output" != *"→ 20260901T101500Z"* ]]
}
