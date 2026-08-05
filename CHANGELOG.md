# Changelog

All notable changes to crowdsim are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
