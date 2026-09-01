# Architecture

Why crowdsim is built out of these pieces, and where each decision lives.

## The shape of it

<!-- illustrative: a hand-drawn map of the pieces, not output any command prints. scripts/check-doc-output.sh
     skips it for that reason: there is nothing here to compare against a terminal. -->

```
        profile.json ─────────────────────────────────┐
        (yours, private: hosts, pools, mix, SLO)      │
                                                      ▼
  ┌──────────────────────── bin/crowdsim (bash) ───────────────────────┐
  │  resolve profile   pools inlined, @file refs read, _keys stripped  │
  │  resolve target    base_url, Host, bypass, skip_classes, insecure  │
  │  GATE 1            host must be allowlisted            → exit 3    │
  │  GATE 2            peak ≤ safe ceiling, or the override → exit 3   │
  │  run k6            one scenario per class, env-passed              │
  │  report            summary + log + history row + optional Slack    │
  └───────────────┬─────────────────────────────────┬──────────────────┘
                  │ spawns                          │ writes
                  ▼                                 ▼
      k6/live-event.js                        out/summary-<run>.json
        │ imports (pure, unit-tested)         out/load-<run>.log
        ├── k6/lib/mix.js       shares, ramp, VUs, rsc URLs
        ├── k6/lib/classify.js  cache hit / miss / never-spoke
        └── k6/lib/summary.js   aborted · generator_ok · target_unreachable
                  │
                  ▼  HTTP, tagged per class
        CDN → edge LB → caching proxy → app instances

  gui/server (express) ── spawns ──▶ bin/crowdsim        gui/ui (react)
        └── reads out/ and profiles/, stores nothing of its own
        └── lib/validate.mjs ◀── also used by `crowdsim validate`, doctor and load (one rule set)

  lib/ (node, optional)  validate.mjs · har.mjs · weights.mjs · report-html.mjs
        └── each one pure, unit-tested, and reached through a thin *-cli.mjs the driver spawns
```

## Why a bash driver and a JS generator

The driver is where decisions with consequences live: the gates, profile resolution, and what counts as a
result. It is bash because its dependencies (`bash`, `curl`, `python3`) exist on every host that runs a
scheduler agent, and because it must keep working when there is no node and no npm — the CLI is the
reference installation, and the GUI is optional.

The generator is JavaScript because k6 is JavaScript, and k6 is the one component not to substitute: at a
few hundred req/s, sustaining the rate *is* the hard part, and a generator that silently fails to deliver it
produces a run that looks like a healthy system under load.

JSON is parsed with inline `python3`, never `jq`: python3 is present where schedulers run, jq often is not.

## Why the mix is data

`--peak` is total user requests per second, split by weights measured on your own edge log. That is the
whole idea: the load that takes down a server-rendered frontend is made of **chains** — one document pulls
N framework navigation requests (React Server Components, Turbo, Inertia…) plus M static assets, all served
by the *same* single-threaded process. Fire a flat URL list at a fixed rate and you measure a load that does
not exist, usually a reassuring one.

Consequences that show up all over the code:

- **Weights are renormalised** over the classes that actually run, so skipping one does not quietly lower
  the load you think you applied.
- **An empty pool drops its class**, loudly. Any fallback would measure the wrong request type under the
  right label.
- **RSC navigation is a first-class kind**, because it is both the largest class in real event traffic and
  the one flat tools cannot produce.

## Where the safety lives, and why only there

Both gates are in `bin/crowdsim`, and nothing else re-implements them:

- the **Nomad job** passes `--i-know-this-breaks-production` only when the dispatch says so;
- the **GUI** spawns the driver and surfaces its exit codes; it composes only known, validated flags;
- the **image** ships no `CROWDSIM_ALLOW_TARGETS` default, and CI asserts that on every build.

A second code path that builds k6 arguments would be a second place for the gates to be wrong. That is the
one architectural rule this project will not trade. The same reasoning put the profile rules in
`lib/validate.mjs` rather than one copy per entry point: two rule sets drift, and the day they do, the one
that matters is whichever the operator did not run.

There is no interactive confirmation anywhere, on purpose: on a scheduler a prompt either hangs or is
auto-answered. Gates are explicit arguments.

