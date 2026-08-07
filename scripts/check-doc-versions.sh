#!/usr/bin/env bash
#
# Every image tag the documentation tells somebody to pull must be the version this repository is at.
#
# This exists because README.md and docs/docker.md spent eleven releases telling people to
# `docker pull ghcr.io/hiway-media/crowdsim:1.2.0` — and docs/docker.md called it "exact version — use
# this". Following the documented path got you an image from before the bandwidth estimate, before
# `discover --verify`, before the validator. Nothing failed, because nothing was looking.
#
# It is the same shape as the relative-link check CI already runs: a claim the documentation makes about
# itself, verified rather than remembered.
#
#   scripts/check-doc-versions.sh          # check, exit 1 on a stale reference
#   scripts/check-doc-versions.sh --fix    # rewrite them to the current version
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
MINOR="${VERSION%.*}"
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

# Where a version is quoted as a thing to type. CHANGELOG is history and must never be rewritten; the
# roadmap describes past milestones; the site/ directory is build output.
FILES=$(git ls-files '*.md' 'ci/**' 'docker-compose.yml' '.env.example' \
        | grep -vE '^(CHANGELOG\.md|docs/changelog\.md|site/)' || true)

stale=0
for f in $FILES; do
  [ -f "$f" ] || continue
  # Any version-looking tag on a line that talks about crowdsim. Restricted to those lines on purpose:
  # elsewhere a ":0.52.0" is the pinned k6 and a "p95: 1.2" is a measurement, and a checker that cries
  # about either is a checker somebody switches off.
  #
  # Both written forms count — the image reference itself, and the "# or :1.2" beside it, which survived
  # the first pass of this fix and would have gone stale again on its own.
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    line="${hit%%:*}"; tag="${hit#*:}"
    case "$tag" in
      "$VERSION"|"$MINOR") continue;;
    esac
    stale=1
    printf '  %s:%s names crowdsim %s — this repository is at %s\n' "$f" "$line" "$tag" "$VERSION"
  done < <(grep -nE 'crowdsim' "$f" 2>/dev/null \
           | grep -oE '^[0-9]+:.*' \
           | awk -F: '{n=$1; line=$0; sub(/^[0-9]+:/,"",line);
                       while (match(line, /:[0-9]+\.[0-9]+(\.[0-9]+)?/)) {
                         tag = substr(line, RSTART+1, RLENGTH-1);
                         print n ":" tag;
                         line = substr(line, RSTART+RLENGTH);
                       }}' || true)
done

if [ "$stale" = "0" ]; then
  printf '✅ every documented image tag matches %s\n' "$VERSION"
  exit 0
fi

if [ "$FIX" = "1" ]; then
  for f in $FILES; do
    [ -f "$f" ] || continue
    # The fixer has to reach exactly what the checker flags, or a release leaves a file the check refuses to
    # pass and --fix cannot repair — which is what happened the first time this ran: it rewrote the image
    # references and left the "# or :1.13" comment beside them, and the two disagreed.
    #
    # :X.Y.Z → the current version, :X.Y → the current minor, both in an image reference and as a bare tag
    # mentioned on a line that talks about crowdsim.
    perl -pi -e '
      next unless /crowdsim/;
      s{crowdsim:[0-9]+\.[0-9]+\.[0-9]+}{crowdsim:'"$VERSION"'}g;
      s{crowdsim:[0-9]+\.[0-9]+(?![0-9.])}{crowdsim:'"$MINOR"'}g;
      s{(?<![\w.:])(:)[0-9]+\.[0-9]+\.[0-9]+(?![0-9.])}{:'"$VERSION"'}g;
      s{(?<![\w.:])(:)[0-9]+\.[0-9]+(?![0-9.])}{:'"$MINOR"'}g;
    ' "$f"
  done
  printf '✏️  rewritten to %s — review the diff before committing\n' "$VERSION"
  exit 0
fi

printf '\n❌ the documentation points at an image nobody should pull.\n'
printf '   Fix them: scripts/check-doc-versions.sh --fix\n'
exit 1
