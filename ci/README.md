# ci/

Things that run crowdsim somewhere other than a workstation. Not part of a run, and not needed to use the
tool — none of it ends up in the container image.

| Path | What |
|---|---|
| [`nomad/crowdsim.nomad.hcl`](nomad/crowdsim.nomad.hcl) | Parameterized **batch** job for dispatching a run on a Nomad client near the target. |
| [`kubernetes/`](kubernetes/README.md) | A **Job** for one run and a **Deployment + Service** for the GUI, plus a kustomization. |

Both schedulers get the same treatment, because the same things go wrong on both: a run that gets retried is
a second outage, a control surface with a public address is an invitation, and a generator co-located with
its target measures the two fighting over a CPU. `make test-k8s` asserts those properties on the manifests;
the Nomad job carries them in `restart`/`reschedule` stanzas.

The GitHub Actions workflows are not here: they have to live in `.github/workflows/`, which GitHub owns.
They are `ci.yml` (lint, the suites that generate no load, the manifests here, the doc links), `e2e.yml`
(the real k6 run, against containers on the runner's own loopback), `image.yml` (build → smoke test →
publish to GHCR on a version tag) and `release.yml` (GitHub Release from the CHANGELOG section), with
`roadmap-sync.yml` replaying `.github/roadmap.json`. See [docs/development.md](../docs/development.md#releasing).

## Why the Nomad job is batch and not service

A load test is a bounded run with an outcome. A `service` job that restarts on exit would re-fire load at
your production every time the brake trips — the exact opposite of what the brake is for. The job also sets
`restart { attempts = 0 }` and `reschedule { attempts = 0 }`: a load test does not get retried, because a
second uncontrolled run is a second outage.

The target, the rate and any safe-peak override live in the **dispatch call**, which is logged and
attributable to whoever made it, rather than in a committed file. The profile is fetched at dispatch time
from your own private repo — a profile is a map of your infrastructure and does not belong in this one.

```bash
nomad job run ci/nomad/crowdsim.nomad.hcl
nomad job dispatch \
  -meta target=edge -meta peak=120 -meta hold=120s \
  -meta allow_targets='www.example.test' \
  -meta profile_url='https://<your-private-repo>/profile.json' \
  crowdsim
```

Placement matters more than it looks: put the generator **near** the target but not **on** it. Co-located,
you measure the two competing for the same CPU. Watch bandwidth too — ~45 KB per page at 380 req/s is
~17 MB/s sustained, and a generator behind a slow link fails to deliver the rate, which crowdsim reports as
`generator_ok: false`.

Full context in [docs/install.md](../docs/install.md#nomad) and [docs/docker.md](../docs/docker.md).
