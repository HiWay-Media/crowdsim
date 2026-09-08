#!/usr/bin/env bats
#
# A flag the subcommand does not use must be an ERROR, not a no-op.
#
# `crowdsim probe --profile p.json --out /tmp/elsewhere` exited 0 and wrote its output to $CROWDSIM_OUT.
# Somebody asked for a directory and got a different one, silently — which is the same class of mistake
# this repository already refuses for an unknown flag (exit 2 rather than ignored). `--out` is a real flag,
# just not one `probe` has, and the parse loop is one flat case over every flag the tool understands.
#
# The accepted set per subcommand is derived from the same `#@ <name>` help blocks the help and the
# completions read: the lines that DECLARE a flag, not the prose that mentions one. So a flag cannot be
# accepted without being documented, and cannot be documented without being accepted.

load helper

setup() {
  crowdsim_setup
  ln -sf "$CROWDSIM" "$BATS_TEST_TMPDIR/stub/crowdsim"
  P="$FIXTURES/minimal.json"
}

# The flags one subcommand declares — the same rule the driver uses.
declared() {
  awk -v want="$1" '
    $0 == "#@ " want { b = 1; next }
    /^#@/ && b { exit }
    b && !/^#/ { exit }
    b { sub(/^# ?/, ""); if ($1 ~ /^--[a-z0-9]/) { sub(/,$/, "", $1); print $1 } }
  ' "$CROWDSIM"
}

subcommands() { sed -n 's/^#@ \([a-z-][a-z-]*\)$/\1/p' "$CROWDSIM"; }

# ── the bug that started this ────────────────────────────────────────────────────────────────────────

@test "probe --out is refused instead of quietly writing somewhere else" {
  run env CROWDSIM_ALLOW_TARGETS='127.0.0.1' "$CROWDSIM" probe --profile "$P" --out "$BATS_TEST_TMPDIR/elsewhere"
  [ "$status" -eq 2 ]
  [[ "$output" == *"--out"* ]]
  [[ "$output" == *"probe"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/elsewhere" ]
}

@test "the refusal names the subcommands the flag does belong to" {
  # Otherwise the message tells somebody they are wrong without telling them where to go.
  run "$CROWDSIM" probe --profile "$P" --peak 500
  [ "$status" -eq 2 ]
  [[ "$output" == *"--peak"* ]]
  [[ "$output" == *"These subcommands take it"* ]]
  [[ "$output" == *"load"* ]]
  [[ "$output" == *"cache-ab"* ]]
}

@test "a subcommand with no flags at all refuses every one of them" {
  run "$CROWDSIM" next --peak 9000
  [ "$status" -eq 2 ]
  [[ "$output" == *"--peak"* ]]
}

@test "a flag from another subcommand is refused everywhere, not only where it is dangerous" {
  run "$CROWDSIM" validate "$P" --html
  [ "$status" -eq 2 ]
  [[ "$output" == *"--html"* ]]

  run "$CROWDSIM" doctor --touch-and-go
  [ "$status" -eq 2 ]
  [[ "$output" == *"--touch-and-go"* ]]

  run "$CROWDSIM" history --html
  [ "$status" -eq 2 ]
}

@test "an unknown flag is still an unknown flag, and says so differently" {
  run "$CROWDSIM" probe --profile "$P" --nonsense
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown option"* ]]
}

# ── nothing that used to work stops working ──────────────────────────────────────────────────────────

@test "every flag a subcommand declares is one the parse loop actually accepts" {
  # The gate is derived from the help blocks, so a typo in a block would invent a flag. The other
  # direction — a flag a subcommand really uses that its block forgets — turns into a refusal, and the
  # two hundred tests in this suite that drive real flag combinations are what catch that.
  local parsed cmd f
  parsed="$(sed -n '/^while \[ \$# -gt 0 \]; do/,/^done$/p' "$CROWDSIM" \
              | grep -oE '^ +--[a-z0-9][a-z0-9-]*\)' | tr -d ' )' | sort -u)"
  for cmd in $(subcommands); do
    for f in $(declared "$cmd"); do
      printf '%s\n' "$parsed" | grep -qx -- "$f" \
        || { echo "the $cmd help declares $f, which the parse loop does not accept"; return 1; }
    done
  done
}

@test "--help and --version are not subcommand flags and work everywhere" {
  local cmd
  for cmd in $(subcommands); do
    run "$CROWDSIM" "$cmd" --help
    [ "$status" -eq 0 ] || { echo "$cmd --help exited $status"; return 1; }
  done
}

@test "load still takes its whole documented flag set at once" {
  run env CROWDSIM_ALLOW_TARGETS='127.0.0.1' "$CROWDSIM" load --profile "$P" \
    --target local --peak 10 --start 5 --steps 2 --step-dur 5s --hold 0s \
    --rsc-mode repeat --max-p95 4000 --max-5xx 0.1 --abort-delay 5s --safe-peak 40 \
    --skip-classes proxy_only --insecure --slack --warmup 5s --warmup-peak 5 --dry-run
  [ "$status" -eq 0 ]
}

@test "the GUI cannot be broken by this gate: every argv it builds is inside the declared sets" {
  # The page spawns this driver for every run. A gate that refused one of the GUI's own flags would take
  # the whole page down, and tests/gui asserts the argv rather than running it.
  local f
  # probe and discover build a fixed argv; assert those two literally
  for f in --profile --target --insecure; do
    printf '%s\n' "$(declared probe)" | grep -qx -- "$f" || { echo "probe rejects the GUI's $f"; return 1; }
  done
  for f in --profile --target --limit; do
    printf '%s\n' "$(declared discover)" | grep -qx -- "$f" || { echo "discover rejects the GUI's $f"; return 1; }
  done
  for f in $(grep -ohE "'--[a-z0-9-]+'" "$CROWDSIM_ROOT/gui/server/lib/args.js" | tr -d "'" | sort -u); do
    case "$f" in --limit) continue;; esac   # discover's, asserted above
    printf '%s\n' "$(declared load)" | grep -qx -- "$f" || { echo "load rejects the GUI's $f"; return 1; }
  done
  printf '%s\n' "$(declared report)" | grep -qx -- --html
  printf '%s\n' "$(declared compare)" | grep -qx -- --json
}

# ── the block extraction that feeds all of this ──────────────────────────────────────────────────────

@test "the last help block ends at the code, not at the end of the file" {
  # `serve` is the last block, and an extraction that only stops at the next `#@` ran on to the end of
  # the script — so `serve` claimed every long option in the source, curl's --resolve and --max-time
  # included. The completions offered all 55 of them from 1.25.0.
  local n; n="$(declared serve | wc -l | tr -d ' ')"
  [ "$n" -le 4 ] || { echo "serve declares $n flags: the block does not end"; declared serve; return 1; }
  declared serve | grep -qx -- --port
  declared serve | grep -qx -- --bind
  ! declared serve | grep -qx -- --resolve
  ! declared serve | grep -qx -- --max-time
}

@test "the bash completion offers a subcommand its own flags and no more" {
  run bash -c "
    source '$CROWDSIM_ROOT/completions/crowdsim.bash'
    COMP_WORDS=(crowdsim serve --) COMP_CWORD=2
    _crowdsim
    printf '%s\n' \"\${COMPREPLY[@]}\""
  [ "$status" -eq 0 ]
  [[ "$output" == *"--port"* ]]
  [[ "$output" == *"--bind"* ]]
  [[ "$output" != *"--resolve"* ]]
  [[ "$output" != *"--peak"* ]]
}
