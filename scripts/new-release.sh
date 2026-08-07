#!/usr/bin/env bash
#
# crowdsim — prepare and tag a release.
#
# The project's rule is that every change ships as a version: a CHANGELOG section, a version bump, an
# annotated tag, and a GitHub Release. That rule held for 1.0.0 only because somebody remembered, and the
# tag had to be created after the fact in a later session. This script is the rule, so it stops depending
# on memory.
#
# Two steps, on purpose. Preparing is mechanical; writing down what changed is not, and a release whose
# notes were generated from commit subjects is a release nobody reads.
#
#   scripts/new-release.sh prepare <minor|patch|major|X.Y.Z>
#       bumps the version in package.json (root + workspaces) and the lock file, and inserts a dated
#       CHANGELOG skeleton for it. Then you write the section.
#
#   scripts/new-release.sh tag
#       verifies the top CHANGELOG section matches package.json, is filled in, and is not already tagged —
#       then creates the annotated tag on HEAD. It never pushes: that stays a human decision.
#
#   scripts/new-release.sh notes [version]
#       prints one version's CHANGELOG section, which is what the release workflow publishes.
#
# Flags:  --dry-run  print what would change and touch nothing
#
# Exit: 0 done · 2 usage · 3 refused (dirty tree, tag exists, placeholder left in the CHANGELOG)
#
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG="$ROOT/CHANGELOG.md"
PKG="$ROOT/package.json"
WORKSPACES=("$ROOT/gui/server/package.json" "$ROOT/gui/ui/package.json")
PLACEHOLDER='_Describe the change here'

DRY=0
CMD=""
ARG=""

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; }
die()  { printf '❌ %s\n' "$1" >&2; exit "${2:-1}"; }

usage() { sed -n '1,30p' "$0" | grep -E '^#' | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    prepare|tag|notes) CMD="$1"; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown flag: $1" 2 ;;
    *) if [ -z "$ARG" ]; then ARG="$1"; shift; else die "unexpected argument: $1" 2; fi ;;
  esac
done
[ -n "$CMD" ] || { usage; exit 2; }

command -v python3 >/dev/null 2>&1 || die "python3 is required" 3
[ -f "$PKG" ] || die "not a crowdsim checkout: no package.json at $ROOT" 3

current() {
  python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1]))["version"])
except Exception as e:
    sys.exit(f"package.json is unreadable ({e})")' "$PKG" || die "cannot determine the current version: $PKG" 3
}

next_version() {
  python3 - "$(current)" "$1" <<'PY'
import re, sys
cur, bump = sys.argv[1], sys.argv[2]
if re.fullmatch(r'\d+\.\d+\.\d+', bump):
    print(bump); raise SystemExit
major, minor, patch = (int(x) for x in cur.split('.'))
if bump == 'major':   print(f"{major+1}.0.0")
elif bump == 'minor': print(f"{major}.{minor+1}.0")
elif bump == 'patch': print(f"{major}.{minor}.{patch+1}")
else:
    sys.exit(f"bump must be major, minor, patch or an explicit X.Y.Z (got: {bump})")
PY
}

# The CHANGELOG is the source of the release notes, so it is parsed rather than trusted.
section() {
  python3 - "$CHANGELOG" "$1" <<'PY'
import re, sys
want = sys.argv[2]
body, keep = [], False
for line in open(sys.argv[1]):
    m = re.match(r'^## \[(\d+\.\d+\.\d+)\]', line)
    if m:
        if keep: break
        keep = (m.group(1) == want)
        continue
    if keep: body.append(line.rstrip('\n'))
print('\n'.join(body).strip())
PY
}

top_version() {
  python3 - "$CHANGELOG" <<'PY'
import re, sys
for line in open(sys.argv[1]):
    m = re.match(r'^## \[(\d+\.\d+\.\d+)\]', line)
    if m:
        print(m.group(1)); break
PY
}

case "$CMD" in

notes)
  version="${ARG:-$(current)}"
  body="$(section "$version")"
  [ -n "$body" ] || die "no CHANGELOG section for $version" 3
  printf '%s\n' "$body"
  ;;

