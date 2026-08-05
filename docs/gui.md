# The GUI

```bash
npm install && npm run gui:build      # once
crowdsim serve                        # http://127.0.0.1:8787

docker compose up                     # or from the container image: no node, no build
```

```
 ▮▮ crowdsim            k6 v0.52.0   allowlist www.example.test   output ./out
 ┌────────────┬──────────────────────────────────────────────────────────────────┐
 │ New run  ◀ │  TARGET                          RATE                            │
 │ Profiles   │  profile  my-site.json           peak  [ 60] req/s               │
 │ History    │  target   edge ▾                 steps [  4] × [60s]  hold [120s]│
 │            │  base url https://www.example…   shape mix ▾   rsc repeat ▾      │
 │ ● running  │  bypass   CDN skipped            ─────────────────────────────── │
 │            │  allowlist ✅ authorised          rsc_page ████████ 25.9 req/s    │
 │            │                                  html     ████     13.9 req/s    │
 │            │  [ Run ] [Dry run] [Probe]       static   ██        5.9 req/s    │
 └────────────┴──────────────────────────────────────────────────────────────────┘
   ramping 15 → 60 … p95 780 ms … 0 dropped
```

## What it is

A form over `bin/crowdsim`. Every run is a child process of the same CLI, with the same gates, writing the
same `out/` directory — so a run launched from a terminal and a run launched from the page are the same kind
of object and appear in the same history.

What it adds over the CLI: seeing what a peak *means* per class before you press the button, whether the
target is allowlisted before you press it, the log while it happens, and the archive with a knee plot.

What it is not: a second implementation of the safety rules, a scheduler, or a store of results.

## The three panels

### New run

- Pick a **profile** (only profiles that validate are offered) and a **target**. The panel shows the
  target's `base_url`, `Host` override, bypass, the classes it skips, and — computed from the allowlist —
  whether that host is authorised. An unlisted host is called out *before* the run, and refused by the CLI
  with exit 3 if you go ahead anyway.
- Set the **rate**: peak, start, steps, step duration, hold, shape, rsc mode, and SLO overrides. The mix
  bars underneath show what the peak means per class in req/s, drawn from the profile's weights — that is
  the number people get wrong when they reason about "60 req/s".
- **Buttons**: Run · Dry run (prints the command, sends nothing) · Probe · Discover URLs. Stop appears
  while a run is in flight.
