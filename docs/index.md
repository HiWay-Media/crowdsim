# crowdsim documentation

crowdsim replays a **live-event traffic mix** against a web frontend, finds the knee, and measures what
caching would actually buy you — instead of estimating it from logs after the outage.

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
       └──────────────────────────────────────────────────────────┘
                        │
                 ┌──────▼───────┐
                 │ summary.json │  per class: p50/p95/p99, % past the proxy
                 │ + history.tsv│  read timeout, failed rate, cache hit ratio
                 └──────────────┘
```

## Start here

**On a machine that already has crowdsim: `crowdsim next`.** It says what has been measured, which
profiles are still drafts, and the single command to run next — generating nothing and changing nothing.

| If you want to… | Read |
|---|---|
| find out where you are, mid-setup | [`next`](cli.md#next) |
| see it working in three commands | [Install](install.md) → Docker |
| understand what it does that `hey`/`vegeta`/`wrk` do not | [Architecture](architecture.md) |
| know why it exists, and what it refuses to do | [`INTENT.md`](../INTENT.md) |
| run it from a container | [Docker](docker.md) |
| write a profile for your own site | [Profile reference](profile.md) |
| load-test **sign-in**, not just anonymous browsing | [`auth` — signing in](profile.md#auth--signing-in) |
| measure the class mix from your own access log | [`weights`](cli.md#weights) |
| plan and execute a real test | [Running a test](running-a-test.md) |
| know whether a result means anything | [Reading results](reading-results.md) |
| hand a run to somebody else, drawn | [`report --html`](cli.md#--html-the-same-run-drawn) |
| use the browser interface | [GUI](gui.md) |
| look up a flag or an exit code | [CLI reference](cli.md) |
| change the code, or cut a release | [Development](development.md) |
| see what changed between releases | [Changelog](../CHANGELOG.md) |
| dispatch runs on Nomad | [`ci/README.md`](../ci/README.md) |
| run it on Kubernetes | [`ci/kubernetes/README.md`](../ci/kubernetes/README.md) |

## The three things worth knowing before you start

**1. `--peak` is total user requests per second, not page loads.** A profile declares request *classes*
with the weights you measured on your own edge log (`crowdsim weights <access.log>` counts them for you); each class gets `weight/total × peak`. On a
server-rendered frontend one document pulls N framework navigation requests plus M assets — all served by
the same process. Fire a flat URL list instead and you measure a load that does not exist, usually a
reassuring one.

**2. Two gates stand between you and an accident.** The target's host must be explicitly allowlisted, and
going past the profile's safe peak requires saying so on the command line, every time. Neither has a
default. See [Safety](running-a-test.md#safety-first-and-not-as-a-formality).

**3. A run can be invalid, and invalid does not look like invalid.** If the generator could not deliver
the requested rate, the summary says `generator_ok: false` and the numbers mean nothing — while looking
exactly like a healthy system absorbing the load. [Reading results](reading-results.md) is short and it is
the page that keeps you honest.

## Conventions in these docs

- Commands are copy-pasteable and were run before being written down.
- `www.example.test` and `203.0.113.10` stand in for your hostnames and addresses. Real ones belong in a
  profile, in your own private repo — never in this one.
- Exit codes are an API: `0` executed (including a run the brake stopped), `2` usage, `3` a safety gate
  refused it, `4` target unreachable, `5` a missing prerequisite.
