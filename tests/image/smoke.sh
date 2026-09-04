#!/usr/bin/env bash
#
# Smoke-test a crowdsim image. Used by `make image-smoke` and by the image workflow, so CI and a laptop
# assert exactly the same things.
#
# It generates NO load: the only run it performs is a --dry-run, and the only refusals it triggers are
# gates. What it proves is that the image is the tool — that the driver still finds the generator after a
# path change, that the GUI actually starts in there, and above all that the absent allowlist default
# survived the build. A published image with a default allowlist would be the single worst regression
# this project can ship, and it would be invisible from the outside.
#
# Usage: tests/image/smoke.sh [image]        (default: crowdsim:dev)
set -eo pipefail

IMAGE="${1:-crowdsim:dev}"
PORT="${SMOKE_PORT:-18788}"
NAME="crowdsim-smoke-$$"
FAILED=0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; FAILED=1; }
warn() { printf '  ⚠️  %s\n' "$*"; }
say()  { printf '%s\n' "$*"; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { say "SKIPPED: docker is not available"; exit 0; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { say "❌ no such image: $IMAGE (build it: make image)"; exit 1; }

run() { docker run --rm --network none "$@"; }

say "▶ smoke-testing $IMAGE"

# ── the tool is present and wired ────────────────────────────────────────────────────────────────────
# Captured, not piped: `grep -q` closes the pipe on its first match, and the container then dies of
# SIGPIPE mid-write — which looks exactly like a broken --help.
help="$(run "$IMAGE" crowdsim --help 2>&1 || true)"
case "$help" in
  *'THIS TOOL GENERATES REAL LOAD'*) ok "crowdsim --help" ;;
  *) bad "crowdsim --help did not print the usage header"; printf '%s\n' "$help" | sed 's/^/      /' ;;
esac

doctor="$(run "$IMAGE" crowdsim doctor 2>&1 || true)"
for expected in 'k6 v' 'curl' 'python3' 'node v' 'GUI built'; do
  case "$doctor" in
    *"$expected"*) ok "doctor reports $expected" ;;
    *)             bad "doctor does not report '$expected'"; printf '%s\n' "$doctor" | sed 's/^/      /' ;;
  esac
done

# The driver must resolve the generator through CROWDSIM_ROOT, not through its own location in
# /usr/local/bin. A --dry-run prints the k6 command it would execute, which is where that shows up.
dry="$(run -e CROWDSIM_ALLOW_TARGETS='www.example.test' "$IMAGE" \
        crowdsim load --profile /crowdsim/profiles/example.json --peak 10 --dry-run 2>&1 || true)"
case "$dry" in
  *'/crowdsim/k6/live-event.js'*) ok "the driver resolves the generator at /crowdsim/k6" ;;
  *) bad "the dry run does not reference /crowdsim/k6/live-event.js"; printf '%s\n' "$dry" | sed 's/^/      /' ;;
esac

# The shared profile rules must be in the image too: without lib/ the driver falls back to the structural
# checks and says so, which means the same command validates differently depending on where it runs.
val="$(run "$IMAGE" crowdsim validate /crowdsim/profiles/example.json 2>&1 || true)"
# NOT just "did it print the banner": the driver prints `▶ validating …` BEFORE it execs node, so this
# assertion passed for a validator that crashed on every profile — which is exactly what the image shipped
# in 1.20.0. What proves the validator RAN is its verdict line, the one it prints at the end.
case "$val" in
  *"errors ·"*"warnings"*) ok "crowdsim validate reaches a verdict in the image" ;;
  *) bad "crowdsim validate did not reach a verdict in the image (a crash looks like this)"
     printf '%s\n' "$val" | sed 's/^/      /' ;;
esac
case "$dry" in
  *"needs node"*) bad "load fell back to structural validation: lib/ is missing from the image" ;;
  *) ok "load reaches the full profile validation" ;;
esac

# ── the image can say which version it is ────────────────────────────────────────────────────────────
# Not cosmetic: this is the one place where nobody else can answer the question. Somebody looking at a
# container they pulled minutes ago has no package.json to read and no repository to check, and a stale
# server serving a current-looking page is a real way to waste an afternoon.
img_version="$(docker run --rm "$IMAGE" crowdsim --version 2>/dev/null | tr -d '\r')"
case "$img_version" in
  "crowdsim unknown"*) bad "the image does not know its own version: the build forgot CROWDSIM_VERSION" ;;
  "crowdsim "[0-9]*)   ok "the image reports its version: $img_version" ;;
  *)                   bad "crowdsim --version said: ${img_version:-nothing}" ;;
