# CLI reference

`crowdsim <subcommand> [flags]`. Everything the tool does is a subcommand of one bash script,
`bin/crowdsim`, whose comment header is also its `--help`.

```bash
crowdsim doctor                                          # what is missing on this machine
crowdsim discover --profile p.json --limit 400            # build a URL pool from the sitemap
crowdsim probe    --profile p.json --target edge          # reachability + cache headers hop by hop
crowdsim load     --profile p.json --target edge --peak 60
crowdsim cache-ab --profile p.json --ttl 10               # two proxy legs, one origin
crowdsim validate p.json                                  # every rule at once, before anything runs
crowdsim history                                          # one line per run: does the knee move?
crowdsim compare <run-a> <run-b>                          # the delta, or a refusal if they differ
crowdsim record  session.har                              # a browser HAR export → a journey file
crowdsim serve                                            # the GUI, on loopback
```

```bash
crowdsim --version      # crowdsim 1.13.2 — including inside the image, where nothing else can say
```

`--version` (and `-V`) answers the question that gets asked while something is going wrong. Inside the image
the answer is baked in at build time, because there is no `package.json` there to read: without it the CLI
had no answer and the GUI reported `null`, so the only source was whatever somebody typed into `docker run`
minutes earlier. `docker inspect` answers it too, from the OCI version label.

## Subcommands

### `doctor`

Checks prerequisites and prints what is missing. With `--profile`, also resolves the profile (pools inlined,
referenced files checked) **and runs the full validation** — the cheapest way to find out a profile is
broken. Always exits 0, even when it found errors: it is a report, not a gate, and a report that exits
non-zero gets wrapped in `|| true` by the first person who scripts it. Use `validate` when you want a gate.

#### `doctor --bench` — measure the generator instead of declaring it

```bash
crowdsim doctor --bench          # ~10s, loopback only, nothing is sent to any target
```

`load` warns you before a run the generator cannot sustain by comparing the bandwidth a peak implies against
`safety.generator_mbps` — a number typed into a profile by hand, usually once, usually copied to the next
profile. So the check that exists to stop you burning a window on an unmeasurable run rested on a guess.

`--bench` measures it: a throwaway HTTP server on loopback, k6 against it in a closed model, and the result
in `out/bench-<run>.json`, which the estimate reads when the profile declares nothing.

```
▶ measuring what this machine can generate (loopback, 10s, 40 VUs)
  nothing is sent to any target: the server below is started here and thrown away.
  ✅ this generator: 45068 req/s of 45 KB → 2080.0 MB/s (16640 Mbit/s)
     ⚠️  loopback: this is the CEILING of this machine, not a prediction. Every real path is
         narrower — a declared safety.generator_mbps you trust still wins over this number.
```

**Run it on the host that will generate the load.** Inside a container on a macOS or Windows host it measures
loopback *inside the VM* — 16 Gbit/s on the machine this was written on — which describes the VM's own
network and says nothing about the path to a target, the very layer that throttles such a run. The artefact
records where it was taken (`in_container`, `kernel`, `virtualised`), the run warns while measuring, and the
bandwidth estimate **refuses to use a virtualised measurement as a ceiling**: silence bought with that number
would be silence in the one place the warning matters.

Read the caveat as part of the number. Loopback is the best network this generator will ever see; the path
to a real target is narrower, always. What the measurement is genuinely good for is the **req/s ceiling** —
the limit that produces dropped iterations and `generator_ok: false` — and for telling a laptop apart from a
runner without anybody guessing.

Three properties, deliberate:

- **A declared `safety.generator_mbps` always wins.** Somebody who knows the uplink is 100 Mbit/s is right,
  and this measurement is not evidence about their network. When the fallback is used, every line says so.
- **Plain `doctor` never benchmarks.** A report that quietly starts generating traffic is not a report.
- **It stays a warning, never a gate**, like the estimate it feeds. A wrong number must not be able to stop a
  run somebody needs.

It needs k6 (exit 5 without it) and node, which serves the local endpoint: Python's `http.server` folds at a
few hundred req/s on loopback, so it would have reported the toy server's ceiling while calling it the
generator's.

### `discover`

Fetches `discover.sitemap` from the profile, extracts `<loc>` entries, strips
`discover.strip_prefix_regex` (locale prefixes the site would redirect), de-duplicates, truncates to
`--limit`, and writes `out/pool-<run>.json`. Point a pool at it with `"pages": "@pool-<run>.json"`.

With `--verify` it then requests each path and keeps only those answering 2xx, reporting what it dropped
and why:

