#!/usr/bin/env bash
#
# The documentation promises that every command in it was run before being written down. Nothing has ever
# run them a second time — and the stale image tags were the proof that documented text rots silently.
#
# Two checks, chosen so that a failure means the DOCUMENTATION is wrong rather than the environment:
#
#   1. every `--flag` the docs hand to `crowdsim` is a flag the driver actually parses. This is the rot that
#      matters: a renamed or removed flag leaves instructions that fail for whoever follows them.
#   2. the commands that need nothing at all — no target, no profile, no docker — are executed for real.
#
# Deliberately out of scope, and said so rather than skipped quietly: anything that needs a target, a
# profile that only exists on somebody's machine, docker, or a browser. Those are the e2e and image suites'
# job; pretending to check them here would be a green tick with nothing behind it.
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CROWDSIM="$ROOT/bin/crowdsim"
FILES=$(git ls-files 'docs/*.md' 'README.md' 'cache-ab/README.md' 'ci/**/*.md')
fail=0

# ── 1. the flags the docs hand out ───────────────────────────────────────────────────────────────────
# What the driver accepts: the long options in its own argument parser, plus the two that are handled in
# subcommand position.
known=$(grep -oE '^[[:space:]]+--[a-z-]+\)' "$CROWDSIM" | tr -d ' )' | sort -u)
known="$known
--help
--version"

# Every crowdsim invocation in a fenced block, and the flags it uses.
documented=$(printf '%s\n' $FILES | xargs grep -hoE '(^|[^a-zA-Z/])crowdsim [^`|>]*' 2>/dev/null \
  | grep -oE ' --[a-z-]+' | tr -d ' ' | sort -u || true)

for flag in $documented; do
  if ! printf '%s\n' "$known" | grep -qx -- "$flag"; then
    printf '  %s appears in the documentation and is not a flag crowdsim parses\n' "$flag"
    printf '%s\n' $FILES | xargs grep -ln -- "$flag" 2>/dev/null | sed 's/^/      in /'
    fail=1
  fi
done
[ "$fail" = "0" ] && printf '✅ every documented crowdsim flag is one the driver parses (%s checked)\n' \
  "$(printf '%s\n' $documented | grep -c . || echo 0)"

# ── 2. the commands that need nothing ────────────────────────────────────────────────────────────────
# Run them exactly as written. If one of these breaks, the first page a new user reads is wrong.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
selfcontained=(
  "--help"
  "--version"
  "doctor"
  "validate $ROOT/profiles/example.json"
)
for cmd in "${selfcontained[@]}"; do
  # shellcheck disable=SC2086
  if CROWDSIM_OUT="$tmp/out" $CROWDSIM $cmd >"$tmp/log" 2>&1; then
    printf '✅ crowdsim %s\n' "$cmd"
  else
    printf '  ❌ crowdsim %s exited %s:\n' "$cmd" "$?"
    sed 's/^/      /' "$tmp/log" | head -5
    fail=1
  fi
done

if [ "$fail" != "0" ]; then
  printf '\n❌ the documentation describes a tool that does not exist.\n'
  exit 1
fi
