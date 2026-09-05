# crowdsim in Docker

Everything needed to install and use crowdsim from the container image: the GUI, single runs, what to
mount, what to set, what it refuses to do, and how to tell a real result from an invalid one.

If you only want the fastest path, it is three commands:

```bash
cp .env.example .env                      # put a token in it: openssl rand -hex 16
docker compose up                         # starts the GUI
open http://127.0.0.1:8787                # paste the token
```

Everything after this point is the explanation of what those three commands did, and how to do the rest.

---

## 1. What is in the image

One image, `ghcr.io/hiway-media/crowdsim`, ~189 MB, `linux/amd64` and `linux/arm64`:

| Component | What it is | Needs |
|---|---|---|
| `crowdsim` | the driver: safety gates, profile resolution, reporting | bash, curl, python3 |
| `k6/live-event.js` + `k6/lib/` | the load generator | k6 (pinned, `grafana/k6:0.52.0`) |
| `gui/server` + built `gui/ui` | the GUI: `crowdsim serve` | node 18 |
| `profiles/example.json` | the documented example profile | — |
| `cache-ab/` | the A/B templates (see §8 — the harness itself runs on the host) |  docker |

One image and not two, even though a generator needs none of the GUI: two tags to keep straight is one
drift away from a run whose driver does not match the page that launched it.

**What is not in the image:** your profiles. A profile holds hostnames, URL pools, build hashes and a map
of how your site is built. It is mounted, never baked in.

---

## 2. Before anything: the two gates

crowdsim generates real traffic. Pointed at production it serves real errors to real users, and to every
co-tenant on the same infrastructure. Two gates stand in the way, and neither can be satisfied by
accident. In Docker they behave exactly as they do on a command line:

| Gate | In Docker |
|---|---|
| **Target allowlist** | The target's host must match `CROWDSIM_ALLOW_TARGETS` or the profile's `safety.allow_hosts`. **The image ships no default** — CI asserts that on every build. Without one, every run exits 3. |
| **Safe peak** | Above the profile's `safety.safe_peak_rps`, a run needs `--i-know-this-breaks-production` on the command line. Never put it in a compose file, a `.env`, or a job spec. |

There is no interactive "are you sure?", on purpose: this runs unattended on schedulers, where a prompt
either hangs or gets auto-answered.

Before a run meant to reach the knee: agree a window, tell whoever watches the uptime alerts, and be
ready to stop. Expect 20–40 seconds of errors even with `--touch-and-go` — a 504 needs a *queue*, and a
queue needs time to build.

---

## 3. Install

### Pull a released tag

```bash
docker pull ghcr.io/hiway-media/crowdsim:1.26.0     # exact version — use this
docker pull ghcr.io/hiway-media/crowdsim:1.26       # latest patch of 1.2
docker pull ghcr.io/hiway-media/crowdsim:latest    # last release
```

Pin an exact version anywhere a result matters. A load test you cannot reproduce is an anecdote, and
`latest` moves under you.

> The GitHub Packages entry may be private. If `docker pull` returns
> `denied`/`unauthorized`, either the package has not been made public yet, or you need to log in:
> `echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-user> --password-stdin` with a token carrying
> `read:packages`.

### Or build it yourself

```bash
git clone https://github.com/hiway-media/crowdsim && cd crowdsim
make image                    # builds crowdsim:dev
```

`make image` is `docker build -t crowdsim:dev .`; nothing else is needed on the host — the UI is compiled
inside the build, so no local node or npm is involved.

### Verify what you got

```bash
make image-smoke                                        # 16 assertions, generates no load
docker run --rm crowdsim:dev crowdsim doctor            # what the image can see
docker run --rm crowdsim:dev crowdsim --help
```

`make image-smoke` is the same script CI runs before publishing anything. It checks that the driver finds
the generator, that the GUI starts, that an unlisted host and an over-ceiling peak are both refused, and —
the one that matters most — that no allowlist default was baked into the image. A published image with a
`CROWDSIM_ALLOW_TARGETS` default would be a load generator that agrees to hit anything, and whoever
pulled the tag would have no way to see it.

`crowdsim doctor` inside the image should report k6, curl, python3, node and `GUI built`. It will report
docker as missing: that is correct and only affects `cache-ab` (§8).