```
▶ verifying 400 paths render (sequential, 0.05s apart — this is not a load test)
  ⚠️  383 of 400 render — 17 dropped (why, per path: out/pool-<run>.report.txt)
      status   404  /news/2019-archive
      redirect 301  /es/teams
```

Use it. A 404 is cheap for the app tier — or is itself rendered — and a 307 measures a redirect: a pool of
either yields a flattering capacity number for a load that never reached the renderer. The alternative was
"verify them by hand", which for 400 URLs means nobody does.

Verification is sequential with a pause between requests (`CROWDSIM_VERIFY_DELAY`, default 0.05s): building
a pool must not itself be a load test. It goes through the same allowlist gate as everything else, and the
report records when it was verified — regenerate after every deploy, since static-asset pools contain build
hashes.

If the document has no `<loc>` entries at all, `discover` exits 4 and says so, rather than writing an empty
pool that surfaces much later as "every class was dropped for want of a non-empty pool".

The same result is written as data, next to the pool, in `out/discover-<run>.json`: what the sitemap offered,
what survived the limit, whether verification ran, and every dropped path with its reason and status. It is
what the GUI reads, and it makes `verified: false` impossible to miss — an unverified pool is a pool nobody
has asked whether it renders.

### `probe`

Preflight against one target: status, TTFB, page size, and every cache-relevant response header, saved to
`out/probe-<run>.log` — and, machine-readably, to `out/probe-<run>.json`. Run it before every load test.
Exits 4 if the target answers ≥400 — a load test against something that does not serve is not a capacity
measurement.

The JSON is what makes `load` able to tell you the bandwidth a peak implies (below). Prose in a log is for
whoever reads this run; the number is for the run somebody starts next week.

It also states a verdict for every layer the profile declares in `cache_headers`, which is the part worth
reading twice:

```
── the layers this profile declares ──
  proxy  X-Proxy-Cache: HIT → HIT (matches /HIT|STALE|UPDATING/i)
  souin  Cache-Status: souin; fwd=miss → MISS (matches /hit/i)
  cdn    X-Cache: NOT PRESENT — nothing to classify
  ⚠️  1 declared header(s) never appeared. That is usually the wrong header NAME in the
     profile rather than a cold cache — and a layer that never speaks is reported as unknown,
     never as a miss, so it cannot quietly drag a hit ratio to zero.
```

Three answers, not two: hit, miss, and *never spoke*. The third is the one that matters, because a header
name that is wrong in the profile looks exactly like a cache that is not working — and reporting it as a miss
would put a confident 0% hit ratio next to a layer the request never crossed. Same rule as the load
generator's own classification (`k6/lib/classify.js`), so the two cannot disagree.

Only cache-relevant headers are stored in the JSON. A probe against a real site can come back with
`Set-Cookie`, and a run archive is not the place for somebody's session.

### `load`

The load test. Validates the profile, resolves the target, passes both gates, then runs k6 with one scenario
per class. Exits 0 whenever it executed — **including when the brake tripped**, because finding the knee is
the intended outcome. Writes `out/summary-<run>.json`, `out/load-<run>.log`, and appends to
`out/history.tsv`.

It also refuses to stay quiet about a generator that cannot win. A load run started **from a container
inside a VM** — Docker Desktop on macOS or Windows, or WSL2 — says so before generating anything:

```
  ⚠️  THIS GENERATOR IS IN A CONTAINER INSIDE A VM (kernel 6.3.13-linuxkit).
      → run k6 natively on this machine, or put this container on a Linux host near the target.
```

Measured, repeatedly: the Docker network layer saturates before the target does, the iterations get dropped,
and the summary comes back `generator_ok: false` after the window is gone. It is a **warning, not a gate**:
the detection (a container marker plus a `linuxkit`/`WSL` kernel) misses runtimes that do not brand their
kernel, and refusing on a signal with false negatives buys nothing. The GUI in a container is unaffected —
it is a page, not a generator.

Before starting it states the bandwidth the requested peak implies, from the newest `probe` of that target:

```
  ℹ️  bandwidth: 380 req/s × 45 KB ≈ 17.6 MB/s (141 Mbit/s) sustained, from probe 20260805T120000Z
  ⚠️  THAT IS MORE THAN THE 100 Mbit/s THIS GENERATOR IS DECLARED TO SUSTAIN.
     Expect generator_ok: false. Move the generator closer to the target, or lower the peak —
     do not lower the SLO.
```

`generator_ok: false` is otherwise diagnosed *after* the window was agreed and the run burned, and most of
those runs were predictable beforehand. Declare `safety.generator_mbps` to have the comparison made; without
it the estimate is still printed. It is a **warning and never a gate**: the estimate assumes every request
weighs what that one page weighed, which is wrong in both directions, and a wrong estimate must never stop a
run somebody needs. The one thing it must not do is stay silent.

