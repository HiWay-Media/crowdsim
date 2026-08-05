# Changelog

All notable changes to crowdsim are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
