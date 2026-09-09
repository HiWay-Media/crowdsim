#!/usr/bin/env bash
#
# The fingerprint of everything that ends up in the image, and the receipt that says it was smoke-tested.
#
# WHY THIS EXISTS — 1.36.0 and 1.37.0 were tagged with a Dockerfile that could not build: the `ui` stage
# did not copy a file the UI imports. Everything local was green, because `make test` cannot see the image
# and `new-release.sh tag` did not check it. The only gate was remembering `make image-smoke`, which
# CLAUDE.md requires and which was skipped. Two releases published no image at all.
#
# So the gate stops being a memory exercise: `make image-smoke` records a receipt here, and `tag` refuses
# unless the receipt matches the tree it is about to tag. Nothing is built at tag time — this verifies a
# run that already happened, which is why it costs a second rather than five minutes.
#
# WHAT COUNTS AS IMAGE-RELEVANT is not written down twice. `.github/workflows/image.yml` already declares
# it, in the `paths:` filters that decide whether CI builds at all, and this script reads that file. A copy
# of the list would leave the gate blind to a path somebody adds to the workflow — which is exactly the
# class of bug this exists to catch.
#
# Usage:
#   image-fingerprint.sh --paths     the pathspecs, one per line (what the workflow says matters)
#   image-fingerprint.sh --print     the fingerprint of the working tree
#   image-fingerprint.sh --record    write the receipt for the working tree
#   image-fingerprint.sh --check     exit 0 if the receipt matches, 1 if not, 2 if there is none
#
# Exit: 0 ok · 1 stale · 2 no receipt / usage · 3 no image surface in this tree
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/image.yml"
# Inside .git/ on purpose: the receipt is a local record of a local run, so it must never be committed and
# must never make the tree dirty. At the repo root it did both — and `tag` refuses a dirty tree, so
# recording a receipt stopped the very command it exists to unblock. Here it needs no .gitignore entry and
# cannot leak into a clone.
GIT_DIR_PATH="$(git -C "$ROOT" rev-parse --git-dir 2>/dev/null || printf '%s' "$ROOT/.git")"
case "$GIT_DIR_PATH" in /*) ;; *) GIT_DIR_PATH="$ROOT/$GIT_DIR_PATH" ;; esac
RECEIPT="${CROWDSIM_IMAGE_RECEIPT:-$GIT_DIR_PATH/crowdsim-image-smoke}"

# The union of every `paths:` list in the image workflow. A union rather than just the push filter: any
# path that can trigger an image build is a path that can change the image.
paths() {
  [ -f "$WORKFLOW" ] || return 3
  python3 - "$WORKFLOW" <<'PY'
import sys
out, inpaths, indent = [], False, None
for raw in open(sys.argv[1], encoding='utf-8'):
    line = raw.rstrip('\n')
    stripped = line.strip()
    if stripped.startswith('paths:'):
        inpaths, indent = True, len(line) - len(line.lstrip())
        continue
    if not inpaths:
        continue
    if not stripped:
        continue
    here = len(line) - len(line.lstrip())
    if stripped.startswith('- ') and here > indent:
        p = stripped[2:].strip().strip('"\'')
        if p and p not in out:
            out.append(p)
        continue
    # Anything else at or above the `paths:` indent ends the list.
    if here <= indent:
        inpaths, indent = False, None
for p in out:
    print(p)
PY
}

# The pathspec git understands: `bin/**` is a glob to Actions and a directory to git.
as_pathspec() {
  case "$1" in
    */\*\*) printf '%s' "${1%/**}/" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Content, not git blobs: `image-smoke` is normally run with a dirty tree, and a fingerprint that only
# saw committed content would call an untested change tested.
#
# The enumeration happens INSIDE python, not through a pipe into it. `python3 - <<'PY'` takes its program
# from stdin, so a pipe into that heredoc delivers nothing and the hash comes out as the sha256 of the
# empty string — a fingerprint that matches everything, i.e. a gate that always passes. This repository
# has been caught by that exact heredoc before (see the mix argument in `crowdsim init`), and here it
# would have been worse: silent and reassuring.
fingerprint() {
  local -a specs=()
  local p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    specs+=("$(as_pathspec "$p")")
  done < <(paths)
  [ "${#specs[@]}" -gt 0 ] || return 3

  python3 -c '
import hashlib, os, subprocess, sys
root, specs = sys.argv[1], sys.argv[2:]
# git ls-files so that node_modules, out/ and anything else ignored stays out of it.
names = subprocess.run(["git", "-C", root, "ls-files", "-z", "--"] + specs,
                       capture_output=True, check=True).stdout.split(b"\0")
files = sorted(n for n in names if n)
if not files:
    sys.exit(3)
h = hashlib.sha256()
for name in files:
    # The NAME is repo-relative and goes into the hash as such, so the fingerprint does not depend on
    # where the checkout lives. The path opened is joined to the root: a bare relative open resolves
    # against whatever cwd the caller had, so running this from any directory but the repo root hashed
    # a DIFFERENT repository and reported a mismatch — or, worse, a match. No apostrophes in here: this
    # block lives inside a single-quoted python3 -c.
    rel = name.decode("utf-8", "surrogateescape")
    h.update(name + b"\0")
    try:
        with open(os.path.join(root, rel), "rb") as fh:
            h.update(hashlib.sha256(fh.read()).digest())
    except OSError:
        h.update(b"<missing>")
print(h.hexdigest())
' "$ROOT" "${specs[@]}"
}

# A tree with no Dockerfile cannot fail to build one.
has_image_surface() {
  [ -f "$ROOT/Dockerfile" ] && [ -f "$WORKFLOW" ]
}

case "${1:-}" in
  --paths)
    paths || { printf 'no %s in this tree\n' "$WORKFLOW" >&2; exit 3; }
    ;;
  --print)
    fingerprint
    ;;
  --record)
    has_image_surface || exit 3
    fp="$(fingerprint)" || exit 3
    printf '%s\n' "$fp" > "$RECEIPT"
    ;;
  --check)
    has_image_surface || exit 3
    [ -f "$RECEIPT" ] || exit 2
    fp="$(fingerprint)" || exit 3
    [ "$(cat "$RECEIPT")" = "$fp" ] || exit 1
    ;;
  *)
    sed -n '2,${/^#/!q; s/^# \{0,1\}//p;}' "$0"
    exit 2
    ;;
esac