## Why `k6/lib/` exists

`live-event.js` used to hold everything. The arithmetic that decides how much load you generate, the cache
classification, and the verdicts (`aborted`, `generator_ok`, `target_unreachable`) are now in three pure
modules with no k6 imports:

| Module | Holds | Tested for |
|---|---|---|
| `mix.js` | shares, ramp stages, VU provisioning, RSC URLs, class paths | renormalisation, `hold=0s`, tiny-share flooring, `maxVUs = rate × timeout`, repeat vs random |
| `classify.js` | header lowercasing, hit patterns, status buckets, the guillotine | **absent header ≠ miss**, RFC 9211 and CDN phrasings, cumulative 5xx |
| `summary.js` | the whole verdict and the text report | decorative `>=0` thresholds not read as a brake, the 2% dropped rule, unreachable-vs-knee |

They run in k6's runtime *and* in `node --test`, so the tested code is the running code. That constrains
them: ES2019 (no optional chaining, no `??`), no node or k6 imports, and randomness injected rather than
called — `rscQuery` takes a `rand` function so the random mode is testable instead of merely plausible.

A bug in this arithmetic does not throw. It produces a test that measured something other than what you
asked for, which is why it is the part with the most tests.

## Why the brake, and why it exits 0

The run climbs and aborts the moment your SLO is crossed, via k6 thresholds with `abortOnFail` and
`delayAbortEval` (so a cold start does not abort it). Holding a system in collapse hurts real users and adds
no information.

The wrapper deliberately does **not** propagate k6's non-zero exit when that happens: finding the knee is
the intended outcome, and a scheduler must not file a successful experiment as a failed job. The call is
wrapped in `set +e` plus `PIPESTATUS` so the summary and the history row are still written.

## Why validity is a first-class output

Three fields exist only to stop you believing a run you should not:

- `generator_ok` — the generator held the rate (>2% dropped iterations invalidates it);
- `target_unreachable` — near-total failure at near-zero latency is connectivity, not capacity;
- `over_guillotine_rate` — the share past the proxy's read timeout, which is the margin that matters, as
  opposed to an average that hides the queue.

A load test's real failure mode is a plausible number, not a crash. These are the guardrails against it.

## The GUI's position

`gui/server` is a form over the CLI: it spawns `bin/crowdsim`, streams the log over SSE, and reads
`out/history.tsv` and `out/summary-*.json`. It stores nothing of its own — a second version of the truth is
always the wrong one — and it holds no copy of the gates. `gui/ui` is a static bundle; nothing imports React
at runtime, which is why it is a build-time dependency and stays out of the image's `node_modules`.

## The container

One image with the driver, the generator and the GUI. Two images would be two tags to keep straight, and the
day they drift is the day somebody runs a load test with a driver that does not match the page that launched
it. In it the driver lives in `/usr/local/bin` and the tool in `/crowdsim`, which is what `CROWDSIM_ROOT` is
for. See [Docker](docker.md).

## Repository layout

```
bin/crowdsim              the driver: gates, resolution, reporting  (also its own --help)
k6/live-event.js          the generator: scenarios, requests, metrics
k6/lib/                   pure logic, imported by the generator and by the tests
lib/                      the driver's node-side logic, each with a thin *-cli.mjs and unit tests:
                          validate.mjs (the profile rules, shared by CLI and GUI), har.mjs (a browser
                          recording → a journey), weights.mjs (an access log → the class mix),
                          report-html.mjs (a summary → a page with charts)
gui/server/lib/           args (flag composition), profiles, runner, history, app
gui/ui/src/               React: RunPanel, ProfilePanel, HistoryPanel, MixBars, SummaryCard
profiles/example.json     the only profile in this repo, documented inline
cache-ab/                 two-leg reverse-proxy A/B harness
ci/                       nomad job spec (dispatch), and why it is batch — see ci/README.md
tests/{unit,cli,gui,e2e,image}/   see Development
docs/                     what you are reading
scripts/                  roadmap sync, release helper
```

## See also

- [Development](development.md) — the test layout and how to change things safely
- [Profile reference](profile.md) — the data all of this is driven by
