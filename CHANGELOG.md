# Changelog

All notable changes to crowdsim are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