### `cache-ab`

Brings up two nginx legs against the same origin, one as-is and one with your candidate config, so you can
load both with the same pool in the same window and get a hit ratio and offload factor you can defend.
Needs docker (exit 5 without it), so it does not work from inside the container image. See
[`cache-ab/README.md`](../cache-ab/README.md).

A **third leg** — normally the narrow subset of the fix you can actually ship this week, measured in the same
window as the full change — needs no compose editing:

```bash
crowdsim cache-ab --new-leg narrow-fix.conf.template            # a copy of the candidate, renamed
crowdsim cache-ab --profile p.json --third narrow-fix.conf.template
```

It refuses (exit 2) a leg template that does not carry the candidate's warning about ignoring the origin's
`Cache-Control` — a third leg is a copy, and a copy is where that paragraph goes missing — and a leg still
identifying itself as `candidate` in `X-AB-Leg`, because two legs answering with the same name cannot be told
apart in the results. `--new-leg` satisfies both by construction and never overwrites an existing file.

`--run` goes the last step: it loads each leg with the same profile at the same peak, one at a time, and then
prints the delta between them.

```bash
crowdsim cache-ab --profile p.json --run --peak 60
```

Sequential on purpose — two generators at once on one host measure the host — so "same window" means the same
session, not the same second, and the output says so. The comparison is `crowdsim compare`, refusals
included. The legs live on `127.0.0.1`, and `--run` does **not** grant itself that allowlist: it is checked
before a container starts, because a subcommand that can authorise a host on your behalf turns the gate into
a suggestion.

### `validate`

```bash
crowdsim validate my-site.json          # or --profile my-site.json
```

Checks the profile against every rule at once and exits 2 if any of them is an error. Generates nothing.

It reports **errors** (the profile would fail, or produce a meaningless run) separately from **warnings**
(it will run, but not necessarily mean what the author thinks):

```
▶ validating my-site.json
  ❌ classes[0].pool     unknown pool "nowhere"
  ❌ slo.brake_class     "gone" is not a class in this profile: nothing would abort the run
  ⚠️  pools.static        pool is empty: every class using it will be dropped from the mix
  2 errors · 1 warning — errors must be fixed before a run means anything
```

Everything at once, and errors first: a validator that stops at the first problem turns one fix into a
sequence of round trips.

**One implementation, two entry points.** The rules live in `lib/validate.mjs` and the GUI's editor applies
exactly these, so validation cannot drift from what a run requires. `load` runs them before the safety
gates and refuses on errors; `doctor --profile` runs them and reports without failing.

Reaching them from bash means **node**, which the CLI otherwise does not need. Its absence is stated, not
hidden: `validate` exits 5 saying so, and `load` prints *"full profile validation needs node — only the
structural checks ran"* and carries on with what `resolve_profile` checks by itself (pool references,
missing pool files, empty pools). What it cannot catch that way is exactly the interesting half — a brake
class that does not exist, an allowlist of `*`, a read timeout below the p95 SLO.

### `history`

Prints `out/history.tsv` as a table: one line per run. What it is for is watching whether the knee moves
after a change — not for reading a single run, which is what the summary is for.

### `serve`

Starts the GUI (needs node and a built UI). Binds `127.0.0.1:8787` by default and refuses any other bind
address without `CROWDSIM_GUI_TOKEN`. See [GUI](gui.md).

## Flags

Only `load` uses most of them; unknown flags are an error (exit 2) rather than being ignored.

