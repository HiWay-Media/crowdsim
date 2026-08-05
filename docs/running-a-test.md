# Running a test

The sequence that produces a number you can defend, and the choreography around it that keeps the test
from becoming an incident.

## Safety first, and not as a formality

crowdsim generates real load. Pointed at production it serves real errors to real users, and to every
co-tenant sharing that infrastructure.

**Two gates, neither satisfiable by accident:**

| Gate | Behaviour |
|---|---|
| Target allowlist | The target's host must match `CROWDSIM_ALLOW_TARGETS` or the profile's `safety.allow_hosts`. There is no default. Refusal is exit 3. |
| Safe peak | Above `safety.safe_peak_rps`, the run refuses to start without `--i-know-this-breaks-production` **on the command line**. Never store that override in a config, a job file or an environment. |

There is deliberately **no interactive "are you sure?"** — this runs unattended on schedulers, where a
prompt either hangs or gets auto-answered. The gates are explicit arguments instead.

**Before a run meant to reach the knee:**

1. Agree a window with whoever owns the service.
2. Tell whoever watches the uptime alerts — otherwise you generate a page, not a measurement.
3. Know how you will stop: `Ctrl-C`, or Stop in the GUI (a SIGINT, so the summary is still written).
4. Expect **20–40 seconds of errors** even with `--touch-and-go`. A 504 needs a *queue*, and a queue needs
   time to build; "just a few seconds" is not a thing.

## The sequence

```
doctor → discover → probe → dry-run → touch-and-go → the real ramp → compare
  │         │         │         │           │              │            │
  │         │         │         │           │              │            └─ against a previous run
  │         │         │         │           │              └─ the number you will quote
  │         │         │         │           └─ 20-40s: does anything break at all
  │         │         │         └─ what k6 will be told, without sending anything
  │         │         └─ does the target answer, and what does each layer say about caching
  │         └─ a pool of URLs that actually render
  └─ is this machine able to generate the load at all
```

### 1. `doctor`

```bash
crowdsim doctor --profile my-site.json
```

Prerequisites, and whether the profile parses with its pools resolved. Cheapest possible failure.

### 2. `discover` — a pool that renders

```bash
crowdsim discover --profile my-site.json --limit 400
# → out/pool-20260805T093710Z.json
```

Then **check the URLs render** and point a pool at the file:

```json
"pools": { "pages": "@pool-20260805T093710Z.json" }
```

A 404 is cheap for the app tier, and a 307 measures a redirect. Either yields a flattering result for a
load that never reached the renderer. Regenerate after every deploy — static pools contain build hashes.

### 3. `probe` — one request, read carefully

```bash
crowdsim probe --profile my-site.json --target edge
```

```
status=200  ttfb=0.184s  bytes=46231
── response headers (cache state of every layer it crossed) ──
HTTP/2 200
cache-control: public, max-age=0, must-revalidate
x-proxy-cache: MISS
x-cache: Miss from cloudfront
```

What to get out of it:

- **Does it answer at all**, from where the generator will run (exit 4 if not).
- **Which layers are in the path**, and whether the headers your profile declares actually appear. A header
  that never shows up will report `n/a` for that layer all run long — usually a wrong name in the profile,
  not a cold cache.
- **The page weight.** 46 KB at 380 req/s is ~17 MB/s sustained; if the generator's link cannot do that,
  the run will be invalid before it starts.

### 4. `--dry-run` — see the command, send nothing

```bash
crowdsim load --profile my-site.json --target edge --peak 60 --dry-run
```

Prints the exact k6 invocation, including every env var the generator will receive. Use it to check the
ramp, the mix, the target and the SLO before anything is generated.

### 5. `--touch-and-go` — the cheapest run that still tells you something

```bash
crowdsim load --profile my-site.json --target edge --peak 60 --touch-and-go
```

`--steps 3 --step-dur 20s --hold 0s --abort-delay 10s`: climb, look, leave. It is the smallest experiment
that can still produce errors — not a way to make a load test harmless.

### 6. The real ramp

```bash
crowdsim load --profile my-site.json --target edge \
  --peak 120 --start 30 --steps 4 --step-dur 60s --hold 120s
```

The run climbs in `steps` linear steps from `--start` to `--peak`, then holds. It aborts the moment the
brake trips — holding a system in collapse hurts real users and adds no information.

Reaching for the knee means going past the safe ceiling, deliberately:

```bash
crowdsim load --profile my-site.json --target edge --peak 400 \
  --i-know-this-breaks-production
```

### 7. Compare

```bash
crowdsim history
```

One line per run. The question this answers is whether the knee **moved** after a change — which is the
question the tool can answer honestly. Absolute numbers from a synthetic pool are harsher than real
traffic; deltas at an identical pool are the defensible part.

## Choosing what to point at

| Target | Answers |
|---|---|
| `public` | "how does the CDN handle it" — and costs you egress |
| `edge` | "how does **my** origin handle it" ← usually the question |
| `proxy-node` | "how much does one caching node absorb" |
| `app-instance` | "what is the per-instance capacity" (needs `skip_classes`) |

## Two shapes

- **`mix`** (default) — one k6 scenario per class, each at its share of `--peak`. Reproduces a measured
  traffic mix. This is what you want for capacity numbers.
- **`journey`** — one iteration is one visitor session: a document plus its fan-out, then 2–4 in-app
  navigations with think time. Reproduces the *shape* of real browsing, and needs a recorded journey file.

## Measuring what a cache would buy

```bash
crowdsim cache-ab --profile my-site.json --ttl 10
crowdsim load --profile my-site.json --base-url http://127.0.0.1:8081 --peak 40   # leg A: as-is
crowdsim load --profile my-site.json --base-url http://127.0.0.1:8082 --peak 40   # leg B: candidate
cd cache-ab && docker compose down
```

Two proxies, same origin, same pool, same window — a hit ratio and an offload factor you can defend,
instead of enabling a cache in production and eyeballing a dashboard. Read
[`cache-ab/candidate.conf.template`](../cache-ab/candidate.conf.template) before copying anything from it:
the example change stops honouring the origin's `Cache-Control`, which means **you** now decide what is
cacheable and the origin can no longer correct you.

## When something goes wrong

| What you see | What it means |
|---|---|
| exit 3 | A gate refused it. Nothing was generated. |
| exit 4 from `probe` | The target did not answer. Fix that before generating load. |
| `generator_ok: false` | The run is invalid. Not a tunable — move the generator. |
| `TARGET NEVER ANSWERED` | Connectivity, not capacity: near-total failure at near-zero latency. |
| The brake trips almost immediately | Often a class 404ing on a tier that does not serve it → `skip_classes`. |
| `class skipped: … (pool is empty)` | Expected and reported; the mix is renormalised over the rest. |

[Reading results](reading-results.md) covers what to do with a run that did produce numbers.
