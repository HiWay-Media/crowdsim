<img src="docs/assets/wordmark.svg" alt="crowdsim — load simulator for live events" height="72">

[![ci](https://github.com/HiWay-Media/crowdsim/actions/workflows/ci.yml/badge.svg)](https://github.com/HiWay-Media/crowdsim/actions/workflows/ci.yml)
[![image](https://github.com/HiWay-Media/crowdsim/actions/workflows/image.yml/badge.svg)](https://github.com/HiWay-Media/crowdsim/actions/workflows/image.yml)
[![pages](https://github.com/HiWay-Media/crowdsim/actions/workflows/pages.yml/badge.svg)](https://hiway-media.github.io/crowdsim/)

Replay a **live-event traffic mix** against a web frontend, find the knee, and measure what caching
would actually buy you — instead of estimating it from logs after the outage.

**Documentation: [hiway-media.github.io/crowdsim](https://hiway-media.github.io/crowdsim/)**

```
                 ┌──────────────┐
                 │   profile    │  your measured request-class mix, URL pools,
                 │   (JSON)     │  cache headers, SLOs, safety allowlist
                 └──────┬───────┘
                        │
   ┌────────────────────▼────────────────────┐
   │  crowdsim  (bash driver + k6 generator) │
   │  ─ ramps in steps toward --peak         │
   │  ─ brakes the moment the SLO is crossed │
   │  ─ classifies every response per layer  │
   └────────────────────┬────────────────────┘
                        │  chains, not a flat URL list
       ┌────────────────▼─────────────────────────────────────────┐
       │  CDN  →  edge LB  →  caching proxy  →  app instances     │
       │           ▲              ▲                ▲              │
       │      X-Cache        X-Proxy-Cache    the tier that       │
       │                                      actually saturates  │
       └──────────────────────────────────────────────────────────┘
                        │
                 ┌──────▼───────┐
                 │ summary.json │  per class: p50/p95/p99, % past the proxy
                 │ + history.tsv│  read timeout, failed rate, cache hit ratio
                 └──────────────┘
```

## Why not `hey`, `vegeta`, `wrk`, or plain k6

Those tools fire a flat list of URLs at a fixed rate. The load that takes down a server-rendered
frontend is made of **chains**: one HTML document pulls N framework navigation requests (React Server
Components, Turbo, Inertia…) plus M static assets, all served by the *same* single-threaded application
process. Fire a flat list and you measure a load that does not exist — usually a reassuring one.

crowdsim adds the three things that turn a load test into evidence:

- **A measured mix, as data.** Request classes with the weights you observed on your own edge log. Not a
  uniform split, not a guess. `--peak` is the total user req/s; each class gets its share.
- **A brake.** The run climbs in steps and aborts as soon as your SLO is crossed. Holding a system in
  collapse hurts real users and adds no information.
- **A validity check.** If the generator failed to deliver the requested rate, the summary says
  `generator_ok: false` and the run must be discarded. A generator-bound run looks exactly like a healthy
  system under load, and it is the most common way to get a confidently wrong answer.

## Install

Two ways in. **Docker** installs nothing and gets you the GUI in three commands — start here if you just
want to see it work; the full guide is [docs/docker.md](docs/docker.md):

```bash
git clone https://github.com/hiway-media/crowdsim && cd crowdsim
cp .env.example .env                 # put a token in it: openssl rand -hex 16
docker compose up                    # http://127.0.0.1:8787
```

**Natively**, which is what you want for running the generator from your own machine:

```bash
brew install k6                      # macOS       — or see grafana.com/docs/k6 for Linux
git clone https://github.com/hiway-media/crowdsim && cd crowdsim
./bin/crowdsim doctor
```

The CLI needs only `k6`, `curl` and `python3`. `npm install` is optional and buys two things: the GUI
(`crowdsim serve`) and the test suite.

Which to use for what: the container is right for the GUI anywhere, and for the generator on a Linux host
near the target. It is **wrong** for generating load from a macOS or Windows laptop against a remote
target — the Docker network layer saturates before the target does and the run is invalid. Native k6 for
that. [docs/docker.md](docs/docker.md) explains what that failure looks like so you can recognise it.

### The container

One image, published on every release, containing the driver, the generator and the GUI. The complete
guide — mounts, environment, permissions, exit codes, troubleshooting — is
**[docs/docker.md](docs/docker.md)**; the pieces the compose file above is made of:

```bash
docker pull ghcr.io/hiway-media/crowdsim:1.20.5        # or :1.20, or :latest

# a run, on a host near the target
docker run --rm --network host \
  -e CROWDSIM_ALLOW_TARGETS='www.example.test' \
  -v "$PWD/my-profile.json:/profile.json:ro" -v "$PWD/out:/out" \
  ghcr.io/hiway-media/crowdsim:1.20.5 crowdsim load --profile /profile.json --target edge --peak 60

# the GUI, on your own machine
docker run --rm -p 127.0.0.1:8787:8787 \
  -e CROWDSIM_GUI_BIND=0.0.0.0 -e CROWDSIM_GUI_TOKEN="$(openssl rand -hex 16)" \
  -e CROWDSIM_ALLOW_TARGETS='www.example.test' \
  -v "$PWD/profiles:/profiles" -v "$PWD/out:/out" \
  ghcr.io/hiway-media/crowdsim:1.20.5 crowdsim serve
```

`make image` builds it locally as `crowdsim:dev`, `make image-smoke` asserts it is still the tool, and
`make image-run` starts the GUI from it with a freshly generated token.

Two details that are not incidental:

- **The image ships no allowlist**, and CI asserts that on every build. An image with a
  `CROWDSIM_ALLOW_TARGETS` default would be a load generator that agrees to hit anything, and whoever
  pulled the tag would have no way to see it.
- **Inside a container, "bind loopback" means "reachable by nobody"**, so the GUI is bound to `0.0.0.0`
  and the reachability decision moves to the port publication: `-p 127.0.0.1:8787:8787` keeps it on your
  own loopback. The token stays mandatory — the server cannot tell how narrowly you published the port.

> **Do not run the generator through Docker on a laptop to test a remote target.** On macOS and Windows
> the Docker network layer saturates before the target does — the iterations get dropped, and the run is
> invalid. Native k6 locally; the container on a Linux host near the target. The *GUI* in the container is
> fine anywhere: it is a page, not a generator.

For Nomad, [`ci/nomad/crowdsim.nomad.hcl`](ci/nomad/crowdsim.nomad.hcl) is a parameterized batch job on the same image: the target, rate and
duration go in the dispatch call, and the profile is fetched at dispatch time from your own private repo.

## Use

```bash
crowdsim doctor                                          # what is missing on this machine
crowdsim doctor --bench                                   # what this machine can generate (loopback)
crowdsim discover --profile p.json --limit 400 --verify    # a URL pool, minus what does not render
crowdsim probe    --profile p.json --target edge          # reachability + cache headers hop by hop
crowdsim load     --profile p.json --target edge --peak 60
crowdsim validate p.json                                  # every rule at once, before anything runs
crowdsim record  session.har                              # a browser HAR export → a journey file
crowdsim history                                          # one line per run, with the knee each measured
crowdsim compare <run-a> <run-b>                          # the delta, or a refusal if they differ
crowdsim weights access.log --profile p.json               # the class mix, counted on your own edge log
crowdsim init                                             # a first profile, drafted from what was measured
crowdsim report  <run-id>                                 # the run as markdown, caveats attached
crowdsim report  <run-id> --html                          # the same run drawn: the ramp, the knee, per class
crowdsim serve                                            # the same thing with a GUI, on loopback
```

“How far are we from the knee, without breaking anything”:

```bash
crowdsim discover --profile p.json --verify && crowdsim probe --profile p.json
crowdsim load --profile p.json --peak 60 --warmup 30s    # stays under the profile's safe ceiling
crowdsim report <run-id> --out ticket.md                 # what to paste, with what it is worth
crowdsim report <run-id> --html                          # and the same run drawn, to attach
```

First time, with no profile of your own yet: `probe` and `discover` once against
[`profiles/example.json`](profiles/example.json) with your `base_url` and allowlist in it, then
`crowdsim init` drafts the real profile from what those two measured — leaving the allowlist and the safe
ceiling blank, because no tool gets to decide those for you. Add `--access-log <file>` and the class
weights are counted from your own traffic instead of drafted as a `TODO`; `crowdsim weights` does the same
for a profile that already exists. The log is handed over, never fetched, and nothing from it is written.

## The GUI

`crowdsim serve` puts a page in front of the same CLI: pick a profile and a target, see the mix the peak
implies, read the exact command before agreeing to it, launch (with an optional warm-up whose numbers are
thrown away), watch the log stream, read the result, hand it over as a report — markdown to paste, or the
same run drawn — and compare it with previous runs. The step-by-step guide, with screenshots, is **[docs/gui.md](docs/gui.md)**.

```bash
npm install && npm run gui:build      # once
crowdsim serve                        # http://127.0.0.1:8787

docker compose up                     # or from the container image: no node, no build
```

Running it in Docker has one wrinkle worth knowing — inside a container, binding loopback means
"reachable by nobody", so the bind moves to `0.0.0.0` and the reachability decision moves to the port
publication. [docs/docker.md §4](docs/docker.md#4-using-the-gui) covers it.

![The crowdsim run form: target and allowlist verdict, the rate, the mix a peak implies, and the exact command
that will run](docs/assets/screens/gui-run-form.png)

It is a form over `bin/crowdsim`, not a second implementation. Every run is a child process of the CLI
with the same gates, writing the same `out/` directory — so a run launched from a terminal and a run
launched from the page are the same kind of object, and appear in the same history. Concretely:

- **The gates are not re-implemented, and cannot be bypassed.** An unlisted host is refused with exit 3
  and the page says so. Above the profile's safe peak the override needs the checkbox *and* the profile
  name typed by hand, for that run: nothing about it is remembered.
- **One run at a time**, and it survives a restart. A second Run is a 409 that names the run already in
  flight. Two generators against one target produce twice the load nobody agreed to and two results that
  are both invalid.
- **The command is readable before it runs.** The page shows the argv the server will spawn — rendered by
  the server from that same argv, not reassembled by the page, so it cannot describe a different run.
  Defaults you cannot see are decisions somebody else made for you.
- **`probe` and `discover` come back as tables, not terminal output.** Per declared cache layer: the header,
  what it said, and whether that counts as a hit — with *the header never appeared* kept distinct from
  *miss*, because the first is a wrong header name in your profile and the second is a cold cache.
- **Loopback by default.** A page that can generate 500 req/s at your production has no business on a
  shared network. Another bind address is allowed, but only with `CROWDSIM_GUI_TOKEN` set.
- **Stop is a SIGINT**, so k6 winds down and still writes the summary. A killed run is a burned window.
- **The result is read in the right order**: is the run valid at all, did the brake trip, and only then
  the numbers. `generator_ok: false` is a banner telling you to discard it, not a footnote.

## Tests

```bash
make test         # unit + front end + GUI + CLI — generates no load whatsoever
make test-k8s     # ci/kubernetes: safety invariants on the manifests (needs kubectl, no cluster)
make test-e2e     # a real 12 req/s run against an nginx container on loopback (needs docker + k6)
make image-smoke  # builds the image, then asserts it is still the tool, gates intact (docker)
make check-docs   # the three claims the docs make about themselves: versions, commands, quoted output
```

| Suite | What it covers |
|---|---|
| `tests/unit/` (`node --test`) | the generator's arithmetic and verdicts, extracted into `k6/lib/`: mix renormalisation, the ramp, VU provisioning, cache classification, `generator_ok`, `target_unreachable`. The tested code is the code k6 imports. |
| `tests/cli/` (`bats`) | `bin/crowdsim` end to end against a stub k6: both safety gates, exit-code contract, profile and target resolution, empty-pool handling, history, and that the brake tripping still exits 0. |
| `tests/ui/` (`node --test`) | the front end's decisions, as plain modules imported from `gui/ui/src/lib/`: which run the page shows, when a result stops belonging to the form, the knee as a table cell, the warm-up rate and the safe ceiling that counts it — and the wording that cannot be softened (safe peak, a refusal, `unknown` ≠ `MISS`). |
| `tests/gui/` (`node --test`) | the API over a real socket: path traversal out of the profile directory, the override confirmation, one-run-at-a-time, gate refusals passed through with their exit code, no webhook leakage. |
| `tests/e2e/` | three legs on loopback, one per conclusion the tool produces: a fast nginx (the chain works, and a healthy target does **not** trip the brake), a slow single-worker origin (**the brake does abort a run**, early, with the generator still holding the rate), and an unreachable target (**connectivity, not capacity** — using a reserved `.test` domain that is never resolved). Skips cleanly without docker or k6. |
| `tests/image/` | the published artefact: the driver finds the generator, the GUI starts, and the gates survived the build — including that no allowlist default was baked in. Runs in CI before anything is pushed. |
| `tests/k8s/` | the Kubernetes manifests, rendered client-side: the Job is never retried, the GUI is one replica behind a `ClusterIP`, there is no `CronJob`, and no override is committed. |

Two things the suites are built around, because they are how a load test lies to you:

- **Nothing in `make test` sends a request.** k6 is a stub on `PATH` and every load path runs `--dry-run`,
  so what is asserted is the decision — refused or allowed, and with which arguments. CI runs exactly those
  suites, and asserts that `make test` cannot grow a dependency on a load-generating one.
- **The unhappy summaries are fixtures.** A run with dropped iterations, and a run that failed instantly
  at ~0 ms, are asserted to be reported as *invalid* and as *unreachable* — never as a capacity number.

## The profile is the whole configuration

`profiles/example.json` is documented inline and is the only profile in this repo, on purpose: a profile
holds hostnames, URL pools and a map of how your site is built. **Keep yours in your own private repo.**

It declares named `targets` (each one a `base_url`, optional `host_header`, and a `bypass` that skips a
CDN while keeping SNI and Host correct), the `classes` that make up the mix, the `pools` they draw from,
the `cache_headers` used to classify each layer, your `slo`, and `safety`.

Three details worth understanding before your first run:

- **A class may hold itself to a sharper SLO** than the profile's, with its own `max_p95_ms` or
  `max_failed_rate` — a navigation request at 2.5 s already means the app is queueing, while a document at
  2.5 s is merely unpleasant. Sharper only: a looser per-class limit is refused, since it would move the knee
  later than the profile asks for. Whatever is crossed first stops the run, and the run says which class and
  which threshold it was.
- **`guillotine_ms`** is your reverse proxy's read timeout. Requests slower than it become 504s for real
  visitors, so crowdsim reports the share of each class that crossed it. That percentage is your margin.
- **`rsc.mode`** — on a Next.js build the `_rsc` query value depends on route and build, not on the
  request, so a huge number of navigation requests collapse onto a handful of distinct URLs.
  `repeat` (default) replays that; `random` measures the opposite hypothesis, i.e. what it would cost if
  the parameter really were per-request.

## Safety

crowdsim generates real load. Pointed at production it serves real errors to real users, and to every
co-tenant sharing that infrastructure. Two gates, neither of which can be satisfied by accident:

| Gate | What it does |
|---|---|
| **Target allowlist** | The target's host must match `CROWDSIM_ALLOW_TARGETS` or `safety.allow_hosts`. There is no default. A load test aimed at the wrong hostname is indistinguishable from an attack. |
| **Safe peak** | Above `safety.safe_peak_rps`, the run refuses to start without `--i-know-this-breaks-production` on the command line. Never store that override in a config or a job file. In the GUI it additionally requires typing the profile name, per run. |

There is deliberately **no interactive “are you sure?”** — this runs unattended on schedulers, where a
prompt either hangs or gets auto-answered. The gates are explicit arguments instead.

Before a run that is meant to reach the knee: agree a window, tell whoever watches the uptime alerts,
and be ready to stop. Expect ~20–40 seconds of errors even with `--touch-and-go` — a 504 needs a
*queue*, and a queue needs time to build, so "just a few seconds" is not a thing.

## Cache A/B

`cache-ab/` brings up two reverse proxies against the same origin, identical except for the change you
are evaluating, and you load both with the same pool in the same window. That gives you a hit ratio and
an offload factor you can defend, instead of enabling a cache in production and eyeballing a dashboard.

```bash
crowdsim cache-ab --profile p.json --ttl 10
crowdsim load --profile p.json --base-url http://127.0.0.1:8081 --peak 40   # leg A: as-is
crowdsim load --profile p.json --base-url http://127.0.0.1:8082 --peak 40   # leg B: candidate
cd cache-ab && docker compose down
```

Read `cache-ab/candidate.conf.template` before copying anything from it into production: the example
change stops honouring the origin's `Cache-Control`, which means **you** now decide what is cacheable and
the origin can no longer correct you. See the warning at the top of that file.

## Reading a result

- `generator_ok: false` → **discard the run.** Nothing else in the summary means anything.
- `aborted: true` → you found the knee. That is a success, and the exit code stays 0. `aborted_by` says which
  class crossed which threshold.
- **Read the per-step table, not the overall p95.** The run climbs through several rates, so one p95 over all
  of it belongs to no rate the system was ever held at. The table says where latency left the SLO — a knee
  from a single run — and marks the step the brake died inside as partial, because a fraction of a step is
  not a result for its rate.
- **The knee is stated once, or refused.** *Clean up to 3 req/s, crossed at 4.* A knee is a crossing the
  system does not come back from: one that is undone at a higher rate is a cold cache, and is reported as
  that instead. When the run cannot support the claim — one completed step, steps shorter than the abort
  delay, a generator that did not hold — the tool says so rather than estimating, because the alternative is
  a confident number that gets quoted in rooms this tool is not in.
- Per class, the interesting column is the share past `guillotine_ms`, not the average latency. Averages
  hide the queue, and the queue is what produces the errors.
- Compare runs against each other at an **identical pool**, before and after a change. Absolute numbers
  are not comparable to your real traffic: a synthetic pool of distinct cold URLs is harsher than real
  traffic concentrated on a few hot keys. The tool measures deltas honestly and absolutes optimistically.

## Not included

Reading your edge's access log to produce a per-URL breakdown needs privileged access to your own load
balancers. That is deliberately outside this tool: it would mean shipping a container that wants an SSH
key for a production edge.

The GUI has no scheduler and no user accounts, also deliberately. Recurring load against your own
production is a decision that belongs in something auditable — the Nomad job is dispatched with the
target, the rate and the override in the dispatch call, which is logged and attributable to whoever made
it. A cron button on a web page is not.

## Documentation

Full documentation is published at **[hiway-media.github.io/crowdsim](https://hiway-media.github.io/crowdsim/)**
and is the same markdown you can read here in **[docs/](docs/index.md)**:

| Page | What |
|---|---|
| [docs/index.md](docs/index.md) | the map, and the three things worth knowing before you start |
| [Install](docs/install.md) | Docker, native, Nomad — and which is right for what |
| [Docker](docs/docker.md) | the container in detail: GUI, runs, mounts, environment, permissions, troubleshooting |
| [Running a test](docs/running-a-test.md) | the sequence from `doctor` to a defensible number, and the choreography around it |
| [Reading results](docs/reading-results.md) | the summary field by field, in the order that keeps you honest |
| [Profile reference](docs/profile.md) | every profile key, and what it costs to get wrong — including the `auth` block and the `login` / `authed` / `signup` classes |
| [CLI reference](docs/cli.md) | subcommands, flags, environment, exit codes, output files |
| [GUI](docs/gui.md) | the browser interface, its safety properties and its deliberate limits |
| [Architecture](docs/architecture.md) | why bash + k6, where the gates live, why `k6/lib` exists |
| [Development](docs/development.md) | the five test suites, how to change things safely, how to cut a release, how to preview the docs site |
| [Changelog](CHANGELOG.md) | what changed in each release (also a page on the docs site) |

Alongside them: [`INTENT.md`](INTENT.md) says why the tool exists and what it deliberately refuses to
do, [`profiles/example.json`](profiles/example.json) documents every field inline,
[`cache-ab/README.md`](cache-ab/README.md) covers the A/B harness,
[`ci/README.md`](ci/README.md) how a run is dispatched on Nomad or [Kubernetes](ci/kubernetes/README.md), `crowdsim --help` every flag, and
[CHANGELOG.md](CHANGELOG.md) what changed in each release.

## License

MIT — see [LICENSE](LICENSE).
