# INTENT.md — crowdsim

**Why this repository exists**, what it commits to doing, and what it *deliberately* does not do.
This is the intent document. It outlives individual features, and it is what a proposal gets measured
against before anybody writes it.

| File | The question it answers |
|---|---|
| **`INTENT.md`** (this one) | **Why** the tool exists, what it is for, what is out of scope |
| [`README.md`](README.md) | **What** it is — install, safety, the subcommands, how to read a result |
| [`docs/`](docs/index.md) | **How** to use it, page by page — published at [hiway-media.github.io/crowdsim](https://hiway-media.github.io/crowdsim/) |
| [`AGENTS.md`](AGENTS.md) · [`CLAUDE.md`](CLAUDE.md) | **How work happens here** — operating rules and known traps, for people and for AI agents |
| [`.github/roadmap.json`](.github/roadmap.json) | **What is missing** — the single source for labels, milestones and issues |
| [`CHANGELOG.md`](CHANGELOG.md) | **What changed** — every commit ships as a tagged release |

---

## 1. In one line

Turn *"the app tier saturates somewhere around N req/s"* and *"a shared micro-cache would cut origin load
by about X"* from two numbers reconstructed after an outage into two numbers you can produce on demand —
against a real live-event frontend, without being the reason it goes down.

## 2. The problem it solves

A live event puts a server-rendered frontend under a spike that nothing else in its week resembles. When
it collapses, the numbers that matter get reconstructed from logs, after the fact, by people who were
awake for the wrong reason. Both of them are guesses, and both get quoted for months.

Trying to produce them with a generic load tool replaces one guess with a more convincing one. Three ways
that happens, all of them measured here rather than imagined:

- **A flat URL list measures a load that does not exist.** The traffic that takes down an SSR frontend is
  made of *chains*: one document pulls N framework navigation requests (React Server Components, Turbo,
  Inertia…) plus M assets, all served by the *same* single-threaded process. Fire a uniform list and the
  answer comes back reassuring.
- **A run without a brake buys no information.** Once the system is in collapse, holding it there hurts
  real users and tells you nothing you did not already know at the crossing.
- **A generator-bound run is indistinguishable from a healthy system.** If the generator never delivered
  the rate it was asked for, the graphs look like absorption. This is the most common way to be
  confidently wrong, and it is why validity is an output field and not a footnote.

crowdsim exists to make the honest version repeatable: a mix measured on your own edge log, a ramp that
stops itself at your SLO, and a result that says out loud when it means nothing.

## 3. Goals, in priority order

1. **Produce a knee that survives being quoted.** Climb in steps, abort at the first SLO crossing, report
   per step rather than one p95 over a whole ramp — and state the knee *once* or refuse to state it.
   A crossing undone at a higher rate is a cold cache, not a knee, and gets reported as that.
2. **Never be the cause of the outage.** Two gates that cannot be satisfied by accident: an explicit
   target allowlist with no default anywhere, and an override for the safe peak that only exists on the
   command line. One run at a time; stop is a SIGINT so the summary still gets written.
3. **Refuse to hand over a number that means nothing.** `generator_ok`, `target_unreachable` and
   `over_guillotine_rate` exist only to stop somebody believing a run they should not.
4. **Measure caching instead of arguing about it.** `cache-ab` puts two proxies in front of the same
   origin, identical but for the change under evaluation, and loads both with the same pool in the same
   window — a hit ratio and an offload factor you can defend, rather than a dashboard you eyeballed after
   enabling something in production.
5. **Be usable by somebody who did not write it.** `doctor` before anything else, `probe` / `discover` /
   `weights` / `init` so the first profile comes from measurement instead of a blank file, a GUI for
   people who should not have to assemble argv, one container image, and documentation whose commands
   were run before they were written down.
6. **Be safe to change.** The arithmetic that decides how much load you generate does not throw when it
   is wrong — it produces a plausible number. So it lives in pure modules with tests, and `make test`
   sends no requests at all, which is why CI can run it on every push.

## 4. Non-goals (explicit)

None of these is a gap waiting to be filled. Each one is a decision.

- **Not a monitoring or APM system.** crowdsim produces a run: a summary, a log, a history row, optionally
  a drawn page. It stores no time series, serves no dashboard, and raises no alert. What your platform
  does between runs is your existing observability's job.
- **It does not go and get your access log.** `weights` reads a file or stdin that *you* hand it, writes
  nothing from it, and fetches nothing. A per-URL breakdown straight off your edge would mean shipping a
  container that wants credentials for a production load balancer.
- **No scheduler and no user accounts in the GUI.** Recurring load against your own production belongs
  somewhere auditable: the Nomad dispatch and the Kubernetes Job carry the target, the rate and the
  override in the call, and the call is attributable. A cron button on a web page is not.
- **No interactive confirmation, anywhere.** This runs unattended on schedulers, where a prompt either
  hangs or is auto-answered. The gates are explicit arguments instead — which also means they show up in
  the log of whoever launched it.
- **Not a general-purpose HTTP benchmark.** If you want to fire a flat list at a fixed rate, `hey`,
  `vegeta`, `wrk` and plain k6 already do that well. crowdsim only earns its complexity where the mix,
  the brake and the validity check matter.
- **Not a browser or RUM tool.** No JavaScript execution, no Core Web Vitals, no rendering. It measures
  what the server does under a mix; what the browser then does with the bytes is a different instrument.
- **Never a default allowlist, not even "for the tests".** An image that agrees to hit anything is a
  load generator whoever pulled the tag has no way to see. CI asserts the absence of that default on
  every build.
- **Not a tool for hosts you do not own.** The allowlist is the whole point: a load test aimed at the
  wrong hostname is indistinguishable from an attack, so the tool refuses to start rather than trust an
  argument.
- **No real profiles, and no run reports, in this repository.** A profile holds hostnames, URL pools and
  a map of how a site is built; keep yours in your own private repo. Here there is exactly one,
  [`profiles/example.json`](profiles/example.json), documented inline. Reports of real runs belong in the
  private ops repository that owns the infrastructure they describe.
- **Not a laptop-to-production generator through Docker.** On macOS and Windows the Docker network layer
  saturates before the target does, and the run is invalid. The container is right for the GUI anywhere
  and for the generator on a Linux host near the target; native k6 for everything else. Documented as a
  failure to recognise, not hidden.

## 5. Principles — the invariants, with the why

| Principle | Why |
|---|---|
| **Both gates live in `bin/crowdsim`, and nowhere else** | A second code path that composes k6 arguments is a second place for a gate to be wrong. The GUI spawns the driver, the Nomad job passes flags, the image ships no defaults. This is the one architectural rule the project will not trade. |
| **One rule set per decision, shared by every entry point** | The profile rules live in `lib/validate.mjs` for the CLI, `doctor`, `load` and the GUI alike. Two copies drift, and the day they do, the one that matters is whichever the operator did not run. |
| **Finding the knee exits 0** | The brake tripping is the intended outcome. A scheduler must not file a successful experiment as a failed job — so the k6 non-zero exit is deliberately not propagated, and the summary is still written. |
| **Validity is a first-class output** | A load test's real failure mode is a plausible number, not a crash. `generator_ok: false` is a banner that says discard the run, not a field somebody may notice. |
| **The mix is data you measured, never a default** | `--peak` is total user req/s split by weights counted on your own edge log. Weights renormalise over the classes that actually run, and an empty pool drops its class loudly, because a fallback would measure the wrong request type under the right label. |
| **Refuse rather than estimate** | The knee is stated once or not at all; `compare` refuses two runs that are not comparable; a header that never appeared is `unknown`, never `MISS`. The alternative is a confident number quoted in rooms this tool is not in. |
| **The logic that can be silently wrong is pure and tested** | `k6/lib/` and `lib/` run in k6 *and* in `node --test`, with randomness injected rather than called. The tested code is the running code — at the cost of ES2019 and no imports. |
| **The GUI keeps no state of its own** | It is a form over the CLI: same child process, same gates, same `out/` directory. A second version of the truth is always the wrong one. |
| **One image, not two** | Two tags drift, and the day they do somebody runs a load test with a driver that does not match the page that launched it. |
| **Zero infrastructure data, because the repo is public** | No real hostname, private address, internal path or webhook in code, docs, comments or commit messages. Examples use `*.test` domains and RFC 5737 addresses. |
| **The documentation is part of the product, and verifies its own claims** | Commands get run before they are written down — which has already caught two real bugs. `make check-docs` then asserts that the versions, the commands and the quoted output still exist. It exists because the docs spent eleven releases telling people to pull an image from before half the features. |
| **Every commit ships as a tagged release** | The CHANGELOG becomes the dated history of the tool rather than of the code, and `git log` can answer "when did this behaviour change?". |
| **Every fixed bug starts from a test that reproduces it** | Otherwise the fix is a belief. |

## 6. Boundaries — what lives where

```
                     ┌────────────────────────────────────────────────┐
                     │            crowdsim (this repo, MIT)           │
                     │                                                │
   the gates,     ──▶│  bin/crowdsim    driver: gates, resolution,    │
   the reporting     │                  reporting, exit codes         │
   the load       ──▶│  k6/             generator + pure logic        │
   the front end  ──▶│  gui/            a form over the CLI           │
   the node logic ──▶│  lib/            validate · har · weights ·    │
                     │                  report-html                   │
   how to use it  ──▶│  docs/ · README  published to Pages            │
   how to ship it ──▶│  Dockerfile · ci/nomad · ci/kubernetes         │
   the A/B        ──▶│  cache-ab/       two legs, one origin          │
                     └───────────────┬────────────────────────────────┘
                                     │ explicit boundaries
      ┌──────────────────────────┬───┴───────────────┬───────────────────────────┐
      ▼                          ▼                   ▼                           ▼
 your private repo        your ops repo        your observability          k6 (upstream)
 the real profiles:       run reports,         dashboards, alerts,         the generator
 hosts, pools, SLOs,      incidents, the       time series between         runtime — pinned,
 safe ceiling             decisions taken      runs                        never reimplemented
```

Practical rule: *"how does the tool behave"* → here. *"what did we measure on our own platform, and what
did we decide about it"* → the private repo that owns that infrastructure. This repository has to stay
useful to somebody who has never seen it.

## 7. How a change gets in

In this order — the order is the point:

1. **A test that fails first.** The generator's arithmetic and the front end's decisions go in
   `k6/lib/` and `gui/ui/src/lib/` with tests in `tests/`, not inside `live-event.js` or a component.
2. **Does it weaken a gate?** Then the answer is no. Not a default, not a config key, not a prompt.
3. **Does it add a second implementation of something?** Then it needs to replace the first one.
4. **`make lint` and `make test`** (no traffic), then `--dry-run` and `doctor` to see the composed
   arguments, then a **local** target — `make test-e2e` or `cache-ab/` — never production to try out code.
5. **Propagate the fact everywhere it is stated**: the `bin/crowdsim` header (which *is* `--help`),
   README, `docs/`, `profiles/example.json`, the image, the job specs, the GUI form.
6. **Document it as part of shipping it**, with copy-pasteable commands that were actually run. If the
   documentation is missing, the feature is not finished.
7. **One release per change**, prepared by the script, with a CHANGELOG section somebody can read.

## 8. How we can tell it is working

- **A run either produces a defensible number or explains why it cannot.** Every refusal in the tool —
  an invalid run, an unreachable target, a knee it will not claim, two runs it will not compare — is a
  place where the previous answer would have been a guess with a decimal point.
- **The caveats survive the hand-off.** What ends up in a ticket or a page carries the conditions the
  number was produced under, because the caveats are the first thing lost in retyping.
- **Somebody else can install it and run it from the documentation alone**, including from the container,
  without reading the source and without asking.
- **The gates have never needed an exception.** No default allowlist has ever been added "for
  convenience", and the safe-peak override has never moved off the command line.
- **`make test` still generates no traffic**, so it stays runnable on every push, by anybody, anywhere.
- **The knee moves for reasons you can name**: `out/history.tsv` and `compare` show the delta across runs
  at an identical pool, before and after a change.

## 9. Who this is for

Whoever owns a server-rendered frontend that has to survive a live event: platform, SRE and DevOps
engineers who need a number before the event and evidence after it, and the developers who will be asked
whether caching would have helped.

Also the **AI agents** working in this repository, for which a written intent is the only way to tell
"missing" apart from "deliberately absent" — see [`AGENTS.md`](AGENTS.md).

## 10. Maintaining this file

`INTENT.md` changes rarely: it is updated when the **purpose** changes, not when the facts do. Update it
when a goal is added or dropped, when a non-goal stops being one (a scheduler in the GUI, say, or reading
an access log over the network), when a boundary between repositories moves, or when a principle is
genuinely revised. Everything factual — flags, fields, numbers — lives in [`README.md`](README.md),
[`docs/`](docs/index.md) and [`CHANGELOG.md`](CHANGELOG.md), which are the living sources.

Last reviewed: 2026-09-02.
