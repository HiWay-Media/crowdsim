# Development

How to change crowdsim without breaking the two things it exists to protect: the gates, and the honesty of
a result.

```bash
npm install          # bats, express, vite, react
make lint            # bash -n on the driver, node --check on every JS file
make test            # unit + GUI + CLI — 150 tests, and not one request sent
make test-e2e        # a real ~12 req/s run against an nginx container on loopback
make image-smoke     # the built image: still the tool, gates intact
```

## The test layout

| Suite | Runner | Covers | Generates load? |
|---|---|---|---|
| `tests/unit/` | `node --test` | `k6/lib/`: mix renormalisation, ramp, VU provisioning, RSC modes, cache classification, the three verdicts | no |
| `tests/cli/` | `bats` | `bin/crowdsim` against a stub k6: both gates, exit codes, profile and target resolution, empty pools, `--touch-and-go`, history, and `scripts/new-release.sh` | no |
| `tests/gui/` | `node --test` | the API over a real socket: traversal, the override confirmation, one-run-at-a-time, refusals passed through, read-only mounts | no |
| `tests/e2e/` | shell + docker | three legs, one per conclusion the tool produces: a fast nginx (chain works, healthy target does *not* abort), a slow single-worker origin (**the brake does abort**, early, generator still holding), and an unreachable target (**connectivity, not capacity**). Skips (exit 0) without docker or k6 | **yes**, on loopback |
| `tests/image/` | shell + docker | the published artefact: driver finds generator, GUI starts, gates survived the build, no allowlist default | no |
| `tests/k8s/` | shell + kubectl | `ci/kubernetes` rendered client-side (no cluster): never-retried Job, cluster-enforced deadline, one GUI replica, ClusterIP only, no CronJob, no committed override, pinned image | no |

Two properties hold this together, and both are load-bearing:

**Nothing in `make test` sends a request.** k6 is a stub on `PATH`; every load path runs `--dry-run`. What
is asserted is the *decision* — refused or allowed, and with which arguments. That is what makes the suite
safe to run anywhere, at any time, including on a shared CI runner.

**CI runs the fake-backed suites on every push and pull request** (`.github/workflows/ci.yml`: `make lint`,
the three suites, a documentation link check, and a guard that `make test` has not grown a dependency on a
load-generating suite). It deliberately does not run `make test-e2e` or `make image-smoke` — the image
workflow owns the second.

**The unhappy summaries are fixtures.** `tests/cli/fixtures/summary-invalid.json` and
`summary-unreachable.json` are asserted to be reported as *invalid* and as *unreachable* — never as capacity
numbers. A load test's failure mode is a plausible wrong answer, so the tests aim at exactly that.

### Why the e2e suite has three legs

A brake is only worth having if it fires. `brakeTripped()` is unit-tested against synthetic metric trees,
and the fast leg asserts the *opposite* case — that a healthy target does not abort a run. Neither would
notice a threshold expression with a typo, or a metric renamed by a k6 upgrade: the result is a brake that
no longer stops anything, and the first person to find out is whoever is watching the outage.

So the second leg runs against a slow origin (`tests/e2e/slow-origin.py`: connections accepted freely, work
serialised through one worker with a delay) and asserts the brake *did* abort — early, with the generator
still holding the rate and the target still answering. Those last two matter: without them an abort could
equally mean "the generator collapsed" or "the target stopped talking to us", and neither is a knee.

One thing it does **not** assert is a non-zero share past the read timeout: at the moment the brake fires
that share is stochastic (0% and 6.7% on two consecutive runs). The condition that actually stopped the run
is the brake class's p95 against its SLO, and that is what is checked.

The third leg covers the other honest failure mode: a target that never answers. It is worth its own leg
because of a precedence that is easy to lose — a 100% failed rate crosses any threshold, so the brake trips
there too, and the report must *still* lead with "TARGET NEVER ANSWERED" rather than presenting the abort as
a knee. Both flags set, one honest conclusion; the leg asserts the words "ABORTED by the brake" do not
appear.