prepare)
  [ -n "$ARG" ] || die "prepare needs a bump: minor, patch, major or X.Y.Z" 2
  version="$(next_version "$ARG")" || die "$version" 2
  say "▶ preparing $(current) → $version"

  if [ -n "$(section "$version")" ]; then
    die "CHANGELOG already has a section for $version — write it, then run: scripts/new-release.sh tag" 3
  fi
  if git -C "$ROOT" rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
    die "tag v$version already exists" 3
  fi

  if [ "$DRY" = "1" ]; then
    say "  would set the version to $version in package.json and the workspaces"
    say "  would insert a CHANGELOG section for $version"
    exit 0
  fi

  DATE="$(date -u +%Y-%m-%d)"
  python3 - "$version" "$DATE" "$CHANGELOG" "$PLACEHOLDER" "$PKG" "${WORKSPACES[@]}" <<'PY'
import json, re, sys
version, date, changelog, placeholder = sys.argv[1:5]
for pkg in sys.argv[5:]:
    with open(pkg) as f: raw = f.read()
    # Rewritten textually, not via json.dump: these files are hand-maintained and a reformat would bury
    # the real change in a whitespace diff.
    new, n = re.subn(r'("version":\s*")\d+\.\d+\.\d+(")', rf'\g<1>{version}\g<2>', raw, count=1)
    if not n: sys.exit(f"no version field in {pkg}")
    with open(pkg, 'w') as f: f.write(new)

text = open(changelog).read()
anchor = re.search(r'^## \[', text, re.M)
if not anchor: sys.exit("CHANGELOG has no release sections to insert before")
skeleton = (f"## [{version}] — {date}\n\n{placeholder} — what changed, and why it mattered. "
            "Keep the project's voice: explain the trap, not the feature list._\n\n"
            "### Added\n\n### Changed\n\n### Fixed\n\n")
open(changelog, 'w').write(text[:anchor.start()] + skeleton + text[anchor.start():])
PY

  ok "version set to $version"
  ok "CHANGELOG section inserted for $version"
  if command -v npm >/dev/null 2>&1 && [ -f "$ROOT/package-lock.json" ]; then
    ( cd "$ROOT" && npm install --package-lock-only --silent >/dev/null 2>&1 ) \
      && ok "package-lock.json synced" || warn "could not sync package-lock.json — run npm install"
  fi
  # The image tags the documentation and the manifests tell people to pull. They spent eleven releases
  # pointing at 1.2.0 — and the Kubernetes manifests at 1.4.1 — because keeping them current depended on
  # somebody remembering. It depends on this line now.
  if [ -x "$ROOT/scripts/check-doc-versions.sh" ]; then
    "$ROOT/scripts/check-doc-versions.sh" --fix >/dev/null 2>&1 \
      && ok "documented image tags moved to $version" \
      || warn "could not update the documented image tags — run scripts/check-doc-versions.sh"
  fi
  say ""
  say "  Next: write the CHANGELOG section (replace the placeholder), commit everything, then:"
  say "      scripts/new-release.sh tag"
  ;;

tag)
  version="$(current)"
  top="$(top_version)"
  [ "$top" = "$version" ] || die "CHANGELOG's newest section is $top but package.json says $version" 3

  body="$(section "$version")"
  [ -n "$body" ] || die "no CHANGELOG section for $version" 3
  case "$body" in
    *"$PLACEHOLDER"*) die "the CHANGELOG section for $version still contains the placeholder" 3 ;;
  esac

  if git -C "$ROOT" rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
    die "tag v$version already exists" 3
  fi
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    die "the working tree is not clean: commit the release first, so the tag points at it" 3
  fi

  if [ "$DRY" = "1" ]; then
    say "would tag v$version on $(git -C "$ROOT" rev-parse --short HEAD)"
    exit 0
  fi

  git -C "$ROOT" tag -a "v$version" -m "Release $version"
  ok "tagged v$version on $(git -C "$ROOT" rev-parse --short HEAD)"
  say ""
  say "  Nothing was pushed. When you are ready:"
  say "      git push && git push --tags"
  say "  The tag triggers the release workflow (GitHub Release from this CHANGELOG section) and the"
  say "  image workflow (build → smoke test → push to ghcr.io)."
  ;;
esac
