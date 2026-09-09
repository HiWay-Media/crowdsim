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

  # `history --html` became real in 1.38.0, so this asks about one it still does not take.
  run "$CROWDSIM" history --insecure
  [ "$status" -eq 2 ]
  [[ "$output" == *"--insecure"* ]]
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
  # The page spawns this driver for every run and for every drawn page. A gate that refused one of the
  # GUI's own flags would take the page down, so each flag in args.js is checked against the subcommand
  # whose builder emits it.
  #
  # It used to assume every flag in args.js belonged to `load`, with `--limit` hand-excepted as
  # discover's. That held while args.js built one argv; it broke the moment it built five (#90), which is
  # a test making a claim about the code's shape rather than about its behaviour. Now the shape is read:
  # each `buildXArgs` names its subcommand in the array it starts with.
  python3 - "$CROWDSIM_ROOT/gui/server/lib/args.js" > "$BATS_TEST_TMPDIR/emitted" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
# Each builder starts its argv with the subcommand: ['load', …], ['history', '--html', …].
bodies = re.split(r'\nexport function (build\w+)\(', src)
for i in range(1, len(bodies), 2):
    body = bodies[i + 1]
    sub = re.search(r"\[\s*'([a-z-]+)'", body)
    if not sub:
        continue
    for flag in sorted(set(re.findall(r"'(--[a-z0-9-]+)'", body))):
        print('%s\t%s' % (sub.group(1), flag))
PY
  [ -s "$BATS_TEST_TMPDIR/emitted" ] || { echo "no builders found in args.js — check this test"; return 1; }

  local sub flag
  while IFS="$(printf '\t')" read -r sub flag; do
    printf '%s\n' "$(declared "$sub")" | grep -qx -- "$flag" \
      || { echo "the GUI passes $flag to \`$sub\`, which does not declare it"; return 1; }
  done < "$BATS_TEST_TMPDIR/emitted"

  # And the five subcommands the page spawns are the ones we think they are: a builder for a sixth would
  # show up here rather than in a 500.
  run cut -f1 "$BATS_TEST_TMPDIR/emitted"
  for sub in load probe discover history compare; do
    [[ "$output" == *"$sub"* ]] || { echo "args.js no longer builds an argv for $sub"; return 1; }
  done
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
