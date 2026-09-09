# Changelog

All notable changes to crowdsim are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.39.0] — 2026-09-09

**The page could hand over one run drawn, and neither the trend nor the delta**
([#90](https://github.com/HiWay-Media/crowdsim/issues/90)). `history --html` and `compare a b --html`
shipped in 1.38.0; `gui/server/lib/app.js` built exactly one drawn-page argv, `['report', runId,
'--html']`. So the GUI plotted the archive, knew which runs were comparable, and could hand over neither
of the two pages that say what the archive means.

That was the fourth recurrence of one shape: #53 was two flags the CLI had and the page did not, #78 was
six summary blocks, #79 was six flags. Every one of them was the page tracking the CLI by hand, and the
two that stopped recurring are the two that got a test.

### Added
- **The archive hands over the trend**: `GET /api/history/trend`, and a **Trend over time (drawn)** button
  above the run list. The filters `history` itself accepts (`last`, `target`, `profile`) are forwarded, so
  the page and the table cannot become two answers to one question.
- **A comparison hands over the delta**: `GET /api/compare/page?a=&b=`, and a **Delta, drawn** button. When
  `compare` refuses the pair the endpoint answers **422 with `compare`'s own text** rather than drawing two
  different experiments on one pair of axes.
- Both are **spawned, not re-rendered** — the CLI draws the page and the server sends the bytes, exactly
  as the run report already worked. A renderer here would be a second opinion about what a run means, and
  the first time the two disagreed the wrong one would be on screen while somebody decided something.
- Both **open in a new tab** rather than downloading. The run report is a file because it goes into a
  ticket; *does the knee move* is a question somebody asks on screen while deciding.
- **Neither is offered when there is nothing to draw, and the page says why** rather than hiding a control
  (`gui/ui/src/lib/drawn.js`): one run is not a trend — through a single point it is a straight line,
  which is the knee's own refusal from one completed step — and a comparison `compare` refused gets no
  drawing.
- **A fourth drawn page cannot appear unnoticed.** `gui/server/lib/drawn-pages.js` declares the set
  exhaustively, with a reason for anything deliberately not offered, and
  `tests/gui/drawn-pages.test.js` asks `bin/crowdsim` which subcommands declare `--html`. A page in
  neither table fails the suite; so does a declared route the server does not serve, and a declared page
  the CLI no longer draws.

### Changed
- The two argv builders live in `gui/server/lib/args.js` with the others, because the filters arrive from
  a URL and end up in an argv: `last` is an integer in range, `target` and `profile` are matched against a
  charset and refused if they start with a dash — a value that starts with one becomes a flag rather than
  an argument. `latest` and `previous` are refused for the delta: the page is showing the archive and
  already knows which two runs it means, so a selector there could let the page and the file it hands over
  name different runs.
- `tests/cli/flags.bats` attributes each flag in `args.js` to **the subcommand whose builder emits it**.
  It used to assume they all belonged to `load`, with `--limit` hand-excepted as discover's — a claim
  about the code's shape that held while `args.js` built one argv and broke the moment it built five. It
  now reads the subcommand each builder starts its array with, and the hand-coded exception is gone.

## [1.38.1] — 2026-09-09

### Added
- **Tagging a release now requires that the image has built** ([#89](https://github.com/HiWay-Media/crowdsim/issues/89)).
  1.36.0 and 1.37.0 were tagged with a Dockerfile that could not build — the `ui` stage did not copy a
  file the UI imports — and published **no image at all**. `make lint`, `make test` and `make test-e2e`
  were green, because none of them builds the image, and `new-release.sh tag` did not ask. The only gate
  was remembering `make image-smoke`, which this repository requires and which was skipped.

  `make image-smoke` now records a receipt in `.git/crowdsim-image-smoke`, fingerprinting the files that
  end up in the image, and `tag` refuses unless the receipt matches the tree it is about to tag:

  ```
  ❌ the image has not been smoke-tested for this tree.

    Run it, then tag:
        make image-smoke
  ```

  Three deliberate properties:

  - **Nothing is built at tag time.** It verifies a run that already happened, so it costs a second and
    not five minutes — which is why the full smoke test can be the gate rather than a bare `docker build`.
  - **What counts as image-relevant is not written down twice.** `scripts/image-fingerprint.sh` reads the
    `paths:` filters in `.github/workflows/image.yml`, the list that already decides whether CI builds.
    A second copy would leave the gate blind to a path added to the workflow — the shape of the bug it
    exists to catch.
  - **The receipt lives in `.git/`.** At the repo root it made the tree dirty, and `tag` refuses a dirty
    tree, so recording a receipt blocked the command it exists to unblock. In `.git/` it needs no
    `.gitignore` entry and cannot reach a clone.

  Prose does not invalidate it; `prepare` does, because the version is baked into the image and the smoke
  test asserts the image reports it. So the honest order is **prepare → CHANGELOG → commit → image-smoke
  → tag**, and `docs/development.md` now has a table of which gate runs when — the previous answer being
  *the ones you remember*.

  `tag --no-image` cuts a release without the gate on a machine that cannot build the image, and says so
  every time. A command-line flag and never an environment variable, the same shape as the safe-peak
  override: a gate somebody forgot they disabled is worse than none. When docker is missing the refusal
  names the flag itself.

### Fixed
- Two defects in the fingerprint, both found by running it rather than reading it, and both of the kind
  that fail *open*:
  - it hashed **nothing**. `python3 - <<'PY'` takes its program from stdin, so piping the file list into
    that heredoc delivered an empty stream and the fingerprint came out as the sha256 of the empty
    string — a value that matches every tree, i.e. a gate that always passes. This repository had already
    been caught by that heredoc once, in `crowdsim init`.
  - it depended on the **current directory**. The file names are repo-relative and were opened as such,
    so running it from anywhere but the repo root hashed a different repository's files. Now joined to
    the repo root, and asserted identical from three directories.

## [1.38.0] — 2026-09-08

Milestone v1.17.0, closed. The two commands that read the **archive** rather than one run had no drawn
form, so the two claims this tool is most confident about could not be attached to anything.

### Added
- **`crowdsim history --html`** ([#87](https://github.com/HiWay-Media/crowdsim/issues/87)): the knee over
  time. *Does the knee move* is the only question this subcommand exists to answer, and it answered it as
  a table — the GUI plotted it, `report --html` draws exactly one run, and there was nothing to hand over.
  The trend is the only claim here that survives its own caveat about absolutes being optimistic, and it
  was the one thing that could not go in a ticket.

  **One line per experiment.** Runs at a different profile, target, shape or fan-out are separated rather
  than averaged, because they are not points on one line; the fan-out rule is `comparableFanOut` from
  `k6/lib/delivery.js` and not a second copy. A discard never joins a line and is listed under *Left out,
  and why*, with its run id. A run whose knee was refused is a **gap**, not a zero — a knee of 0 req/s
  would be a claim about the system. And **one run is not a trend**: the page says so instead of drawing a
  line through a single point, which is the same refusal that stops a knee being read off one step.

  The records go through the same `--json` view the table is built from, so the page and the terminal
  cannot disagree about what a run was.
- **`crowdsim compare a b --html`** ([#88](https://github.com/HiWay-Media/crowdsim/issues/88)): the delta,
  drawn **as a delta** — the bar is the change, centred on zero, left better and right worse. Two absolute
  bars would leave the reader subtracting by eye, and that subtraction is the one number this tool is
  confident about: the absolutes come from a synthetic pool of cold URLs and travel badly.

  It is drawn from what `compare --json` prints, which is what makes it allowable at all. `report --html`
  declines to draw two runs and is right for the reason it gives — *two runs on one pair of axes without
  compare's refusals is a picture of two different experiments* — and this page has those refusals
  because it has no second opinion to have: **a refusal stops the drawing**, and adding one to `compare`
  cannot leave the picture behind. That refusal message now points here instead of implying no drawn
  comparison exists.
- Both pages reuse the run report's shell, stylesheet and geometry (`page()`, `W`/`H`/`PAD`, now
  exported), so a second page cannot drift from the first on what *self-contained* means. And
  `tests/image/smoke.sh` asserts both load inside the image: they import across directories, which is the
  shape that broke 1.20.0.

### Fixed
- **No image published for 1.36.0 or 1.37.0: the UI build stage lacked the one file the UI imports from
  outside itself.** `gui/ui/src/lib/summary-blocks.js` imports `outcomeBands` from `k6/lib/failure.js`,
  so the page and the drawn report share **one** band arithmetic rather than two that can disagree — the
  right call, and it costs a line in the Dockerfile that was not there. The `ui` stage copied only
  `gui/ui/`, so `vite build` inside the image failed with:

  ```
  Could not resolve "../../../../k6/lib/failure.js" from "src/lib/summary-blocks.js"
  ```

  A checkout has the whole repository, so `make lint`, `make test` and the UI tests all passed. The only
  thing that could catch it was building the image — and the image build is not part of `make test`, so
  the image workflow went red on a release, twice, while everything local was green.

- **A guard inside `make test`**: `tests/gui/ui-build-inputs.test.js` reads the UI's imports that resolve
  outside `gui/ui/` and the paths the Dockerfile's `ui` stage copies, and asserts they agree. It cannot
  prove the image builds — `make image-smoke` does that, and it is the gate this change skipped — but it
  fails in a second on the mistake that actually happened. A second assertion keeps the list of escaping
  imports explicit, so reaching out of the UI stays a deliberate decision.

  The same class of mistake on the server side is already covered: `gui/server` imports
  `lib/validate.mjs`, the runtime stage copies `lib/`, and the smoke test asserts it loads. The
  difference is that the UI is **bundled at build time** and the server runs from source at runtime, so
  they need their imports in two different stages.

## [1.37.0] — 2026-09-08

**A server-side series was a table, and the overlay it exists for was done by eye.** `--server-metrics`
(1.31.0) aligns a handed-in series to the run's own steps — reading it *against* latency is the entire
reason for aligning it — and reported it as mean and max per step, so doing that meant putting two tables
side by side and comparing rows.

### Added
- **`seriesChart()`** ([#86](https://github.com/HiWay-Media/crowdsim/issues/86)): the series on the
  ramp's own step axis, with p95 beside it, in `report --html`. The artefact is read from beside the
  summary rather than passed as a flag — the driver already wrote it there, and a report should not need
  to be told what its own run produced.

  Four things it must not do, and does not:

  - **Two scales, both named.** The series keeps its own units and its own axis; one shared axis would
    make two different quantities look like one.
  - **No trend line through both, and no smoothing.** The shape is the shape that was recorded.
  - **A step with no samples is a gap** — the line breaks into segments rather than spanning a window
    nobody recorded, which would draw data that does not exist. Asserted by counting the segments.
  - **The caveat is on the chart**, not only in the prose above it: a chart travels further than the
    paragraph next to it, and the word is *correlation*. A unit test asserts the SVG contains none of
    *caused*, *because*, *explains* or *due to*.

  On an invalid run the series is drawn **without** the latency line, for the same reason the failure mode
  is still shown there: a counter that rose is not a latency claim, while latency from a run that did not
  deliver its rate describes the generator or the target rather than the system.

## [1.36.0] — 2026-09-08

**«Concentrated on 2 of 5 classes» was prose next to a chart of something else.** That claim is the whole
distinction the failure-mode line makes — the same code on some classes and not others points at a pool or
a route, spread evenly it points at the system — and it is exactly what a chart is for. `classChart` drew
p95, so a run serving 474 × 404 on two classes drew a perfectly healthy set of bars.

### Added
- **`outcomeChart()`**: one stacked bar per class, split by outcome, in `report --html`
  ([#85](https://github.com/HiWay-Media/crowdsim/issues/85)) — and the same rows on the GUI's result
  card. Three rules that are not decoration:

  - **A class with no requests is absent**, not a band of width zero. A zero bar reads as a class that
    was fine; a class that never ran is a different statement, and this project has been caught by that
    conversion more than once.
  - **`cs_5xx` counts the 502s and 504s too**, so the bands are 504, 502 and *other* 5xx. Stacking the
    raw counters would draw more failures than the class had, and a stack past its own total is a chart
    nobody can read.
  - **Counts, never shares recomputed at the drawing site.** `failure_mode.share` and these bands come
    from the same numbers, or they disagree on one page.

  A run where nothing failed gets no chart at all: six full-width bars say nothing the p95 chart does not
  already say better. Every band carries a CSS class and a `<title>`, and the failure bands are hatched
  as well as coloured — the page's whole point is that it travels, and it gets printed.
- **`outcomeBands()` lives in `k6/lib/failure.js`**, next to the code list, and *both* renderers import
  it — the drawn report and the browser bundle. Two copies of "cs_5xx is the superset" is the duplication
  this project keeps paying for, and the page and the report end up side by side in the same
  conversation.
- **`tests/image/smoke.sh` asserts `lib/report-html.mjs` loads inside the image.** That file now imports
  `../k6/lib/failure.js` — a cross-directory import in a file the image ships, which is exactly the shape
  that broke 1.20.0 (`lib/validate.mjs` → `k6/lib/auth.js`, ESM in a checkout and CommonJS in the
  container). Asserted by name rather than assumed.

## [1.35.0] — 2026-09-08

The first two of milestone v1.17.0, both the same shape: **a chart is a worse place to be wrong than a
sentence.** A wrong scale does not throw — it draws something convincing.

### Fixed
- **The knee plot's axis now says which rate it is drawing**
  ([#83](https://github.com/HiWay-Media/crowdsim/issues/83)). This was the unmet half of
  [#78](https://github.com/HiWay-Media/crowdsim/issues/78), which was closed with it unmet: that issue's
  acceptance asked for it and 1.34.0 delivered the banners without touching the plot. `stepCurve()` mapped
  `requested_rps` onto an unlabelled axis, so on a mix with a fan-out of 1.25 the page showed a knee at 60
  while the target was taking 76 — the wrong answer 1.29.0 removed from the text, moved onto the chart.

  `rateAxis()` names the rate and, in the axis title, gives the pair and the fan-out. The curve carries
  both rates per point, so a step's tooltip reads *20 req/s requested → 25 delivered*. A run whose
  delivered rate was **refused** says so rather than falling back to the requested rate wearing the
  delivered label, and the knee badge's title carries the delivered pair when the run has one — derived
  from the knee, not read out of the summary sentence, which is what an earlier version of the test
  accidentally asserted.
- **The drawn report says which kind of invalid a run is**
  ([#84](https://github.com/HiWay-Media/crowdsim/issues/84)). `report --html` rendered no
  `drop_diagnosis`, so since 1.32.0 the artefact most likely to be attached to a ticket still opened with
  *DISCARD THIS RUN* for a target that had simply saturated — the advice 1.32.0 exists to correct. A
  saturated target is now drawn as a finding, a starved generator as a discard, and the
  no-latency-charts rule is unchanged either way: a rate that was not delivered was not measured.
- **`What answered, and with what`**: the status codes per class, and across the run. p95 per class was
  the only thing a class did on that page, so a run serving 474 × 404 on two classes drew a perfectly
  healthy set of bars. Shown on an invalid run too — a 404 does not become untrue because the rate was
  not delivered. A counter of zero is drawn as `0`, not as *n/a*: unlike a latency, zero is a real answer
  for a counter.

### Added
- **A drift guard for the drawn report**, symmetric with the GUI's. `lib/report-html.mjs` exports `DRAWN`
  and `DELIBERATELY_NOT_DRAWN`, each omission with its reason, and a unit test asks **`buildSummary`
  itself** for its keys and fails on a block belonging to neither. The GUI accumulated six unrendered
  blocks because nothing noticed and got a guard in 1.34.0; this page was left without one and was
  already missing `drop_diagnosis` by then. Seven blocks stay off it on purpose — `concurrency` and
  `think_time` (journey-only numbers, not shapes), `allocation` and `mix_target` (one arithmetic, one
  picture), `signup` and `auth` (they name real accounts), `server_side` (its own chart, in #86), and
  `rsc_mode` (an input, not a measurement).

## [1.34.0] — 2026-09-08

Milestone v1.16.0, closed. **The page rendered `knee` and nothing else that had been added to the summary
since 1.21.0.** Six blocks had accumulated — `concurrency`, `think_time`, `allocation`, `failure_mode`,
`delivery`, `server_side` — because nothing noticed, and the `failure_mode` one meant #74's wrong answer
was still live in the place most people look: a run that *completed without crossing its thresholds*
while serving 32% 404s on one class read as a pass.

### Added
- **The result view shows what the summary says** ([#78](https://github.com/HiWay-Media/crowdsim/issues/78)):
  the failure mode **first**, then why the rate was not held (the generator — discard — or the target — a
  finding), then requested → delivered with its fan-out, then the knee. The sentences are the summary's
  own: the panel, the markdown report, the HTML page and the card all quote one verdict rather than each
  rebuilding it, because four renderings are four chances to disagree while somebody decides something.
- **A drift guard.** `gui/ui/src/lib/summary-blocks.js` holds two exhaustive lists — what the page
  renders, and what it deliberately does not, each with the reason — and
  `tests/ui/summary-blocks.test.js` fails when a block belongs to neither. It asks **`buildSummary`
  itself**, not a stored fixture: a fixture is a snapshot of what the summary looked like when somebody
  last updated it, and this drift is exactly what a stale snapshot cannot see. Verified by dropping a
  block from the list and watching the test name it.

  Six blocks stay off the page on purpose: `concurrency` and `think_time` are journey-shape only and the
  page cannot launch a journey run; `allocation` duplicates the `mix_target` table already rendered;
  `signup` names real accounts and belongs in `out/`; `auth` needs a credentials file the page cannot
  express; `server_side` is its own artefact. A block left out on purpose is a decision — one left out
  because nobody looked is the bug.
- **The six flags of 1.30.0 and 1.31.0 are expressible from the page**
  ([#79](https://github.com/HiWay-Media/crowdsim/issues/79)), which is the same complaint as #53 when it
  was two. Two of them are not ordinary form fields: either starts a **further run**, so the page says
  so — and only when one is on. The wording is in `lib/messages.js` with the safe-peak text, because it
  cannot be softened:

  > Either of these can start a FURTHER run when this one finishes. Each attempt is its own run with its
  > own id and history row, and goes through both gates again — the safe-peak override is never inherited.

  The two checkboxes are mutually exclusive because the driver takes the first: a page that let both be
  ticked would describe a run that does not happen. `args.js` keeps its allowlist shape — no `extraArgs`,
  no shell — and refuses a floor without a recalibration, a hold without a certification, and a label
  without a series.
- **The series field is a path, never a URL.** crowdsim does not fetch server-side metrics, so there is
  nothing to point at a backend; the field takes a **relative** path under the server's working
  directory, with no absolute root and no `..`, because a form field that could name any file on the
  server is a file-read primitive with a text box in front of it. The label must look like a metric name,
  since it is rendered.

### Fixed
- **`check-no-attribution.sh` failed on its own denylist.** 1.33.1 shipped a check that passed while the
  list was untracked and failed the first time it ran after being committed — the list necessarily
  contains the names it forbids. It is now excluded from its own search, and
  `CROWDSIM_ATTRIBUTION_DENYLIST` points the check at a file in a private repository for anyone who
  would rather the list not live here at all (a missing list skips, it does not fail).

## [1.33.1] — 2026-09-08

### Fixed
- **The e2e suite's first leg failed about one run in six**, with *a completed run reported a partial
  step*. The cause was not the cold container it looked like: `partial` was `ranMs < step.endMs` with no
  tolerance, so a run that finished a few tens of milliseconds before its planned total — k6's graceful
  stop, or plain rounding — marked its **last step** a fraction of itself. Nothing was wrong with those
  runs; a boundary of milliseconds was deciding whether a step counts as a measurement.

  `PARTIAL_TOLERANCE_MS` is one second: orders of magnitude below any step this tool runs and orders
  above that jitter. The case the flag exists for — the brake firing mid-step — is never within a second
  of a step's end, and a test asserts both directions. A suite that fails one run in six teaches people
  to ignore red, which 1.24.0 had just finished addressing from the other end.

### Changed
- **A customer name and its capacity figures are no longer in this repository.** The name of the campaign
  this tool was built against appeared in six tracked files, and from there in published release notes
  and two issue bodies, next to the concurrent-user requirement, the rate a tier stayed clean past and
  the number of accounts a run created in somebody's identity provider. Together those describe a named
  third party's capacity, which nobody agreed to publish.

  **Every measured number stays** — they are the evidence for the invariants those comments defend, and
  losing them would make the code less defensible rather than more private. What went is the
  attribution. The two issue bodies are edited; git history is not rewritten, because rewriting tags
  that are already pulled buys little and breaks every checkout.

  `CLAUDE.md` and `AGENTS.md` now say explicitly that a customer, campaign or tenant **name** counts as
  infrastructure data. It got through because the rule enumerated hostnames and paths and a name is
  neither. `scripts/check-no-attribution.sh` (in `make check-docs`) keeps it out, with the list in
  `scripts/attribution-denylist.txt` — verified by reintroducing the name and watching it fail.

## [1.33.0] — 2026-09-08

**`probe` requested `pools.pages[0]` and assumed the other 399.** That is the trap this tool documents
everywhere else — *404s do not load the app tier, so a pool of invented paths yields a false "it handles
this beautifully"* — surviving inside the one command whose entire job is to catch it before a run.
`discover --verify` does request every path it builds, but only for pools it built itself: a pool written
by hand, edited, or narrowed later never went through it, and the 1.29.0 failure-mode line only catches
it *after* the window.

### Added
- **`--pool-sample <n>`** (default **5**): how many URLs per pool `probe` checks. A **sample**, never the
  whole pool, and **spread across it** rather than the first n — the first entries of a sitemap-derived
  pool are the shallowest pages, which are also the most likely to exist. Paced by
  `CROWDSIM_VERIFY_DELAY`, the same knob discovery uses, because a preflight must not become the load
  test. Only pools a class actually draws from are checked.

  A pool where more than half the sample is unserved exits **4**; below half it warns and says the real
  share may be higher, because this is a sample and not a census.
- **The premise check samples too.** One endpoint answering 401 does not establish that the other 399
  require the token, so `authedTargets()` takes the same sample and one public path among several now
  refuses the class instead of being invisible behind a verified first entry.

### Fixed
Two defects found by running this against a real target, both introduced by the change itself:

- **A 401 is not a broken path.** Counting only 2xx/3xx as served reported a correctly configured
  `authed` pool as mostly-404 and made `probe` exit **4 on a healthy profile** — a false refusal, which
  for this tool is the worst direction to fail in. A 401/403 means the route exists and wants a token;
  whether it *should* is the premise check's question, a few lines further down the same output.
- **The pool check killed the rest of the probe.** Its python exits 4 to signal a broken pool, and under
  `set -eo pipefail` that took down the subshell the whole probe body runs in — so the authed-premise
  section simply never ran. Wrapped in `|| rc=$?`, the same way the k6 invocation is, and for the same
  reason.

### Changed
- The two samplers now pick the same indices. Python's `round()` rounds 2.5 down and JavaScript's
  `Math.round` rounds it up, so `probe` was checking one set of URLs and the premise check another for
  the same pool.

## [1.32.0] — 2026-09-08

**`generator_ok: false` covered two opposite causes, and it is the verdict that decides whether a window
was wasted.** `generatorHeldRate()` is one line — `dropped_iterations > 2% of requests` — and k6 drops an
iteration when no virtual user is free to start it. That happens both when the generator is starved *and*
when every VU is blocked on a target that stopped keeping up. The tool reported both as *THE GENERATOR DID
NOT HOLD THE RATE — discard this run* and told the operator to move the generator closer to the target.

Measured, while building the follow-up runs of 1.30.0: a run at 12 req/s against a single-worker origin
with a 300 ms delay — a target that cannot serve 12 req/s by construction — said exactly that, on a
completely healthy generator. The advice was wrong and the run was the answer. It is the first line of
[reading a result](docs/reading-results.md), and it voids the knee, the concurrency figure, the delivered
rate and `compare`.

### Added
- **`summary.drop_diagnosis`** (`k6/lib/validity.js`): which of the two, from evidence the run already
  records. A starved generator leaves the target answering promptly with VUs to spare; a saturated target
  has every VU in flight and latency climbing. Either signal is enough for the `target` verdict — a queue
  is a queue whether or not it has crossed a threshold somebody wrote down.

  | verdict | meaning | discard? |
  |---|---|---|
  | `generator` | starved on this side of the wire | yes |
  | `target` | the target could not absorb the rate | **no — that is the finding** |
  | `unreachable` | connectivity, not capacity | yes |
  | `unknown` | the run does not record enough to tell | yes, the safe direction |

  **`generator_ok` keeps its meaning exactly** — the generator did not deliver the requested rate, true
  either way — because `history.tsv`, the GUI and `compare` all read it. What changed is the diagnosis
  and everything that follows from it.
- **Every scenario's VU ceiling is summed** (`VU_CEILING_TOTAL`), which is what makes *every VU was in
  flight and we were still dropping* observable in `mix` shape; and the driver passes its own
  container-inside-a-VM detection to the generator, because the driver can see `/.dockerenv` and the
  host kernel and the k6 runtime cannot. It changes the **advice** on a `generator` verdict, never the
  verdict.
- **e2e leg 2b**: a rate the target cannot absorb, asserted not to be reported as a starved generator —
  including that the knee, the delivered rate and the panel agree with each other. Nothing else in the
  suite can prove it, because it needs a target that saturates for real.

### Changed
- **The whole screen tells one story.** The panel said *the TARGET could not absorb it* while the knee
  said *the generator did not hold the requested rate* and the delivered rate said *what arrived measures
  the generator* — three sentences from one fact, two of them wrong. `knee()` and `delivery()` now take
  the diagnosis: both still refuse, and neither blames the generator for a target that saturated.
- **`--recalibrate` accepts a saturated target.** That was the one retry worth doing, and 1.30.0 refused
  it along with the starved generator, because a knee refused for `generator_ok` said only the first half.
  Verified end to end: 12 → 6 → 3, three archived runs.
- `docs/reading-results.md` step 1 is rewritten around the two answers rather than around one.
- The e2e GUI assertions derive the expected run count from the archive instead of a literal `3`, which
  broke the moment a leg was added and said nothing about the GUI.

## [1.31.1] — 2026-09-08

### Fixed
- **A rounding-error 502 outranked 474 real 404s in the failure-mode headline.** The codes are ranked
  most-specific-first so that a 504 is not swallowed by the `cs_5xx` counter that also counts it — and
  1.29.0 applied that ranking *unconditionally*, so two 502s out of 21,299 requests (0.01%) took the
  headline from a 2.2% 404 concentration in the same run. That is the bug the line exists to prevent,
  arrived at from the other side: the headline named the rounding error and buried the finding.

  Specificity now decides only between codes that are **both material**. Among the codes that clear the
  0.5% headline floor, the most specific wins; if none of them clears it — which only happens on an
  aborted run, where any failure is material by definition — the largest does. Magnitude gates the
  choice, specificity orders it.
- A test in `tests/unit/failure.test.js` was named the opposite of what it asserted (*"a material 404
  outranks a material-but-less-common 504"* while asserting `504`). The assertion was right; in a suite
  where the test names are the documentation, a name that lies is worse than a missing test.

## [1.31.0] — 2026-09-08

Milestone v1.15.0, closed. **crowdsim describes the symptom perfectly and could say nothing about the
cause.** Every number it produces is measured from outside — latency, failed rate, cache hit ratio, the
knee — which is the right place to measure what users experience and the wrong place to answer *why*. A
run ended with a defensible knee and no way to tell a saturated app tier from a CPU quota being throttled,
and those have different fixes: one is a rewrite, the other is one line of configuration.

### The scope decision, made first
[#75](https://github.com/HiWay-Media/crowdsim/issues/75) was written as unimplementable until this was
answered, because there were two answers and one of them is a different tool: **crowdsim is handed a
series; it does not go and collect one.** That is now a non-goal in `INTENT.md`, next to the identical
decision about the access log — collecting would mean a load generator holding credentials for a metrics
backend or a cluster. Nothing in `lib/server-metrics-cli.mjs` speaks HTTP, and a test asserts it.

### Added
- **`--server-metrics <file> --server-metrics-label <name>`**: a server-side series, aligned to the run's
  own steps, so the step where latency climbed can be read against what the server was doing in it.

  ```
    ── cpu_throttled_periods, per step (handed to this run, not collected) ──
       step  requested  samples  mean      max
       s1            7        7         0        0
       s2            9        7      1.14        8
       s3           12        7        32       56
       peak         12        5        72       88
  ```

  Written to `out/server-side-<run>.json` and included in `crowdsim report`. Accepts a two-column
  CSV/TSV or a JSON array, with timestamps in epoch seconds **or** milliseconds — decided by magnitude
  rather than guessed, because guessing aligns a series to the wrong century. A header row is skipped
  rather than parsed as a sample.

  **What comes out is a correlation, said as a correlation.** A counter that rose during the same minutes
  is a reason to look, not a finding; promoting it to a cause would be the same mistake as quoting a knee
  as an absolute. A unit test asserts the caveat contains none of *caused*, *because*, *explains* or
  *due to*.

  The refusals, none of which fail a run that already happened: no label (an unnamed column cannot be read
  against anything), no overlap with the run's window (reported as such rather than as a table of zeroes
  that reads like an idle server), a missing or unparseable file, and no node. And **a step with no
  samples is absent, not zero** — zero is a measurement, *nobody recorded anything here* is a different
  statement.
- **Every per-step row carries its own window** (`start_ms`, `end_ms`). A run id *is* the run's start in
  UTC, so those two fields are what let anything recorded with a clock line up with the step it belongs
  to. A partial step ends where the **run** ended, not where its window would have: averaging a series
  over seconds the run never reached would describe a window that did not happen.

### Changed
- `tests/cli/fixtures/summary-good.json` has the two-step ramp its knee always implied. It had no
  `per_step` at all, which no test had needed until a series had to align to one.

## [1.30.0] — 2026-09-08

Milestone v1.14.0, closed. Two runs in six on one campaign were thrown away because `--start` was already
past capacity, and a third existed only to certify a knee the sweep had found. Both were decisions the
tool had already made and then handed back as a sentence to act on by hand.

These are the only flags under which crowdsim generates load nobody typed a command for, so both are
**off by default** and both refuse far more often than they agree.

### Added
- **`--recalibrate`** ([#72](https://github.com/HiWay-Media/crowdsim/issues/72)). When the ramp's first
  step does not survive, the run measured nothing — no curve, and the tool already refuses to name a knee
  from it — so its whole output was *lower `--start` until the first step survives*. It now does that
  itself, up to three attempts, halving each time and **keeping the ramp's shape** (`--peak` comes down
  with `--start`, or the second step would be past capacity instead of the first). `--recalibrate-floor`
  is where it gives up; if the system cannot serve the floor, that is the finding.

  It refuses whenever the failure is not capacity: a generator-bound run, an unreachable target, steps
  shorter than `--abort-delay`, a run that *did* complete a step — and a run whose failures are **404s**,
  where the pool names paths the target does not serve and the same run at half the rate produces the
  same result.
- **`--certify`** ([#73](https://github.com/HiWay-Media/crowdsim/issues/73)). A knee found while climbing
  was *swept* through, not held. Certifying it is one run at that rate with a `--hold`
  (`--certify-hold`, default 60s), as a **separate run** — a swept number and a sustained one must never
  end up under one label. It refuses a refused knee (a hold there would produce a clean sustained number
  for a rate the run never established), a knee that was already sustained, a run with a transient
  crossing (that is a cold cache: `--warmup` first), and a rate above the safe peak.

**What makes this safe is the re-entry.** A follow-up run is this same driver invoked again with two
numbers changed, so both gates are re-checked *by construction* rather than by remembering to:

- **`--i-know-this-breaks-production` does not carry over.** Sweeping past the ceiling is a decision taken
  once on a command line; holding that rate for minutes is a larger authorisation than passing through it.
  A sweep with the override followed by `--certify` gets the sweep and refuses the hold — asserted.
- **Every attempt is its own run**, with its own id, summary, log and `history.tsv` row. The attempt that
  failed is kept: the fact that its `--start` was too high is itself a capacity finding.
- **Every other flag is forwarded verbatim.** The follow-up filters the original command line rather than
  rebuilding one from resolved state, because a flag this code did not think about would otherwise be
  dropped in silence — and a run that is not the run somebody asked for is the class of wrong answer this
  tool exists to avoid.
- One hold, not a chain: a certification does not certify itself.

The two policies are pure and unit tested (`k6/lib/recalibrate.js`, `k6/lib/certify.js`) because they
decide whether this tool generates traffic; the driver only acts on the one line
`lib/followup-cli.mjs` prints. Both need node — without it the run is still archived and the follow-up is
not attempted, with a line saying so.

### Fixed
- **Two runs that started in the same second shared a run id**, and the second overwrote the first's
  summary, log and history row. Rare with a real ramp, which takes minutes — and *certain* with
  `--recalibrate`, where the follow-up starts the instant the sweep ends, which is exactly where the
  overwritten run is the evidence. Found by a test that expected two summaries and found one. The id
  format is load-bearing (the GUI matches `^\d{8}T\d{6}Z$`, so do the completions), so the driver waits
  for the next second instead of changing its shape — bounded, so a frozen clock cannot become a hang.

## [1.29.0] — 2026-09-08

Two of the four items of milestone v1.14.0, both from the same six-run campaign, and both the same shape
of complaint: **the report was true and pointed at the wrong thing.**

### Added
- **The knee names the rate that was DELIVERED as well as the rate that was requested**
  ([#71](https://github.com/HiWay-Media/crowdsim/issues/71)). `--peak` is the total *user* requests per
  second, on purpose, and one user request in the mix fans out into several HTTP requests — so the rate
  the target actually had to survive is a larger number. On the campaign this came from, 60 requested
  arrived as roughly 76 delivered, consistently enough that every report was translated by hand before it
  could be quoted. A knee quoted as 60 when the system fell over at 76 is not conservative: it is wrong
  in the direction that gets capacity bought.

  Both rates now appear everywhere the knee does — the panel, `summary.delivery`, `report`,
  `report --html`, `history.tsv` (four columns, rendered as one `requested→delivered` cell in the default
  view) and the GUI's history records. The delivered rate is **measured** (`http_reqs` over that step's
  own window), never `requested × fan_out`: deriving it would make the fan-out an assumption dressed as a
  measurement.

  Three things this refuses, each found by running it rather than by reading it:

  - **A ratio below one is not a fan-out.** A fan-out is HTTP requests *per* user request and cannot be
    under one; fewer arriving than were asked for means the target did not keep up. The first version
    printed *fan-out 0.77x* for a perfectly healthy generator against a slow origin.
  - **The ratio is measured on the same rows the quoted pair comes from.** Reading the pair off the hold
    while aggregating the ratio over every step, climbing ones included, produced *"12 requested → 12
    arrived (fewer arrived than asked for)"* — a line contradicting itself. A hold is where a rate is
    actually held, so that is what the ratio describes when the ramp has one.
  - **The pair is the one the knee quotes.** A ramp with a hold has two complete rows at the top rate;
    picking the climbing one made the panel say *12 → 11* while the knee said *12 → 12*. Two numbers for
    one thing in one output is the disagreement this project refuses everywhere else.

  And the fan-out is a property of the **mix**, not of the run: `compare` now refuses two runs whose
  fan-out differs by more than 10%, for the same reason it already refuses two different URL pools. A run
  archived without one is *unknown* rather than *the same* — a warning, not a silent match.
- **A failure-mode line, before the brake's own reason**
  ([#74](https://github.com/HiWay-Media/crowdsim/issues/74)). One report opened with *ABORTED by the
  brake — stopped by class html p95* while the news was **6.31% 404s concentrated on the frontend classes
  alone**. Both sentences were true — a class answering 404 at volume drags a p95 up with it — and the
  headline sent its reader looking for a slow renderer that was never slow.

  `summary.failure_mode` now names which class, which status code and what share, at the top of the
  panel, the markdown report and the HTML page. A run that *completed without crossing its thresholds*
  and served 32% 404s on one class now says so on the second line, where it used to read as a pass.

  The rules that keep it from becoming a banner nobody reads: a clean run gets **no** line at all rather
  than an empty heading; below 0.5% of requests it is omitted unless the brake aborted the run (where
  whatever failed is material by definition); a **concentration** is named as one, with the denominator,
  because the same code on some classes and not others points at a pool while an even spread points at
  the system; the codes are ranked most-specific-first, so a 504 is not swallowed by the `cs_5xx` counter
  that also counts it; and the brake's own reason still follows, unchanged — the two are not merged.

  It is derived from the summary and nothing else. It is also the one thing on the HTML page that an
  invalid run still gets: a 404 does not become untrue because the generator was short.

### Changed
- `k6/lib/brake.js` declares the per-class status-code thresholds (`cs_504`, `cs_502`, `cs_5xx`,
  `cs_404`, `cs_denied`). Decorative like the rest and load-bearing for the same reason: k6 only surfaces
  a tagged sub-metric if a threshold names it, and without them the summary knows a class failed but not
  with what — so the failure-mode line would have to attribute the run's dominant code to every class
  that failed, which is the guess it exists to avoid.
- `docs/reading-results.md` reads in nine steps rather than seven: the failure mode is step 3, before the
  brake, and requested-versus-delivered is step 5. Both quote real output from real runs, so
  `check-doc-output.sh` verifies them.

## [1.28.0] — 2026-09-08

**`crowdsim probe --profile p.json --out /tmp/elsewhere` exited 0 and wrote its output to
`$CROWDSIM_OUT`.** A directory was asked for and a different one was used, in silence. `--out` is a real
flag — just not one `probe` has — and the argument parser was one flat `case` over every flag the tool
understands, so every flag was accepted by every subcommand and then ignored by most of them.

This repository already refuses an unknown flag with exit 2 rather than ignoring it, on the grounds that
a typo must not become a silently different run. A flag that belongs to a *different* subcommand is the
same mistake wearing a valid name: you believe you asked for something, and you did not.

### Added
- **A flag the subcommand does not take is an error (exit 2)**, naming the subcommands that do:

  ```
  ❌ --out is not a flag of `probe`. These subcommands take it:
       report, init, record
    It was accepted and then ignored before, which is worse: you asked for something and did not get it.
    See: crowdsim probe --help
  ```

  The accepted set comes from the **same `#@ <name>` help blocks** that `crowdsim <sub> --help` and the
  shell completions read — specifically the lines that *declare* a flag, not the prose that mentions one
  (`record`'s text says "a journey file for `--shape journey`", and reading that as a flag `record`
  accepts is exactly how one would slip through). So a flag cannot be accepted without being documented,
  and cannot be documented without being accepted.

  `tests/cli/flags.bats` holds both directions, including that **every argv the GUI builds stays inside
  the declared sets** — a gate that refused one of the page's own flags would take the whole page down.
  The other direction is held by the two hundred existing CLI tests, which drive real flag combinations
  against every subcommand: a set that was too narrow would turn them red.

### Fixed
- **The last help block did not end.** `serve` is the last `#@` block in the script, and the extraction
  only stopped at the *next* one — so it ran on to the end of the file and claimed every long option in
  the source, curl's `--resolve` and `--max-time` included. `crowdsim serve --<TAB>` offered **55 flags
  for a subcommand with two**, from 1.25.0. Both completions and the tests now end a block at the first
  line that is not a comment, and a test asserts `serve` declares no more than four.
- `crowdsim validate --profile <f>` is documented as well as accepted. It always worked; it was the one
  flag the new gate would have refused for want of a line in the help.

### Changed
- `docs/cli.md` §Flags leads with the refusal, and the exit-code table says exit 2 now covers a flag from
  another subcommand.

## [1.27.0] — 2026-09-05

Milestone v1.13.0, closed — and the leg it adds found a regression this project had shipped two releases
earlier, which is the entire argument for it.

**Every authenticated run has been broken since 1.24.0.** That release added a check that an `authed`
class names a pool it can draw from. The generator calls `validateAuth` with a *subset* of the profile —
`{ auth, classes }`, because `--skip-classes` has already been applied to the class list — so the new
check read `profile.pools` off an object that has none, concluded the pool was missing, and threw in k6's
init context: `the authed class \`authed_api\` draws from the pool "api", which is not in this profile`.
The profile was fine. The unit tests passed. The CLI suite passed. Nothing in this repository ran an
authenticated class against anything.

### Added
- **An end-to-end leg for the authenticated classes**
  ([#68](https://github.com/HiWay-Media/crowdsim/issues/68)). Every bug these classes have shipped lived
  in the **wiring**, and all of them were found by running them rather than by the suite: the login that
  could not read its own token (`discardResponseBodies` makes `res.body` undefined, and in k6's runtime
  `JSON.parse(undefined)` returns undefined instead of throwing, so reading `.error` off it threw a
  `TypeError` on every iteration of both authenticated classes — three releases, invisible, because a
  unit test calls `parseToken` with a string); a credentials file that parsed to zero accounts, which
  made the login class send nothing and vanish from every table; and 401/403 going uncounted, so a class
  being refused printed zero errors.

  `tests/e2e/run.sh` now drives a real sign-in against four nginx endpoints — a token endpoint with a
  **wrapped** body (`data.access_token`, the shape that broke), one that answers 200 with no usable
  token, a read that 401s without the header, and one that does not — plus a registration endpoint that
  the `signup` class posts to. It asserts that the token was read, that the bearer reached the API
  (`denied: 0`), that a login handing back no token is *counted* (`cs_auth_fail`, reported as
  `no token:`), that the signup manifest names the accounts and carries **no password**, that a
  credentials file with only a header refuses the run, and that `probe` verifies the premise against an
  endpoint that requires the token and refuses one that does not.

  Each of the three original bugs fails this leg if reintroduced — checked by reintroducing one:
  disabling the login's `responseType` produces `the login could not read a token out of
  data.access_token (39 failures)`.

  The credentials it uses are **generated into `.out/` at run time**, never committed: a file that looks
  like a credential list has no place in a public repository, even a fake one.

### Fixed
- **Authenticated runs work again.** `k6/live-event.js` passes `pools` to `validateAuth`, and
  `validateAuth` no longer claims a pool is missing when it was never shown any pools — not being handed
  the pools is not evidence that a pool is absent. Two unit tests hold both ends, one of them asserting
  the call site in the generator's source, because that failure was invisible from every other angle.
- **`crowdsim next` answered in minutes on a real checkout.** It looked for a journey file with a
  recursive `**` glob over the working directory, which on a repository with `node_modules` in it walks
  everything — `make test` went from one minute to thirty. It now looks in two conventional places, one
  level deep, and a test asserts it does not descend.

### Changed
- `docs/development.md`: the e2e suite has four legs, and the new section says why the authenticated ones
  needed their own.

## [1.26.0] — 2026-09-05

Milestone v1.10.0, closed. The two remaining items are both about a command that knew the answer and made
you work for it.

### Added
- **`crowdsim next` — where you are, and the one command to run next**
  ([#59](https://github.com/HiWay-Media/crowdsim/issues/59)). Getting from a clean checkout to a run is
  `doctor` → `discover` → `probe` → `init` → editing the `TODO`s and the two deliberately empty safety
  keys → `validate` → `load`. Every one of those is documented and every one works; what was missing was
  any answer to *where am I*. `doctor` reports on the machine and stops, `init` writes a draft and stops,
  and the only thing that knew a profile was still a draft was `validate` — which you had to run to find
  out.

  It reports what `out/` holds from `probe`, `discover` and a completed run, which profiles exist and
  which are still drafts, and names the single next command as text to copy. It **generates no traffic,
  writes nothing and never edits a profile**, which is what makes it safe to run blind on a machine
  somebody else set up.

  And it **fills nothing in**. `safety.allow_hosts` and `safety.safe_peak_rps` are the two gates: it
  reports them as the decisions they are, with what each one means, and the next step it names is *you
  decide these* — never a suggested value. No prompt, no wizard, no `-y`. A guided setup is exactly where
  an interactive confirmation would get added by accident, and this tool has none on purpose.
- **`history` takes arguments** ([#58](https://github.com/HiWay-Media/crowdsim/issues/58)):
  `--last N`, `--target <host>`, `--profile <name>`, `--cols a,b,c`, `--json`. It used to accept nothing
  at all — `--last 5` was `unknown option` — and printed all fourteen columns of every run ever recorded,
  which after a few dozen runs is a wall that wraps around the one thing it exists to show: whether the
  knee moves.

  The default view is eight columns and always keeps the run id and the knee. **A run whose generator did
  not hold the rate is marked in the margin**, not carried in a column at the far right that somebody has
  to know to read: it is a discard, and a discard that reads like a result is worse than no row at all.
  **A filtered or truncated view says so on its last line, with the total** — `showing 2 of 3 runs ·
  --last 2` — because a subset of runs that looks like all of them is the same class of mistake as a p95
  quoted for a rate that never happened.

  `--json` emits the **same record shape** `gui/server/lib/history.js` produces, and
  `tests/gui/history-shape.test.js` runs the driver and the GUI module against one fixture and compares
  them field by field. Two shapes would mean the page and the terminal disagreeing about what a run was,
  while somebody is deciding something. The parser stays header-keyed, so a row written before a column
  existed still prints, with an empty cell rather than a `0` — a knee of 0 req/s is a claim about the
  system, and *this run predates the knee* is not the same statement.

### Changed
- `docs/running-a-test.md` opens on **where am I** rather than on a nine-step list a reader has to keep
  their place in, and `docs/index.md` §Start here leads with `next`.

## [1.25.0] — 2026-09-05

Three of the five items of milestone v1.10.0, which is about the tool being usable rather than the tool
being right. None of these changes what a run measures; all three are things somebody had to work around
every single day.

### Added
- **`crowdsim <subcommand> --help`** ([#55](https://github.com/HiWay-Media/crowdsim/issues/55)). `load`
  has twenty flags, and finding one of them meant reading the synopsis of twelve other subcommands first:
  every subcommand answered `--help` with the same seventy lines. Now each one answers for itself, with
  its own synopsis, its own flags and one copy-pasteable example, and exits **0** — asking for help is not
  a usage error.

  It stays **one source**. The per-subcommand text lives in the same comment header the global help comes
  from, in `#@ <name>` blocks below a marker where `crowdsim --help` stops; `usage()` and
  `subcommand_usage()` both extract by structure. Two sources would disagree once, and a help page that
  contradicts the tool is worse than a long one. `tests/cli/help.bats` asserts that **every flag the
  argument parser accepts appears in at least one block**, so a flag added and never documented fails the
  suite instead of shipping invisible.
- **Shell completion for bash and zsh** ([#56](https://github.com/HiWay-Media/crowdsim/issues/56)), in
  `completions/`, installed as documented in [docs/install.md](docs/install.md#optional-shell-completion)
  and shipped in the image at `/crowdsim/completions/`. Subcommands, the flags of the subcommand actually
  being typed, `--profile` against `$CROWDSIM_PROFILES`, and run ids against `$CROWDSIM_OUT/history.tsv`.

  Two properties are deliberate. It **reads the driver's own comment header** for subcommands and flags
  rather than carrying a copy — a copy is stale by the next release, and then quietly hides the flag
  somebody just added. And it **never runs crowdsim**: reading a file is free, while a completion that
  shells out to this tool is a completion that can generate load from a keystroke.
  `--i-know-this-breaks-production` completes like any other flag; hiding it would make nobody safer, it
  would only make the gate look like a secret instead of a decision somebody takes.
- **`latest` and `previous`, wherever a run id is accepted**
  ([#57](https://github.com/HiWay-Media/crowdsim/issues/57)). `crowdsim report latest` used to answer *no
  summary for latest*, so reporting on the run that just finished meant reading its id out of `history`
  and retyping sixteen characters — which is also how the wrong run gets reported: `20260901T123654Z` and
  `20260901T123645Z` are one glance apart. One resolver, used by `report`, `compare` and
  `report --compare`, so `crowdsim compare previous latest` works and keeps every refusal `compare`
  already has.

  **The resolution is always printed** — `ℹ️  latest → 20260901T121500Z` — on stderr, so it cannot land in
  a redirected report. A command that silently picks a run is how a result gets attributed to the wrong
  experiment. And **`latest` skips nothing**: the newest run resolves even when it is a discard
  (`generator_ok: false`) and is reported as the discard it is, because quietly stepping back to the
  previous run would hand over a valid-looking result for a run nobody asked about. No runs at all, or
  `previous` with only one, exits 2 and names `crowdsim history`.

### Changed
- `crowdsim --help` no longer opens with a blank line, and stops at the per-subcommand marker rather than
  growing by every block added below it.
- `tests/image/smoke.sh` asserts that `crowdsim load --help` answers inside the image and that the
  completions are there: in a container there is no README next to you and no man page.

## [1.24.0] — 2026-09-05

**A run was green and measured nothing, and a test suite that could have caught it was failing thirteen
tests on purpose.** Both halves of this release come from the same week: the first authenticated smoke
against a real target, and the count of failures somebody had to reproduce before trusting the suite.

The `authed` class in that smoke was pointed at `/api/auth/whoami`, which answers **200 with the same body
and no `Authorization` header at all**. So the class sent an anonymous GET wearing a bearer token and
reported p50 63 ms as an authenticated read. The login itself was genuinely proven — a real token out of
`data.access_token`, `no token: 0` over 29 iterations — and nothing in the tool could tell the two apart.
That is the failure shape this project exists to avoid: a run that completed, clean, and answered a
question nobody asked. `cs_denied` (1.20.5) does not help, because it counts a class being *refused* under
load, and here the anonymous request succeeds.

### Added
- **`probe` verifies the premise of every `authed` class instead of assuming it**
  ([#67](https://github.com/HiWay-Media/crowdsim/issues/67)). One request per class, sent **without the
  token**, before any load. A `401`/`403` is the only thing that proves the class measures an
  authenticated read, and it is stated out loud — *"no warning"* is not evidence:

  ```
  ── the premise of every authed class (one request, sent without the token) ──
    ✅ authed_api  /api/me
       the endpoint refused the request without a token (401)
       so what this class measures is an authenticated read, not a public one.
  ```

  A `2xx` is refused with **exit 4** and named: *this endpoint does not require the token*. So is a `404`,
  which is the older trap (a pool of URLs the target does not serve) and reads differently because the fix
  is different. A **`3xx` is deliberately not counted either way**: from here a redirect to a login wall
  and a redirect to a public canonical URL look identical, and choosing between them would be exactly the
  confident wrong answer the rest of this is written against — it warns, names the ambiguity, and
  continues. Verdicts in `lib/premise.mjs`, unit tested; the requests are made by the driver with the same
  TLS and Host flags as the rest of `probe`.
- **The half that needs no target is refused at validation.** An `authed` class that names no pool, or an
  empty one, now fails `validate` and `load` before anything runs. A class with no URLs sends nothing —
  and a class that sends nothing is *absent* from every table in the summary rather than reported as
  broken, which is the same invisibility that made a zero-account credentials file look like a working run.
- **`tests/cli/premise.bats`**: six tests against a python3 server on loopback that answers 401 on one path
  and 200 on another. It is the one CLI test that needs something to answer, because the question is what
  the *target* says to a request without a token, and a stub cannot have an opinion about that.

### Fixed
- **The CLI suite is green, and any `not ok` is now a regression**
  ([#69](https://github.com/HiWay-Media/crowdsim/issues/69)). `docs/development.md` documented an expected
  baseline of **eleven** failures "by design" on a developer machine; the real count was **thirteen**; and
  the number was the least of it. The `without <tool>` tests build a `PATH` of symlinks to everything the
  driver needs minus the one tool being removed — and that list was copied into four helpers, **missing
  `dirname` in all four**. `bin/crowdsim` calls `dirname` on its second line to find its own root, so
  every one of those tests died at **exit 1** before reaching the check it was written for: *"without
  node, validate exits 5"* had been asserting nothing at all for as long as it had existed. The tool list
  is now one constant (`CROWDSIM_TEST_TOOLS`) and the four helpers are one function, `path_without <tool>`.
- **The two `cache-ab --run` legs were testing the 1.20.4 exit code, not their own subject.** Since 1.20.4
  a generator that exits 0 without writing a summary is exit 4 — correctly, a run that never happened is
  not a result — and the suite's stub k6 does exactly that, so both tests stopped at the first leg. The
  `cache-ab` stub now leaves a summary behind, which is what a real k6 does.

  A suite whose expected output includes thirteen failures is a suite nobody reads, which is how these
  went unexamined for three releases. There is no baseline to reproduce any more.

## [1.23.0] — 2026-09-04

Milestone v1.12.0, closed. **A signup class creates real accounts in a real identity provider, and the tool
that created them recorded nothing about them.** A class at 40/s for five minutes makes twelve thousand;
one real campaign left ~2,970 behind and had to open a ticket to hunt them down, findable only
because somebody had thought to use a dedicated mail domain. A run that created 2,970 accounts is not
finished when the numbers are in.

### Added
- **`out/signups-<run-id>.json`, after any run with a `signup` class**: the run id, the target, the signup
  URL, the email pattern, the counts, and every address the run created. Every identity is the pattern with
  `{tag}` replaced by `<run id>-<vu>-<iteration>`, so one run's accounts are exactly those carrying its run
  id — the file carries that as `email_glob`, which is the cleanup key and works in a provider's own search
  box.
- **Two things the manifest will never contain, both asserted by a test.** No **password** — not even the
  throwaway one the template declares, and not one hidden inside the body template: a file that lists
  credentials for a real system is a different category of object from a run artefact. And no **deletion**:
  crowdsim will not remove accounts from an identity provider, because a tool that could do that is a tool
  that could do it by accident. The glob is there so your own script can.
- **The run says it out loud, and the reports carry it as a caveat**: how many accounts now exist, on which
  target, where the manifest is, the glob that finds them, that crowdsim will not delete them — and that
  the file names real accounts on a real system and must not be committed. `summary.signup` carries
  `created` (from a metric: a 409 on a duplicate is a request that happened and an account that did not),
  `failed` and the glob.
- The address list comes out of the run log, because a k6 virtual user has no other channel: VUs are
  isolated, so there is no shared array to collect into and read in `handleSummary`. That is also why the
  glob is in the file — a truncated log makes the list short, and the count, which comes from a metric,
  stays exact.

### Fixed
- **A signup-only profile was refused for a credentials file it has no use for.** `credentialsRefusal`
  (1.20.4) asked `usesAuth()`, which is true for `signup` as well, so a registration run demanded a
  `username,password` CSV — while a signup class *creates* accounts rather than signing in with them.
  `validateAuth` had drawn that line correctly from the start. Found by running a signup class against a
  real registration endpoint, which is also how the manifest above was verified: 40 accounts created, 40
  listed, no credential in the file.

## [1.22.0] — 2026-09-04

Milestone v1.12.0, second half: **a class can be aimed at a rate.** A finding is almost always about one
class — *"the login saturates at ~150 login/s"* is the sentence a campaign comes back with — and until now
a run could only be aimed with one global `--peak` split by weights. Reproducing that finding meant solving
for a weight by hand, in the wrong direction, every time the question changed.

### Added
- **`rate_rps` on a class, instead of a weight.** The pinned classes get exactly what they ask for and the
  rest split **what is left** by weight (`allocate()` in `k6/lib/mix.js`). That composition is the design,
  not a convenience: `--peak` keeps meaning the total, and the total is what the safe-peak gate reads, so a
  per-class rate is not a way past a ceiling — pin a class under the ceiling, ask for a `--peak` above it,
  and the run is refused with exit 3 like any other. Asserted in `tests/cli/profile.bats`.
- **The shares come out of the same arithmetic as the rates.** Everything downstream — the ramp, the VU
  provisioning, `mix_target` — is expressed as a share of the peak, so computing it twice is how the ramp
  and the rates would eventually disagree about what the run was doing.
- **The summary records what each class was aimed at and where the number came from** (`allocation`:
  `rates`, `pinned`, `fixed_total`, `note`). A finding about one class gets quoted as that class's rate, so
  it belongs in the file rather than being recomputed from a weight by whoever reads it later.
- **A pinned rate is the rate at peak**, and the class still ramps with everybody else. Holding it flat
  from the first step would put the total above that step's own total, and `--start`/`--steps` would stop
  meaning anything.

### Changed
- **Fixed rates above `--peak` are refused before k6 starts** (exit 2), naming what was asked for and the
  peak it exceeds. They are **never scaled down to fit**: the run would then measure a rate nobody asked
  for and report it under the one they did. The driver refuses first, with a proper exit code, and
  `allocate()` refuses again in the generator's init context as a backstop that cannot drift from it.
- **When every class is pinned, `--peak` is a ceiling and not a target**, and both the run and `validate`
  say so: a run that generated 200 req/s next to a `--peak` of 500 needs to have said why in advance.
- `validate` refuses a class that declares both a `weight` and a `rate_rps` — with both, one is silently
  ignored and the run aims somewhere nobody chose — and a `rate_rps` that is not a positive number.
- A profile with no `rate_rps` anywhere produces byte-identical shares to 1.21.0, asserted against
  `shares()` in `tests/unit/mix.test.js`.

## [1.21.0] — 2026-09-04

Milestone v1.12.0, first half: **the unit the requirement is written in.** A capacity requirement arrives
as *"7,000 concurrent users"* and every number this tool produced was a rate, so somebody converted one
into the other in their head with an assumption they never wrote down. A real campaign of 2026-09 of
2026-09-04 did it properly, and that is the method here: Little's law, cross-checked against a count of
sessions in flight, the two printed side by side. They agreed — and **the agreement is what made the
number defensible, not the number.**

### Added
- **Concurrent users, two ways, never merged** (new `k6/lib/session.js`, in `summary.concurrency`, in the
  panel and in both reports). `derived` is the session arrival rate the run drove times the mean session
  duration it measured; `observed` is the peak number of sessions running at once, counted. `agree` is the
  field to read first: one method alone cannot tell a measurement from an artefact of the arithmetic, and
  a disagreement past 25% IS the finding — it means the arrival rate and the session duration describe
  different parts of the run, and neither figure should leave the terminal. Nothing anywhere is their
  average.
- **Four refusals, because a concurrency figure gets quoted in rooms this tool is not in.** A generator
  that did not hold the rate, a target that never answered, and a run the brake stopped are all refused
  with a reason and a fix: concurrency is a property of a steady state, and an aborted ramp never had one
  ("read the knee instead, then measure in a `--hold` below it"). And when the sessions in flight reach
  the VU ceiling the run provisioned, that number is reported as **our own configuration, not a
  measurement**. `--shape mix` gets no figure at all: without sessions there is no session duration, and
  rate/duration arithmetic over a class mix would be a number with nothing behind it.
- **`journey.think_time`: the reading pauses, declared or measured.** Session duration is the fan-out plus
  the pauses, so the pace is half of any concurrency figure — and it was hard-coded as
  `sleep(1 + Math.random() * 4)`, in one place, with nothing in a profile able to change it. Two shapes:
  `samples` (pauses somebody observed, picked from rather than fitted to a range) and `min_ms`/`max_ms`
  for a declared one. **The default is unchanged** — 1000–5000 ms, the value this tool has always used,
  asserted by a test — and the run reports its `source`, so a concurrency figure is never read as if the
  pace had been measured.
- **`crowdsim record` carries the pauses out of the recording** it already reads: the gap between the
  last byte of one page and the request for the next document, with negative gaps and anything past five
  minutes dropped rather than smoothed (a tab left open is not a reading pause). It writes them with
  `measured: true` and says how many it found, so a measured pace costs one command instead of a
  spreadsheet.
- `validate` refuses an inverted think-time range and a `0` inside `samples`. Both fell back to the
  default in silence, and a run whose pace nobody chose still prints a concurrency figure.

### Fixed
- **The arrival rate is not `iterations.rate`.** That counter is *completed* iterations, so the first
  version of this feature reported `derived 3` against `in flight 50` for a ramp the brake had cut, and
  called it a disagreement — the derived number was garbage by construction rather than evidence of
  anything. Found by running it against a real target, which is also how the refusals above came to exist.

## [1.20.5] — 2026-09-04

**The authenticated classes were run against a real target for the first time, and two of the three
findings are about a run that looks green while measuring nothing.** The definition came from the
generator one real campaign of 2026-09 actually used: the sign-in it saturated is not an
identity-provider token endpoint but an application login — `POST /api/auth/login`, an
`application/x-www-form-urlencoded` body, the token at `data.access_token`. That is why the backend
saturated while the identity provider sat at 26%: the load never reached it directly.

### Fixed

- **A login could not read its token at all, and it aborted the scenario mid-ramp.** The run sets
  `discardResponseBodies: true` — headers are the measurement, bodies are RAM — so `res.body` is
  undefined, and in the generator's runtime `JSON.parse(undefined)` returns undefined instead of
  throwing: reading `.error` off it threw a `TypeError` on every iteration of both authenticated
  classes. The login request now asks for its own body (`responseType: 'text'`), for that request only,
  and an absent body is reported as `token response body is empty` rather than parsed.
- **A weights class this command cannot count no longer steals the requests of the class that served
  them.** `compileRules` mapped every kind that was not `rsc` to `plain` — true when those were the only
  two kinds. A `login` class declared on a page pool then matched **every document GET in the log**: a
  window with three page views and one sign-in produced a mix of 100% login. `login` and `signup` are
  POSTs and this command counts GETs, so they are now carried through to be *reported* and never
  matched, and `weights` says `cannot be counted from a GET log` instead of `0%` — a different finding
  with a different fix.
- **A profile that posts its credentials to an application endpoint is no longer refused for a missing
  `client_id`.** That field belongs to the OAuth password grant, which is now one mode (`mode:
  "password_grant"`) beside the default form post; the validator asks for it only there.
- **The `no summary produced` test still expected exit 0**, the behaviour 1.20.4 deliberately changed to
  exit 4. A test that asserts the bug is worse than no test.

### Added

- **`mode`, `fields` and `token_path` in the `auth` block**: the form field names, extra fields, a JSON
  body, and a dotted path to the token and refresh token in a wrapped response. Guessing that the token
  sits at the top level reads as *the login works but returns no token*, so the path is part of the
  profile.
- **Two counters for the failures that used to be invisible.** `cs_denied` counts **401/403** — an
  authenticated class that starts being *refused* under load is neither a 5xx nor a 404, and until now
  nothing counted it, so a run whose whole authenticated half was rejected printed zero errors.
  `cs_auth_fail` counts a login that answered without a usable token, which is not an HTTP error either.
  Both appear in the summary line as `401/403:` and `no token:`.

### Notes

- **`/api/auth/whoami` on the smoked target is public**: it answers 200 with the same body and no
  token, so it cannot validate an `authed` class — an authenticated read needs an endpoint that actually
  refuses an anonymous request, and neither the campaign's own test nor this one had one. The login is
  proven end-to-end (a real account, a 1.482-character token from `data.access_token`, 29 iterations,
  `no token: 0`); the authenticated read is not proven by that smoke, and this is the caveat to carry
  into the first real authenticated campaign.

## [1.20.4] — 2026-09-04

An audit of the authenticated classes, three releases after they shipped. The worst finding is the shape
this project exists to avoid: **a run that completed, clean, with its entire authenticated half never
attempted.** A class with no requests is invisible by design — `steps.js` drops it because a row of zeros
reads as a step that was fast, and the per-class table filters it out — so anything that silently produces
zero requests produces a plausible wrong answer.

### Fixed
- **A credentials file that parses to no accounts refuses the run**, in the generator's init context, with
  the reason and the fix. `pickUser` returns null on an empty list, `login()` returned false without
  sending anything, and the caller ignored the return value: the login class emitted **zero requests** and
  vanished from every table. Every way of getting there looks fine from the outside — a header-only CSV,
  the wrong separator, comments only, a space-separated file. Verified against a real generator: it now
  fails at init and the driver exits 4.
- **A run that never happened is no longer a success.** When the generator produces no summary — a profile
  it refuses at init, a missing journey file, an out-of-memory — the driver warned on a terminal and
  returned **0**, so a Nomad batch and a CI job recorded it as executed. It exits **4** now, saying there
  is nothing to interpret and that nothing went into the history. `0` still means executed, and a run the
  brake stopped still keeps it: that is an outcome.
- **Fewer accounts than virtual users is now stated instead of assumed away.** `pickUser` assigns by
  `vuId % users.length`, so 50 accounts across 400 VUs means each account signs in from about eight of
  them at once, and some identity providers serialise work per subject — part of the ceiling measured is
  then the account count. `usersNeeded()` had been written for exactly this question, exported and
  unit-tested, and **nothing ever called it**. The run says so at startup, the summary records it in
  `auth` (`users`, `vus`, `sharing_note`), and both reports carry it as a caveat beside the numbers.
- **A CSV header of `email,password` was an account that could never log in.** Only `username` and `user`
  were recognised as a header, so one credential in the rotation failed every single time — with 50
  accounts that is 2% of logins, the same order of magnitude as `max_failed_rate`, quietly eating the
  error budget or tripping the brake as if the system had failed.
- **A signup template substitutes every placeholder, not only the first.** `String.replace` with a string
  pattern replaces one occurrence, so a body that used `{tag}` twice was sent with a literal `{tag}` still
  in it — a 400 from the API, read as the write path rejecting load. (`split`/`join`, because `replaceAll`
  is ES2021 and `k6/lib` stays ES2019.)

### Added
- `.github/roadmap.json`: milestone **v1.12.0**, the four things a real campaign of 2026-09
  needed and this tool could not say — concurrency instead of only rates, an absolute rate for one class,
  think time that can be measured rather than hard-coded, and a record of the accounts a signup run
  created. Each one is this tool answering in the unit the question was asked in; none is a new kind of
  tool. The campaign ran on the other generator for exactly these reasons.


## [1.20.3] — 2026-09-04

**The driver's part of the authenticated classes had no test.** It does one thing — hand the path of the
credentials file to the generator, never the credentials themselves — and that is exactly the kind of
plumbing that breaks quietly: an env that stops being forwarded produces a run that signs in as nobody
and reports the API rejecting it under load.

### Added

- **`tests/cli` covers the credentials passthrough**: the path reaches the generator as `-e
  CROWDSIM_AUTH_USERS=…`, an unset variable tells the generator nothing at all, an empty one is treated
  as unset rather than forwarded as an empty env, and the variable is documented in `--help`, where
  people look for it.

### Fixed

- **`docs/development.md` now says why the CLI suite refuses to run under bash 3.2** and what a passing
  run looks like on a developer machine: the `without <tool>` tests simulate a minimal environment, so on
  a laptop that has k6, node, docker and `column(1)` installed they fail by design. Eleven of them, with
  or without this change — a number worth knowing before reading it as a regression.

## [1.20.1] — 2026-09-04

**A credentials path set for a whole environment broke every anonymous run on it.** `CROWDSIM_AUTH_USERS`
is meant to be set once — on a Nomad job, on a CI runner — but the generator opened the file
unconditionally, and `open()` on a missing path throws in the init context. Setting it centrally, which is
the point of an environment variable, made every profile without a login class refuse to start.

### Fixed

- **The credentials file is read only when a class in *that run* signs in**, and the check happens after
  `--skip-classes` has been applied: skipping the authenticated classes now runs without credentials, as
  it should. The predicate lives in `k6/lib/auth.js` as `usesAuth()` and is used by the generator, the
  profile linter and the auth validation itself — three copies of the same question is how one of them
  ends up disagreeing.
- **A missing credentials file is refused with the fix, not with a stat error.** k6's own message is
  `stat <path>: no such file or directory`, which is accurate and says nothing about what to do; the run
  now names the path, the CSV format, and the two ways out (point the variable somewhere real, or drop
  the classes with `--skip-classes`).

### Added

- **The parameterized Nomad job supports authenticated runs**: `CROWDSIM_AUTH_USERS` points at the
  allocation's secrets directory, and a commented template renders the CSV from a Nomad variable
  (`nomad var put nomad/jobs/crowdsim auth_users=@users.csv`) so the credentials exist for the life of
  the run and nowhere else. The GUI needs nothing: every run is a child process of the driver and
  inherits the environment. Documented in `docs/profile.md`, together with the refusal message.

## [1.20.0] — 2026-09-04

**Every class crowdsim shipped until now was an anonymous GET, and that hides the component that breaks
first.** On a real campaign the web tier held over 7,000 concurrent users without effort while sign-in
saturated at ~150 logins/s: the ceiling was in authentication, and no anonymous profile can reach it. A
load test that cannot log in confirms what you already knew and stays silent about the only thing that
was wrong. This release adds sign-in, authenticated reads and registration as first-class kinds.

### Added

- **`login`, `authed` and `signup` class kinds**, driven by a new `auth` block in the profile. `login`
  posts the OAuth2 password grant and keeps the token for that virtual user; `authed` sends
  `Authorization: Bearer` and draws its paths from a pool; `signup` registers a new identity per
  iteration. The logic lives in `k6/lib/auth.js` with unit tests — `live-event.js` stays wiring.
- **One account per virtual user**, assigned deterministically from a `username,password` CSV. With a
  single shared account you measure how the identity provider handles one subject's sessions instead of
  how it handles load, and a failure cannot be traced to a credential. VU 7 always signs in as the same
  account, so a run is reproducible.
- **`CROWDSIM_AUTH_USERS=<path>`**, which wins over `auth.users_csv`. Credentials are passed as a path at
  run time and stay out of the profile: profiles get shared, secrets should not travel with them.
- **`auth.logout`** for runs that have to be comparable. 150 logins/s for one minute is 9,000 sessions on
  the identity provider, and the memory they hold is a variable of the result: a second run that starts
  from a loaded provider is not comparable with the first. Off by default — it costs one request per
  iteration.
- **`docs/profile.md` gained an `auth` section** with the tested command, the CSV format, what each kind
  does, and the three things to know before pointing this at production: brute-force detection turns a
  single wrong credential into a run that measures lockouts; the login class is normally the first to
  knee, so it wants its own `max_p95_ms`; and sign-in is not cacheable, so a CDN in front changes nothing.

### Changed

- **Automatic re-login.** A token issued at the start of a ramp expires while the ramp is still climbing.
  Without this an `authed` class degrades to 100% failures and trips the emergency brake, reporting a
  collapse that is an artefact of the test. The token is refreshed when it is about to expire and when a
  request comes back 401.
- **Unique identity per `signup` iteration.** Replaying one address creates the account on the first
  request and measures the conflict on every one after — the class would look consistent and mean
  nothing. `{email}` and `{tag}` are substituted in the body, and `{tag}` carries the run id, so two runs
  never collide. ⚠️ The accounts are real: plan the cleanup, and give them a dedicated mail domain so
  they can be found afterwards.
- **The profile validator knows the new kinds**, and refuses the profiles that would run and mean
  something else: an `authed` class with no `login` class (the token would have no source), a login class
  with no token endpoint, `logout` without `logout_url` (sessions would pile up silently). It imports the
  rules from `k6/lib/auth.js` rather than restating them — a lint that drifts from the runtime is worse
  than no lint. `login` and `signup` are exempt from the "a class needs a pool" rule, because their URL
  comes from the auth block.

### Fixed

- **A credentials CSV using semicolons dropped every line.** The separator was chosen by comparing
  `indexOf(';')` with `indexOf(',')`, and when one of the two is absent `indexOf` returns `-1`, which
  compares as "earliest": a file exported by a spreadsheet in a semicolon locale parsed to zero users and
  the run started with nothing to sign in with. Found by the unit test that covers that export.

## [1.19.3] — 2026-09-02

**Nothing in this repository said why it exists.** The README says what the tool is, `docs/` says how to
use it, `AGENTS.md` says how work happens here — and between them a reader could still not tell a gap from
a decision. The GUI has no scheduler, `weights` will not fetch your access log, the image ships no
allowlist default: each of those reads as something nobody got around to, and each is a refusal with a
reason behind it. That distinction only existed in the heads of the people who made the calls, which is
exactly the kind of knowledge that goes missing first.

### Added
- **`INTENT.md`** — the purpose of the tool, its goals in priority order, the **non-goals stated as
  decisions rather than gaps**, the invariants with the reason each one exists, and the boundary between
  this repository and the private ones that hold real profiles and real run reports. It is the document a
  proposal gets measured against before anybody writes it: a change that weakens a gate, adds a second
  place for the gates to be wrong, or turns a refusal into an estimate is answered here rather than
  re-argued.
- It is deliberately the one page that **does not go stale with the facts**. Flags, fields and numbers stay
  in `README.md`, `docs/` and this file; `INTENT.md` changes when the *purpose* changes — a goal added or
  dropped, a non-goal that stops being one, a boundary that moves. It carries the date it was last
  reviewed for that reason.

### Changed
- `README.md` and `docs/index.md` link it, and both `AGENTS.md` and `CLAUDE.md` point at it in their
  pointer list — an agent working here needs the written intent to tell "missing" from "left out on
  purpose". No behaviour, no flag and no output changed in this release.

## [1.19.2] — 2026-09-02

**The GUI in the published image could not launch a single run, and had not been able to since that image first
shipped in 1.2.0 — thirty releases ago.** Reported by somebody running the container, who worked around it in a Nomad job. Every check this
repository had said the image was fine — because none of them ever asked the page to do the one thing it is
for.

### Fixed
- **`CROWDSIM_BIN` is declared in the image** (`/usr/local/bin/crowdsim`). The image puts the driver there
  and the rest of the tool in `/crowdsim`; the GUI server derived the driver's path from its own location —
  `/crowdsim/gui/server/../../bin/crowdsim` — which does not exist. So the page started, printed nothing
  unusual, and every run failed after the click with `crowdsim could not be started: spawn
  /crowdsim/bin/crowdsim ENOENT`. The Kubernetes manifests had the same fault, from the same cause, and are
  fixed by the same line.
- **The documented default was false, which is why the gap survived.** `docs/cli.md` and `docs/gui.md` both
  said `CROWDSIM_BIN` defaulted to `$CROWDSIM_ROOT/bin/crowdsim` — the reasonable assumption, and not what
  the code did. `CROWDSIM_ROOT=/crowdsim` therefore looked like it covered this. It is now true: the order
  is `CROWDSIM_BIN`, then `$CROWDSIM_ROOT/bin/crowdsim`, then the server's own checkout, then `crowdsim` on
  `PATH` (new `gui/server/lib/bin.js`, with tests).
- **`crowdsim serve` names itself.** It exports its own absolute path as `CROWDSIM_BIN`, so the page spawns
  the script that was invoked rather than another copy a search happened to find first — which matters with
  two versions installed side by side. An explicit `CROWDSIM_BIN` from the caller still wins.
- **A server that cannot spawn the driver refuses to start** (exit 2), naming `CROWDSIM_BIN` and listing
  where it looked, instead of serving a page that accepts every click and fails each one. A
  `CROWDSIM_BIN` that is set and not executable is reported as itself and never silently replaced: a GUI
  that spawns a different driver from the one it was told to is worse than one that refuses.
- **The startup log says which driver it will spawn**, next to the profiles and the output directory, so
  `docker logs` can answer *what is this page actually running?*

### Added
- **The assertion whose absence let this ship.** `tests/image/smoke.sh` now launches a `--dry-run` through
  the GUI's own API and fails when the run cannot start. Everything it checked before — the GUI starts,
  answers, sees k6, serves the page, refuses an untokened request — passed on every broken image. Verified
  the only way that means anything: the new check was run against the image built *before* this fix, and it
  failed, naming `CROWDSIM_BIN`. A dry run composes the whole k6 invocation and passes both gates without
  sending a request, so it stays safe on a shared runner.

### Changed
- Nothing about the interface. If you carry `CROWDSIM_BIN=/usr/local/bin/crowdsim` in a job spec as a
  workaround, it keeps working and is now redundant — the image sets the same value.

## [1.19.1] — 2026-09-01

Documentation catching up with two releases of its own product. The GUI screenshots still showed the page as
it was before the warm-up fields and the report buttons existed, and the architecture page still described a
`lib/` with one module in it.

### Fixed
- **The two GUI screenshots are the GUI that ships.** `gui-run-form.png` was taken before `--warmup` reached
  the form and `gui-result.png` before the report buttons did, so the page in the documentation had neither.
  Retaken against a real server with a real archive, and cropped to the same framing as the rest.
- **The result card no longer prints its own backticks.** The note under the report buttons was written as
  markdown and rendered as JSX, so it read `` `.html` `` on screen. It says HTML and markdown instead. Found
  by looking at the screenshot rather than at the diff, which is what the screenshot is for.
- **The run form's field list in `docs/gui.md` names the warm-up**, and the panel list says where the report
  buttons are. A field that exists and is not in the reference is a field nobody knows to use.
- **`docs/architecture.md` lists what `lib/` actually holds** — `validate.mjs`, `har.mjs`, `weights.mjs`,
  `report-html.mjs`, each pure, unit-tested and reached through a thin `*-cli.mjs` — instead of the single
  module it had when the page was written, under a filename (`validate.js`) that has not existed for
  releases.

## [1.19.0] — 2026-09-01

Every number this tool produces is a curve — rate against latency, per step — and the only place that curve
was ever drawn is the GUI. The moment a result left the page it went back to being a table of eight rows, with
the reader asked to draw the ramp in their head. `report` now draws it. The interesting half of the work is
what the charts refuse to draw: a chart is the most persuasive thing this tool can produce, and a chart of a
run that measured nothing is the most persuasive wrong answer available to it.

### Added
- **`crowdsim report <run-id> --html`: the same run as one self-contained page.** The ramp as a curve with
  the SLO and the read timeout drawn on it, the knee as a band between the last clean rate and the first
  crossed one, p95 per class against the limit each class is actually held to, and the cache per layer. One
  file, no dependencies: no script, no font, no stylesheet, nothing fetched — it opens offline, attaches to a
  ticket, and prints to PDF with the tables expanded. Needs `node`; the markdown report is unchanged and
  still needs nothing but `python3`.
- **An invalid run gets no latency chart, and one chart it does get.** `generator_ok: false` means no step
  measured the rate it claims, and a curve drawn from it looks exactly like a healthy system absorbing load.
  Such a run gets the requested-against-delivered chart — the evidence of *why* it is invalid — and nothing
  else: no ramp, no per-class bars, not even a p95 tile. Same for a target that never answered: a p95 of
  nearly zero is not a fast system. And a knee recorded next to a verdict that voids it is shown as **not
  counting**, because an older summary can carry both and the knee is the number that gets quoted in rooms
  this tool is not in.
- **A threshold line only where there is a threshold, and one that does not fit is named.** A limit line at a
  guessed value moves the knee for the reader, so a run archived before the summary carried its thresholds
  gets a curve with no line and a sentence saying why. A read timeout ten times the p95 is left off the scale
  rather than flattening the curve into the bottom of the picture — and said to be left off, because a line
  that is simply absent reads as a limit nothing came near.
- **The rest of the drawing rules, each with a test.** A partial step is a hollow marker, a dashed segment and
  a note (the brake fires while latency is climbing, so that step is a fraction of one, biased towards its
  worst part). A cache layer whose header never appeared is `unknown`, never a 0% bar — that is usually a
  wrong header name in the profile, a different bug with a different fix. A step that emitted no p95 is absent
  rather than plotted at zero. Every chart carries the same numbers as a table underneath it and describes
  itself in words, for a screen reader and for when the SVG does not render at all.
- **The summary records the limits the run was judged against**: `slo.max_p95_ms`, `slo.max_failed_rate`,
  `slo.guillotine_ms` and `slo.per_class`. They were already in the generator's context — the brake and the
  knee use them — and the only way the numbers left a run was the sentence in `knee.crossed.why`. A threshold
  is not something to reconstruct from prose.
- **The GUI offers both**, by spawning the same command: *Report (.md)* and *Report with charts (.html)*,
  through `GET /api/history/<run-id>/report?format=md|html`. Any other format is a 400 — the value ends up in
  an argv.
- Geometry is pure and unit-tested in `lib/report-html.mjs` + `tests/unit/report-html.test.js`, with
  coordinates asserted as numbers: that x increases along the ramp, that a higher p95 is a *smaller* y, that
  the knee band starts on the clean step and ends on the crossed one. A wrong scale throws nothing. The e2e
  suite then draws **every** run in its archive from real data and checks the rule per run — the first version
  of that check asserted a curve on the newest run, which happened to be the unreachable one, and the suite
  was right to fail.

### Changed
- `--html` reports one run: `--html --compare` is a usage error (exit 2) naming `crowdsim compare`. Drawing
  two runs on one pair of axes without that command's refusals would put a confident picture behind two
  different experiments. The markdown report still embeds the comparison, refusal included.
- `docs/cli.md` carries a real screenshot of the page, taken from a real run against a slow origin on
  loopback. Taking it found a threshold label sitting on top of a data point, which is the reason to take it.

## [1.18.0] — 2026-09-01

Milestone v1.9.0, closed. Every page of this documentation says the class weights must come from your own
edge access log, and `init` wrote them as a `TODO` for exactly that reason — while nothing in the tool would
read a log, so the single most important input was left to somebody counting lines in a terminal. The GUI,
meanwhile, could not express the two flags that keep a cold start out of the numbers, and could not hand over
the one document a finished run is read from. And the claim these docs make about themselves — that their
commands were run before being written down — had a hole in it: nothing looks at what those commands *print*,
which is the part a reader compares against their own terminal.

### Added
- **`crowdsim weights <access.log>` counts the mix instead of asking you to.** A file, or stdin
  (`ssh edge 'zcat access.log.*.gz' | crowdsim weights - --profile p.json`) — the tool never fetches a log,
  because that would mean privileged access to a production edge. It prints the count, the share and the
  weight to paste per class, what it could not classify, and the window the log covers, and it **writes
  nothing**: not the profile, not an artefact in `out/`. An access log holds URLs, addresses and user agents,
  and `out/` is a directory people copy from. Rules in `lib/weights.mjs`, tested in
  `tests/unit/weights.test.js`; the driver's side in `tests/cli/weights.bats`.
- **A class is recognised by what the profile declares, never by the shape of a URL.** In order: `kind` as a
  hard filter (an `rsc` class only ever matches a request carrying the navigation parameter, and a `plain`
  class only ever matches one without it — the same path is two classes, which is why they are two classes),
  then the new `log_match` globs, then `path_prefix`, then the class's own pool. `/favicon.ico` is obviously
  an asset and the command still refuses to file it under `static`: a guessed class is a made-up mix, which
  is the thing this command exists to replace. What no class claims is reported as an **unclassified share of
  the counted requests** — never folded into a class, never dropped — with the paths and the patterns that
  would catch them, because a mix computed from 40% of a log is a mix of something else.
- **`log_match`, a profile key with no effect on a run.** A list of path globs saying how a class looks in a
  log. A profile without it generates identical traffic and simply cannot have its mix measured. `validate`
  refuses a pattern that does not start with `/`: such a pattern can never match, and an unclassified share is
  a slow way to find that out.
- **`crowdsim init --access-log <file>` drafts the profile and measures its weights in one step**, through
  those same rules. The measurement travels into the file, not only to the terminal: `_classes_comment`
  records how many requests were classified, what share was not, and the window they came from; each measured
  class says so in its own comment. A class the log never showed keeps its placeholder weight and gains a
  `TODO: NOT ONCE in the log that was measured` — a class is not deleted because one window did not contain
  it, which is how a mix loses its long tail. Nothing from the log reaches `out/`: the draft receives counts,
  shares and a window, never a URL. `allow_hosts` and `safe_peak_rps` stay empty, as always.
- **A refusal rather than a confident mix.** More than half the lines unparsed is exit 2, quoting the lines
  as they were read and pointing at `--format` (`request`, `path`, `method`, `status`, `time`, `-`); a field
  that is not one of those is exit 2 rather than a column read by guesswork. A log that parses but matches
  nothing at all is exit 4, naming the paths. Non-GET and non-2xx/3xx are excluded and said so: this tool
  sends GETs only, so a write in the mix is a weight for load that will never be generated, and a 404 in the
  mix is a weight for requesting URLs that do not exist.
- **The GUI can warm up.** `--warmup` and `--warmup-peak` existed on the command line and not in
  `gui/server/lib/args.js`, so every run launched from the page folded its own cold start into the numbers —
  and the page is where the people least likely to know that are launching runs. The form offers both, the
  command preview shows them (the preview is the contract), and a blank rate is the ramp's own starting rate,
  which is what the driver does with it. **A warm-up is load**: the safe ceiling applies to it, the page says
  which of the two rates is over it before you click, and the refusal is still the driver's exit 3. New
  `gui/ui/src/lib/warmup.js`, tested in `tests/ui/warmup.test.js`.
- **The GUI hands over the report.** *Download report (.md)* on a result spawns `crowdsim report`, exactly
  like every other action, and serves the CLI's own file. The caveats are the point of that document, and a
  second renderer in the server would be a second opinion about what a run means. `GET
  /api/history/<run-id>/report`.
- **One run has an address.** `#history=<run-id>` opens that run's result, the same way
  `#history=<a>,<b>` opens a comparison — so a result can be handed over, report button included, instead of
  telling somebody which row to click.
- **`scripts/check-doc-output.sh`: the output quoted in the documentation is output the tool still
  produces.** It takes the distinctive wording out of every quoted block — validator refusals, panel lines,
  report sections, GUI banners — and asserts it still exists in the source it comes from. Wording only:
  numbers came from a real run on somebody's machine and will never match again, so a phrase is cut at any
  digit, path, URL, percentage or placeholder, and at column boundaries. A block that cannot be checked
  mechanically is **marked** `<!-- illustrative: why -->` and counted, not skipped in silence. `--self-test`
  plants a refusal the tool has never printed and asserts the checker catches it, naming file and line: a
  checker nobody has watched fail is a checker nobody knows the shape of. In CI, and in `make check-docs`
  alongside the other two.

### Changed
- **`crowdsim --help` no longer opens with `!/usr/bin/env bash`, and no longer stops at line 60.** The
  comment header is still the help text — it cannot drift from the script — but it is now extracted by
  structure, from line 2 to the first line that is not a comment. The old `sed -n '1,60p' | grep '^#'` had
  two silent failure modes and both were live: the shebang was printed as the first line of the help, and the
  header was one line from the ceiling that would have truncated it. `tests/cli/cli.bats` asserts both ends,
  and that every dispatched subcommand is named in the header.
- `history.tsv`, the exit-code contract and every existing flag are untouched. A profile with no `log_match`,
  a run with no warm-up and a GUI request without either field produce byte-identical commands to 1.17.0,
  asserted in `tests/gui/args.test.js`.

### Fixed
- **`init` drafted a pool reference that did not resolve.** The `pages` pool was written as
  `@<basename>`, which is read relative to the *profile*, so `crowdsim init --out ~/p.json` produced a
  profile whose pool file was not where the reference pointed. It is now a path relative to the draft's own
  directory. Found while measuring a mix against a freshly drafted profile: 80% of the log came back
  unclassified because the pool could not be read.
- **`init` taught the wrong key for the navigation parameter.** It drafted `rsc.query`, and the generator
  reads `rsc.param` (`k6/live-event.js`) — harmless while the value was the default `_rsc`, and silently
  wrong for any site that names it something else: every navigation request in the run would be a URL that
  site never serves. `init` now writes `param`, and `validate` warns when a profile carries `rsc.query`,
  naming the value that would be lost.

## [1.17.0] — 2026-08-31

The tool reported "completed" or "aborted" and left everybody to turn that into a capacity figure by hand,
which in practice means rounding up to `--peak` — the one rate nobody measured the system surviving. With the
ramp reported step by step (1.16.0), the sentence people actually came for is computable, and so is the
harder half: knowing when a run cannot support it.

### Added
- **The knee, named once: *clean up to 3 req/s, crossed at 4*.** New `k6/lib/knee.js`, in `summary.knee`, in
  the panel, in `report`, in `history.tsv` and on the page. It arrives with the two caveats that never
  survive retyping — that a rate the ramp swept through is not a rate that was sustained (only `--hold`
  sustains one), and that a knee at a synthetic pool of cold URLs is harsher than one at real traffic.
- **A knee is a crossing the system does not come back from.** A step that crosses and is then undone at an
  equal or higher rate is reported as a cold cache or noise, with `--warmup` as the fix, rather than as the
  knee. See below: this rule came from a run, not from a whiteboard.
- **Five refusals, each naming what to change**, because a knee gets quoted in rooms this tool is not in:
  fewer than two completed steps (one point is not a curve), nothing completed at all (the ramp already
  starts at or above capacity — lower `--start`), steps shorter than `--abort-delay` (the brake is not
  evaluated in them, so a step can pass while already crossing), a generator that did not hold the rate, and
  an unreachable target. The refusal is printed as loudly as the claim would have been: a quiet absence reads
  as *no knee found*, and then the peak gets quoted.
- **`history.tsv` carries `knee_clean` and `knee_crossed`**, empty rather than `0` when a run could not
  support a knee — and the GUI reads them as `null`, so a refused knee cannot arrive on the page as a knee at
  zero req/s. Rows written before these columns existed keep working: the parser is header-keyed.
- **The GUI plot is a curve, not only dots.** Selecting a run draws its own per-step shape — rate against
  p95, from a single run — over the historical dots, which are each one run's requested peak against its
  whole-ramp p95. The two are on the same axes and do not mean the same thing, and the page says so.
- **`report` leads with the knee**, and with the refusal when there is one.

### Fixed
- **A cold start was being reported as the knee.** A real run against a slow origin came back with p95 736 ms
  at 1→2 req/s and then 611 and 609 ms at the same rate; the first version of this feature announced *"the
  ramp starts at or above this system's capacity — lower --start"*. It was an empty cache. The rule is now
  that a crossing must persist to the end of the run to be the knee, and a transient one is named as what it
  is. This is the second bug in two releases found by running the thing against a real target instead of a
  metric tree.

## [1.16.0] — 2026-08-31

The number this tool hands over described a rate the system was never held at. A run climbs from `--start` to
`--peak` and then holds, and the summary reported one p50/p95/p99 over all of it — a mixture, dominated by the
cheap early steps. So the knee, the thing the tool is named after, could only be found by running four times
and comparing, while the shape of the curve was already inside every single run and was averaged away before
anybody saw it.

### Added
- **The ramp, step by step.** Every request is tagged with the step it happened in, and the summary carries a
  `per_step` block — requested rate, achieved rate, p50/p95/p99, failed rate, share past `guillotine_ms`, and
  the same per class — printed as a table under the per-class one. One run now shows where latency left the
  SLO. New `k6/lib/steps.js`, with the boundaries built from the same `stages()` the scenarios are: computed
  twice, they would disagree once, and a step table that does not match the ramp is wrong with authority.
- **A climbing step reports the range it swept, not a single rate.** A k6 stage ramps linearly from the
  previous target to its own, so labelling a step `20 req/s` when it went `15 → 20` is the same averaging one
  level down. The table prints `15→20`, and `20 held` for the hold — the only part of a run where a rate was
  actually sustained, and therefore the only one worth quoting.
- **A step the run died inside is marked partial**, with the reason in the summary and under the table: the
  brake fires while latency is climbing, so a fraction of a step is biased towards its worst part. Reported
  because it is evidence, marked because it is not a result. A step that sent nothing is absent rather than a
  row of zeros, which would read as a step that was fast, and requests still in flight when the last stage
  ends carry no step tag at all — crediting them to the peak would move the slowest requests of the run into
  the step people quote.
- The per-step thresholds exist only to make k6 surface the tagged sub-metrics: every one of them is `>=0`
  and none can abort, asserted in `tests/unit/brake.test.js`. Climbing a ramp is not a brake. A run with no
  ramp context — a journey, an older caller — gets no per-step block and prints exactly what it printed
  before, also asserted.

### Fixed
- **`achieved` per step, measured over the step's own window.** k6's `rate` field on a tagged sub-metric
  divides the count by the *whole* test duration: the first real run of this feature reported 1.7 req/s for a
  step that had delivered 7.5, which reads as a catastrophically slow generator and is an artefact of the
  divisor. Found by running it against the e2e target rather than trusting the metric tree.

## [1.15.0] — 2026-08-20

Milestone v1.7.0: four things the tool knew and did not hand over. It had measured the page weight, the cache
layers and a pool that renders, and still left writing the first profile entirely to you. It could tell a
document from a navigation request everywhere except in the one place it matters, the brake. It knew the first
thirty seconds of a run are a cold cache and folded them into the p95 anyway. And it produced a result nobody
could paste anywhere without leaving the caveats behind.

### Added
- **`crowdsim init` drafts a first profile from what has already been measured**, and says which run each part
  came from — the target and page weight from the newest `probe`, the verified pool from `discover`, the
  fan-out from `record`. Writing the first profile is the highest step in this tool, and most of it was
  sitting in `out/` with nothing to assemble it. What it refuses to do is the point: `safety.allow_hosts`
  stays empty, because filling it in would be crowdsim authorising a host on your behalf, and
  `safety.safe_peak_rps` stays empty, because that is a decision about how far somebody's production may be
  bent. Everything else it cannot measure — the class weights above all, since the tool does not read edge
  logs — is a `TODO` rather than a plausible number. `validate` refuses the draft until a human has been
  through them, which is the actual guard. It never overwrites a file, refuses to write into the profile
  directory, and with no artefacts at all exits 4 naming the two commands to run first.
- **A class can declare its own `max_p95_ms` or `max_failed_rate`.** One SLO for every class was one too few:
  a document at 2.5 s is unpleasant, a navigation request at 2.5 s means the app is already queueing, and
  waiting for a shared 5 s limit spends a minute measuring a system that was already gone. Per-class limits
  may only be **sharper** — a looser one is refused by `validate`, since it would move the knee later than the
  profile asks for — and a limit tight enough to abort on the ramp is a warning. The thresholds are built in
  `k6/lib/brake.js`, with the invariant under test: a profile that declares no per-class SLO gets exactly the
  thresholds it got before.
- **The run says which class and which threshold stopped it**, in the panel, in `summary.aborted_by`, in the
  GUI's banner and in the report. With per-class SLOs "the brake tripped" stopped being enough to act on. Runs
  archived before this show the verdict without the detail rather than a culprit reconstructed from the
  profile — that would name a class that may not be the one that crossed.
- **`--warmup <dur>` runs the generator once before the measured run and throws the numbers away** (to
  `warmup-<run>.json`, which is not a result and has no brake). The first thirty seconds of any run measure an
  empty cache, a cold pool and an unJITted app, and they sit inside the p95 you are about to quote; with a
  sharp per-class SLO they abort the run and read as a knee that is not there. `--warmup-peak` defaults to
  `--start` and passes the same safe-peak gate as anything else.
- **`crowdsim report <run-id>`** writes one run as markdown for the place results actually go — a ticket, a PR,
  an incident timeline — with the caveats attached to the numbers, because the caveats are what does not
  survive retyping. Validity first, then what happened, then the numbers, then what they are worth. A run with
  `generator_ok: false` comes out as **DISCARD THIS RUN** with no latency table to quote; `--compare`
  delegates to `compare`, refusal included.
- **`validate` refuses a profile that is still a draft**: a `TODO` left in any value (`_comment` fields
  excepted — that is where the instructions live), an `slo.max_p95_ms` or `guillotine_ms` that is not a
  positive number, and an `allow_hosts` declared as `[]`. A non-numeric SLO does not fail loudly; it makes
  every threshold pass, so the run cannot brake at all. One diagnosis per field, never two.

### Fixed
- **`crowdsim history` could not run inside the published image.** It formatted with `column(1)`, which comes
  from util-linux and does not exist in busybox — so the one subcommand whose entire job is to print a file
  exited 127 in the container. It aligns in python3 now, which was already a hard runtime dependency.
- **`make image-smoke` could pass against an image built three releases earlier.** It did not build first, and
  the assert did not compare the image to the working tree: the run that closed this reported a healthy image
  labelled 1.14.0 while the tree was 1.14.1. This is the suite that guards the invariant nobody may regress —
  no allowlist default in the image — so a stale pass is the worst kind. It builds first, and says so if the
  label and the tree disagree.

## [1.14.1] — 2026-08-07

Cutting 1.14.0 broke the check 1.14.0 had just added — the fastest possible proof that a repair and its
detection have to read the same lines.

### Fixed
- **`scripts/check-doc-versions.sh --fix` could not fix everything the check flagged.** The fixer rewrote
  the image references and left the `# or :1.13` comment beside them, which the widened detection then
  refused. So the release that introduced the guard left a tree the guard rejected and its own `--fix`
  considered done: a blocked release with no way forward but editing by hand. Both halves read the same
  lines now — an image reference and a bare tag mentioned on a line that talks about crowdsim.

## [1.14.0] — 2026-08-07

Milestone [v1.8.0](https://github.com/HiWay-Media/crowdsim/milestone/9): the distance between what ships and
what was tested, and between what the documentation promises and what exists. Nothing here was failing —
that is the point. Nothing was watching.

### Added
- **`crowdsim --version`, and an image that knows which one it is**
  ([#47](https://github.com/HiWay-Media/crowdsim/issues/47)). The question gets asked while something is
  going wrong, by somebody looking at a container pulled minutes ago — and nothing inside the image could
  answer it: the CLI had no flag, and the GUI reads a `package.json` the image does not contain, so
  `/api/env` returned `null`. The version is baked at build time (`ARG` + the OCI version label, so
  `docker inspect` answers too), the driver reports it, and the page shows it. `docker run … crowdsim
  --version` now prints it; the smoke test fails the build if it says `unknown`.
- **CI runs the e2e suite against the k6 the image actually pins**
  ([#46](https://github.com/HiWay-Media/crowdsim/issues/46)). It pins 0.52.0 while every test here had run
  against 2.1.0 — two majors apart, because the suite installs whatever is newest on the runner. So the
  generator users receive had never been the generator the evidence came from. A second job reads the pin
  from the Dockerfile and runs the whole suite on it, and the suite now records which k6 produced its
  numbers — in the archive and out loud:

  ```
  ▶ generator: k6 v2.1.0 …
  ⚠️  the image ships k6 0.52.0 — these results come from a different generator
  ```

  The brake is why this matters: it is a threshold with `abortOnFail`, so a changed syntax or a renamed
  metric produces a run that no longer stops.
- **CI checks the two claims the documentation makes about itself**
  ([#48](https://github.com/HiWay-Media/crowdsim/issues/48)). `scripts/check-doc-commands.sh` asserts that
  every `--flag` the docs hand to `crowdsim` is one the driver parses, and executes the commands that need
  nothing at all. What needs a target, a profile or docker is out of scope **and says so** — pretending
  otherwise would be a green tick with nothing behind it. Proved it can fail before trusting it.
- **What `doctor` knows, in the page** ([#49](https://github.com/HiWay-Media/crowdsim/issues/49)): version,
  k6, output directory, allowlist, and the generator ceiling `doctor --bench` measured — with the caveat the
  artefact carries. A ceiling measured inside a VM is shown as exactly that and never as a ceiling, so the
  page cannot undo the fix 1.13.1 made to the estimate. The page does not offer to run the benchmark: that
  generates load, and a report that starts traffic on its own is not a report.

### Fixed
- **The documentation told people to pull an image from eleven releases ago.** README and `docs/docker.md`
  said `:1.2.0` — and called it "exact version — use this" — while the Kubernetes manifests said `:1.4.1`
  and the Nomad job and compose file `:1.2.0`. Following the documented path got you a build from before the
  bandwidth estimate, `discover --verify` and the validator. All twelve references are current, and they
  stay current by construction: `scripts/new-release.sh prepare` moves them, and
  `scripts/check-doc-versions.sh` fails CI when they drift — the same way a broken relative link already
  does. That the deployment manifests were among them is the part worth remembering: this was not a
  documentation typo, it was the path somebody deploys with.

## [1.13.2] — 2026-08-07

The e2e suite died in CI on `warn: command not found` — a helper used only by branches this machine never
takes, in a check that CI could not have run anyway.

### Fixed
- **`tests/e2e/run.sh` called a `warn` helper that was never defined.** It is used by exactly two paths — no
  browser, and no built UI — and this laptop takes neither, so the browser pass added in 1.13.0 shipped with
  a `command not found` waiting on the first machine that did. Both paths are now defined, and both were
  *executed* before this was committed: `CROWDSIM_CHROME=/nonexistent make test-e2e` for the first, the
  built UI moved aside for the second.
- **The rendered-page check would have skipped on every CI run**, which is the same as not having it. The e2e
  workflow ran `npm ci` and never built the UI, so `gui/ui/dist` never existed there. It builds it now, and
  the prerequisite step fails loudly if the build is missing rather than letting the check disappear —
  the same rule that already applies to docker and k6 in that job.

### Changed
- `CROWDSIM_CHROME` names the browser for the rendered-page check, and **is a constraint rather than a
  preference**: set it to something unusable and the check is skipped with the reason, instead of quietly
  falling back to another browser. Somebody who names a browser wants that one — and it is what makes the
  no-browser branch reachable on a machine that has one.
- `docs/development.md`: a branch that only runs elsewhere is a branch you have not run, with the two
  commands that take the e2e suite's skip paths.

## [1.13.1] — 2026-08-06

Three bugs, none of them on the tracker: found by building the container image for the first time since
`bin/`, `k6/` and `gui/` all changed, and by running the suite on a clean clone the way CI does.

### Fixed
- **A generator ceiling measured inside a VM was used as reassurance.** `doctor --bench` in a container on a
  macOS or Windows host measures loopback *inside the VM* — 16 640 Mbit/s on the machine that found this —
  and stored it with no record of where it came from. `load` then compared a real peak against that number
  and said nothing. So the check that exists to predict `generator_ok: false` was silenced by a measurement
  from the one environment that guarantees it, which is worse than having no measurement at all.
  - The benchmark now warns while measuring, and the artefact records `in_container`, `kernel` and
    `virtualised` with a caveat that replaces the ordinary one.
  - The bandwidth estimate **refuses to use a virtualised measurement as a ceiling** and asks for
    `safety.generator_mbps`, or for a benchmark taken on the host that will generate the load.
  - Verified in the real scenario, not a fixture: `--bench` inside the published image on this laptop, then
    a run that reads it back.
- **`crowdsim compare` crashed on a summary written by an older version.** A missing `dur` produced a Python
  traceback and **exit 1** — a code that is not in the contract at all, which schedulers, the bats suite and
  the GUI all read. Through `--json` it reached the page as unparseable output and a 500. It is a refusal now,
  like every other pair that cannot be compared: exit 2, the run named, the missing field named, and the
  reason stated (an archive outlives the version that wrote it).
- **A GUI test could not run as root**, which is every container, including the clean-checkout run the suite
  is meant to be safe for: root ignores the `0500` directory the read-only-mount test depends on, so the
  write succeeded and the test failed for a reason unrelated to the code. It skips as root now, saying why —
  the same choice the e2e suite makes without docker.

### Changed
- `docs/cli.md` states the trap plainly: run `doctor --bench` on the host that will generate the load, and
  what the artefact records about where it was taken.

## [1.13.0] — 2026-08-06

Milestone [v1.5.0](https://github.com/HiWay-Media/crowdsim/milestone/6): the five defects the GUI audit found,
fixed test-first — which is the rule 1.12.0 wrote down, applied for the first time.

### Fixed
- **The page no longer goes silent when it loses the live log**
  ([#31](https://github.com/HiWay-Media/crowdsim/issues/31)). It used to be one line —
  `es.onerror = () => es.close()` — which threw away EventSource's own reconnection *and* said nothing, so a
  server that went away looked exactly like a run that had gone quiet while the pill still read *running*.
  Now the retry is left to the browser, a banner says the log was lost and that it is reconnecting, and after
  enough failed attempts it says the server is not answering and points at `out/`, where the driver's own log
  and summary are. **The run's status stops being asserted while the connection is down**: it reads *not
  known*, because the state of the connection and the state of the run are two different things.
  - A reconnect now receives one `snapshot` event with everything the server has, replacing the log instead
    of appending a second copy of it. The old protocol replayed individual `line` events, which a
    reconnecting client cannot tell from new output.
  - Verified by reproducing the audit's own scene: a run in flight, the server killed, the page screenshotted.
- **The run log no longer costs more to render than the run costs to produce**
  ([#32](https://github.com/HiWay-Media/crowdsim/issues/32)). It was `join('\n')` on every appended line:
  measured at 760 MB of strings and 215 ms of join time over the 4000 lines the server keeps, before React
  reconciles a 371 KB text node — once per line, on the machine generating the load. Lines are batched now
  and published on a 200 ms tick, and the buffer says how many earlier lines it dropped and where the whole
  log lives.
- **The archive is reachable without a mouse** ([#33](https://github.com/HiWay-Media/crowdsim/issues/33)).
  History rows and knee-plot points carried `onClick` and nothing else, while the comparison checkboxes
  beside them were focusable — half a panel reachable is worse than either whole answer. They are focusable
  and activatable with Enter or Space now, they announce themselves, and focus is visible in a page that is
  mostly dark and mostly grey. A modified key press is left to the browser.
- **`crowdsim serve` explains a startup failure instead of dumping a stack**
  ([#34](https://github.com/HiWay-Media/crowdsim/issues/34)). A busy port printed an `EADDRINUSE` object, a
  syscall name and a Node banner, and exited 1. It now names the port, names the likely cause — another
  `crowdsim serve` — and exits 2. The same for an address this host does not have, a privileged port, and a
  profile directory that does not exist. This was found by accident during the audit, and it is how a
  three-release-old server went unnoticed: the new one died quietly and the stale page looked current.
- **The page is usable on a small screen** ([#35](https://github.com/HiWay-Media/crowdsim/issues/35)). Below
  760 px the navigation stops holding a column of its own, the brand stops wrapping onto three lines, and the
  form gives one field per line instead of two half-legible ones. The safety block is deliberately unchanged
  at every width: the allowlist verdict and the safe-peak warning are the last things that should lose room.

### Added
- The new behaviour has tests before it had code, per suite: `tests/ui/stream.test.js` for the connection
  states and the line buffer, `tests/gui/startup.test.js` for the startup messages and the snapshot contract,
  and a keyboard-reachability assertion in the e2e browser pass — which can see what a DOM-less suite cannot.

### Changed
- `docs/gui.md` documents what a lost stream looks like, and gains two troubleshooting rows for the failures
  that now explain themselves.
- One existing GUI test changed with the protocol it pinned: the stream's replay is asserted as a snapshot,
  not as `line` events. It failed for the right reason, which is what a contract test is for.

## [1.12.0] — 2026-08-06

Milestone [v1.6.0](https://github.com/HiWay-Media/crowdsim/milestone/7): the front end had 1415 lines and no
test of any kind. The rule "every fixed bug starts with a test that reproduces it" had held everywhere except
the one place with nowhere to put such a test — and it showed, in bugs found by screenshotting the page.

### Added
- **`tests/ui/`, and `make test-ui` inside `make test`**
  ([#37](https://github.com/HiWay-Media/crowdsim/issues/37)). The runner is `node --test`, the same one the
  rest of the repository uses, because the decisions under test are plain ES modules with no JSX and no React
  import — verified, not assumed, before choosing. That keeps one runner and adds **no dependency** to a UI
  that carries react and vite and nothing else; a testing framework larger than the app would have been a
  poor trade. What the choice costs is written down rather than discovered later, and `tests/ui/00-harness`
  proves the suite can fail and that it is loading the app's own modules, the way
  `tests/cli/00-environment.bats` does for the CLI.
- **The front end's decisions live in `gui/ui/src/lib/`**
  ([#38](https://github.com/HiWay-Media/crowdsim/issues/38)), the way `k6/lib/` holds the generator's: which
  run to show on load, when a result stops belonging to the form, the tab and comparison pair in the URL
  fragment, which of two runs is A, how a delta is painted, whether a host matches the allowlist. The
  components read as wiring, and the states nobody clicks through by hand — an empty archive, a run with no
  summary, a refusal, a header that never appeared — are covered.
- **A test per front-end bug that actually shipped**
  ([#39](https://github.com/HiWay-Media/crowdsim/issues/39)), named after the trap rather than the function:
  the reload that discarded a finished run, the comparison pair with no defined direction, the tab that lived
  only in React state, and the run-id shape that made a probe's result unreachable.
- **Safety-surface tests** ([#40](https://github.com/HiWay-Media/crowdsim/issues/40)) for the three parts of
  the page that are not conveniences: the safe-peak block (two deliberate acts, nothing remembered, and
  reading the armed command is not arming it), the refusal card (the reason and **no numbers**), and
  `unknown` never being painted as `MISS` or as 0%. The sentences they assert now live in
  `gui/ui/src/lib/messages.js`, because wording inside JSX has no reviewer but the diff.
- **A rendered-page check in the e2e suite**, because none of the above can prove a component renders any of
  it: one real browser, the real bundle, the real server, asserting the archive is on screen and that a clean
  run and a knee are told apart. It skips loudly without Chrome — a check that quietly disappears is worse
  than one that is missing on purpose. It earned its place immediately by failing on a wrong assertion of
  mine (it looked for an "invalid" run in an archive that has none); the page was right.

### Changed
- `docs/development.md` gains the suite, what the layer cannot cover, and the rule: **a UI change starts with
  a failing test**, with one stated exception so it is not argued about per commit — a purely visual change
  (spacing, a colour) does not get one. The same rule is in `AGENTS.md` and `CLAUDE.md`, where it is read
  before a change rather than after.
- CI runs the new suite alongside the others.

## [1.11.0] — 2026-08-05

The backlog, cleared. Both items are the same shape: the tool knew something and was not saying it.

### Added
- **`crowdsim cache-ab --run`** ([#29](https://github.com/HiWay-Media/crowdsim/issues/29)) loads each leg
  with the same profile at the same peak and then prints the delta, instead of bringing the legs up, printing
  two `crowdsim load` lines, and leaving the comparison to whoever remembers to make it. The whole reason for
  two legs is the number between them.
  - **Sequential, not concurrent.** Two generators at once on one host measure the host, and the delta they
    produce is between two runs throttled by the same laptop. The cost is that "same window" means the same
    session rather than the same second, and the output says that rather than glossing over it.
  - The comparison is `crowdsim compare`, refusals included — demonstrated the first time it ran here, where
    both legs 502'd and it refused to produce a delta between two runs that never reached their target.
  - **It grants itself no allowlist.** The legs are on `127.0.0.1`, so that host must be allowlisted like any
    other; the check runs before a container starts. A subcommand that can authorise a host on your behalf
    turns the gate into a suggestion.
- **A load run inside a VM says so before it generates anything**
  ([#30](https://github.com/HiWay-Media/crowdsim/issues/30)). That the Docker network layer on macOS and
  Windows saturates before the target does is measured and was documented in three places — while the tool
  let the run happen and reported `generator_ok: false` afterwards, which is the failure the bandwidth
  estimate exists to pre-empt.

  Detection is `/.dockerenv` (or the cgroup path) plus a `linuxkit` / `WSL` kernel release — verified from
  inside a container rather than assumed. It **warns and does not refuse**: the signal misses every VM
  runtime that does not brand its kernel, and refusing on a check with false negatives buys nothing, while
  its one false positive (Docker Desktop on a Linux host) is a case where the warning is still right, because
  the VM boundary is the problem. A detection that can be wrong must not become a gate. The GUI is
  unaffected — it is a page, not a generator.

### Changed
- `cache-ab/README.md` documents `--run` and one trap found by running it: both leg templates proxy to
  `${ORIGIN_ADDR}:443`, so a plain-HTTP origin answers 502 on every request and the run reads as "target
  never answered". Correct behaviour, confusing for ten minutes.

## [1.10.0] — 2026-08-05

Milestone [v1.4.0](https://github.com/HiWay-Media/crowdsim/milestone/5), and one theme: a judgement that
already exists should not depend on which interface you opened, or on a number nobody re-measured.

### Added
- **Two runs compared in the GUI** ([#27](https://github.com/HiWay-Media/crowdsim/issues/27)). Tick two runs
  in History and press Compare: overall, per class and per cache layer, improvements and regressions marked
  differently.

  **The page decides nothing.** `crowdsim compare` grew a `--json` mode, the server spawns it, and the card
  renders what came back — the same verdict, the same refusals, the same wording a terminal would print. A
  second copy of "are these two runs comparable" living in the server would be the one on screen the day the
  two disagreed, and a delta between two different experiments looks exactly like an answer. There is a test
  that asserts the endpoint and the CLI return byte-identical structures.
  - A refusal is rendered as prominently as a result: `422` from the API, a red card in the page, no numbers
    at all. Not a 200 with an empty table.
  - A comparison has an address — `#history=<run-a>,<run-b>` — so the delta can be pasted into an incident
    doc and reopened by somebody else.
  - The two run ids are matched against the run-id shape before they reach a spawn argv, for the same reason
    profile names are checked before they become a path.
- **`crowdsim doctor --bench`** ([#28](https://github.com/HiWay-Media/crowdsim/issues/28)) measures what this
  machine can generate, instead of trusting a `safety.generator_mbps` typed by hand. A throwaway HTTP server
  on loopback, k6 against it in a closed model, and the result in `out/bench-<run>.json`, which the bandwidth
  estimate reads when the profile declares nothing.

  ```
  ✅ this generator: 45068 req/s of 45 KB → 2080.0 MB/s (16640 Mbit/s)
     ⚠️  loopback: this is the CEILING of this machine, not a prediction.
  ```

  The caveat is part of the number, and it is stored inside the artefact so a value read back next month
  carries it too. Loopback is the best network this generator will ever see.
  - **A declared `safety.generator_mbps` still wins**, and when the fallback is used every line says so —
    including the warning, which reads `WAS MEASURED DOING ON LOOPBACK` rather than `IS DECLARED TO SUSTAIN`.
  - **Plain `doctor` never benchmarks**: a report that quietly starts generating traffic is not a report.
  - It stays a warning, never a gate, like the estimate it feeds.

### Changed
- `crowdsim compare` computes its result once into a structure and then either prints prose or dumps JSON,
  rather than printing as it goes. That is what makes one verdict serve both interfaces; the text output is
  unchanged, and the eleven existing tests still pass against it unmodified.
- The millisecond formatting in `compare` follows the size of the number (`0.87 ms`, `140 ms`): sub-millisecond
  deltas on a loopback target used to print as `+0 ms (+67%)`, which reads like a broken calculation.

### Fixed
- The benchmark's local server is node, not python3, even though python3 is the driver's own dependency:
  `http.server` is a thread per connection and folded at a few hundred req/s on loopback, with k6 reporting
  connection resets. Measured, and caught before shipping — it would have made `--bench` report the toy
  server's ceiling while calling it the generator's, which is the exact species of confidently wrong number
  this tool exists to avoid.

## [1.9.1] — 2026-08-05

### Changed
- `docs/development.md` names what is next instead of leaving it as "whatever is open on the tracker":
  milestone [v1.4.0](https://github.com/HiWay-Media/crowdsim/milestone/5) is two runs compared *in the page*
  with the same refusals the CLI applies, and `doctor --bench` measuring what this generator can sustain
  rather than trusting a `safety.generator_mbps` somebody typed once and copied between profiles. One theme:
  a judgement that already exists should not depend on which interface you opened, or on a number nobody
  re-measured.

## [1.9.0] — 2026-08-05

The last open feature on the tracker: the cache A/B third leg stops costing a compose edit.

### Added
- **A third cache-ab leg without editing `docker-compose.yml`**
  ([#14](https://github.com/HiWay-Media/crowdsim/issues/14)). The useful third leg is the **narrow subset** of
  a fix — the version you can actually ship this week — measured in the same window as the full change, so
  you learn what shipping the narrow one is worth. It used to require copying a service block by hand, which
  is how a comparison quietly stops being made.

  ```bash
  crowdsim cache-ab --new-leg narrow-fix.conf.template          # a copy of the candidate, renamed
  crowdsim cache-ab --profile p.json --third narrow-fix.conf.template
  ```

  The service is declared behind a compose profile, so a normal two-leg run is unchanged — `docker compose
  config` still reports exactly `asis` and `candidate` until `--third` asks for more.

  Two refusals (exit 2), both about the result being readable rather than about nginx starting:
  - **A leg template that does not carry the candidate's warning** about ignoring the origin's
    `Cache-Control`. A third leg is a copy of the candidate, and a copy is exactly where that paragraph goes
    missing — it is the difference between a measurement and serving one visitor's response to another.
    `--new-leg` carries it across by construction; a hand-written leg is checked before anything starts.
  - **A leg still identifying itself as `candidate`** in `X-AB-Leg`: two legs answering with the same name
    cannot be told apart in the results, which turns the exercise into one number with two sources.

  `--new-leg` refuses to overwrite a leg somebody has already written, refuses the reserved names `asis` and
  `candidate`, and builds the file in a temporary path so a leg that fails its own checks is never left on
  disk. The whole thing goes through the allowlist gate like every other target.

### Changed
- `docs/development.md` no longer lists milestone v1.3.0 as planned work — it is delivered — and states the
  two things this project has decided *not* to build (a scheduler in the GUI, edge-log parsing), so neither
  is proposed again as an oversight.

### Fixed
- Two bugs in the scaffolding, both found by running it rather than reading it: the `X-AB-Leg` rename was
  anchored at column 0 while the directive is indented inside the server block, so the copy silently kept the
  name `candidate` — and the check that should have caught it used an invalid BRE, so it failed for the wrong
  reason. The check is an ERE now, and it runs before the file is moved into place.

## [1.8.0] — 2026-08-05

The last two items of milestone v1.3.0: the comparison that carries the meaning, and a way to produce the
journey file the journey shape has always needed.

### Added
- **`crowdsim compare <run-a> <run-b>`** ([#13](https://github.com/HiWay-Media/crowdsim/issues/13)) — overall
  and per-class p50/p95/p99, failed rate, share past the read timeout, 504s and the cache hit ratio per
  layer, with an improvement and a regression marked differently.

  **What it refuses is the feature**, because this tool measures deltas honestly and absolutes optimistically,
  so a comparison is the claim people actually make out loud. Exit 2, with the reason, when either run has
  `generator_ok: false` (that run has no numbers at all), when either never reached its target, when the URL
  pools differ (two different experiments — compared from the archived `profile-<run>.json`, which is why it
  is archived), or when the shapes differ. A different **target** or **peak** is a legitimate question, so it
  is allowed and *stated*: the report says this is a comparison between two targets, not a before/after of
  one. A cache header that never appeared stays `n/a` in the delta and is never called 0%.
- **`crowdsim record <file.har>`** ([#21](https://github.com/HiWay-Media/crowdsim/issues/21)) — a browser HAR
  export becomes the `{path, rsc[], static[]}` journey file `--shape journey` needs. The instruction used to
  be "record it with a real browser" with no way to turn the recording into the file, so the mode went unused
  and the mix shape carried load nobody clicks.

  Four judgements, each of them a way to end up measuring something other than your own site, and each unit
  tested in `tests/unit/har.test.js`:
  - **Third-party hosts are dropped.** Analytics and fonts are not your capacity problem, and generating them
    would aim load at somebody else's infrastructure — from a tool whose premise is that you only hit hosts
    you explicitly allowed. The output names whose they were.
  - **Per-request cache-busters are stripped; per-build ones are kept.** Measured, not guessed from a list of
    parameter names: if a value *varies* between requests to the same path it is noise, and keeping it turns
    the recording into a pool of unique cold URLs — the pool that makes any cache look useless. A constant
    value is a build hash, part of the URL the cache sees, and dropping it would measure a URL that does not
    exist. `?build=9f2c1` survives, `?_=1754400000123` does not.
  - **The navigation parameter is stripped entirely**, because the generator adds it back itself and whether
    it repeats or is randomised is the experiment (`rsc.mode`).
  - **Failures and non-GET requests are not recorded.** A 404 in a journey is a load test of your error page.
  - The origin travels inside the file — a journey recorded against staging says nothing about production's
    fan-out — and `record` **refuses to write into the profile directory**: a journey names real routes, the
    same category as a URL pool, and the profile directory is the one that gets committed. It also refuses to
    overwrite an existing recording without `--force`. Exit 4 when nothing usable was recorded, saying what to
    record instead ("Preserve log" on, and a page *load*, not just the XHRs after it).
  - Verified end to end, not just parsed: a HAR built from the requests a real Chrome made, then
    `--shape journey` against a local target — 4 sessions/s produced 24 documents, 162 navigation requests
    and 96 assets, in the ratio the recording described.

### Changed
- `docs/cli.md` documents both, with the refusal table for `compare` and the four judgements for `record`;
  `docs/running-a-test.md` puts them in the sequence (record before a journey run, compare after two runs);
  `docs/profile.md` points `journey.file` at the command that writes it.
- The CLI suite is now 118 tests: 11 for `compare` (mostly refusals) and 11 for `record` (mostly the two
  guards that protect a repository rather than a measurement).

## [1.7.0] — 2026-08-05

The three GUI items of milestone v1.3.0, and a documented walkthrough with real screenshots. Writing that
walkthrough found three bugs, which is the reason the rule about trying every documented step exists.

### Added
- **The command is readable before it runs** ([#22](https://github.com/HiWay-Media/crowdsim/issues/22)). The
  run panel shows the argv the server will spawn, live as the form changes, pasteable into a terminal with
  `CROWDSIM_ALLOW_TARGETS` included — without it the CLI exits 3 and the copy would confuse rather than help.
  - **It is not assembled by the page.** `POST /api/preview` and `POST /api/runs` go through one
    `resolveArgv`, and `gui/server/lib/command.js` only renders that array. A preview built separately is a
    description of what the server probably does, and the first time the two drift it is a wrong answer
    delivered exactly as somebody authorises real traffic. The test asserts array equality between what was
    previewed and what was spawned, not similarity.
  - The preview renders `--i-know-this-breaks-production` as soon as the box is ticked, and says you are
    reading it armed. Nobody should have to type a confirmation in order to *read* what a flag will do —
    and reading it buys nothing: the launch still demands the profile name, per run.
  - It doubles as live validation: `peak: lots` comes back as a field error before the button exists.
- **`probe` and `discover` come back as data**
  ([#24](https://github.com/HiWay-Media/crowdsim/issues/24)). Both commands now write their result as JSON
  next to their log, and the GUI renders tables from those files rather than scraping terminal output.
  - `out/probe-<run>.json` carries a verdict per declared cache layer: the header, what it said, and whether
    that counts as a hit under the profile's own pattern — with **three** answers, not two. *Never appeared*
    is kept distinct from *miss*, because the first is a wrong header name in your profile and the second is
    a cold cache, and reporting the first as a miss puts a confident 0% hit ratio next to a layer the request
    never crossed. Same rule as `k6/lib/classify.js`, so the preflight and the run cannot disagree.
  - Only cache-relevant headers are stored. A probe against a real site can come back with `Set-Cookie`, and
    a run archive is not the place for somebody's session — asserted in the e2e suite.
  - `out/discover-<run>.json` carries what the sitemap offered, what survived `--limit`, whether verification
    ran, and every dropped path with its reason and status. `verified: false` is stated rather than implied.
- **A restart no longer loses the run** ([#23](https://github.com/HiWay-Media/crowdsim/issues/23)), and the
  page now says which of two things happened — see *Changed* for what was measured.
  - `out/gui-run.json` holds one line of state: id, kind, pid, argv, run id. On startup the server checks it.
  - A pid still alive is **adopted**: listed, counted for one-run-at-a-time (a rebuild must not become two
    generators), stoppable by pid, and followed through the driver's own run log file. It never invents an
    exit code — this server was not there when it ended.
  - A stop that cannot be delivered says so and gives the command: `kill -INT <pid>`.
- **A step-by-step [GUI guide](docs/gui.md) with eight screenshots**, all from real runs against a local
  target, plus a troubleshooting table of symptom → cause → fix. Reloading the page keeps the last result,
  and each tab is a link (`#run`, `#profiles`, `#history`).

### Changed
- **What happens when the GUI server dies was measured, and it is not what the issue assumed.** Kill the
  server and the driver *and* k6 are gone within about two seconds: the driver's stdout is a pipe held by the
  server, so the next write fails and `set -eo pipefail` takes the run down. The child is therefore
  deliberately **not** detached — a load generator whose supervisor is gone is precisely the one nobody can
  see and nobody can stop. So the common case after a crash is not "still running" but "interrupted", and the
  page now states that plainly, recovers the driver's log from disk, and points at the archive instead of
  showing an empty list. Adoption remains for the case where the process does outlive the server.

### Fixed
- **A probe run's own result was unreachable from the GUI.** The runner recognised only the run id shape
  `load` prints (alone on a line) and not the one `probe` prints (inline with the base url), so a probe never
  had a run id — and therefore no route to `out/probe-<run>.json`, the file with the answer in it. Both
  shapes are now read, and prose that merely contains the word "run" still is not.
- **`discover` never announced its run id at all**, so the report it writes existed under a name nothing
  could know. It now prints it the same way `probe` does.
- **Reloading the page threw away the finished run.** The effect that loads a profile also cleared the last
  result, and it runs on first load too — wiping the run just restored from the server and leaving the page
  looking like nothing had ever happened. Clearing now happens where it belongs: when somebody actually
  selects a different profile, because a result belongs to the profile it came from.

## [1.6.2] — 2026-08-05

CI failed on one wrong digit, and the interesting part is why no local run ever caught it: on macOS the CLI
suite **could not fail at all**.

### Fixed
- **`tests/cli` was decorative on every macOS machine, and `make test-cli` now refuses to run there.** bats
  reports a failing assertion through `errexit`, and under bash 3.2 — still `/bin/bash` on macOS — a failing
  `[[ ... ]]` does not trip it. This suite is written in `[[ ]]`, so all ~300 content assertions were no-ops:
  it printed `92 ok` on a driver that could have printed anything. `[ ]` and `false` do trip errexit; the
  compound `[[ ]]` does not, which is why nobody noticed.
  - `make test-cli` looks for a bash that can fail and stops with instructions if there is none
    (`brew install bash`). `bin/crowdsim` itself is unaffected and still runs on 3.2.
  - `tests/cli/00-environment.bats` sorts first and is the canary for anyone running `npx bats` directly. It
    asserts with `[ ]`, and its second test *proves* the property rather than assuming it: a subshell running
    `set -e; [[ "hello" == *"NOPE"* ]]` must exit non-zero. On bash 3.2 it exits 0, and the test says so.
  - Verified both ways: 94/94 under bash 5, a clean refusal under 3.2.
- **The bandwidth estimate: the expectation was wrong, not the driver.** 380 req/s × 46231 B is 140.54
  Mbit/s, which prints as `141`; the test, `docs/cli.md`, `profiles/example.json` and the 1.6.0 note all said
  `140`. Written by hand instead of read off a run — exactly what this project's documentation rule exists to
  prevent — and the one place that would have objected was the suite that could not fail. All four now agree
  with the arithmetic.

## [1.6.1] — 2026-08-05

Housekeeping after the documentation site landed.

### Fixed
- **`scripts/__pycache__/mkdocs_hooks.cpython-313.pyc` had been committed.** MkDocs imports
  `scripts/mkdocs_hooks.py` as a module, so every local `make docs` leaves bytecode next to it — versioned
  build output that changes with the interpreter and belongs to nobody's checkout but the one that produced
  it. It is untracked now, and `__pycache__/` is ignored by both git and the Docker build context.

## [1.6.0] — 2026-08-05

Two of the three ways a run quietly measures the wrong thing now get answered before the run, not after.
And writing the test for the first of them found that `discover` had been producing an empty pool since
1.0.0.

### Added
- **`discover --verify`** requests each discovered path and keeps only what answers 2xx, reporting what it
  dropped and why (`out/pool-<run>.report.txt`, which also records when it was verified). A 404 is cheap for
  the app tier — or is itself rendered — and a 307 measures a redirect: a pool of either yields a flattering
  capacity number for a load that never reached the renderer. The previous instruction was "verify them
  before using them", which for 400 URLs means nobody did.
  - Sequential, paced by `CROWDSIM_VERIFY_DELAY` (0.05s): building a pool must not itself be a load test.
  - It goes through the same allowlist gate as everything else, and refuses to leave you with nothing —
    if every path is dropped it exits 4 rather than writing an empty pool.
- **The bandwidth a peak implies, before the run.** `probe` now also writes `out/probe-<run>.json` with the
  page weight, and `load` and `doctor --profile` state what the requested rate needs:
  `380 req/s × 45 KB ≈ 17.6 MB/s (141 Mbit/s) sustained`. Declare the optional
  **`safety.generator_mbps`** and it is compared, loudly:
  *THAT IS MORE THAN THE 100 Mbit/s THIS GENERATOR IS DECLARED TO SUSTAIN. Expect generator_ok: false.*
  - `generator_ok: false` is otherwise diagnosed after the window was agreed and the run burned, and most
    of those runs were predictable beforehand. `probe` had already measured the number; nothing was using it.
  - A **warning and never a gate**: the estimate assumes every request weighs what that one page weighed,
    which is wrong in both directions, and a wrong estimate must never stop a run somebody needs. The one
    thing it must not do is stay silent.
- `tests/cli/discover.bats` — the sitemap is read through a `file://` URL, so parsing is covered without
  sending a request: distinct paths, locale stripping, `--limit`, and the two loud failures. Plus four CLI
  tests over the bandwidth estimate, and an e2e leg (`1b`) that runs `--verify` against an nginx serving a
  sitemap with a 404 and a redirect in it: 5 discovered, 3 kept, both dropped with reasons.

### Fixed
- **`discover` wrote an empty pool from 1.0.0 to 1.6.0.** `python3 - args <<'PY'` takes the *program* from
  stdin, so the piped sitemap was discarded and `sys.stdin.read()` returned `""` — zero `<loc>` entries,
  every time, silently. Nothing failed because nothing checked: the CLI suite only asserted that the command
  passes the allowlist gate, and the e2e suite never called it. The sitemap now goes to a file which python
  reads, a document with no `<loc>` entries exits 4 with an explanation instead of writing `[]`, and both are
  tested. The lesson is in `docs/development.md`, because the same shape appears elsewhere in the driver.
- The release workflow passed the CHANGELOG through a shell string, so a section written in this project's
  voice — full of backticks and `$( )` — was **executed** rather than published. That is why 1.5.2 has no
  GitHub Release. The notes now go to a file and are handed over with `--notes-file`, every `${{ }}` value
  reaches `run:` through `env:`, and the image name in the notes is lowercased to match what GHCR accepts.

## [1.5.2] — 2026-08-05

Two CI failures, both of the same family: a suite that passed on every developer machine and could not
pass on a clean checkout. That is the worst way for a test to be wrong — it reports the developer's
environment, not the code, and it does so in green.

### Fixed
- **The CLI fixtures for `@file` pools were never in the repository.** `.gitignore` blocks `pool-*.json`
  so a real URL pool — a map of somebody's site — can never be committed by accident. The rule is right;
  it also swallowed `tests/cli/fixtures/pool-file.json` and `pool-pages.json`. Both existed locally, on no
  runner, so the inlining test failed in CI while the *missing-file* test next to it passed for the wrong
  reason: the file it expected to be absent was absent everywhere. The fixtures are renamed
  (`with-pool-file.json`, `pages.pool.json`) rather than un-ignored — weakening that pattern to fix a test
  is the wrong trade.
- **The "cache-ab without docker" test assumed docker lives in `/usr/local/bin`.** It built a `PATH` from
  that assumption, which holds on a developer's Mac and not on a Linux runner, where docker is in
  `/usr/bin` alongside every other tool the driver needs — so docker was found, the exit-5 path was never
  taken, and the test failed. It now uses a `path_without_docker` helper built from symlinks, the same way
  the suite already handles a missing `k6` and a missing `node`.
- `make test-unit` and `make test-gui` pass the test glob unquoted: `node --test` only learned to expand
  globs in v22, and CI runs the LTS, where a quoted pattern arrives verbatim and fails with
  "Could not find".

## [1.5.1] — 2026-08-05

### Added
- **A third e2e leg: a target that never answers.** It covers the other honest failure mode, and it exists
  for a precedence that is easy to lose — a 100% failed rate crosses any threshold, so the brake trips there
  too, and the report must *still* lead with "TARGET NEVER ANSWERED" instead of presenting the abort as a
  knee. Both flags set, one honest conclusion; the leg asserts the words "ABORTED by the brake" never appear,
  that the wrapper says what to do next (`crowdsim probe`), and that the driver still exits 0.
  - It uses an example domain, as you would — `www.example.test`, reserved by RFC 6761 — and deliberately
    **does not resolve it**. A resolver that hijacks NXDOMAIN would hand back a stranger's address, and the
    test would then generate load against them. The profile's `bypass` removes DNS from the question: the
    host stays `www.example.test` for SNI, Host and the allowlist, while the connection goes to a loopback
    port where nothing listens. `example.com` is somebody's real infrastructure and is never a target.
- **`.github/workflows/e2e.yml`** — the suite that actually generates load, on a runner, against targets the
  runner owns. k6 natively (not through Docker: the container network layer would sit between the generator
  and the target, which is the one thing this suite must not measure), a 10-minute cap for the same reason
  the Kubernetes Job has `activeDeadlineSeconds`, and the run archive uploaded as an artifact so a failure
  can be told apart from a runner having a bad day.
  - It asserts k6 and docker are really present before starting: without them the suite SKIPs with exit 0,
    which is correct on a laptop and useless in CI — a runner image change must not turn this into a green
    no-op.

## [1.5.0] — 2026-08-05

Kubernetes gets the same treatment Nomad already had: manifests whose defaults are the safe ones, with the
reasoning next to each value, and a checker so the reasoning cannot be edited away by accident.

### Added
- **`ci/kubernetes/`** — a **Job** for one load run, a **Deployment + Service** for the GUI, and a
  kustomization, all on the published image. Five values in there are safety properties rather than
  preferences, and each is explained where it sits:
  - `backoffLimit: 0` + `restartPolicy: Never` — Kubernetes retries a failed Job by default, and here a
    "failure" can mean *the brake tripped on the way to a real answer*. A retry is a second uncontrolled run
    against a system you just bent.
  - `activeDeadlineSeconds` — the cluster's own dead-man switch, for a run that hangs where the brake cannot
    see it.
  - `replicas: 1` and `strategy: Recreate` — **the one-run-at-a-time rule lives in the server's memory**, so
    a second replica (or a rolling update's overlap) means two generators against one target: twice the load
    nobody agreed to, and two invalid results.
  - `ClusterIP`, no Ingress — a page that can start a load generator gets no public address; reach it with
    `kubectl port-forward`, authenticated by your kubeconfig and visible in the audit log.
  - no `CronJob` — recurring load belongs somewhere attributable, not in a schedule nobody reads.
  - The production override is deliberately absent from the manifests, `hostNetwork` is commented with its
    trade-off, requests equal limits (a throttled generator becomes the bottleneck being measured), and the
    profile arrives as a ConfigMap you create from your own private copy.
- **`tests/k8s/check.sh`** (`make test-k8s`, and a CI step) asserts all of the above. It renders the
  manifests with `kubectl kustomize` — entirely client-side, no cluster, nothing applied — which both proves
  the YAML parses and strips the comments, so an assertion cannot be satisfied by a commented-out line.
  Verified in both directions: flipping `replicas`, the Service type and `backoffLimit` makes it fail.
- `ci/kubernetes/README.md`: the five decisions, why `generateName` means `kubectl create` and not `apply`,
  placement and the `hostNetwork` trade-off, how to read results (and how to keep the archive on a PVC), and
  what is deliberately missing — no Helm chart, no HPA (autoscaling a load generator means unbounded load),
  no ServiceMonitor.

### Changed
- `ci/README.md` covers both schedulers, and the CI link check now includes `ci/**/README.md`, so the new
  guides cannot rot unnoticed.
- `docs/install.md` gains a Kubernetes path, and the suite table in `docs/development.md` and the README
  gains `tests/k8s/`.

## [1.4.1] — 2026-08-05

### Changed
- The Nomad job moved to **`ci/nomad/crowdsim.nomad.hcl`**. It is deployment plumbing — how a run gets
  dispatched somewhere other than a workstation — and it was sitting at the repository root next to the
  things you actually use.
- `ci/README.md` explains what lives there, why the job is `batch` and not `service` (a service that
  restarts would re-fire load at your production every time the brake trips), and where the workflows are
  and why they cannot move (`.github/workflows/` is GitHub's).
- `ci/` is excluded from the Docker build context: none of it belongs in the image.
- References updated in the README, `docs/install.md`, `docs/docker.md`, `docs/architecture.md`,
  `docs/index.md` and the agent rules. `profiles/` deliberately stayed where it is — see below.

### Notes
- `profiles/` was left at the root on purpose. It is not CI: it is the directory a run reads, the default of
  `CROWDSIM_PROFILES`, the volume `docker compose up` mounts, and the thing `.gitignore` protects so that
  only the example is ever committed. Moving it would touch ~55 references and break the shape every user's
  own checkout has, to gain nothing but a shorter root listing.

## [1.4.0] — 2026-08-05

The profile rules were reachable only from the GUI, so the operator at a terminal — the primary user of
this tool — learned about a broken profile from a k6 stack trace in the init context, *after* deciding to
generate load. Now there is one rule set and both entry points use it.

### Added
- **`crowdsim validate <profile>`** — every rule at once, errors separated from warnings, exit 2 if any
  error. Generates nothing. Errors first and all of them together: a validator that stops at the first
  problem turns one fix into a sequence of round trips.
- `lib/validate.mjs` is now the single implementation, with `lib/validate-cli.mjs` as its command-line face.
  The GUI imports the same module, so validation cannot drift from what a run requires.
- `load` runs it **before the safety gates** and refuses on errors; `doctor --profile` runs it and reports.
  A profile with a brake class that does not exist can no longer reach k6 — nothing would have aborted that
  run.
- 13 CLI tests over the wiring, and one more GUI test over the rules.

### Changed
- **The error/warning line is now load-bearing**, because `load` refuses on errors. An error is reserved for
  what is fatal to *any* run of the profile; two rules moved to warnings as a result: a target declared
  without a `base_url` (nobody has to select it, and selecting it already fails with a precise exit 2), and
  a profile with no named targets at all (legitimate when every run passes `--base-url`). Getting this wrong
  in the strict direction was caught by the test fixtures immediately — the suite has profiles with
  deliberately broken targets, and `load` started rejecting them.
- **`doctor` always exits 0**, including when it found profile errors. It is a report, and a report that
  exits non-zero gets wrapped in `|| true` by the first person who scripts it. `validate` is the gate.
- The image now carries `lib/`, and the smoke test asserts `crowdsim validate` works inside it and that
  `load` reaches the full validation. Without that the same command would validate differently depending on
  where it ran — the worst kind of drift.
- The cost of the choice, stated rather than hidden: full validation needs **node**, which the CLI otherwise
  does not. `validate` exits 5 saying so; `load` prints "only the structural checks ran" and carries on with
  what the driver checks by itself (pool references, missing pool files, empty pools). The half it cannot
  check that way is the interesting half.

### Fixed
- `lib/validate.js` renamed to `.mjs`. Inside the image there is no `package.json` above `lib/`, so a `.js`
  file with ESM syntax was read as CommonJS and `crowdsim validate` died with a `SyntaxError` — found by the
  smoke test that was added in the same commit. The extension now states the module system instead of
  depending on a file that may not be there.

## [1.3.0] — 2026-08-05

The brake is now proven to fire, and the suites that prove it run on every push. Until this release the
brake — the feature that makes it defensible to point this tool at anything — was only tested against
synthetic metric trees and against a target that was *not* supposed to trip it.

### Added
- **`tests/e2e/`: a second leg that proves the brake aborts a run.** `slow-origin.py` accepts connections
  freely and serialises the work through one worker with a delay, so offering it more requests per second
  than it can serve makes a queue whose wait time grows — the shape of a real collapse. The leg asserts the
  run aborted, that it stopped **early** (6 s of a planned 30 s — without this, a brake that never fires
  passes by simply finishing), that the driver still exited 0, that the brake class's p95 crossed its SLO,
  and that the archive recorded it.
  - It also asserts `generator_ok` and `target_unreachable`, which is what makes the abort unambiguous:
    without them an abort could equally mean "the generator collapsed" or "the target stopped answering",
    and neither is a knee.
  - It deliberately does not assert a non-zero share past the read timeout: at the moment the brake fires
    that share is stochastic (0% and 6.7% on two consecutive runs), and the condition that stopped the run
    is the p95.
- **`.github/workflows/ci.yml`** — `make lint` plus the three fake-backed suites on every push and pull
  request, on a clean checkout after `npm install` alone. It also checks that every relative link in the
  README and `docs/` resolves, and guards that `make test` has not grown a dependency on a load-generating
  suite. `make test-e2e` and `make image-smoke` are not part of it.
- CI and image badges in the README.

### Changed
- **The e2e suite skips instead of failing** when docker or k6 is missing: a clear `⏭ SKIPPED` and exit 0.
  It is legitimately skipped on most machines, and a red run that means "you don't have docker" teaches
  people to ignore red runs. A failed assertion still exits 1.
- The e2e suite's first leg is unchanged, and now runs alongside the second in one invocation; the GUI check
  asserts both runs appear in the archive and that the aborted one is distinguishable.

### Fixed
- The slow origin was first written as a single-threaded `HTTPServer`. With HTTP/1.1 keep-alive it stays
  inside one connection and never returns to `accept()`, so every other client waited for the first one to
  go away: head-of-line blocking of the whole server, producing 10 s latencies that looked like a knee and
  were an artefact. The run aborted for the wrong reason. Accepting freely and rationing the work is the
  correct model, and the difference is visible — the same rate now produces a stable ~900 ms p95 instead of
  a wall of timeouts.

## [1.2.2] — 2026-08-05

The versioning rule and the documentation both stop depending on somebody remembering. Writing the docs
found two things the code was getting wrong, which is the argument for writing them.

### Added
- **`scripts/new-release.sh`** — the one-commit-one-release rule, mechanised. `prepare` bumps the version
  across the root and both workspaces plus the lock file and inserts a dated CHANGELOG skeleton; `tag`
  verifies and creates the annotated tag; `notes` prints one version's section. It never pushes.
  `tag` refuses in the three cases that produce a release nobody can trust: the placeholder is still in the
  CHANGELOG, the tree is dirty (the tag would point at something that is not the release), or the top
  CHANGELOG section does not match `package.json`. 12 CLI tests, each in a throwaway git repo.
- **`.github/workflows/release.yml`** — on a pushed `v*` tag, publishes a GitHub Release whose notes are
  that CHANGELOG section. It fails rather than improvising when the section is missing: a release tagged
  without being described is exactly what this is meant to prevent. It also checks that `package.json`
  matches the tag, so a tag that does not point at the release commit cannot publish.
- **A documentation set** in `docs/`, structured so GitHub Pages is a small next step: an index plus
  [install](docs/install.md), [Docker](docs/docker.md), [running a test](docs/running-a-test.md),
  [reading results](docs/reading-results.md), [profile reference](docs/profile.md),
  [CLI reference](docs/cli.md), [GUI](docs/gui.md), [architecture](docs/architecture.md) and
  [development](docs/development.md). ~1800 lines covering every flag, every profile key, every summary
  field, every exit code, and what each of them costs to get wrong.

### Changed
- `package.json` and both workspaces are back in sync with the released version. They had been left at
  1.1.0 while the CHANGELOG and the tags moved on to 1.2.1 — the new script's first act was to refuse to
  work until that was fixed, and `release.yml` would have failed on the v1.2.1 tag because of it.
- Documenting is now a standing rule in `CLAUDE.md` / `AGENTS.md`: runnable commands, a reference for
  whatever was added, and troubleshooting for how it realistically fails.

### Fixed
- A target can declare `insecure: true` and have it honoured. `profiles/example.json` documented it on the
  `proxy-node` target, but the driver never read it — so a node addressed by IP, presenting a certificate
  for a name, produced a wall of TLS failures that reads exactly like an outage unless you remembered
  `--insecure` on every run. Two CLI tests, including that a target without it keeps verification on.

## [1.2.1] — 2026-08-05

### Added
- **`docs/docker.md`**: the complete Docker guide — what is in the image, the two gates as they behave in
  a container, pulling or building, verifying what you got, the GUI (compose and `docker run`, and why the
  bind is `0.0.0.0` while the publication is `127.0.0.1`), single runs, reading the archive, a full
  reference of environment variables / mounts / ports / exit codes / the uid the image runs as, what the
  container deliberately cannot do, Nomad, a troubleshooting table, and the publish pipeline.
- **`docker-compose.yml`** + `.env.example`: `docker compose up` starts the GUI with `./profiles` and
  `./out` mounted from the checkout. It defines no generator service on purpose — a compose service that
  restarts would re-fire load every time the brake trips — and it refuses to start without a token.
- README: a Docker-first install path, a documentation index, and pointers into the guide.

### Fixed
- Saving a profile with `/profiles` mounted read-only returned a bare `500`. A read-only mount is a normal
  Docker setup, so the filesystem's refusal is now translated: `409` with "the GUI can read and run
  profiles but not save them". Listing, validating and running keep working. Covered by a GUI test.

## [1.2.0] — 2026-08-05

One container image, published to a registry, containing the driver, the generator and the GUI — so the
tool can be tried without installing k6, node or anything else.

### Added
- **Single image** `ghcr.io/hiway-media/crowdsim`, built in three stages: the UI is compiled with vite,
  runtime dependencies are installed separately (`--omit=dev`, so express only — no vite, no react, no
  bats), and both land on the pinned `grafana/k6` base together with node. 189 MB, `linux/amd64` and
  `linux/arm64`.
  - One image and not two: two tags to keep straight is one drift away from a run whose driver does not
    match the page that launched it.
  - `crowdsim load` and `crowdsim serve` both work in it. Profiles mount at `/profiles`, output at `/out`.
- `.github/workflows/image.yml`: build, smoke-test, and publish to GHCR — `{version}`, `{major}.{minor}`
  and `latest` on an annotated `v*` tag only. A push to main builds and tests and publishes nothing;
  nothing is ever pushed before the smoke test passes.
- `tests/image/smoke.sh` (`make image-smoke`), the same script CI runs: `--help` and `doctor` inside the
  image, the driver resolving the generator at its relocated path, an unlisted host and an over-ceiling
  peak both refused with exit 3, an untokened off-loopback bind refused, and the GUI answering on the
  published port with its UI present and unauthenticated requests rejected. It also asserts the image
  declares **no** `CROWDSIM_ALLOW_TARGETS` default — a published image with one would be a generator that
  agrees to hit anything, invisibly to whoever pulled the tag.
- `make image`, `make image-run` (starts the GUI from the image with a freshly generated token).
- `.dockerignore`: `out/` and every profile but the example stay out of the build context. A run archive
  names your hosts and a profile maps your infrastructure; neither belongs in a registry.

### Changed
- `bin/crowdsim` honours `CROWDSIM_ROOT`. In the image the driver lives in `/usr/local/bin` and the rest
  of the tool in `/crowdsim`; deriving the root from the script's own path resolved to `/usr/local` and
  would have broken `serve` and `cache-ab` with no error worth reading. Covered by two CLI tests.
- The Nomad job pins `:1.2.0` and says why it is a pinned tag and not `latest`.
- `react` and `react-dom` moved to devDependencies: the build output is a static bundle, nothing imports
  them at runtime, and this keeps them out of the image.

## [1.1.1] — 2026-08-05

### Fixed
- `npm run test:cli` now invokes bats the same way `make test-cli` does (`npx bats`), so the CLI suite runs
  on a clean clone after `npm install` alone instead of requiring a globally installed bats.

## [1.1.0] — 2026-08-05

Adds a test suite and a GUI. Neither changes what a run does: the generator's behaviour is unchanged, the
safety gates still live in `bin/crowdsim`, and the GUI is a form over that same CLI.

### Added
- **Test suite**, four layers, none of which generates load except the last:
  - `tests/unit/` (`node --test`) over the generator logic now extracted into `k6/lib/{mix,classify,summary}.js`:
    mix renormalisation when a class is skipped or dropped, the ramp and the `hold=0s` case, VU
    provisioning sized on rate × timeout, RSC repeat-vs-random, cache classification including
    *absent header ≠ miss*, and the `generator_ok` / `target_unreachable` verdicts.
  - `tests/cli/` (`bats`) over `bin/crowdsim` with a stub k6: both gates, the exit-code contract
    (2 usage · 3 gate · 4 unreachable · 5 k6 missing), profile and target resolution, `@file` pools,
    empty-pool dropping, `--touch-and-go`, history accumulation, and that the brake tripping exits 0.
  - `tests/gui/` (`node --test`) over the API on a real socket: profile-directory traversal attempts, the
    safe-peak confirmation, one-run-at-a-time, refusals passed through with their exit code, no webhook
    in any response.
  - `tests/e2e/` a real ~12 req/s run against an nginx container on loopback, asserting the mix
    proportions, the cache classification, the history row and the GUI reading them back.
  - `make test` (no load), `make test-e2e` (load, local only), `make lint`.
- **GUI** — `crowdsim serve`, a React page served by a small Express API (`gui/`):
  profile editor with live validation, run launcher showing the mix the peak implies and whether the
  target is allowlisted, live log over SSE with a graceful Stop, run archive with a knee plot and a
  comparison against previous runs at the same profile/target/shape.
  - Binds `127.0.0.1` by default and refuses any other address without `CROWDSIM_GUI_TOKEN`.
  - The safe-peak override requires the checkbox *and* the profile name typed for that run; it is never
    stored server-side, and the confirmation is stripped from the run record.
  - One run at a time (409 naming the active run); Stop sends SIGINT so the summary is still written.
  - Reads and writes only the driver's own files: `out/history.tsv`, `out/summary-*.json`, `profiles/`.
- `k6/lib/` as the single home for logic worth testing, imported unchanged by `k6/live-event.js`.

### Changed
- `bin/crowdsim`: new `serve` subcommand and `--port` / `--bind`; `doctor` now also reports node and
  whether the GUI has been built. `--help`, the Nomad job and the Docker image are unaffected.
- `k6/live-event.js` delegates the ramp, the classification and the summary to `k6/lib/`. Behaviour is
  unchanged; `handleSummary` is now a shell that supplies the run context.

## [1.0.0] — 2026-08-05

First release. Extracted from an internal load-testing harness and generalised: the request-class mix,
URL pools, cache headers, SLOs and safety allowlist are now a **profile** supplied at runtime, so the
tool itself knows nothing about any particular site.

### Added
- `bin/crowdsim` driver: `doctor`, `discover`, `probe`, `load`, `cache-ab`, `history`.
- `k6/live-event.js` generator: profile-driven request classes (`plain`, `rsc`), `mix` and `journey`
  shapes, per-class latency/error/cache metrics, emergency brake with `abortOnFail`, and a
  `generator_ok` validity flag that marks generator-bound runs as unusable.
- Two safety gates: a mandatory target-host allowlist, and `--i-know-this-breaks-production` above the
  profile's safe peak. No interactive confirmation, so the gates also hold on a scheduler.
- `Dockerfile` and `nomad/crowdsim.nomad.hcl` (parameterized batch job) for running the generator on a
  Linux host near the target.
- `cache-ab/`: two-leg reverse-proxy A/B harness with documented nginx templates.
- Documented example profile, README, and cache-ab guide.