---

## 4. Using the GUI

### With compose (the intended way)

```bash
cp .env.example .env
openssl rand -hex 16                  # put the output in CROWDSIM_GUI_TOKEN
docker compose up                     # add -d to detach
```

Open <http://127.0.0.1:8787> and paste the token. `docker-compose.yml` mounts `./profiles` and `./out`
from the checkout, so profiles you edit in the page are real files on your disk and runs land in `./out`
next to the ones the CLI writes.

If `CROWDSIM_GUI_TOKEN` is empty, compose refuses to start and says so. That is not a bug to work around:

```
required variable CROWDSIM_GUI_TOKEN is missing a value:
set CROWDSIM_GUI_TOKEN (e.g. openssl rand -hex 16) — see .env.example
```

To use a locally built image instead of the published one, set `CROWDSIM_IMAGE=crowdsim:dev` in `.env`.

### With plain docker run

```bash
docker run --rm -p 127.0.0.1:8787:8787 \
  -e CROWDSIM_GUI_BIND=0.0.0.0 \
  -e CROWDSIM_GUI_TOKEN="$(openssl rand -hex 16)" \
  -e CROWDSIM_ALLOW_TARGETS='www.example.test' \
  -v "$PWD/profiles:/profiles" \
  -v "$PWD/out:/out" \
  ghcr.io/hiway-media/crowdsim:1.26.0 crowdsim serve
```

Or `make image-run`, which does exactly this against `crowdsim:dev` and prints a freshly generated token.

### Why `0.0.0.0` plus `-p 127.0.0.1:`

Outside a container the GUI binds loopback and needs no token. Inside one, "bind loopback" means
"reachable by nobody" — the loopback in question is the container's own. So the bind address becomes
`0.0.0.0` and **the reachability decision moves to the port publication**:

```
-p 127.0.0.1:8787:8787     only your machine can reach the page          ← do this
-p 8787:8787               every interface, i.e. your whole network       ← don't
```

The token stays mandatory either way, because the server cannot tell how narrowly you published the port.
It refuses to start on a non-loopback bind without one:

```bash
$ docker run --rm -e CROWDSIM_GUI_BIND=0.0.0.0 crowdsim:dev crowdsim serve
refusing to bind 0.0.0.0 without CROWDSIM_GUI_TOKEN.
exit status 3
```

### Editing profiles, and read-only mounts

Mount `./profiles` read-write and the page's editor saves to it. Mount it `:ro` — a reasonable thing to
do with a map of your infrastructure — and the page still lists, validates and runs profiles; only saving
is refused, with an explanation rather than an error:

```
409  the profile directory is not writable (EROFS): the GUI can read and run
     profiles but not save them. Mount it read-write, or edit the file outside the GUI.
```

`example.json` is read-only regardless: it is the shipped documentation. Use *Save as…* for your own.

---

## 5. Running a load test from the container

```bash
docker run --rm --network host \
  -e CROWDSIM_ALLOW_TARGETS='www.example.test' \
  -v "$PWD/my-profile.json:/profile.json:ro" \
  -v "$PWD/out:/out" \
  ghcr.io/hiway-media/crowdsim:1.26.0 \
  crowdsim load --profile /profile.json --target edge --peak 60
```

`--network host` matters: NAT adds a hop that becomes the bottleneck before the target does. On a Linux
host, use it.

### ⚠️ Not from a laptop against a remote target

On macOS and Windows the Docker network layer saturates before the target does. This is measured, not
theorised: the iterations get dropped, and the run is invalid. crowdsim will tell you —

```
generator     ⛔ DID NOT hold: 4213 iterations dropped → RESULT INVALID
```

— but you will have burned the window. For local runs, install k6 natively (`brew install k6`) and use
the CLI directly. For a remote target, run the container on a Linux host near it, or dispatch the Nomad
job (§9).

The **GUI** in a container is fine anywhere: it is a page. Just remember that a run it starts is generated
by that same container, so the same caveat applies to the runs, not to the page.

### The other subcommands

