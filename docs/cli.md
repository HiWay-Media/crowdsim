# CLI reference

`crowdsim <subcommand> [flags]`. Everything the tool does is a subcommand of one bash script,
`bin/crowdsim`, whose comment header is also its `--help`.

```bash
crowdsim doctor                                          # what is missing on this machine
crowdsim discover --profile p.json --limit 400            # build a URL pool from the sitemap
crowdsim probe    --profile p.json --target edge          # reachability + cache headers hop by hop
crowdsim load     --profile p.json --target edge --peak 60
crowdsim cache-ab --profile p.json --ttl 10               # two proxy legs, one origin
crowdsim history                                          # one line per run: does the knee move?
crowdsim serve                                            # the GUI, on loopback
```

## Subcommands

### `doctor`

Checks prerequisites and prints what is missing. With `--profile`, also resolves the profile — pools
inlined, referenced files checked — which is the cheapest way to find out a profile is broken. Exits 0
even when things are missing: it is a report, not a gate.

### `discover`

Fetches `discover.sitemap` from the profile, extracts `<loc>` entries, strips
`discover.strip_prefix_regex` (locale prefixes the site would redirect), de-duplicates, truncates to
`--limit`, and writes `out/pool-<run>.json`. Point a pool at it with `"pages": "@pool-<run>.json"`.

Two traps it handles, and one it does not:

- a 404 is cheap for the app tier, or is itself rendered → it measures the wrong thing;
- sitemaps advertise locale-prefixed paths that 307 → you would measure redirects, not renders;
- **it does not verify that the URLs render.** Do that before using the pool. Regenerate after every
  deploy: static-asset pools contain build hashes.

### `probe`

Preflight against one target: status, TTFB, page size, and every cache-relevant response header, saved to
`out/probe-<run>.log`. Run it before every load test. Exits 4 if the target answers ≥400 — a load test
against something that does not serve is not a capacity measurement.

### `load`

The load test. Resolves the profile and the target, passes both gates, then runs k6 with one scenario per
class. Exits 0 whenever it executed — **including when the brake tripped**, because finding the knee is
the intended outcome. Writes `out/summary-<run>.json`, `out/load-<run>.log`, and appends to
`out/history.tsv`.

### `cache-ab`

Brings up two nginx legs against the same origin, one as-is and one with your candidate config, so you can
load both with the same pool in the same window and get a hit ratio and offload factor you can defend.
Needs docker (exit 5 without it), so it does not work from inside the container image. See
[`cache-ab/README.md`](../cache-ab/README.md).

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

## Exit codes

They are an API: the Nomad job, CI and the GUI all branch on them.

| Code | Meaning | Typical cause |
|---|---|---|
| `0` | Executed | Also when the brake tripped — that is an outcome, not an error |
| `2` | Usage | Unknown flag or subcommand, missing/unparseable profile, unknown target, `--shape journey` without `journey.file` |
| `3` | A safety gate refused it | No allowlist, host not allowlisted, peak above the ceiling without the override, GUI asked to bind off-loopback without a token |
| `4` | Target unreachable | `probe` got ≥400 or no answer |
| `5` | Missing prerequisite | k6 absent, docker absent for `cache-ab`, node absent for `serve` |

## Output files

```
out/
  summary-<run_id>.json    the result — see Reading results
  load-<run_id>.log        the full run log
  probe-<run_id>.log       the preflight
  pool-<run_id>.json       what discover found
  profile-<run_id>.json    the profile as resolved for that run (pools inlined)
  history.tsv              one appended line per run
```

`<run_id>` is a UTC timestamp, `20260805T093710Z`. `out/` is gitignored: it names your hosts.

## See also

- [Running a test](running-a-test.md) — how these commands fit together
- [Profile reference](profile.md) — what `--target`, the classes and the SLO come from
- [Reading results](reading-results.md) — the summary, field by field