It uses an example domain, as you would, and deliberately does not resolve it: `.test` is reserved and
absent from the global DNS (RFC 6761), but a resolver that hijacks NXDOMAIN would hand back a stranger's
address — and the test would then generate load against them. The profile's `bypass` removes DNS from the
question and sends the connection to a loopback port where nothing listens. `example.com` is somebody's real
infrastructure and is never a target.

### Writing a test

- Logic worth testing goes in `k6/lib/`, not in `live-event.js`. Those modules run in k6 **and** in node, so
  keep them ES2019 (no optional chaining, no `??`), free of k6/node imports, and inject randomness rather
  than calling it.
- CLI tests get a stub k6 and a fake profile from `tests/cli/helper.bash`. The PATH-without-k6 helper builds
  a directory of symlinks rather than filtering `$PATH`: on macOS k6 and python3 live in the same brew
  directory, and filtering would remove python3 too — making the test pass for the wrong reason at the wrong
  exit code.
- GUI tests boot the app on an ephemeral port against `tests/gui/fixtures/fake-crowdsim`, which records its
  argv instead of sending anything.
- Every bug fix starts from a test that reproduces it.

## Changing the driver

`bin/crowdsim` is one bash script. Things that will bite:

- **The comment header is the `--help`.** `usage()` is `sed -n '1,60p' | grep '^#'`; push a line past 60 and
  help silently loses it. A CLI test guards the boundary.
- `set -eo pipefail`, deliberately **without** `-u`: many variables are optional. Do not add `-u` without
  initialising everything.
- The k6 call sits inside `set +e` with `PIPESTATUS[0]`, so a tripped brake still writes the summary and the
  history row. Do not "simplify" it into `if k6 run …`.
- `die()` takes `"$1"` and an exit code as `$2` — not `"$*"`.
- Adding a flag touches, at minimum: the arg parser, the env passed to k6, the usage header, `docs/cli.md`,
  and a CLI test. If the GUI should expose it too: `gui/server/lib/args.js` (validated, never passed
  through) and the run form.

## Changing the generator

`k6/live-event.js` builds scenarios and issues requests; everything else belongs in `k6/lib/`. Watch out for:

- k6's `TIMEOUT` (default `10s`) must stay **above** the proxy read timeout (`guillotine_ms`), otherwise the
  504s you are measuring never arrive.
- Thresholds ending in `>=0` are decoration: k6 only surfaces a tagged sub-metric in the summary if some
  threshold names it. Never count them as "the brake tripped" — that would mark every run aborted.
- `JOURNEY` is passed only in journey shape; otherwise k6 would open a file it never uses, and a profile
  naming a missing journey would die in the init context with a stack trace instead of a load test.

## Changing the profile rules

They live in `lib/validate.mjs` — one implementation, used by `crowdsim validate` (through
`lib/validate-cli.mjs`, which `doctor` and `load` also call) and by the GUI's editor. Adding a rule means
deciding which side of a line it falls on:

- **error** — fatal to *any* run of the profile. `load` refuses on these, before the safety gates.
- **warning** — it will run, but perhaps not mean what the author thinks.

Getting that wrong has a cost in both directions. Too strict and `load` starts rejecting profiles that work
today (a target nobody selects, declared without a `base_url`, was an error for exactly one commit before
this was noticed); too lenient and the rule is decoration. The rules are tested in
`tests/gui/validate.test.js`, the wiring in `tests/cli/validate.bats`.

## Changing the GUI

- `gui/server/lib/args.js` is the security-critical file: known flags, validated values, no shell, no
  passthrough, and the safe-peak override only with the per-run typed confirmation.
