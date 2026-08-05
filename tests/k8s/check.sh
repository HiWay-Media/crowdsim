#!/usr/bin/env bash
#
# Check the Kubernetes manifests in ci/kubernetes/.
#
# Three of the values in there are safety properties rather than preferences, and all three are one careless
# edit away from being lost: a Job that retries re-fires load at a system you just bent, a second GUI replica
# breaks the one-run-at-a-time rule (it lives in the server's memory), and a Service that is not ClusterIP
# gives a load generator a public address. This asserts them.
#
# It renders the manifests with `kubectl kustomize`, which is entirely client-side — no cluster, no API
# discovery. Two things come out of that: the YAML is proven to parse, and the rendered output has no
# comments, so an assertion cannot be satisfied by a line that is commented out.
#
# Missing kubectl is a SKIP (exit 0): most machines do not have it and this suite is not what it is for.
# A failed assertion is a failure (exit 1).
set -eo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
K8S="$ROOT/ci/kubernetes"
FAILED=0

ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; FAILED=1; }
say()  { printf '%s\n' "$*"; }
skip() { printf '⏭  SKIPPED: %s\n' "$*"; exit 0; }

command -v kubectl >/dev/null 2>&1 || skip "kubectl is not installed (client-side rendering only, no cluster needed)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "▶ checking $K8S"

# ── render ───────────────────────────────────────────────────────────────────────────────────────────
GUI="$TMP/gui.rendered.yaml"
kubectl kustomize "$K8S" > "$GUI" 2>"$TMP/gui.err" \
  || { bad "kubectl kustomize failed"; sed 's/^/      /' "$TMP/gui.err"; exit 1; }
ok "kustomization renders ($(grep -c '^kind:' "$GUI") objects)"

# The Job uses generateName so every run is its own object, and kustomize insists on a metadata.name — so it
# is rendered on its own, with a name substituted just for the check. The substitution is the only edit.
JOBDIR="$TMP/job"; mkdir -p "$JOBDIR"
sed 's/generateName: crowdsim-load-/name: crowdsim-load-check/' "$K8S/load-job.yaml" > "$JOBDIR/load-job.yaml"
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - load-job.yaml\n' \
  > "$JOBDIR/kustomization.yaml"
JOB="$TMP/job.rendered.yaml"
kubectl kustomize "$JOBDIR" > "$JOB" 2>"$TMP/job.err" \
  || { bad "load-job.yaml does not render"; sed 's/^/      /' "$TMP/job.err"; exit 1; }
ok "load-job.yaml parses"

ALL="$TMP/all.yaml"; cat "$GUI" "$JOB" > "$ALL"

has()  { grep -qE "$1" "$2"; }
want() { has "$2" "$3" && ok "$1" || bad "$1"; }
deny() { has "$2" "$3" && bad "$1" || ok "$1"; }

# ── the run is never retried ─────────────────────────────────────────────────────────────────────────
want "the Job is never retried (backoffLimit: 0)"        '^  backoffLimit: 0$'        "$JOB"
want "pods are never restarted (restartPolicy: Never)"   'restartPolicy: Never'      "$JOB"
want "the cluster enforces a hard stop (activeDeadlineSeconds)" 'activeDeadlineSeconds:' "$JOB"
deny "no CronJob: recurring load is not a schedule"      '^kind: CronJob$'           "$ALL"

# ── the gates are not pre-answered ───────────────────────────────────────────────────────────────────
deny "the production override is not committed in a manifest" 'i-know-this-breaks-production' "$ALL"
deny "no allowlist of \"*\""                             'CROWDSIM_ALLOW_TARGETS.*"\*"' "$ALL"
deny "no floating image tag"                             'image: .*:latest'          "$ALL"
want "the image tag is pinned"                           'image: ghcr\.io/hiway-media/crowdsim:[0-9]+\.[0-9]+\.[0-9]+' "$ALL"

# ── the GUI cannot be run twice, or reached from outside ──────────────────────────────────────────────
# "One run at a time" is enforced in the server's process. Two replicas means two generators.
want "the GUI runs exactly one replica"                  '^  replicas: 1$'           "$GUI"
want "rollouts replace rather than overlap (Recreate)"   'type: Recreate'            "$GUI"
want "the Service is ClusterIP"                          '^  type: ClusterIP$'       "$GUI"
deny "no LoadBalancer"                                   'type: LoadBalancer'        "$ALL"
deny "no NodePort"                                       'type: NodePort'            "$ALL"
deny "no Ingress: a load generator gets no public address" '^kind: Ingress$'         "$ALL"

# ── the token is a secret, and the bind is deliberate ────────────────────────────────────────────────
want "the GUI token comes from a Secret"                 'secretKeyRef'              "$GUI"
if grep -A1 'name: CROWDSIM_GUI_TOKEN' "$GUI" | grep -qE '^\s+value:'; then
  bad "CROWDSIM_GUI_TOKEN has a literal value in the manifest"
else
  ok "no literal token in the manifest"
fi
# In a pod, binding loopback would mean reachable by nobody.
want "the GUI binds 0.0.0.0 (reachability is the Service's job)" 'value: 0\.0\.0\.0' "$GUI"

# ── nothing runs as root ─────────────────────────────────────────────────────────────────────────────
want "workloads run as non-root"                         'runAsNonRoot: true'        "$JOB"
want "the GUI runs as non-root"                          'runAsNonRoot: true'        "$GUI"
deny "no privilege escalation"                           'allowPrivilegeEscalation: true' "$ALL"

say ""
if [ "$FAILED" = "0" ]; then
  ok "kubernetes manifests pass"
else
  printf '❌ kubernetes manifest check FAILED\n'
  exit 1
fi
