#!/usr/bin/env bash
#
# The documentation quotes the tool's own output — validator refusals, panel lines, report sections, GUI
# banners — and those blocks are the part a reader compares against their own terminal. A stale one is worse
# than a missing one: it tells somebody their tool is broken, or hides that it changed.
#
# `check-doc-commands.sh` proves the documented COMMANDS run and that every documented flag is parsed. It
# cannot see what those commands print. This does, by the only method that does not require running every
# command against a real target: it takes the distinctive wording out of each quoted output block and asserts
# that the wording still exists in the source the message comes from.
#
# Not hypothetical. While writing the v1.7.0 documentation a quoted `validate` refusal turned out never to
# have existed in that wording; it was caught by running the command one more time than usual, which is not
# a control.
#
# What is asserted, and what is deliberately not:
#
#   · **wording, not numbers.** Every number in a quoted block came from a real run on somebody's machine
#     and will never match again. Phrases are cut at any token carrying a digit, a path, a URL, a run id or
#     an interpolated value, so `p95 240 ms` is never asserted and "past the read timeout" is.
#   · **phrases, not whole sentences.** The sources wrap and concatenate their strings; a sentence in the
#     docs is often three source lines. Whitespace is collapsed on both sides and a phrase of five or more
#     words is looked for in the collapsed source.
#   · **a block that cannot be checked mechanically is marked, not skipped in silence.** Put
#     `<!-- illustrative: why -->` immediately before the fence and the block is skipped, counted and
#     listed. A block whose prose is too short or too numeric to assert contributes nothing and is counted
#     as such: the report says how many blocks were checked, marked and empty, so a silent zero is visible.
#
# Usage:
#   scripts/check-doc-output.sh              check README.md and docs/
#   scripts/check-doc-output.sh --self-test  prove the checker can fail: plants a fabricated refusal in a
#                                            temporary copy of the docs and asserts it is caught
#
# Exit: 0 every quoted phrase still exists in the source · 1 a quote the tool no longer produces
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-check}"