- The server stores no results. Anything it displays comes from `out/` or from `profiles/`.
- `gui/ui` is a static bundle; React is a devDependency because nothing imports it at runtime.
- After changing `gui/ui`, `npm run gui:build` — `crowdsim serve` serves `gui/ui/dist`, and `doctor` warns
  when it is missing.

## Releasing

Every change ships as a version: a CHANGELOG section, a version bump, an annotated tag, a GitHub Release
and — on the tag — a published image. `scripts/new-release.sh` is that rule, so it stops depending on
memory.

```bash
scripts/new-release.sh prepare patch      # or minor, major, or an explicit X.Y.Z
#   bumps package.json (root + workspaces) and the lock file
#   inserts a dated CHANGELOG skeleton

$EDITOR CHANGELOG.md                      # write what changed and why it mattered
git add -A && git commit                  # the release commit
scripts/new-release.sh tag                # verifies, then tags. Never pushes.

git push && git push --tags               # yours to run
```

`tag` refuses in three cases, each of which would produce a release nobody can trust: the CHANGELOG section
still holds the placeholder, the tree is dirty (the tag would point at something that is not the release),
or the top CHANGELOG section does not match `package.json`.

What the tag triggers once pushed:

| Workflow | Does |
|---|---|
| `release.yml` | Publishes a GitHub Release whose notes are that CHANGELOG section (`new-release.sh notes`). Fails if the section is missing — a release tagged without being described is the thing to prevent. |
| `image.yml` | Builds for the runner's arch → smoke-tests → builds `linux/amd64,linux/arm64` → pushes `{version}`, `{major}.{minor}` and `latest`. Nothing reaches the registry before the smoke test passes. |
| `roadmap-sync.yml` | Only on roadmap changes: replays `.github/roadmap.json` onto labels, milestones and issues. |
| `ci.yml` | On every push and pull request: lint, the three fake-backed suites, the Kubernetes manifests, the doc links. |
| `e2e.yml` | On changes to the driver, the generator or the suite: the real k6 run, on the runner's own loopback. |

Version numbers and milestone names are **independent**. Milestone `v1.2.0` (the GUI) shipped inside release
1.1.0; release 1.2.0 was the container image. Read the CHANGELOG for what a version contains, and the
milestone for what a body of work was.

Bump `minor` for new subcommands, flags or features and for removals; `patch` for fixes and documentation.
Commits touching only `.github/roadmap.json`, `scripts/sync-roadmap.sh` or `.github/workflows/` are exempt:
they are planning and plumbing, not product.

## Documentation is part of the change

Anything user-facing ships with: copy-pasteable commands that were **run** before being written down, a
reference for whatever it adds (env, mounts, flags, exit codes), and troubleshooting entries for the ways it
realistically fails. A new page goes into [`docs/index.md`](index.md) and the README index, or it does not
exist.

Explain the trap, not the feature. The docs in this repo have caught real bugs — a `500` where a `409`
belonged, a profile key the driver silently ignored — precisely because every documented command was
executed first.

## The roadmap

`.github/roadmap.json` is the source of truth for labels, milestones and issues.

```bash
scripts/sync-roadmap.sh --dry-run     # always first
scripts/sync-roadmap.sh
```

The sync is additive: it creates what is missing and re-aligns milestones and labels. It **never** closes an
issue and **never** rewrites a body somebody may have edited — so a decision has to go in a comment on the
issue as well as in the file. Issues are matched by their `key`, not by their title, so titles can be
reworded without opening duplicates.

## Coming next

Planned work lives in milestone [v1.3.0](https://github.com/HiWay-Media/crowdsim/milestone/4): CI running
lint and tests, an e2e leg that proves the brake actually aborts a run, a bandwidth estimate that warns
before an unsustainable run, `discover --verify`, `crowdsim record` from a HAR, one profile validator
reachable from the CLI, `crowdsim compare`, and three GUI refinements.

GitHub Pages for these docs is a next step: the structure here (an `index.md` plus one page per topic, all
plain Markdown with relative links) is what it will be built from.