| Flag | Default | Applies to | What it does |
|---|---|---|---|
| `--profile <file>` | — | all but `doctor`/`history`/`serve` | The profile. Required. |
| `--target <name>` | `targets.default` | load, probe, discover, cache-ab | A named target from the profile. |
| `--base-url <url>` | — | load | Bypasses target resolution entirely. Still subject to the allowlist. |
| `--shape mix\|journey` | `mix` | load | `mix` = one scenario per class; `journey` = visitor sessions from a recorded journey file. |
| `--peak <n>` | `60` | load, cache-ab | **Total user requests/s** at peak, split across classes by weight. |
| `--start <n>` | `15` | load | Rate of the first step. |
| `--steps <n>` | `4` | load | Number of linear steps from start to peak. |
| `--step-dur <dur>` | `60s` | load | Duration of each step. |
| `--hold <dur>` | `120s` | load | Time held at peak. `0s` means climb and leave. |
| `--rsc-mode repeat\|random` | `repeat` | load | `repeat` replays the few distinct navigation URLs a real build produces; `random` measures the opposite hypothesis (a genuine cache-buster). |
| `--max-p95 <ms>` | `slo.max_p95_ms` | load | Brake: abort when the brake class's p95 crosses this. |
| `--max-5xx <ratio>` | `slo.max_failed_rate` | load | Brake: abort when the failed rate crosses this. |
| `--abort-delay <dur>` | `30s` | load | Grace period before the brake is evaluated, so a cold start does not abort the run. |
| `--safe-peak <n>` | `safety.safe_peak_rps` | load | The ceiling for this run. Can only make the gate stricter in practice — going above still needs the override. |
| `--i-know-this-breaks-production` | off | load | The only way past the safe peak. Command line only, every time. |
| `--touch-and-go` | off | load | Preset: `--steps 3 --step-dur 20s --hold 0s --abort-delay 10s`. The cheapest ramp that still produces errors — **not** a way to make a test harmless. |
| `--skip-classes <a,b>` | target's `skip_classes` | load | Classes to leave out (routes a given tier does not serve). |
| `--insecure` | target's `insecure` | load, probe | Skip TLS verification, for a node addressed by IP. |
| `--slack` | off | load | Post a recap to `CROWDSIM_SLACK_WEBHOOK`. |
| `--dry-run` | off | load | Print the exact k6 invocation and stop. Sends nothing. |
| `--limit <n>` | `400` | discover | Maximum URLs in the pool. |
| `--verify` | off | discover | Request each discovered path and keep only those answering 2xx. Sequential, paced by `CROWDSIM_VERIFY_DELAY`. |
| `--ttl <s>` | `10` | cache-ab | Cache TTL for the candidate leg. |
| `--port <n>` | `8787` | serve | GUI port. |
| `--bind <addr>` | `127.0.0.1` | serve | GUI bind address. Anything but loopback needs a token. |
| `-h`, `--help` | — | all | The usage header. |

## Environment

| Variable | Default | What it does |
|---|---|---|
| `CROWDSIM_ALLOW_TARGETS` | **none** | Comma-separated host globs the tool may hit. Required unless the profile declares `safety.allow_hosts`. No default, by design. |
| `CROWDSIM_OUT` | `./out` | Where summaries, logs, resolved profiles and `history.tsv` go. |
| `CROWDSIM_PROFILES` | `./profiles` | The directory the GUI reads and writes. |
| `CROWDSIM_SLACK_WEBHOOK` | unset | Target for `--slack`. A secret: never hardcode it. |
| `CROWDSIM_ROOT` | parent of the script | Where `k6/`, `gui/` and `cache-ab/` live. Set to `/crowdsim` in the image. |
| `CROWDSIM_K6_SCRIPT` | `$CROWDSIM_ROOT/k6/live-event.js` | The generator script. |
| `CROWDSIM_GUI_PORT` / `_BIND` / `_TOKEN` | `8787` / `127.0.0.1` / unset | See [GUI](gui.md). |
| `CROWDSIM_BIN` | `$CROWDSIM_ROOT/bin/crowdsim` | Which driver the GUI spawns. |
| `CROWDSIM_VERIFY_DELAY` | `0.05` | Seconds between requests during `discover --verify`. Building a pool must not be a load test. |

## Exit codes

They are an API: the Nomad job, CI and the GUI all branch on them.

| Code | Meaning | Typical cause |
|---|---|---|
| `0` | Executed | Also when the brake tripped — that is an outcome, not an error |
| `2` | Usage | Unknown flag or subcommand, missing/unparseable profile, unknown target, `--shape journey` without `journey.file` |
| `3` | A safety gate refused it | No allowlist, host not allowlisted, peak above the ceiling without the override, GUI asked to bind off-loopback without a token |
| `4` | Target unreachable | `probe` got ≥400 or no answer |
| `5` | Missing prerequisite | k6 absent, docker absent for `cache-ab`, node absent for `serve` |

### `compare`

```bash
crowdsim compare 20260805T090000Z 20260805T093000Z
```

The delta between two runs from `out/`: overall p50/p95/p99, failed rate, the share past the read timeout,
504s, the cache hit ratio per layer, and the same per class. An improvement and a regression are marked
differently, and the footer says what the numbers are worth:

```
  A  20260805T090000Z   profile live-event  https://www.example.test  shape mix  peak 60
  B  20260805T093000Z   profile live-event  https://www.example.test  shape mix  peak 60

  ── overall ─────────────────────────────────────────────────────────────────────
                               A           B   change
  p95                     200 ms      140 ms   -60 ms (-30%) ✅
  failed rate              0.00%       0.00%   +0.00 pp  =

  ── cache hit ratio per layer ───────────────────────────────────────────────────
  proxy                   61.00%      94.00%   +33.00 pp (+54%) ✅
  cdn                        n/a         n/a   header never appeared in either run
```

