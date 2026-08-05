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

ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; FAILED=1; }
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
case "$val" in
  *"validating"*) ok "crowdsim validate works in the image" ;;
  *) bad "crowdsim validate is broken in the image"; printf '%s\n' "$val" | sed 's/^/      /' ;;
esac
case "$dry" in
  *"needs node"*) bad "load fell back to structural validation: lib/ is missing from the image" ;;
  *) ok "load reaches the full profile validation" ;;
esac

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

# ── the GUI runs in there ────────────────────────────────────────────────────────────────────────────
# Off-loopback bind without a token must be refused, in the image as everywhere else.
set +e
run -e CROWDSIM_GUI_BIND=0.0.0.0 "$IMAGE" crowdsim serve >/dev/null 2>&1
rc=$?
set -e
[ "$rc" = "3" ] && ok "binding 0.0.0.0 without a token is refused (exit 3)" \
                || bad "an untokened 0.0.0.0 bind exited $rc, expected 3"

TOKEN="smoke-$$"
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8787" \
  -e CROWDSIM_GUI_BIND=0.0.0.0 -e CROWDSIM_GUI_TOKEN="$TOKEN" \
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