- Above the safe peak, a red block appears. See [the override](#the-safe-peak-override) below.

### Profiles

A JSON editor with live validation, and a summary of what the profile means: the mix as shares, the
targets, the safe peak, the allowlist, the brake, the read timeout, the cache layers.

A raw editor on purpose: a profile is a small, heavily commented document that people diff in git, and a
generated form would strip the `_comment` keys that make it readable. What the GUI adds is telling you what
is wrong while you type — errors (would fail, or be meaningless) and warnings (would run, but not mean what
you think):

```
classes[3]            pool "static" is empty: this class will be dropped and the mix renormalised
slo.guillotine_ms     the read timeout is below the p95 SLO: the brake would abort only after real
                      users are already getting 504s
safety.allow_hosts    an allowlist of "*" is not an allowlist
```

`example.json` is read-only — it is the shipped documentation. Use *Save as…*. If `profiles/` is mounted
read-only, the page still lists, validates and runs profiles and explains that it cannot save them.

### History

`out/history.tsv` and the summaries, read from disk. Runs with `generator_ok: false` are struck through in
the table and drawn hollow in the knee plot (p95 against requested peak) rather than plotted next to valid
ones. Selecting a run shows the full result — the verdict banners first, then the per-class table — and a
comparison against previous runs at the **same profile, target and shape**, labelled so nobody quotes the
absolutes: *deltas are the honest part*.

## Safety

The gates live in the CLI and the GUI cannot weaken them. Concretely:

| Property | How |
|---|---|
| Gates not re-implemented | Every run is `bin/crowdsim` as a child process; refusals surface with the driver's own exit code (3 = a gate) |
| No argument smuggling | Only known flags with validated values are composed — numbers are integers in range, durations match `30s`/`2m`/`500ms`, shape and rsc mode are closed sets, a base URL must be http(s) without credentials, a target name must start alphanumeric. No shell, no passthrough. |
| One run at a time | A second Run is a `409` naming the run already in flight. Two generators against one target is twice the load nobody agreed to, and two invalid results. |
| Graceful stop | Stop sends SIGINT, so k6 winds down and still writes the summary. SIGKILL only after 10 s, and it says so. |
| Loopback by default | Any other bind address requires `CROWDSIM_GUI_TOKEN`; the server exits 3 without it. |
| No secret echo | `/api/env` reports *whether* a Slack webhook is configured, never its value. |

### The safe-peak override

Above the profile's `safe_peak_rps` the run panel turns into a block that states what will happen, and asks
for two deliberate acts **for that run**: the checkbox, and the profile's name typed by hand.

```
┌ DANGER ──────────────────────────────────────────────────────────────┐
│ 500 req/s is above this profile's safe ceiling of 150 req/s.         │
│ Past this point the run is expected to serve 5xx to real users of    │
│ www.example.test, and to degrade any co-tenant on the same nodes.    │
│ Agree a window, tell whoever watches the uptime alerts, and be ready │
│ to stop. Then type the profile name to confirm.                     │
│   ☐ I know this breaks production      Profile name [            ]  │
└──────────────────────────────────────────────────────────────────────┘
```

Nothing about it is remembered: the confirmation is not stored, not defaulted, and is stripped from the run
record. Without both, the API answers `400` naming the `confirm` field.

Why it exists at all, rather than being CLI-only: somebody who needs to reach the knee will do it either
way, and pushing them to hand-assemble a command line buys a copy-paste window — the wrong rate against the
wrong target — not consent. The friction stays where it is useful: an explicit act that names the thing
being risked.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `CROWDSIM_GUI_PORT` | `8787` | Or `crowdsim serve --port` |
| `CROWDSIM_GUI_BIND` | `127.0.0.1` | Or `--bind`. Off loopback requires a token. |
| `CROWDSIM_GUI_TOKEN` | unset | Bearer token on every `/api` route |
| `CROWDSIM_PROFILES` | `./profiles` | The directory the editor reads and writes |
| `CROWDSIM_OUT` | `./out` | Shared with the CLI — this is the point |
| `CROWDSIM_ALLOW_TARGETS` | unset | Inherited by every run it starts |
| `CROWDSIM_BIN` | `$CROWDSIM_ROOT/bin/crowdsim` | Which driver to spawn |

In a container the bind must be `0.0.0.0` (loopback there means "reachable by nobody") and the
reachability decision moves to the port publication: see [Docker §4](docker.md#4-using-the-gui).

## HTTP API

Same-origin, JSON. Useful if you want to drive it from something else — though for automation the CLI is
the better interface: it is the thing the API calls anyway.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/env` | k6 version, directories, allowlist, whether Slack is configured, valid shapes/modes |
| `GET` | `/api/profiles` | List, with validation state per profile |
| `GET` | `/api/profiles/:name` | Raw text, parsed object, validation |
| `PUT` | `/api/profiles/:name` | Save (`{raw, force}`); `422` with details if it has errors, `409` if the directory is read-only |
| `DELETE` | `/api/profiles/:name` | Delete (never `example.json`) |
| `POST` | `/api/validate` | Validate `{raw}` without touching disk |
| `POST` | `/api/runs` | Start `{kind: load\|probe\|discover, profile, …}`; `201` with the run record, `409` if one is in flight |
| `GET` | `/api/runs` | Every run this server started, newest first, plus the active one |
| `GET` | `/api/runs/:id` | One run, with its log and summary |
| `GET` | `/api/runs/:id/stream` | Server-sent events: `line`, then `end` |
| `POST` | `/api/runs/:id/stop` | Graceful stop |
| `GET` | `/api/history` | `out/history.tsv`, newest first |
| `GET` | `/api/history/:runId` | Summary, history row, comparable runs, run log |

Profile names are matched against a whitelist pattern **and** the resolved path is checked to still be
inside the profile directory — a profile path is user input, and a profile is a map of your infrastructure.

## Limits, on purpose

- **No scheduler.** Recurring load against production belongs somewhere auditable, where the target, the
  rate and the override are attributable to whoever asked. That is the Nomad dispatch; a cron button on a
  page is not.
- **No user accounts.** One token, or loopback. This is a console, not a portal.
- **No results of its own.** Everything shown comes from the driver's files. A second version of the truth
  is always the wrong one.
- **Runs live in the server's memory.** Restart it while a run is going and the page loses sight of it while
  k6 keeps going — [issue #23](https://github.com/HiWay-Media/crowdsim/issues/23).

## See also

- [Docker](docker.md) — running the GUI from the image
- [Reading results](reading-results.md) — what the result panels are showing you
- [Development](development.md) — the GUI's layout and its test suite