**The value is in what it refuses** (exit 2), because a comparison between two runs that were not the same
experiment is a confident number with nothing behind it:

| It refuses when | Because |
|---|---|
| either run has `generator_ok: false` | that run has no numbers at all — the generator was the bottleneck |
| either run never reached its target | connectivity, not capacity |
| the URL pools differ | two different experiments; a colder pool is a harder test. Compared from the archived `profile-<run>.json`, which is why it is archived |
| a pool exists in only one run | same reason |
| the shapes differ | a journey and a mix are not the same load |

A different **target** or a different **peak** is a legitimate question — what does the CDN add, where is the
knee — so those are allowed and *stated*: the report says this is a comparison between two targets, not a
before/after of one.

`--json` prints the same thing as data — the same verdicts, the same refusals, the same exit code — which is
how the GUI shows a comparison without owning a second copy of these rules:

```bash
crowdsim compare 20260805T090000Z 20260805T093000Z --json
```

### `record`

```bash
crowdsim record session.har                        # → out/journey-<run>.json
crowdsim record session.har --out ~/private/journey.json --force
```

Turns a browser HAR export into the journey file `--shape journey` needs. In DevTools: **Network → Preserve
log on → reload the page → click around → the ⬇ Export HAR button**. Then:

```
  ✅ 2 pages · 1 navigation requests · 4 assets
     origin https://www.example.test  →  out/journey-20260805T174432Z.json
     from 12 recorded requests
     dropped 2 third-party (fonts.gstatic.com, www.google-analytics.com) — not your capacity problem,
             and not yours to generate load against
     dropped 1 that did not answer 2xx/3xx
     dropped 1 non-GET (this tool does not send writes)
     stripped per-request query params: _, _rsc
```

Four judgements it makes, all of them ways to end up measuring something other than your site:

- **Third-party hosts are dropped.** Analytics and fonts are not your capacity problem, and generating them
  would aim load at somebody else's infrastructure — from a tool whose premise is that you only hit hosts you
  explicitly allowed.
- **Per-request cache-busters are stripped; per-build ones are kept.** Measured, not guessed from a list of
  names: if a parameter's value *varies* between requests to the same path it is noise, and keeping it turns
  the recording into a pool of unique cold URLs — the pool that makes any cache look useless. A constant value
  is a build hash, part of the URL the cache sees, and dropping it would measure a URL that does not exist.
- **The navigation parameter (`_rsc`) is stripped entirely**, because the generator adds it back itself, and
  whether it repeats or is randomised is the experiment (`rsc.mode`).
- **Failures and non-GET requests are not recorded.** A 404 in a journey is a load test of your error page,
  and this tool does not send writes at a production system.

The origin travels inside the file: a journey recorded against staging tells you nothing about production's
fan-out. `record` **refuses to write into the profile directory** — a journey names real routes, the same
category as a URL pool — and refuses to overwrite an existing file without `--force`. Needs node; the rules
live in `lib/har.mjs` with unit tests. Exit 4 when nothing usable was recorded, with what to record instead.

Re-record after a redesign or a deploy that changes the fan-out: a journey is a snapshot of what one build
made the browser fetch.

## Output files

```
out/
  summary-<run_id>.json    the result — see Reading results
  load-<run_id>.log        the full run log
  probe-<run_id>.log       the preflight
  probe-<run_id>.json      the same as data: page weight + a verdict per declared cache layer
  pool-<run_id>.json       what discover found
  pool-<run_id>.report.txt what --verify dropped, and why
  discover-<run_id>.json   the same as data: offered, kept, dropped, and whether it was verified
  journey-<run_id>.json    what record extracted from a HAR (data about your site: keep it private)
  profile-<run_id>.json    the profile as resolved for that run (pools inlined)
  history.tsv              one appended line per run
  bench-<run_id>.json      what doctor --bench measured this machine doing, and where it was measured
                           (loopback: a ceiling — and not one at all if taken inside a VM)
  gui-run.json             written by `serve` only: the run in flight, so a restart can find it
```

`<run_id>` is a UTC timestamp, `20260805T093710Z`. Every subcommand that writes files announces its run id in
its output, which is how anything reading afterwards — you, or the GUI — finds them. `out/` is gitignored: it
names your hosts.

## See also

- [Running a test](running-a-test.md) — how these commands fit together
- [Profile reference](profile.md) — what `--target`, the classes and the SLO come from
- [Reading results](reading-results.md) — the summary, field by field
