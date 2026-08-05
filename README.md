# crowdsim

Replay a **live-event traffic mix** against a web frontend, find the knee, and measure what caching
would actually buy you — instead of estimating it from logs after the outage.

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

```bash
brew install k6                      # macOS       — or see grafana.com/docs/k6 for Linux
git clone https://github.com/hiway-media/crowdsim && cd crowdsim
./bin/crowdsim doctor
```

Docker, for running it on a host near the target:

```bash
docker build -t crowdsim .
docker run --rm --network host \
  -e CROWDSIM_ALLOW_TARGETS='www.example.test' \
  -v "$PWD/my-profile.json:/profile.json:ro" -v "$PWD/out:/out" \
  crowdsim crowdsim load --profile /profile.json --target edge --peak 60
```

> **Do not run the generator through Docker on a laptop to test a remote target.** On macOS and Windows
> the Docker network layer saturates before the target does — the iterations get dropped, and the run is
> invalid. Native k6 locally; the container on a Linux host near the target.

For Nomad, `nomad/crowdsim.nomad.hcl` is a parameterized batch job: the target, rate and duration go in
the dispatch call, and the profile is fetched at dispatch time from your own private repo.

## Use

```bash
crowdsim doctor                                          # what is missing on this machine
crowdsim discover --profile p.json --limit 400            # build a URL pool from the sitemap
crowdsim probe    --profile p.json --target edge          # reachability + cache headers hop by hop
crowdsim load     --profile p.json --target edge --peak 60
crowdsim history                                          # one line per run: does the knee move?
```

“How far are we from the knee, without breaking anything”:

```bash
crowdsim discover --profile p.json && crowdsim probe --profile p.json
crowdsim load --profile p.json --peak 60          # stays under the profile's safe ceiling
```

## The profile is the whole configuration

`profiles/example.json` is documented inline and is the only profile in this repo, on purpose: a profile
holds hostnames, URL pools and a map of how your site is built. **Keep yours in your own private repo.**

It declares named `targets` (each one a `base_url`, optional `host_header`, and a `bypass` that skips a
CDN while keeping SNI and Host correct), the `classes` that make up the mix, the `pools` they draw from,
the `cache_headers` used to classify each layer, your `slo`, and `safety`.

Two details worth understanding before your first run:

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
| **Safe peak** | Above `safety.safe_peak_rps`, the run refuses to start without `--i-know-this-breaks-production` on the command line. Never store that override in a config or a job file. |

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
- `aborted: true` → you found the knee. That is a success, and the exit code stays 0.
- Per class, the interesting column is the share past `guillotine_ms`, not the average latency. Averages
  hide the queue, and the queue is what produces the errors.
- Compare runs against each other at an **identical pool**, before and after a change. Absolute numbers
  are not comparable to your real traffic: a synthetic pool of distinct cold URLs is harsher than real
  traffic concentrated on a few hot keys. The tool measures deltas honestly and absolutes optimistically.

## Not included

Reading your edge's access log to produce a per-URL breakdown, and watching a run live from a second
terminal, both need privileged access to your own load balancers. That is deliberately outside this tool:
it would mean shipping a container that wants an SSH key for a production edge.

## License

MIT — see [LICENSE](LICENSE).
