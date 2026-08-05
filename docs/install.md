# Install

Three ways in, for three different jobs.

| Path | Right for | Wrong for |
|---|---|---|
| **Docker** | seeing it work, the GUI anywhere, the generator on a Linux host near the target | generating load from a macOS/Windows laptop against a remote target |
| **Native** | running the generator from your own machine, development | nothing — this is the reference installation |
| **Nomad** | recurring or remote runs, attributable to whoever dispatched them | a first look |
| **Kubernetes** | a run as a Job, or the GUI in a cluster you already operate | a first look |

## Docker (nothing to install)

```bash
git clone https://github.com/hiway-media/crowdsim && cd crowdsim
cp .env.example .env                 # put a token in it: openssl rand -hex 16
docker compose up                    # the GUI on http://127.0.0.1:8787
```

The full guide — mounts, environment, permissions, troubleshooting — is [Docker](docker.md). The image is
`ghcr.io/hiway-media/crowdsim`, ~189 MB, `linux/amd64` and `linux/arm64`, and contains the driver, the
generator and the GUI.

> ⚠️ Do not generate load *through* Docker from a macOS or Windows laptop against a remote target: the
> Docker network layer saturates before the target does, the iterations get dropped and the run is
> invalid. crowdsim will tell you (`generator_ok: false`), but the window is gone. The GUI in a container
> is fine anywhere — it is a page, not a generator.

## Native

```bash
brew install k6                      # macOS — Linux: https://grafana.com/docs/k6/latest/set-up/install-k6/
git clone https://github.com/hiway-media/crowdsim && cd crowdsim
./bin/crowdsim doctor
```

`doctor` prints what is present and what is missing:

```
▶ crowdsim prerequisites
  ✅ k6 k6 v0.52.0 (…)
  ✅ curl
  ✅ python3
  ✅ docker (needed only for cache-ab)
  ✅ node v18.20.1 (needed only for the GUI)
  ⚠️  GUI not built (npm install && npm run gui:build)
  ⚠️  CROWDSIM_ALLOW_TARGETS unset (the profile must declare safety.allow_hosts)
  ✅ output directory: /path/to/out
```

Requirements, and nothing else:

| Tool | Needed for | Notes |
|---|---|---|
| `k6` | the generator | **Do not substitute it.** A generator that cannot sustain the rate produces a run that looks like a healthy system under load. |
| `curl` | `probe`, `discover` | |
| `python3` | profile resolution, summaries, history | No `jq`: python3 is on every host that runs a scheduler agent, and jq often is not. |
| `docker` | `cache-ab` only | Two nginx legs against one origin. |
| `node` 18+ | the GUI only | The CLI never needs it. |

Put `bin/crowdsim` on your `PATH` if you like — it resolves its own root, so a symlink into `~/.local/bin`
works. In an unusual layout, set `CROWDSIM_ROOT` to the directory holding `k6/`, `gui/` and `cache-ab/`.

### Optional: the GUI and the test suite

```bash
npm install            # bats, express, vite, react
npm run gui:build      # compiles gui/ui into gui/ui/dist
crowdsim serve         # http://127.0.0.1:8787
make test              # 32 unit + 50 GUI + 68 CLI, generating no load whatsoever
```

`npm install` is not needed to run a load test. It buys exactly two things: `crowdsim serve` and `make
test`.

## Nomad

`ci/nomad/crowdsim.nomad.hcl` is a parameterized **batch** job on the published image:

```bash
nomad job run ci/nomad/crowdsim.nomad.hcl
nomad job dispatch \
  -meta target=edge -meta peak=120 -meta hold=120s \
  -meta allow_targets='www.example.test' \
  -meta profile_url='https://<your-private-repo>/profile.json' \
  crowdsim
```

Batch and not service on purpose: a load test is a bounded run with an outcome. A service job that
restarts on exit would re-fire load at your production every time the brake trips — the opposite of what
the brake is for. The target, the rate and any override live in the dispatch call, which is logged and
attributable; the profile is fetched at dispatch time from your own private repo.

Place the generator **near** the target but not **on** it: co-located, you measure the two competing for
the same CPU. Watch bandwidth too — ~45 KB per page at 380 req/s is ~17 MB/s sustained.

## Kubernetes

```bash
kubectl create configmap crowdsim-profile --from-file=profile.json=./my-site.json
kubectl create -f ci/kubernetes/load-job.yaml        # one run
kubectl logs -f job/<name>

kubectl create secret generic crowdsim-gui --from-literal=token="$(openssl rand -hex 16)"
kubectl apply -k ci/kubernetes                       # the GUI
kubectl port-forward svc/crowdsim-gui 8787:8787
```

A **Job** for a run and a **Deployment** for the GUI, on the published image. Five values in there are safety
properties rather than preferences — never retried, a cluster-enforced deadline, exactly one GUI replica
(the one-run-at-a-time rule lives in the server's memory), `ClusterIP` only, and no `CronJob`. All five are
asserted by `make test-k8s`, and all five are explained in
[`ci/kubernetes/README.md`](../ci/kubernetes/README.md).

## Your first profile

The tool knows nothing about any site until you give it a profile. Start from the shipped example, which
documents every field inline:

```bash
cp profiles/example.json ~/my-profiles/my-site.json     # then edit it
crowdsim doctor --profile ~/my-profiles/my-site.json    # does it parse, do the pools resolve
```

Keep your profiles in **your own private repo**: a profile holds hostnames, internal addresses, real
routes and build hashes. `.gitignore` here refuses everything but the example, on purpose. The
[profile reference](profile.md) explains every key and what it costs to get wrong.

## Next

- [Running a test](running-a-test.md) — the sequence from `probe` to a defensible number
- [Docker](docker.md) — the container in detail
- [GUI](gui.md) — the browser interface
