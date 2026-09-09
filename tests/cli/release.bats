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

# ── the image gate (#89) ─────────────────────────────────────────────────────────────────────────────
#
# 1.36.0 and 1.37.0 were tagged with a Dockerfile that could not build: the `ui` stage did not copy a file
# the UI imports. Everything local was green — lint, unit, ui, gui, cli, e2e — because `make test` cannot
# see the image, and `tag` did not check it. The only gate was remembering `make image-smoke`.
#
# So `image-smoke` records a receipt fingerprinting the files that end up in the image, and `tag` refuses
# unless the receipt matches the tree it is about to tag. The check costs nothing at tag time: it verifies
# a run that already happened rather than starting one.

# A fake repo that HAS an image surface, plus the fingerprint helper the two share.
with_image_surface() {
  mkdir -p "$REPO/.github/workflows" "$REPO/bin" "$REPO/tests/image"
  cp "$ROOT/scripts/image-fingerprint.sh" "$REPO/scripts/" 2>/dev/null || true
  cat > "$REPO/.github/workflows/image.yml" <<'YML'
name: image
on:
  push:
    tags: ['v*']
    branches: [main]
    paths:
      - Dockerfile
      - bin/**
      - package.json
YML
  printf 'FROM alpine\n' > "$REPO/Dockerfile"
  printf '#!/usr/bin/env bash\necho hi\n' > "$REPO/bin/crowdsim"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "an image surface"
}

# Pretend `make image-smoke` passed on the tree as it stands.
record_receipt() {
  ( cd "$REPO" && ./scripts/image-fingerprint.sh --record )
}

@test "tag refuses when the image was never smoke-tested for this tree" {
  with_image_surface
  "$RELEASE" prepare patch
  fill_changelog
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "feat: something worth releasing"

  run "$RELEASE" tag
  [ "$status" -eq 3 ]
  [[ "$output" == *"image"* ]]
  [[ "$output" == *"make image-smoke"* ]]
  [ -z "$(git -C "$REPO" tag -l v1.2.1)" ]
}

@test "tag proceeds once the image has been smoke-tested for this tree" {
  with_image_surface
  "$RELEASE" prepare patch
  fill_changelog
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "feat: something worth releasing"
  record_receipt

  run "$RELEASE" tag
  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" tag -l v1.2.1)" = "v1.2.1" ]
}

@test "a receipt for a different tree does not count" {
  # The failure mode this exists for: smoke-test, then change the Dockerfile, then tag. The receipt has to
  # be about the tree being tagged, not about the last time somebody ran the suite.
  with_image_surface
  record_receipt
  printf 'FROM alpine\nRUN echo changed\n' > "$REPO/Dockerfile"
  "$RELEASE" prepare patch
  fill_changelog
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "feat: a different image"

  run "$RELEASE" tag
  [ "$status" -eq 3 ]
  [[ "$output" == *"make image-smoke"* ]]
}

@test "a change that cannot reach the image does NOT invalidate the receipt" {
  # A gate nobody can satisfy gets worked around. Writing the CHANGELOG after the smoke run is the normal
  # release order, so it must not send you back to docker for another five minutes.
  #
  # `prepare` comes first because it bumps package.json, which IS image-relevant — the version is baked
  # into the image and the smoke test asserts the image reports it. So the honest order is prepare, then
  # smoke, then tag; prose after the smoke run is free.
  with_image_surface
  "$RELEASE" prepare patch
  fill_changelog
  record_receipt
  printf '\nsome prose\n' >> "$REPO/CHANGELOG.md"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "docs: words only"

  run "$RELEASE" tag
  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" tag -l v1.2.1)" = "v1.2.1" ]
}

@test "--no-image tags anyway, and says what it skipped" {
  # Explicit, on the command line, every time — the safe-peak rule. A machine that cannot build the image
  # must still be able to cut a release, loudly.
  with_image_surface
  "$RELEASE" prepare patch
  fill_changelog
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "feat: something worth releasing"

  run "$RELEASE" tag --no-image
  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" tag -l v1.2.1)" = "v1.2.1" ]
  [[ "$output" == *"WITHOUT the image gate"* ]]
  [[ "$output" == *"--no-image"* ]]
  # and it names the consequence, not just the flag
  [[ "$output" == *"published none"* ]]
}

@test "a tree with no Dockerfile has no image to gate on" {
  # The gate engages on the surface, not on a flag: a repo with no image cannot fail to build one.
  "$RELEASE" prepare patch
  fill_changelog
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "feat: something worth releasing"

  run "$RELEASE" tag
  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" tag -l v1.2.1)" = "v1.2.1" ]
}

@test "the fingerprint reads the workflow's own paths, so the two cannot drift" {
  # If the list of image-relevant paths were copied into the script, adding one to the workflow would
  # leave the gate blind to it — which is the class of bug this whole issue is about.
  run grep -c "image.yml" "$ROOT/scripts/image-fingerprint.sh"
  [ "$output" -ge 1 ]
  run bash -c "cd '$ROOT' && ./scripts/image-fingerprint.sh --paths"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Dockerfile"* ]]
  [[ "$output" == *"bin"* ]]
  [[ "$output" == *"k6"* ]]
  # and NOT things that cannot reach the image
  [[ "$output" != *"CHANGELOG"* ]]
  [[ "$output" != *"docs/"* ]]
}
