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
doctor → discover → probe → init → dry-run → touch-and-go → the real ramp → compare → report
  │         │         │       │        │           │              │            │         │
  │         │         │       │        │           │              │            │         └─ hand it over
  │         │         │       │        │           │              │            └─ against a previous run
  │         │         │       │        │           │              └─ the number you will quote
  │         │         │       │        │           └─ 20-40s: does anything break at all
  │         │         │       │        └─ what k6 will be told, without sending anything
  │         │         │       └─ a first profile, drafted from the three steps above (first time only)
  │         │         └─ does the target answer, and what does each layer say about caching
  │         └─ a pool of URLs that actually render
  └─ is this machine able to generate the load at all
```

The first time through, `init` sits in the middle of that line rather than at the start: writing a profile is
easier once the tool has measured the page weight, the cache layers and a pool that renders. Every run after
that starts at `probe`.

### 1. `doctor`

```bash
crowdsim doctor --profile my-site.json
```

Prerequisites, and whether the profile parses with its pools resolved. Cheapest possible failure.

### 2. `discover` — a pool that renders

```bash
crowdsim discover --profile my-site.json --limit 400 --verify
# → out/pool-20260805T093710Z.json          (only the paths that answered 2xx)
# → out/pool-20260805T093710Z.report.txt    (what was dropped, and why)
```

`--verify` is the step nobody performs by hand at 400 URLs. Then point a pool at the file:

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
  the run will be invalid before it starts. `probe` records it, and `load` states the implied bandwidth
  before every run — declare `safety.generator_mbps` and it is checked rather than merely reported.

### 3b. `init` — the first profile, from what was just measured (first time only)

```bash
crowdsim init --out my-site.json
crowdsim validate my-site.json      # it will refuse: that is the point
```

Drafts a profile from the artefacts the last three commands left in `out/`, naming which run each part came
from. What it leaves blank is what matters: `safety.allow_hosts` and `safety.safe_peak_rps` stay empty, the
class weights are labelled a starting point rather than a mix, and everything else it cannot measure is a
`TODO` instead of a plausible number. `validate` refuses the file until you have been through them. Details
in the [CLI reference](cli.md#init).

Bootstrapping question, answered: the first `probe` and `discover` need *a* profile, so start from
[`profiles/example.json`](../profiles/example.json) with your own `base_url` and allowlist, and let `init`
write the real one afterwards.

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
  --peak 120 --start 30 --steps 4 --step-dur 60s --hold 120s --warmup 30s
```

`--warmup 30s` runs the generator once before the measured run and throws the numbers away. The first thirty
seconds of any run measure an empty cache, a cold connection pool and an unJITted app — and they sit inside
the p95 you are about to quote. With a per-class SLO they do worse than that: a class held to 800 ms trips
the brake on the cold start and the run reads as a knee that is not there. The warm-up defaults to `--start`
and has [no brake of its own](reading-results.md#a-warm-up-is-not-part-of-the-result); its numbers go to
`warmup-<run>.json`, never into the summary.

The run climbs in `steps` linear steps from `--start` to `--peak`, then holds. It aborts the moment the
brake trips — holding a system in collapse hurts real users and adds no information.

**The steps are the measurement, not the run.** Every request is tagged with the step it happened in, so one
run shows where latency left the SLO instead of one p95 averaged over every rate it passed through:

```
  ── per step (the ramp: where the knee is) ──
  step        req/s asked  achieved      p50       p95       p99    >SLO   failed
  ───────────────────────────────────────────────────────────────────────────────
  s1                  2→3       2.3   439 ms    709 ms    798 ms   0.00%    0.00%
  s2*                 3→5       3.0   660 ms    855 ms    856 ms   0.00%    0.00%
```

That is a knee between 3 and 5 req/s, from a single run. Read
[the per-step table](reading-results.md#4-the-per-step-table-not-the-aggregate-p95) before quoting anything:
a climbing step sweeps a range of rates rather than holding one, and `--hold` is the only part of the run
where a rate was actually sustained. So the ramp is what finds the knee, and the hold is what you quote.

Reaching for the knee means going past the safe ceiling, deliberately:

```bash
crowdsim load --profile my-site.json --target edge --peak 400 \
  --i-know-this-breaks-production
```

### 7. Compare

```bash
crowdsim history                                        # one line per run: did the knee move?
crowdsim compare 20260805T090000Z 20260805T093000Z      # the delta, per class and per cache layer
```

The question these answer is whether the knee **moved** after a change — which is the question the tool can
answer honestly. Absolute numbers from a synthetic pool are harsher than real traffic; deltas at an identical
pool are the defensible part.

`compare` earns its keep by **refusing**: two runs at different URL pools are two different experiments, and a
run with `generator_ok: false` has no numbers at all. Either one gets exit 2 and an explanation instead of a
plausible percentage. A different target or peak is allowed and labelled, because "what does the CDN add" is a
real question — it is just not a before/after of one target. Details in the
[CLI reference](cli.md#compare).

### 8. `report` — hand the result to somebody else

```bash
crowdsim report 20260820T125356Z --out ticket.md
crowdsim report 20260820T125356Z --compare 20260819T171100Z
```

The numbers paste easily and the caveats do not, which is how a p95 from a synthetic pool becomes a capacity
figure in somebody else's slide two weeks later. `report` writes the run as markdown with the caveats attached
— validity first, then what happened (naming the class and threshold that stopped it), then the numbers, then
what they are worth. A run with `generator_ok: false` comes out as **DISCARD THIS RUN**, with no latency table
to quote. It names your hosts, so it belongs wherever your run archives already belong.

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
  navigations with think time. Reproduces the *shape* of real browsing, and needs a recorded journey file:

  ```bash
  # DevTools → Network → Preserve log → load the page, click around → Export HAR
  crowdsim record session.har                     # → out/journey-<run>.json
  crowdsim load --profile my-site.json --shape journey --peak 40
  ```

  `record` drops third-party hosts, strips per-request cache-busters while keeping build hashes, and does not
  record failures or writes — each of those is a way to end up measuring something other than your own site.
  See [CLI reference](cli.md#record).

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
| The brake trips almost immediately | Often a class 404ing on a tier that does not serve it → `skip_classes`. Or a cold start against a sharp per-class SLO → `--warmup`. Either way `aborted_by` names the class. |
| `class skipped: … (pool is empty)` | Expected and reported; the mix is renormalised over the rest. |

[Reading results](reading-results.md) covers what to do with a run that did produce numbers.
