# crowdsim on Kubernetes

Two manifests: a **Job** for one load run, and a **Deployment + Service** for the GUI. Both use the
published image, so the gates, the exit codes and the archive behave exactly as they do on a command line.

```bash
# once: your profile, and a token for the GUI
kubectl create configmap crowdsim-profile --from-file=profile.json=./my-site.json
kubectl create secret generic crowdsim-gui --from-literal=token="$(openssl rand -hex 16)"

# one run
kubectl create -f ci/kubernetes/load-job.yaml       # create, not apply — see "Why generateName" below
kubectl logs -f job/<name>

# the GUI
kubectl apply -k ci/kubernetes
kubectl port-forward svc/crowdsim-gui 8787:8787     # http://127.0.0.1:8787, paste the token
```

`tests/k8s/check.sh` (`make test-k8s`) renders these with `kubectl kustomize` — client-side, no cluster — and
asserts the properties below. They are not preferences, and each one is a single careless edit from being
lost.

---

## The five decisions that are not preferences

### 1. `backoffLimit: 0` and `restartPolicy: Never`

Kubernetes retries a failed Job by default. Here a "failure" can simply mean **the brake tripped on the way
to a real answer** — and a retry is a second uncontrolled run against a system you have just bent. A load
test is never retried; that is the same reason the Nomad job sets `attempts = 0`.

### 2. `activeDeadlineSeconds`

The cluster's own dead-man switch, for the case where a run hangs somewhere the emergency brake cannot see.
Size it to the ramp plus the hold plus a margin: the shipped Job is `4 × 60s + 120s = 360s`, with a deadline
of 600s. Long enough not to cut a real run short, short enough that a forgotten generator is not still
running an hour later.

### 3. `replicas: 1`, and `strategy: Recreate`

**"One run at a time" is enforced in the server's memory.** Two replicas means two generators can be started
against the same target at once: twice the load nobody agreed to, and two results that are each invalid. A
`RollingUpdate` has the same problem for the length of the rollout — and one of those pods may be holding a
running generator, so `Recreate` is the honest strategy.

### 4. `ClusterIP`, and nothing else

No LoadBalancer, no NodePort, no Ingress. A page that can start a load generator does not get a public
address. `kubectl port-forward` is authenticated by your kubeconfig and leaves a trail in the audit log,
which is the right shape for a control surface like this. Outside a cluster the GUI binds loopback for the
same reason; in a pod every bind is non-loopback, so the reachability decision moves here.

### 5. No `CronJob`

Recurring load against production is a decision that belongs somewhere auditable, attributable to whoever
asked for it — the Nomad dispatch records the target, the rate and any override against a person. A schedule
nobody reads is the opposite of that. The checker asserts no `CronJob` exists in these manifests.

---

## Why `generateName` on the Job

Every run wants to be its own object: a second run must not collide with the first, and the record of what
ran should stay in the cluster until you clear it (`ttlSecondsAfterFinished: 86400`). That means
`kubectl create`, not `kubectl apply` — and it is also why the Job is not in `kustomization.yaml`, since
kustomize requires a `metadata.name`. The checker renders it separately.

## Placement, and the network

Put the generator **near** the target but **not on it**. Co-located you measure the two competing for the
same CPU, and the number means nothing. The Job ships a commented `nodeAffinity` (right zone) and
`podAntiAffinity` (off the target's nodes) to adapt.

`hostNetwork: true` is commented out, deliberately. It removes the CNI hop, which matters at a few hundred
req/s — an overlay can saturate before the target does, and crowdsim will report `generator_ok: false`, an
*invalid* run rather than a slow one. It also puts the pod on the node's network namespace, which most
clusters restrict. Turn it on when the numbers say the network is the bottleneck, not before.

Bandwidth is the constraint people forget: ~45 KB per page at 380 req/s is ~17 MB/s sustained.

## Resources

The generator is **CPU-bound** at high rates. Requests equal limits on purpose: if the kubelet throttles the
pod mid-ramp, the generator becomes the bottleneck being measured and the run is invalid. Start at 2 CPU /
2 Gi and watch `generator_ok`; if it is false, the answer is more CPU or a closer node, never a lower SLO.

The GUI's own limits look generous for a page — because the **runs it starts are children of that process**.
A tight limit there would throttle the generator.

## Reading the results

The Job mounts an `emptyDir` at `/out`, so the summary and the log die with the pod. `kubectl logs` has the
full run report, which is usually enough for a single run:

```bash
kubectl logs job/<name>
```

To keep the archive — `history.tsv` accumulating across runs, which is how you see whether the knee moves —
swap the `emptyDir` for a PVC (the GUI manifest already uses one) and point both at it. Then the GUI's
history view shows runs launched from the Job too: there is only one source of truth, and it is the driver's
own files.

## The profile

Not in these manifests and not in the image: a profile holds your hostnames, URL pools, build hashes and a
map of how your site is built. Create it from your own private copy:

```bash
kubectl create configmap crowdsim-profile --from-file=profile.json=./my-site.json
```

Mounted read-only for the GUI as well. The editor then reports that it cannot save (a 409 with an
explanation) instead of pretending to — a reasonable default for a map of your infrastructure. If you do
want to edit profiles from the page, use a PVC instead and drop `readOnly`.

## What is missing on purpose

- **No Helm chart.** Two manifests with comments explaining the decisions are more useful than a chart with
  values that hide them. If you need one, the manifests are the reference.
- **No HPA.** Autoscaling a load generator means an unbounded amount of load, decided by a controller.
- **No ServiceMonitor.** The run's own summary is the measurement; scraping the generator would tell you
  about the generator.

## See also

- [`../README.md`](../README.md) — the Nomad job, and what else lives in `ci/`
- [docs/docker.md](../../docs/docker.md) — the image these manifests run, in detail
- [docs/reading-results.md](../../docs/reading-results.md) — what `kubectl logs` is showing you