run_check() {
  local docs_root="$1"
  python3 - "$docs_root" "$ROOT" <<'PY'
import glob, os, re, sys

docs_root, root = sys.argv[1], sys.argv[2]

# ── the sources a documented message can legitimately come from ──────────────────────────────────────
# Named rather than globbed over the whole repository: a phrase that only exists in a test fixture or in
# another doc page is not a phrase the tool produces, and finding it there would make this check circular.
SOURCE_GLOBS = [
    'bin/crowdsim',
    'lib/*.mjs',
    'k6/*.js',
    'k6/lib/*.js',
    'gui/server/lib/*.js',
    'gui/ui/src/lib/*.js',
    'gui/ui/src/components/*.jsx',
    'scripts/new-release.sh',
    'scripts/check-doc-commands.sh',
    'scripts/check-doc-versions.sh',
    # NOT this file. It contains the fabricated refusal --self-test plants, so searching itself would find
    # that sentence and pass — a checker that reads its own test data cannot fail. The cost is that this
    # script's own output cannot be asserted from the docs, which is why the block quoting it in
    # docs/development.md is marked illustrative.
    'tests/e2e/run.sh',
    'tests/image/smoke.sh',
    'tests/k8s/check.sh',
    'Makefile',
]

def load_sources():
    text = []
    for pattern in SOURCE_GLOBS:
        for path in sorted(glob.glob(os.path.join(root, pattern))):
            with open(path, encoding='utf-8', errors='replace') as fh:
                text.append(fh.read())
    blob = '\n'.join(text)
    # A source builds its output out of quoted fragments, f-strings, template literals and `+`. Everything
    # that only exists to join those fragments is removed, so a sentence split across three lines collapses
    # back into the sentence the user sees.
    blob = blob.replace('\\n', ' ').replace("\\'", "'").replace('\\"', '"').replace('\\`', '`')
    blob = re.sub(r'[\'"`]', ' ', blob)
    blob = re.sub(r'\s*\+\s*', ' ', blob)
    # `${x}` is an interpolated value, not wording — but only when it IS just a value. A multi-line ternary
    # inside an interpolation carries the messages themselves, and stripping to the next `}` ate 367
    # characters of summary.js, taking two documented panel lines with it. So: short, single-line, no
    # nested braces or newlines. Anything longer keeps its text, which is where the wording lives.
    blob = re.sub(r'\$\{[^{}\n]{1,80}\}', ' ', blob)
    blob = re.sub(r'\s+', ' ', blob)
    return blob

SOURCES = load_sources()

# ── which fenced blocks are tool output ──────────────────────────────────────────────────────────────
# By what is inside them, not by their language tag: the tool's own markers. A block of shell commands has
# none of these, and neither has a JSON example.
MARKERS = ('✅', '❌', '⚠️', 'ℹ️', '▶', '╔', '║', '╚', '⛔')

# Tokens that carry a value rather than wording. A phrase is cut at every one of them.
VALUE = re.compile(r'''(
      \d                          # any digit: a rate, a duration, a byte count, a run id
    | [/\\]                       # a path
    | https?:                     # a URL
    | [<>{}]                      # a placeholder
    | %                           # a percentage
    | @                           # a pool reference or an address
    | \$                          # a shell variable
    | \.[A-Za-z]{2,}              # a hostname, a filename, a dotted profile key
)''', re.VERBOSE)

HAS_LETTER = re.compile(r'[A-Za-z]')

# Two or more spaces in printed output is a COLUMN boundary, not a sentence. The validator prints the field
# in one column and the message in the next, and the tool builds those two from different places — a phrase
# spanning the gap exists only in the rendered output and could never be found in a source.
COLUMNS = re.compile(r'\s{2,}')

# Leading noise on an output line: indentation, bullets, box drawing, the markers themselves.
LEAD = re.compile(r'^[\s·│║╔╚╝╗─═▶✅❌⚠️ℹ️⛔•\-*#>]+')

MIN_WORDS = 5
MIN_CHARS = 28
# A rendered sentence is often assembled from an interpolated value and two string fragments, so the whole
# phrase may exist nowhere in any source while every part of it does. The assertion is therefore: SOME run
# of this many consecutive words from the quoted line still exists in the source. Four words and twenty
# characters is short enough to survive interpolation and long enough that a rewritten message fails —
# which the --self-test mode exists to keep true.
WINDOW_WORDS = 4
WINDOW_CHARS = 20

def phrases(line):
    """The assertable wording in one line of quoted output: runs of >=5 value-free words."""
    text = LEAD.sub('', line)
    if not text.strip():
        return []
    out = []
    for cell in COLUMNS.split(text):
        current = []
        for token in cell.split():
            # Quoting is layout too: the docs put a message in backticks where the source has it bare.
            token = token.strip('`\'"“”')
            if not token or VALUE.search(token) or not HAS_LETTER.search(token):
                if len(current) >= MIN_WORDS:
                    out.append(' '.join(current))
                current = []
                continue
            current.append(token)
        if len(current) >= MIN_WORDS:
            out.append(' '.join(current))
    # Trailing punctuation is layout, not wording: a sentence that ends a line in the docs may continue in
    # the source, and vice versa.
    return [p.strip(' .,;:—–()[]') for p in out if len(p) >= MIN_CHARS]

def normalise(text):
    """The same shape on both sides: quoting is layout, and a source's `it's` is `it s` once the delimiters
    are gone, so the doc side has to lose its apostrophes too."""
    return re.sub(r'\s+', ' ', re.sub(r'[\'"`’]', ' ', text)).strip()

def produced(phrase):
    words = normalise(phrase).split()
    for size in range(len(words), WINDOW_WORDS - 1, -1):
        for start in range(0, len(words) - size + 1):
            window = ' '.join(words[start:start + size])
            if len(window) >= WINDOW_CHARS and window in SOURCES:
                return True
    return False

files = ['README.md'] + sorted(glob.glob(os.path.join(docs_root, 'docs', '*.md')))
if docs_root != root:
    files = [os.path.join(docs_root, 'README.md')] + sorted(glob.glob(os.path.join(docs_root, 'docs', '*.md')))

checked = marked = empty = asserted = 0
missing = []

ILLUSTRATIVE = re.compile(r'<!--\s*illustrative\b', re.IGNORECASE)

for path in files:
    if not os.path.exists(path):
        continue
    lines = open(path, encoding='utf-8').read().split('\n')
    i = 0
    while i < len(lines):
        if not lines[i].lstrip().startswith('```'):
            i += 1
            continue
        fence_line = i
        i += 1
        block = []
        while i < len(lines) and not lines[i].lstrip().startswith('```'):
            block.append(lines[i])
            i += 1
        i += 1
        body = '\n'.join(block)
        if not any(m in body for m in MARKERS):
            continue
        # The marking has to be immediately before the fence, so it cannot be inherited by a later block:
        # skip blank lines, and read back through one HTML comment only. A fixed three-line window looked
        # simpler and silently ignored a four-line comment — this one.
        j = fence_line - 1
        while j >= 0 and not lines[j].strip():
            j -= 1
        comment = []
        if j >= 0 and lines[j].strip().endswith('-->'):
            while j >= 0:
                comment.append(lines[j].strip())
                if lines[j].strip().startswith('<!--'):
                    break
                j -= 1
        if ILLUSTRATIVE.search(' '.join(reversed(comment))):
            marked += 1
            rel = os.path.relpath(path, docs_root)
            print(f'  ⚑ {rel}:{fence_line + 1} marked illustrative — not asserted')
            continue
        checked += 1
        found_any = False
        for offset, line in enumerate(block):
            for phrase in phrases(line):
                found_any = True
                asserted += 1
                if not produced(phrase):
                    missing.append((os.path.relpath(path, docs_root), fence_line + 2 + offset, phrase))
        if not found_any:
            empty += 1

if missing:
    print('❌ quoted output the tool no longer produces:')
    for path, line, phrase in missing:
        print(f'    {path}:{line}')
        print(f'      “{phrase}”')
    print('')
    print('  Either the message changed and the documentation still shows the old one, or the block is')
    print('  illustrative rather than quoted. Fix the quote, or mark the block:')
    print('      <!-- illustrative: hand-written example, not the tool\'s output -->')
    print('  Numbers are never asserted; only the wording is.')
    sys.exit(1)

print(f'✅ {asserted} quoted phrases in {checked} output blocks are still produced by the tool '
      f'({marked} marked illustrative, {empty} with no assertable wording)')
PY
}

