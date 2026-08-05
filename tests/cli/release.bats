#!/usr/bin/env bats
#
# scripts/new-release.sh — the versioning rule, mechanised.
#
# Every test runs in a throwaway git repo with its own package.json and CHANGELOG: the script must never
# be able to tag the real checkout while being tested, and the refusals are the point of it existing.

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  REPO="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$REPO/scripts" "$REPO/gui/server" "$REPO/gui/ui"
  cp "$ROOT/scripts/new-release.sh" "$REPO/scripts/"
  RELEASE="$REPO/scripts/new-release.sh"

  cat > "$REPO/package.json" <<'JSON'
{
  "name": "crowdsim",
  "version": "1.2.0",
  "private": true
}
JSON
  printf '{\n  "name": "@crowdsim/gui-server",\n  "version": "1.2.0"\n}\n' > "$REPO/gui/server/package.json"
  printf '{\n  "name": "@crowdsim/gui-ui",\n  "version": "1.2.0"\n}\n' > "$REPO/gui/ui/package.json"
  cat > "$REPO/CHANGELOG.md" <<'MD'
# Changelog

## [1.2.0] — 2026-08-05

### Added
- The thing that shipped in 1.2.0.
MD

  git -C "$REPO" init -q
  git -C "$REPO" config user.email dev@example.test
  git -C "$REPO" config user.name dev
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "initial"
  git -C "$REPO" tag -a v1.2.0 -m "Release 1.2.0"
}

version_of() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$1"; }

fill_changelog() {
  python3 - "$REPO/CHANGELOG.md" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
open(p, 'w').write(re.sub(r'_Describe.*?_\n', '- A real, written change.\n', s, flags=re.S))
PY
}

@test "prepare bumps patch, and --dry-run touches nothing" {
  run "$RELEASE" prepare patch
  [ "$status" -eq 0 ]
  [ "$(version_of "$REPO/package.json")" = "1.2.1" ]

  run "$RELEASE" prepare --dry-run minor
  [ "$status" -eq 0 ]
  [[ "$output" == *"1.2.1 → 1.3.0"* ]]
  [ "$(version_of "$REPO/package.json")" = "1.2.1" ]
}

@test "prepare accepts an explicit version and rejects nonsense" {
  run "$RELEASE" prepare 2.0.0
  [ "$status" -eq 0 ]
  [ "$(version_of "$REPO/package.json")" = "2.0.0" ]

  run "$RELEASE" prepare sideways
  [ "$status" -eq 2 ]
}

@test "prepare keeps the workspaces on the same version as the root" {
  # A GUI reporting a different version than the driver it drives is a support conversation nobody needs.
  run "$RELEASE" prepare minor
  [ "$status" -eq 0 ]
  [ "$(version_of "$REPO/gui/server/package.json")" = "1.3.0" ]
  [ "$(version_of "$REPO/gui/ui/package.json")" = "1.3.0" ]
}

@test "prepare inserts a dated CHANGELOG skeleton above the previous release" {
  run "$RELEASE" prepare patch
  [ "$status" -eq 0 ]
  run head -5 "$REPO/CHANGELOG.md"
  [[ "$output" == *"## [1.2.1]"* ]]
  run grep -c '^## \[' "$REPO/CHANGELOG.md"
  [ "$output" -eq 2 ]
}

@test "prepare refuses a version that already has a CHANGELOG section" {
  run "$RELEASE" prepare 1.2.0
  [ "$status" -eq 3 ]
  [[ "$output" == *"already has a section"* ]]
}

@test "prepare refuses a version that is already tagged" {
  # The section check catches 1.2.0 first, so this uses a tag with no section behind it.
  git -C "$REPO" tag -a v1.4.0 -m "Release 1.4.0"
  run "$RELEASE" prepare 1.4.0
  [ "$status" -eq 3 ]
  [[ "$output" == *"already exists"* ]]
}

@test "tag refuses while the placeholder is still in the CHANGELOG" {
  # This is the whole reason the flow has two steps: an unwritten release must not be taggable.
  "$RELEASE" prepare patch
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "release 1.2.1"
  run "$RELEASE" tag
  [ "$status" -eq 3 ]
  [[ "$output" == *"placeholder"* ]]
  [ -z "$(git -C "$REPO" tag -l v1.2.1)" ]
}

@test "tag refuses a dirty tree, so the tag cannot point at something that is not the release" {
  "$RELEASE" prepare patch
  fill_changelog
  run "$RELEASE" tag
  [ "$status" -eq 3 ]
  [[ "$output" == *"working tree is not clean"* ]]
}

@test "tag refuses when the CHANGELOG's newest section is not the package version" {
  python3 - "$REPO/package.json" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()                    # read first: open(p, 'w') truncates before the argument is evaluated
open(p, 'w').write(re.sub(r'"1\.2\.0"', '"9.9.9"', s))
PY
  git -C "$REPO" commit -qam "bump only"
  run "$RELEASE" tag
  [ "$status" -eq 3 ]
  [[ "$output" == *"newest section is 1.2.0 but package.json says 9.9.9"* ]]
}

@test "tag creates the annotated tag on HEAD once the release is written and committed" {
  "$RELEASE" prepare patch
  fill_changelog
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "feat: something worth releasing"

  run "$RELEASE" tag --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"would tag v1.2.1"* ]]
  [ -z "$(git -C "$REPO" tag -l v1.2.1)" ]

  run "$RELEASE" tag
  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" tag -l v1.2.1)" = "v1.2.1" ]
  # annotated, not lightweight: a release tag carries a message
  [ "$(git -C "$REPO" cat-file -t v1.2.1)" = "tag" ]
  # and it points at the release commit
  [ "$(git -C "$REPO" rev-list -n1 v1.2.1)" = "$(git -C "$REPO" rev-parse HEAD)" ]
  # and it says, in words, that nothing left the machine
  [[ "$output" == *"Nothing was pushed"* ]]
}

@test "notes prints one version's section, which is what the release workflow publishes" {
  run "$RELEASE" notes 1.2.0
  [ "$status" -eq 0 ]
  [[ "$output" == *"The thing that shipped in 1.2.0."* ]]
  [[ "$output" != *"## ["* ]]

  run "$RELEASE" notes 7.7.7
  [ "$status" -eq 3 ]
}

@test "no subcommand prints usage and exits 2" {
  run "$RELEASE"
  [ "$status" -eq 2 ]
  [[ "$output" == *"prepare"* ]]
  run "$RELEASE" --help
  [ "$status" -eq 0 ]
}