```bash
docker run --rm --network host -e CROWDSIM_ALLOW_TARGETS='www.example.test' \
  -v "$PWD/my-profile.json:/profile.json:ro" -v "$PWD/out:/out" \
  ghcr.io/hiway-media/crowdsim:1.26.0 crowdsim probe --profile /profile.json

# same shape for: discover --limit 400 · load --dry-run · history · report <run-id> [--html] · init
```

Always start with `probe`: it tells you what answered, what each layer said about caching, and how heavy
one page is. Then `discover` if you need a URL pool. Then `load --dry-run` to see the exact k6 invocation
without sending anything.

**`weights`, on a log the container cannot reach by itself.** The class mix is counted from an access log you
hand over — the tool never fetches one — so inside a container the log arrives as a read-only mount or on
stdin. `-i` is what makes the pipe work; without it docker gives the container a closed stdin and the
command reads nothing — `❌ the log is empty: no lines to classify.`, exit 2 — no matter what you piped:

```bash
# a log on this host
docker run --rm -v "$PWD/my-profile.json:/profile.json:ro" -v /var/log/nginx:/logs:ro \
  ghcr.io/hiway-media/crowdsim:1.26.0 crowdsim weights /logs/access.log --profile /profile.json

# a log that never lands on disk here
ssh edge 'zcat /var/log/nginx/access.log.*.gz' \
  | docker run --rm -i -v "$PWD/my-profile.json:/profile.json:ro" \
      ghcr.io/hiway-media/crowdsim:1.26.0 crowdsim weights - --profile /profile.json
```

No `/out` mount is needed and none is used: this subcommand writes nothing, which is deliberate — an access
log holds URLs, addresses and user agents, and `out/` is a directory people copy from. It needs no allowlist
either, because it generates no traffic.

---

## 6. Reading the results

Everything lands in the directory mounted at `/out` — including, after a run with a `signup` class,
`signups-<run-id>.json`, which names the accounts that run created on your target. It holds no password
and crowdsim will not delete them, but it is not a file to leave in a shared volume or commit anywhere:

```
out/
  summary-20260805T093710Z.json    the machine-readable result — read this
  load-20260805T093710Z.log        the full run log
  profile-20260805T093710Z.json    the profile as resolved for that run (pools inlined)
  history.tsv                      one line per run, appended
```

Read the summary in this order, because the order is what keeps you honest:

1. **`generator_ok: false` → discard the run.** Nothing else in the file means anything. A
   generator-bound run looks exactly like a healthy system absorbing the load.
2. **`target_unreachable: true` → connectivity, not capacity.** Near-total failure at near-zero latency
   means the connections were refused or never routed. A saturated system is slow *before* it errors.
3. **`aborted: true` → you found the knee.** That is the intended outcome, and the exit code stays 0.
4. Only then the numbers — and per class, the interesting column is the share past `guillotine_ms`, not
   the average latency. Averages hide the queue, and the queue is what produces the errors.

Compare runs only against each other at an identical URL pool. Absolute numbers from a synthetic pool of
cold URLs are harsher than real traffic concentrated on a few hot keys: the tool measures deltas honestly
and absolutes optimistically.

---

## 7. Reference

### Environment variables

| Variable | Default in the image | What it does |
|---|---|---|
| `CROWDSIM_ALLOW_TARGETS` | **none, deliberately** | Comma-separated host globs the tool may generate load against. Without it (and without `safety.allow_hosts` in the profile) every run exits 3. |
| `CROWDSIM_OUT` | `/out` | Where summaries, logs and `history.tsv` go. |
| `CROWDSIM_PROFILES` | `/profiles` | The directory the GUI reads and writes. |
| `CROWDSIM_GUI_PORT` | `8787` | GUI port inside the container. |
| `CROWDSIM_GUI_BIND` | unset → loopback | Bind address. Anything but loopback requires a token. |
| `CROWDSIM_GUI_TOKEN` | unset | Bearer token for `/api`. Mandatory for a non-loopback bind. |
| `CROWDSIM_SLACK_WEBHOOK` | unset | If set, `--slack` posts a run recap. A secret: keep it in `.env` or a secret store. |
| `CROWDSIM_ROOT` | `/crowdsim` | Where `k6/`, `gui/` and `cache-ab/` live. Set because the driver is in `/usr/local/bin`; leave it alone. |
| `CROWDSIM_BIN` | `/usr/local/bin/crowdsim` | The driver the GUI spawns for every run. Set for the same reason as `CROWDSIM_ROOT` — and missing from 1.2.0 to 1.19.1, which is why the GUI in the image could not launch anything. Leave it alone. |
| `CROWDSIM_K6_SCRIPT` | `/crowdsim/k6/live-event.js` | Overrides the generator script. |

