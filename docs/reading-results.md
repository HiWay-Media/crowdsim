# Reading results

A load test's failure mode is not a crash — it is a plausible number that is wrong. This page is the order
in which a run must be read, and what every field means.

## Read it in this order

```
1. generator_ok      false → STOP. Discard the run. Nothing below means anything.
2. target_unreachable true  → connectivity, not capacity. Not a knee.
3. aborted           true  → you found the knee. That is a success.
4. per step: at which RATE did latency leave the SLO   ← the knee itself
5. per class: the share past guillotine_ms             ← your margin
6. only then: the overall latency, errors, cache
```

### 1. `generator_ok: false` → discard the run

More than 2% of iterations were dropped: k6 could not start them at the requested rate, so the bottleneck
was the **generator or its network**, not the system under test.

```
generator     ⛔ DID NOT hold: 4213 iterations dropped → RESULT INVALID
```

This is the single most common way to get a confidently wrong answer out of a load test, because such a run
looks *exactly* like a healthy system absorbing the load: low latency, no errors, a rate that seems fine.
It is not a threshold to tune. Move the generator closer to the target, or onto a bigger host, and repeat —
and if you were running through Docker on a macOS or Windows laptop, that is the cause.

### 2. `target_unreachable: true` → connectivity

Over 90% failed **and** p95 under 50 ms. A saturated system is *slow* before it errors — a real knee shows
up as latency climbing into the timeout. Near-zero latency with near-total failure means connections
refused or never routed: wrong address, wrong port, TLS, firewall, or a container whose network namespace
does not reach the target. Reporting that as "the brake found the knee" would hand out a capacity number
for a target nobody touched. Run `crowdsim probe` before trying again.

### 3. `aborted: true` → the knee, and that is the point

A threshold with `abortOnFail` fired: the brake stopped the run. The exit code stays **0**, because this is
the outcome the tool exists to produce. Holding a system in collapse hurts real users and adds no
information.

**Which threshold, for which class**, is in `aborted_by` — and in the panel, on the line under the outcome:

```
  outcome       ⛔ ABORTED by the brake (knee exceeded)
                stopped by class rsc_page — p(95)<300, reached 534
```

```json
"aborted_by": { "metric": "http_req_duration", "class": "rsc_page",
                "threshold": "p(95)<300", "value": 464.84875 }
```