esac

label_version="$(docker image inspect "$IMAGE" \
  --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)"
if [ -n "$label_version" ] && [ "$label_version" != "unknown" ]; then
  ok "docker inspect answers it too (label: $label_version)"
else
  bad "the OCI version label is missing or unknown, so `docker inspect` cannot answer it"
fi

# Is this image even the working tree? A smoke test that passes against an image built three releases ago
# reads exactly like a smoke test that passed — and this suite is the one that guards the invariant nobody
# may regress (no allowlist default in the image). It has already happened: the label said 1.14.0 while the
# tree was 1.14.1, because `make image-smoke` does not build. Now it says so.
tree_version="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '')"
if [ -z "$tree_version" ]; then
  warn "cannot read the working tree's version (no node): not checking whether the image matches it"
elif [ "$label_version" = "$tree_version" ]; then
  ok "the image is this working tree (both $tree_version)"
else
  bad "this image was built from version $label_version, and the working tree is $tree_version.
      Whatever you are about to trust this run for, it was not tested. Build it first:
        make image && make image-smoke"
fi

# ── the gates survived the build ─────────────────────────────────────────────────────────────────────
# No allowlist in the image's environment. This is the one that must never regress.
env_allow="$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -c '^CROWDSIM_ALLOW_TARGETS=' || true)"
if [ "$env_allow" = "0" ]; then
  ok "the image declares no CROWDSIM_ALLOW_TARGETS default"
else
  bad "the image ships a CROWDSIM_ALLOW_TARGETS default — a load test aimed at the wrong host"
fi

set +e
run "$IMAGE" crowdsim load --profile /crowdsim/profiles/example.json \
  --base-url https://not-allowed.test --peak 10 --dry-run >/dev/null 2>&1
rc=$?
set -e
[ "$rc" = "3" ] && ok "an unlisted host is refused (exit 3)" \
                || bad "an unlisted host exited $rc, expected 3"

set +e
run -e CROWDSIM_ALLOW_TARGETS='www.example.test' "$IMAGE" \
  crowdsim load --profile /crowdsim/profiles/example.json --peak 5000 --dry-run >/dev/null 2>&1
rc=$?
set -e
[ "$rc" = "3" ] && ok "a peak above the safe ceiling is refused (exit 3)" \
                || bad "a peak of 5000 exited $rc, expected 3"

# ── the image reads its own JavaScript the way a checkout does ───────────────────────────────────────
# One field, `"type": "module"`, decides whether every .js under k6/ and lib/ is an ES module or CommonJS.
# Without a package.json above them it is CommonJS in the image and ESM everywhere else, so the image runs
# code whose meaning depends on a file it does not contain. That shipped in 1.20.0 and broke `validate`,
# both gates' exit codes and the GUI. Asserted as the invariant it is, so the next failure names the cause
# instead of the symptom.
mod="$(run "$IMAGE" sh -c 'cat "${CROWDSIM_ROOT:-/crowdsim}/package.json" 2>/dev/null' || true)"
case "$mod" in
  *'"type": "module"'*|*'"type":"module"'*) ok "the image declares its JS as ES modules (type: module)" ;;
  *) bad "no \"type\": \"module\" at CROWDSIM_ROOT: every .js under k6/ and lib/ will be read as CommonJS" ;;
esac
# And the cross-boundary import that actually broke: a .mjs importing a .js from k6/lib.
if run "$IMAGE" node -e 'import("/crowdsim/lib/validate.mjs").then(m => {
  if (typeof m.validateProfile !== "function") { console.error("no validateProfile export"); process.exit(1); }
  process.exit(0);
}).catch((e) => { console.error(String(e && e.message)); process.exit(1); })' >/dev/null 2>&1; then
  ok "lib/validate.mjs loads inside the image, k6/lib import included"
else
  bad "lib/validate.mjs does not load in the image — the ESM/CommonJS split is back"
  run "$IMAGE" node -e 'import("/crowdsim/lib/validate.mjs").catch(e => console.error(e.message))' 2>&1 \
    | sed 's/^/      /' | head -4
fi