### Mounts and ports

| Path | Mode | Notes |
|---|---|---|
| `/out` | read-write | The run archive. Also a declared `VOLUME`. |
| `/profiles` | read-write, or `:ro` | Read-write only if you want the GUI's editor to save. |
| a single profile | `:ro` is fine | e.g. `-v "$PWD/p.json:/profile.json:ro"` for one run. |
| `8787/tcp` | — | The GUI. Publish it to `127.0.0.1` only. |

### The user inside the container

The image runs as uid `12345` (inherited from the k6 image), not root. On Linux a bind-mounted `./out`
owned by your user will not be writable by it. Two fixes, either is fine:

```bash
mkdir -p out && sudo chown 12345 out            # give the container's user the directory
docker run --user "$(id -u):$(id -g)" ...       # or run as yourself (verified to work)
```

On macOS and Windows, Docker Desktop maps ownership for you and neither is needed.

### Exit codes

They are an API — the Nomad job, CI and the GUI all branch on them:

| Code | Meaning |
|---|---|
| 0 | Executed. **Including a run stopped by the brake**: finding the knee is an outcome, not an error. |
| 2 | Usage: bad flag, missing or malformed profile, unknown target. |
| 3 | A safety gate refused it: host not allowlisted, or peak above the ceiling without the override. Also the GUI refusing a non-loopback bind without a token. |
| 4 | The target did not answer during `probe`. |
| 5 | A prerequisite is missing (k6, docker for `cache-ab`, node for `serve`). |

---

## 8. What the container deliberately cannot do

- **`crowdsim cache-ab`** brings up two nginx containers, so it needs a docker socket. From inside the
  image it stops with `cache-ab needs docker` (exit 5). Run it on the host, from a checkout:
  `crowdsim cache-ab --profile p.json --ttl 10`. Handing a container the host's docker socket to make
  this work is a much bigger decision than an A/B cache test warrants.
- **The test suites** (`make test`, `make test-e2e`) are not in the image — `tests/` is excluded from the
  build context. They belong to a checkout, not to a published artefact. The exception is
  `tests/image/smoke.sh`, which runs *against* the image from outside.
- **No scheduler, no accounts.** Recurring load against production belongs in something auditable, where
  the target, the rate and the override are recorded against whoever asked for them. That is what the
  Nomad dispatch is for; a cron button on a page is not.

---

## 9. On a Linux host near the target, and Nomad

`ci/nomad/crowdsim.nomad.hcl` is a parameterized **batch** job on this same image — batch and not service,
because a load test is a bounded run with an outcome. A service job that restarts on exit would re-fire
load at your production every time the brake trips.

```bash
nomad job run ci/nomad/crowdsim.nomad.hcl
nomad job dispatch \
  -meta target=edge -meta peak=120 -meta hold=120s \
  -meta allow_targets='www.example.test' \
  -meta profile_url='https://<your-private-repo>/profile.json' \
  crowdsim
```

The target, the rate and the override live in the dispatch call — which is logged and attributable —
rather than in a committed file. The profile is fetched at dispatch time from your own private repo.