Since a class can declare [its own SLO](profile.md#a-class-may-set-its-own-limit), the knee is not
necessarily at the profile's `max_p95_ms` nor in its `brake_class`, and "the brake tripped" stopped being
enough to act on. `class` is `null` when an overall threshold fired, and the whole field is `null` on any run
archived before this existed — never a guess reconstructed from the profile, which would name a class that
may not be the one that crossed.

### 4. The per-step table, not the aggregate p95

A run climbs from `--start` to `--peak` in `--steps` steps and then holds. The `latency` line at the top of
the panel is one p95 over **all** of it, so it describes a mixture of rates — mostly the cheap early ones —
and belongs to no rate the system was ever held at. The table below it is the one that answers the question
the tool is named after:

```
  ── per step (the ramp: where the knee is) ──
  step        req/s asked  achieved      p50       p95       p99    >SLO   failed
  ───────────────────────────────────────────────────────────────────────────────
  s1                  2→3       2.3   439 ms    709 ms    798 ms   0.00%    0.00%
  s2*                 3→5       3.0   660 ms    855 ms    856 ms   0.00%    0.00%
  * partial: the run ended inside this step, so this row is a fraction of it — usually the worst
    fraction, since the brake fires while latency is climbing. It is not a result for that rate.
```

Three things in that table are deliberate:

- **`5→10` is not `10`.** A k6 stage ramps linearly from the previous target to its own, so a climbing step
  *sweeps* a range of rates rather than holding one. A row labelled with a single number would be the same
  averaging one level down.
- **`20 held` is the hold**, and the only part of a run where the requested rate was actually sustained. If
  you want one rate to quote, it is this one.
- **`achieved` is measured over that step's own window.** k6's rate field on a tagged sub-metric divides by
  the whole test duration — it reported 1.7 req/s for a step that delivered 7.5 — so the table computes it
  from the step's requests and the step's seconds.

A step that sent nothing is absent rather than shown as a row of zeros, which would read as a step that was
fast. Requests still in flight when the last stage ends carry no step tag at all: crediting them to the peak
would move the slowest requests of the run into the step people quote.

### 5. The share past `guillotine_ms`, per class

`guillotine_ms` is your reverse proxy's read timeout. Requests slower than it become 504s for real
visitors, so the interesting column is not the average latency but the **percentage that crossed it**:

```
  class           target req/s      p50       p95       p99    >SLO   failed
  ─────────────────────────────────────────────────────────────────────────
  rsc_page                25.9   140 ms    900 ms   1600 ms   0.31%    0.10%
  html                    13.9    90 ms    500 ms    800 ms   0.00%    0.00%
  rsc_search              13.7   380 ms   4200 ms   8900 ms   4.80%    0.20%
```

That 4.80% is the margin: at this rate, roughly one search in twenty is already a 504 for somebody.
Averages hide the queue, and the queue is what produces the errors.

## `summary-<run_id>.json`, field by field

### Run identity

| Field | Meaning |
|---|---|
| `run_id` | UTC timestamp, e.g. `20260805T093710Z`. Also the `X-Crowdsim-Run` header on every request, so you can find the test in your own access logs. |
| `profile` | The profile's `name`, not its filename. |
| `shape` | `mix` or `journey`. |
| `base_url` | What was actually hit. |
| `rsc_mode` | `repeat` or `random`. Runs with different modes are not comparable. |
| `peak_rps_user_target` | The `--peak` you asked for, in total user req/s. |

### Verdicts

| Field | Meaning |
|---|---|
| `aborted` | A real threshold failed — the brake stopped the run. (Thresholds ending in `>=0` are decoration used to surface per-class sub-metrics; they are excluded.) |
| `generator_ok` | `dropped_iterations` ≤ 2% of `requests`. False invalidates everything else. |
| `target_unreachable` | `failed_rate` > 0.9 and p95 null or < 50 ms. |
| `per_step` | The ramp, step by step: `requested_rps` (and `from_rps`, the rate the step swept up from), `sustained`, `achieved_rps`, `requests`, `p50/p95/p99`, `failed_rate`, `over_guillotine_rate`, `partial`, and `per_class` for the classes that ran in it. `null` for a run whose caller supplied no ramp. |
| `aborted_by` | Which threshold stopped it: `{ metric, class, threshold, value }`, or `null` — including on older runs, which did not record it. |
| `warmup` | What the warm-up was (`"30s at 20 req/s"`), or `null`. The warm-up's own numbers are in `warmup-<run_id>.json` and are never mixed in here. |
| `is_warmup` | `true` only inside `warmup-<run_id>.json`. That file is not a result: it has no brake and its latencies describe a cold system on purpose. |

### Volume and latency

| Field | Meaning |
|---|---|
| `requests` | Total HTTP requests, all classes. Not page views. |
| `rps_avg` | Achieved rate. Compare it with `peak_rps_user_target`: a large gap with `generator_ok: true` usually means the brake cut the run short. |
| `failed_rate` | k6's `http_req_failed` — transport errors and non-2xx/3xx. |
| `dur.p50` / `p95` / `p99` / `max` | Overall request duration, ms, **across the whole ramp** — a mixture of rates, so it is not the latency at your peak. Use `per_step` for that. `null` means no sample. |
| `dropped_iterations` | Iterations k6 could not start. The input to `generator_ok`. |

### Errors and the timeout

| Field | Meaning |
|---|---|
| `guillotine_ms` | The read timeout from the profile, echoed for context. |
| `over_guillotine_rate` | Share of all requests slower than it. |
| `e504` / `e502` / `e5xx` / `e404` | Counters. `e5xx` is cumulative: a 504 is also a 5xx. A 404 count that is not ~0 usually means a pool of URLs that do not exist, or a class hitting a tier that does not serve it. |

### Cache

| Field | Meaning |
|---|---|
| `cache.<layer>` | Hit ratio per declared layer, `0`–`1`, or **`null` = never observed**. |

`null` is not 0. A `Rate` with no samples would report 0%, which reads as "the cache missed everything"
when the truth may be "this layer was never in the path" or "the header name in the profile is wrong". If
every layer is `null`, the summary says so in words.

### Per class

`per_class.<name>` carries `p95`, `p99`, `med`, `failed`, `over_guillotine`, `reqs`, `cache.<layer>`, and
`rps_target` — the rate that class was asked to produce (`null` in journey shape, where sessions rather
than classes are scheduled). `mix_target` lists the same targets in one place.

A class with `reqs: 0` did not run: it was skipped, dropped for an empty pool, or does not exist in this
shape. The text table leaves it out rather than printing a row of zeroes.

## `history.tsv`

One appended line per run, written by the driver — the GUI reads the same file, so runs launched from a
terminal and runs launched from the page sit side by side:

```
run_id  profile  base_url  shape  peak  aborted  reqs  rps  failed  p95  e504  gen_ok
```

```bash
crowdsim history          # printed as a table
```

## Handing a run to somebody else

```bash
crowdsim report 20260820T125356Z --out ticket.md
```

The numbers are the easy part to paste; the caveats are what gets lost, and a p95 with no caveats becomes a
capacity figure in somebody else's slide. [`report`](cli.md#report) writes the run as markdown with the
caveats attached to it — validity first, then what happened, then the numbers, then what they are worth. A
run with `generator_ok: false` comes out as **DISCARD THIS RUN** with no latency table at all.

## A warm-up is not part of the result

`--warmup 30s` runs the generator once before the measured run, at `--warmup-peak` (default: `--start`), and
throws its numbers away — into `warmup-<run_id>.json`, which exists so you can check the warm-up did what you
asked, not so you can quote it. Nothing from it reaches `summary-<run_id>.json`; the measured run only
records **that** it happened, in `warmup`.

It matters because the first thirty seconds of any run measure an empty cache, a cold connection pool and an
unJITted app, and those thirty seconds sit inside the p95 you are about to quote. It matters even more with a
per-class SLO: a class held to 800 ms will trip the brake on a cold start and the run will read as a knee
that is not there.

**The warm-up has no brake**, deliberately: a cold start crossing an SLO is what a warm-up exists to absorb,
so aborting there would abort exactly the runs that most needed warming. Its thresholds are the decorative
ones that make the per-class sub-metrics appear, nothing more — which is also why its file is not a result.
Read it if the measured run surprises you: a warm-up already at 4 s p95 says the ramp never had a chance.

What a warm-up does **not** do is flatter a cold system. It warms the same pool the run is about to use, so
the measured run still faces the URLs it was going to face — and at a pool of 400 distinct cold URLs, warming
one is not warming the next.

## Comparing runs honestly

- Only against each other, and only at an **identical URL pool**. A synthetic pool of distinct cold URLs is
  harsher than real traffic concentrated on a few hot keys.
- Same `rsc_mode`, same shape, same target. `repeat` and `random` answer different questions.
- Never against a run with `generator_ok: false`.
- Absolute numbers are optimistic in one direction and pessimistic in another; the **delta** across a change
  is what the tool measures honestly. That is what to quote.

The GUI's history view enforces the first three: it only offers runs with the same profile, target and shape
as comparable, marks invalid runs as unusable, and draws them hollow in the knee plot instead of alongside
valid ones.

## What is deliberately not here

A per-URL breakdown of which routes were slowest. That needs your edge's access log, which means privileged
access to your load balancers — outside a tool that would then want an SSH key for a production edge. The
`X-Crowdsim-Run` header exists so you can do that analysis in your own log stack.

## See also

- [Running a test](running-a-test.md) · [Profile reference](profile.md) · [GUI](gui.md)