# ── the GUI runs in there ────────────────────────────────────────────────────────────────────────────
# Off-loopback bind without a token must be refused, in the image as everywhere else.
set +e
run -e CROWDSIM_GUI_BIND=0.0.0.0 "$IMAGE" crowdsim serve >/dev/null 2>&1
rc=$?
set -e
[ "$rc" = "3" ] && ok "binding 0.0.0.0 without a token is refused (exit 3)" \
                || bad "an untokened 0.0.0.0 bind exited $rc, expected 3"

TOKEN="smoke-$$"
# CROWDSIM_PROFILES points at the profile the image ships, so the API has something to launch. /profiles is
# an empty mount point by design — the profiles are yours — and an empty directory would make the run
# assertion below untestable rather than safe.
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8787" \
  -e CROWDSIM_GUI_BIND=0.0.0.0 -e CROWDSIM_GUI_TOKEN="$TOKEN" \
  -e CROWDSIM_PROFILES=/crowdsim/profiles \
  "$IMAGE" crowdsim serve >/dev/null

up=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/env" >/dev/null 2>&1; then
    up=1; break
  fi
  sleep 0.5
done

if [ "$up" = "1" ]; then
  ok "the GUI answers on the published port"
  env_json="$(curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/env")"
  case "$env_json" in
    *'"k6":"k6 v'*) ok "the GUI sees k6 inside the image" ;;
    *)              bad "the GUI does not see k6: $env_json" ;;
  esac
  case "$env_json" in
    *'"ui":true'*) ok "the built UI is present" ;;
    *)             bad "the GUI reports no built UI" ;;
  esac
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/env")"
  [ "$code" = "401" ] && ok "the API refuses an unauthenticated request (401)" \
                      || bad "an unauthenticated request returned $code, expected 401"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/")"
  [ "$code" = "200" ] && ok "the page is served" || bad "the page returned $code"

  # ── and the page can do its one job: spawn the driver ─────────────────────────────────────────────
  # THE ASSERTION WHOSE ABSENCE LET A BROKEN IMAGE SHIP. Everything above proves the GUI starts, answers,
  # sees k6 and serves the page — and all of it passed for thirty releases while every run launched from
  # that page died instantly: the server derived the driver's path from its own location
  # (/crowdsim/bin/crowdsim) and the image puts it in /usr/local/bin. Nothing was watching the one thing
  # the GUI exists for, so the failure was found by somebody running the container.
  #
  # --dry-run: the driver composes the whole k6 invocation, checks the profile, passes both gates and
  # exits 0 without sending a single request. Which makes this safe in CI and still end-to-end.
  say "  the GUI can spawn the driver (dry run — no traffic)"
  started="$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"kind":"load","profile":"example.json","target":"edge","peak":10,"dryRun":true}' \
    "http://127.0.0.1:$PORT/api/runs")"
  run_id="$(printf '%s' "$started" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("id") or "")
except Exception:
    print("")' 2>/dev/null)"
  if [ -z "$run_id" ]; then
    bad "the GUI refused to start a dry run: $started"
  else
    verdict=""
    for _ in $(seq 1 30); do
      verdict="$(curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/runs/$run_id" \
        | python3 -c 'import json,sys
d = json.load(sys.stdin)
log = " ".join(d.get("log") or [])
print(d.get("status"), d.get("exit_code"), "|", log[-300:])' 2>/dev/null)"
      case "$verdict" in
        running*) sleep 0.5;;
        *) break;;
      esac
    done
    case "$verdict" in
      *"could not be started"*)
        bad "the GUI cannot spawn the driver in this image — CROWDSIM_BIN is the fix: $verdict";;
      "done 0 "*)
        ok "the GUI spawned the driver and the dry run exited 0";;
      *)
        bad "a dry run through the GUI ended as: $verdict";;
    esac
    # And the driver it resolved is named in the log, so `docker logs` can answer "what is this running?"
    case "$(docker logs "$NAME" 2>&1)" in
      *"driver    /usr/local/bin/crowdsim"*) ok "the server names the driver it spawns, at startup" ;;
      *) bad "the startup log does not say which driver the GUI will spawn" ;;
    esac
  fi
else
  bad "the GUI never answered on 127.0.0.1:$PORT"
  docker logs "$NAME" 2>&1 | sed 's/^/      /'
fi

say ""
if [ "$FAILED" = "0" ]; then
  ok "image smoke test passed"
else
  printf '❌ image smoke test FAILED\n'
  exit 1
fi