Placement matters more than it looks: put the generator *near* the target but not *on* it. Co-locating
means measuring the two competing for the same CPU. Bandwidth is the other constraint: ~45 KB per page at
380 req/s is ~17 MB/s sustained, and a generator behind a slow link will fail to deliver the rate — which
crowdsim will report as `generator_ok: false`.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| exit 3, `no target allowlist` | No `CROWDSIM_ALLOW_TARGETS` and no `safety.allow_hosts` | Set the env var on the container, or the key in the profile. There is no default, by design. |
| exit 3, `host 'x' is not in the allowlist` | The target's host does not match any pattern | Fix the pattern or the target. Check the *host*, not the URL: no scheme, no port. |
| exit 3, `above the safe ceiling` | `--peak` exceeds the profile's `safe_peak_rps` | Lower the peak, or add `--i-know-this-breaks-production` on the command line — deliberately, having warned people. |
| exit 3, `refusing to bind 0.0.0.0 without CROWDSIM_GUI_TOKEN` | GUI off loopback, no token | Set `CROWDSIM_GUI_TOKEN`. Publish the port to `127.0.0.1` too. |
| exit 5, `k6 not found` | Not the shipped image, or an overridden entrypoint | Use the image as published; its `ENTRYPOINT` is reset so `crowdsim` drives k6. |
| exit 5, `cache-ab needs docker` | `cache-ab` from inside the container | Run it on the host (§8). |
| exit 2, `profile not found` | The mount path and the `--profile` path disagree | The path is the one *inside* the container: `-v "$PWD/p.json:/profile.json:ro"` → `--profile /profile.json`. |
| every GUI run fails instantly with `crowdsim could not be started: spawn /crowdsim/bin/crowdsim ENOENT` | An image older than 1.19.2: it did not set `CROWDSIM_BIN`, and the GUI looked for the driver next to itself instead of in `/usr/local/bin` | Upgrade the image, or pass `-e CROWDSIM_BIN=/usr/local/bin/crowdsim`. From 1.19.2 the server refuses to start at all when it cannot find the driver, rather than failing at the click. |
| `SyntaxError: Named export … not found … is a CommonJS module`, then gates returning exit 2 and no GUI | Image 1.20.0 or 1.20.1: `/crowdsim/package.json` was not shipped, so every `.js` under `k6/` and `lib/` was read as CommonJS while the same files are ES modules in a checkout | Upgrade to 1.20.2 or later. There is no workaround worth carrying: the profile validator cannot run, so `load` and `doctor` refuse before reaching the safety gates. |
| `generator_ok: false` | The generator could not hold the rate | Not a tunable. Move the generator near the target, onto a bigger host, and off Docker Desktop. |
| `TARGET NEVER ANSWERED` | Wrong address/port, TLS, or the container's network namespace cannot reach the target | `crowdsim probe` first; on Linux add `--network host`. |
| `Permission denied` writing `/out` | Host directory not writable by uid 12345 | `sudo chown 12345 out`, or `--user "$(id -u):$(id -g)"`. |
| GUI answers 401 everywhere | Token missing or wrong | Paste the token in the page; for `curl`, `-H "Authorization: Bearer <token>"`. |
| GUI page is 503, "UI not built" | A build without the UI stage | Rebuild with `make image`; the published image always has it (`/api/env` reports `"ui": true`). |
| Saving a profile returns 409 | `/profiles` mounted read-only | Mount it read-write, or edit the file on the host. |
| `docker pull` denied | The package is private | Make it public, or `docker login ghcr.io` with a `read:packages` token. |
| Second Run gives 409 | A run is already in flight | Stop it from the page. One generator at a time, on purpose. |

---

## 11. Building and publishing

```bash
make image                    # build crowdsim:dev
make image-smoke              # assert it is still the tool, and the gates survived
make image-run                # start the GUI from it with a generated token
```

`.github/workflows/image.yml` does the same in CI and then publishes:

```
build for the runner's arch → load → smoke test → (only if it passed)
   → build linux/amd64 + linux/arm64 → push to ghcr.io
```

Nothing reaches the registry before the smoke test passes, and tags are published **only** from an
annotated `v*` tag or an explicit workflow dispatch. A push to `main` builds and tests and publishes
nothing: `latest` means the last release, not the last commit somebody landed.

Published tags: `{version}`, `{major}.{minor}`, and `latest` (version tags only).

---

## See also

- [Documentation index](index.md) — every page
- [Install](install.md) — the native and Nomad paths
- [Running a test](running-a-test.md) — the sequence from `probe` to a defensible number
- [Reading results](reading-results.md) — the summary, field by field
- [GUI](gui.md) · [CLI reference](cli.md) · [Profile reference](profile.md) · [Architecture](architecture.md)
- [`cache-ab/README.md`](../cache-ab/README.md) — measuring what a cache change actually buys
