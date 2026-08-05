#!/usr/bin/env bash
#
# crowdsim — sync .github/roadmap.json to GitHub labels, milestones and issues.
#
# The roadmap file is the source of truth; this script replays it. It is idempotent and additive:
# it creates what is missing and re-aligns milestone and labels on issues it already opened. It never
# closes an issue, never reopens one, and never overwrites a body a human has edited — an issue that
# has been discussed is worth more than the paragraph that seeded it.
#
# Issues are matched by the `key` field, carried in a hidden marker at the end of the body, not by
# title. A title can be reworded in the roadmap without opening a duplicate.
#
# Usage:
#   scripts/sync-roadmap.sh [--dry-run] [--repo <owner/name>] [--file <path>]
#
#   --dry-run   print what would change and touch nothing (do this first)
#   --repo      target repository (default: the one the current checkout points at)
#   --file      roadmap file (default: .github/roadmap.json)
#
# Exit codes:  0 done · 2 usage · 3 missing prerequisite (gh, jq, authentication)
#
set -eo pipefail

DRY_RUN=0
REPO=""
FILE=".github/roadmap.json"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$1" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --repo)    REPO="$2"; shift 2 ;;
    --file)    FILE="$2"; shift 2 ;;
    -h|--help) sed -n '1,25p' "$0" | grep '^#'; exit 0 ;;
    *)         die "unknown argument: $1" 2 ;;
  esac
done

command -v gh >/dev/null 2>&1 || die "gh is not installed (https://cli.github.com)" 3
command -v jq >/dev/null 2>&1 || die "jq is not installed" 3
gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)" 3
[ -f "$FILE" ] || die "roadmap file not found: $FILE" 3
jq empty "$FILE" 2>/dev/null || die "roadmap file is not valid JSON: $FILE" 3

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) \
    || die "cannot determine the repository — pass --repo <owner/name>" 3
fi

[ "$DRY_RUN" = 1 ] && say "DRY RUN — nothing will be written to $REPO" || say "Syncing $FILE -> $REPO"
say ""

# ---------------------------------------------------------------- labels

say "Labels"
while IFS=$'\t' read -r name color description; do
  [ -n "$name" ] || continue
  if [ "$DRY_RUN" = 1 ]; then
    say "  would ensure  $name"
    continue
  fi
  # --force updates colour and description when the label already exists.
  gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force >/dev/null
  say "  ensured       $name"
done < <(jq -r '.labels[]? | [.name, .color, (.description // "")] | @tsv' "$FILE")
say ""

# ------------------------------------------------------------ milestones

say "Milestones"
existing_milestones=$(gh api "repos/$REPO/milestones?state=all&per_page=100" --paginate)

while IFS=$'\t' read -r title description; do
  [ -n "$title" ] || continue
  number=$(printf '%s' "$existing_milestones" \
    | jq -r --arg t "$title" '[.[] | select(.title == $t) | .number] | first // empty')
  if [ -n "$number" ]; then
    say "  exists        $title (#$number)"
    continue
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  would create  $title"
    continue
  fi
  number=$(gh api "repos/$REPO/milestones" -X POST \
    -f title="$title" -f description="$description" --jq .number)
  say "  created       $title (#$number)"
done < <(jq -r '.milestones[]? | [.title, (.description // "")] | @tsv' "$FILE")

# Re-read so milestones created in this run are resolvable below.
if [ "$DRY_RUN" = 0 ]; then
  existing_milestones=$(gh api "repos/$REPO/milestones?state=all&per_page=100" --paginate)
fi
say ""

# ---------------------------------------------------------------- issues

# One paginated read, then match locally: the search API is eventually consistent and would let a
# second run open duplicates of issues the first run just created.
existing_issues=$(gh api "repos/$REPO/issues?state=all&per_page=100" --paginate \
  | jq '[.[] | select(has("pull_request") | not)
             | {number, title, body: (.body // ""), state,
                milestone: (.milestone.title // null),
                labels: [.labels[].name]}]')

say "Issues"
created=0; updated=0; unchanged=0

count=$(jq '.issues | length' "$FILE")
i=0
while [ "$i" -lt "$count" ]; do
  issue=$(jq ".issues[$i]" "$FILE")
  i=$((i + 1))

  key=$(printf '%s' "$issue"      | jq -r '.key')
  title=$(printf '%s' "$issue"    | jq -r '.title')
  ms_title=$(printf '%s' "$issue" | jq -r '.milestone // empty')
  body=$(printf '%s' "$issue"     | jq -r '.body | join("\n")')
  marker="<!-- roadmap:$key -->"
  body="$body

$marker"

  ms_number=""
  if [ -n "$ms_title" ]; then
    ms_number=$(printf '%s' "$existing_milestones" \
      | jq -r --arg t "$ms_title" '[.[] | select(.title == $t) | .number] | first // empty')
    if [ -z "$ms_number" ] && [ "$DRY_RUN" = 0 ]; then
      warn "$key: milestone '$ms_title' not found — creating the issue without one"
    fi
  fi

  number=$(printf '%s' "$existing_issues" \
    | jq -r --arg m "$marker" '[.[] | select(.body | contains($m)) | .number] | first // empty')

  if [ -z "$number" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      say "  would create  [$key] $title"
      created=$((created + 1))
      continue
    fi
    args=(--repo "$REPO" --title "$title" --body "$body")
    [ -n "$ms_number" ] && args+=(--milestone "$ms_title")
    while IFS= read -r label; do
      [ -n "$label" ] && args+=(--label "$label")
    done < <(printf '%s' "$issue" | jq -r '.labels[]?')
    url=$(gh issue create "${args[@]}")
    say "  created       [$key] ${url##*/}  $title"
    created=$((created + 1))
    continue
  fi

  # Existing issue: re-align milestone and labels only. The body stays as it is.
  current=$(printf '%s' "$existing_issues" | jq --argjson n "$number" '.[] | select(.number == $n)')
  cur_ms=$(printf '%s' "$current" | jq -r '.milestone // ""')
  missing_labels=$(printf '%s' "$issue" | jq -r --argjson cur "$(printf '%s' "$current" | jq '.labels')" \
    '[.labels[]? | select(. as $l | $cur | index($l) | not)] | join(",")')

  drift=""
  [ -n "$ms_title" ] && [ "$cur_ms" != "$ms_title" ] && drift="milestone -> $ms_title"
  [ -n "$missing_labels" ] && drift="${drift:+$drift, }labels += $missing_labels"

  if [ -z "$drift" ]; then
    unchanged=$((unchanged + 1))
    continue
  fi

  if [ "$DRY_RUN" = 1 ]; then
    say "  would update  [$key] #$number  ($drift)"
    updated=$((updated + 1))
    continue
  fi

  args=(--repo "$REPO")
  [ -n "$ms_title" ] && [ "$cur_ms" != "$ms_title" ] && args+=(--milestone "$ms_title")
  if [ -n "$missing_labels" ]; then
    IFS=',' read -ra add <<< "$missing_labels"
    for label in "${add[@]}"; do args+=(--add-label "$label"); done
  fi
  gh issue edit "$number" "${args[@]}" >/dev/null
  say "  updated       [$key] #$number  ($drift)"
  updated=$((updated + 1))
done

say ""
say "Done: $created created, $updated updated, $unchanged unchanged."
