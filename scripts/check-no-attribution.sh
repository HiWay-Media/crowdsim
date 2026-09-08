#!/usr/bin/env bash
#
# No customer or campaign NAME in this repository.
#
# CLAUDE.md forbids infrastructure data here — hostnames, internal paths, build hashes. A customer name
# attached to capacity figures is the same category and arguably a more sensitive one: the concurrent-user
# requirement, the rate a tier stayed clean past, the number of accounts a run created in an identity
# provider. Together they describe a named third party's capacity, and nobody agreed to publish that.
#
# It got in because the rule enumerated hostnames and paths and a name is neither. This check is the
# cheapest way to keep it out: a list of names that must not appear, asserted over the tracked files.
#
# The measured NUMBERS stay. They are the evidence for the invariants those comments defend, and losing
# them would make the code less defensible rather than more private. What must not travel is the
# attribution.
set -eo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One name per line. Case-insensitive, matched anywhere in a tracked file.
# The list itself is the one place these names appear by necessity, so it is excluded from the search
# below — without that this check failed on its own denylist the first time it ran after being committed.
# If even that is too much for a public repository, point CROWDSIM_ATTRIBUTION_DENYLIST at a file in a
# private one: a missing list is a skip, not a failure, and CI can supply it.
NAMES_FILE="${1:-${CROWDSIM_ATTRIBUTION_DENYLIST:-scripts/attribution-denylist.txt}}"
[ -f "$NAMES_FILE" ] || { printf '  ⚠️  no denylist at %s — nothing to check\n' "$NAMES_FILE"; exit 0; }

found=0
while IFS= read -r name; do
  case "$name" in ''|'#'*) continue;; esac
  if git grep -In -i -- "$name" -- . ':!scripts/attribution-denylist.txt' >/dev/null 2>&1; then
    printf '❌ "%s" appears in tracked files:\n' "$name"
    git grep -In -i -- "$name" -- . ':!scripts/attribution-denylist.txt' | sed 's/^/     /' | head -10
    found=1
  fi
done < "$NAMES_FILE"

if [ "$found" = "1" ]; then
  printf '\n  A customer or campaign name is infrastructure data (see CLAUDE.md). Keep the measured\n'
  printf '  numbers — they are the evidence — and drop the attribution.\n'
  exit 1
fi
printf '  ✅ no customer or campaign name in the tracked files (%s checked)\n' \
  "$(grep -cvE '^\s*(#|$)' "$NAMES_FILE")"