case "$MODE" in
  check)
    run_check "$ROOT"
    ;;
  --self-test)
    # A checker nobody has watched fail is a checker nobody knows the shape of. This plants a refusal the
    # tool has never printed — in a COPY of the docs, so the real ones are untouched — and asserts it is
    # caught, naming the file and the line.
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    mkdir -p "$tmp/docs"
    cp "$ROOT/README.md" "$tmp/README.md"
    cp "$ROOT"/docs/*.md "$tmp/docs/"
    cat >> "$tmp/docs/cli.md" <<'PLANT'

## A block that was never printed

```
▶ validating my-site.json
  ❌ safety.allow_hosts  this profile has not been approved by the platform team, please raise a ticket
  1 error · 0 warnings
```
PLANT
    printf '▶ self-test: a fabricated refusal must be caught\n'
    if run_check "$tmp" > "$tmp/out" 2>&1; then
      cat "$tmp/out"
      printf '❌ the checker passed a quote the tool has never produced: it cannot fail, so it proves nothing\n'
      exit 1
    fi
    if ! grep -q 'approved by the platform team' "$tmp/out"; then
      cat "$tmp/out"
      printf '❌ the checker failed, but not on the planted quote — it is failing for another reason\n'
      exit 1
    fi
    grep -E 'docs/cli.md:[0-9]+' "$tmp/out" | head -2 | sed 's/^/    /'
    printf '✅ the checker catches a quote the tool does not produce, and names the file and line\n'
    printf '\n▶ and the real documentation:\n'
    run_check "$ROOT"
    ;;
  *)
    printf 'usage: check-doc-output.sh [--self-test]\n' >&2
    exit 2
    ;;
esac
