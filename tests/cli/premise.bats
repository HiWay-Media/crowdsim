#!/usr/bin/env bats
#
# The premise of an `authed` class: that its endpoint actually requires the token.
#
# This is the one CLI test that needs something to answer, because the question is what the TARGET says to
# a request sent without a token — a stub cannot have an opinion about that. It is a handful of requests
# to a python3 server on loopback, not load: the suite still generates none.
#
# It exists because a run was green while measuring nothing. An `authed` class was pointed at an endpoint
# that answers 200 with no Authorization header, so it sent an anonymous GET wearing a bearer token and
# reported the latency as an authenticated read.

load helper

setup() {
  crowdsim_setup
  PORT=8794
  SRV="$BATS_TEST_TMPDIR/srv.py"
  cat > "$SRV" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/api/me') and 'Authorization' not in self.headers:
            self.send_response(401); self.end_headers(); self.wfile.write(b'no'); return
        if self.path.startswith('/api/public-open'):
            self.send_response(200); self.end_headers(); self.wfile.write(b'open'); return
        if self.path.startswith('/api/gone'):
            self.send_response(404); self.end_headers(); self.wfile.write(b'nope'); return
        self.send_response(200); self.send_header('Content-Type', 'text/html')
        self.send_header('Cache-Control', 'max-age=60'); self.end_headers()
        self.wfile.write(b'<html>ok</html>')
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
  python3 "$SRV" "$PORT" & SRV_PID=$!
  export SRV_PID
  # wait for it rather than sleeping a guess: a race here would look like an unreachable target
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
    sleep 0.2
  done
  export CROWDSIM_ALLOW_TARGETS=127.0.0.1
}

teardown() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null || true
}

# Writes a profile with one authed class drawing from $2, and echoes its path.
profile_with() {
  local f="$BATS_TEST_TMPDIR/$1.json"
  cat > "$f" <<JSON
{ "name": "$1",
  "targets": { "default": "local", "list": { "local": { "base_url": "http://127.0.0.1:$PORT" } } },
  "safety": { "allow_hosts": ["127.0.0.1"], "safe_peak_rps": 100 },
  "pools": { "pages": ["/"], "api": ["$2"] },
  "classes": [ { "name": "html", "kind": "plain", "pool": "pages", "weight": 97 },
               { "name": "login", "kind": "login", "weight": 2 },
               { "name": "authed_api", "kind": "authed", "pool": "api", "weight": 1 } ] }
JSON
  printf '%s' "$f"
}

@test "an endpoint that refuses the anonymous request verifies the premise, and says so out loud" {
  run "$CROWDSIM" probe --profile "$(profile_with good /api/me)"
  [ "$status" -eq 0 ]
  [[ "$output" == *"the premise of every authed class"* ]]
  [[ "$output" == *"refused the request without a token (401)"* ]]
  [[ "$output" == *"Every authed class is pointed at an endpoint that requires the token."* ]]
}

@test "an endpoint that answers 200 without the token is refused with exit 4" {
  # The real bug: /api/auth/whoami returned the same body with and without the header, and the class
  # reported an anonymous GET as an authenticated read.
  run "$CROWDSIM" probe --profile "$(profile_with public /api/auth/whoami)"
  [ "$status" -eq 4 ]
  [[ "$output" == *"this endpoint does not require the token (200 without one)"* ]]
  [[ "$output" == *"anonymous GET wearing a bearer token"* ]]
  [[ "$output" == *"cannot measure an authenticated read"* ]]
}

@test "a pool that names a path the target does not serve is the other refusal, and reads differently" {
  run "$CROWDSIM" probe --profile "$(profile_with gone /api/gone)"
  [ "$status" -eq 4 ]
  [[ "$output" == *"the path does not exist on this target (404)"* ]]
  [[ "$output" != *"does not require the token"* ]]
}

@test "a profile with no authed class gets no section at all, and no exit code" {
  local f="$BATS_TEST_TMPDIR/plain.json"
  cat > "$f" <<JSON
{ "name": "plain",
  "targets": { "default": "local", "list": { "local": { "base_url": "http://127.0.0.1:$PORT" } } },
  "safety": { "allow_hosts": ["127.0.0.1"], "safe_peak_rps": 100 },
  "pools": { "pages": ["/"] },
  "classes": [ { "name": "html", "kind": "plain", "pool": "pages", "weight": 100 } ] }
JSON
  run "$CROWDSIM" probe --profile "$f"
  [ "$status" -eq 0 ]
  [[ "$output" != *"premise"* ]]
}

@test "without node the check does not run, and probe says that rather than staying quiet" {
  # Silence would read exactly like a verified premise, which is the failure this whole check is against.
  PATH="$(path_without_node)" run "$CROWDSIM" probe --profile "$(profile_with good /api/me)"
  [ "$status" -eq 0 ]
  [[ "$output" == *"the premise could not be checked"* ]]
  [[ "$output" == *"needs node"* ]]
}

@test "an authed class with no pool is refused before any target is involved" {
  local f="$BATS_TEST_TMPDIR/nopool.json"
  cat > "$f" <<JSON
{ "name": "nopool",
  "targets": { "default": "local", "list": { "local": { "base_url": "http://127.0.0.1:$PORT" } } },
  "safety": { "allow_hosts": ["127.0.0.1"], "safe_peak_rps": 100 },
  "auth": { "token_url": "http://127.0.0.1:$PORT/token", "mode": "form", "users_csv": "/tmp/u.csv" },
  "pools": { "pages": ["/"] },
  "classes": [ { "name": "html", "kind": "plain", "pool": "pages", "weight": 97 },
               { "name": "login", "kind": "login", "weight": 2 },
               { "name": "authed_api", "kind": "authed", "weight": 1 } ] }
JSON
  run "$CROWDSIM" validate "$f"
  [ "$status" -ne 0 ]
  [[ "$output" == *"authed_api"* ]]
  [[ "$output" == *"names no pool"* ]]
}

# ── how much of a pool a preflight checks (#77) ──────────────────────────────────────────────────────

@test "a pool whose first entry answers but whose rest do not is caught, not assumed" {
  # The blind spot: probe read pools.pages[0] and assumed the other 399. This pool answers at [0] and
  # 404s everywhere else, which is exactly the shape that used to pass.
  local f="$BATS_TEST_TMPDIR/liar.json"
  python3 - "$f" "$PORT" <<'PY'
import json, sys
pages = ["/"] + ["/api/gone"] * 9
json.dump({"name": "liar",
  "targets": {"default": "local", "list": {"local": {"base_url": "http://127.0.0.1:%s" % sys.argv[2]}}},
  "safety": {"allow_hosts": ["127.0.0.1"], "safe_peak_rps": 100},
  "pools": {"pages": pages},
  "classes": [{"name": "html", "kind": "plain", "pool": "pages", "weight": 100}]},
  open(sys.argv[1], "w"), indent=1)
PY
  run "$CROWDSIM" probe --profile "$f"
  [ "$status" -eq 4 ]
  [[ "$output" == *"how much of each pool answers"* ]]
  [[ "$output" == *"mostly paths this target does not serve"* ]]
  [[ "$output" == *"discover --verify"* ]]
}

@test "a healthy pool is reported as healthy, and the probe still exits 0" {
  run "$CROWDSIM" probe --profile "$(profile_with good /api/me)"
  [ "$status" -eq 0 ]
  [[ "$output" == *"sampled"* ]]
  [[ "$output" == *"are served"* ]]
}

@test "--pool-sample 1 is the old behaviour, and says how big the pool was anyway" {
  run "$CROWDSIM" probe --profile "$(profile_with good /api/me)" --pool-sample 1
  [ "$status" -eq 0 ]
  [[ "$output" == *"1 of 1 sampled"* || "$output" == *"of 1 sampled"* ]]
}

@test "the sample is paced, so a preflight cannot become the load test" {
  # Not a timing assertion — those are flaky. The pacing is the same knob discovery uses, and the point
  # is that it is honoured rather than that it takes a particular number of milliseconds.
  run grep -c 'VERIFY_DELAY' "$CROWDSIM"
  [ "$output" -ge 2 ]
}

@test "the premise check samples the pool too: one 401 does not speak for the rest" {
  local f="$BATS_TEST_TMPDIR/mixed.json"
  python3 - "$f" "$PORT" <<'PY'
import json, sys
# /api/me needs the token; /api/public-open does not. A one-URL check on [0] would call this verified.
json.dump({"name": "mixed",
  "targets": {"default": "local", "list": {"local": {"base_url": "http://127.0.0.1:%s" % sys.argv[2]}}},
  "safety": {"allow_hosts": ["127.0.0.1"], "safe_peak_rps": 100},
  "pools": {"pages": ["/"], "api": ["/api/me", "/api/me", "/api/public-open"]},
  "classes": [{"name": "html", "kind": "plain", "pool": "pages", "weight": 97},
              {"name": "login", "kind": "login", "weight": 2},
              {"name": "authed_api", "kind": "authed", "pool": "api", "weight": 1}]},
  open(sys.argv[1], "w"), indent=1)
PY
  run "$CROWDSIM" probe --profile "$f"
  [ "$status" -eq 4 ]
  [[ "$output" == *"/api/public-open"* ]]
  [[ "$output" == *"does not require the token"* ]]
}

# ── a preflight against a target that does not answer must not keep asking (#94) ─────────────────────
#
# 1.33.0 made `probe` sample 5 URLs per pool instead of checking one. Against a target that ANSWERS that
# is a few extra requests, paced, exactly as intended. Against one that does not answer it is 5 more
# timeouts per pool, plus the authed samples — measured at 2 minutes 7 seconds for a single probe against
# a blackholed address, where before it was one request. Thirteen probes in this suite turned a 90-second
# job into a 46-minute one in CI, and the runner killed it.
#
# The first request already establishes whether the target answers. If it did not, sampling the pools
# sends thirty more requests to learn the same thing.

@test "a target that never answers is not sampled: the first request already said so" {
  local f="$BATS_TEST_TMPDIR/dead.json"
  # Loopback, a port nothing listens on: refused instantly, so this test is fast whatever the fix costs.
  python3 - "$f" <<'PY'
import json, sys
json.dump({"name": "dead",
  "targets": {"default": "local", "list": {"local": {"base_url": "http://127.0.0.1:9"}}},
  "safety": {"allow_hosts": ["127.0.0.1"], "safe_peak_rps": 100},
  "pools": {"pages": ["/", "/a", "/b", "/c", "/d"]},
  "classes": [{"name": "html", "kind": "plain", "pool": "pages", "weight": 100}]},
  open(sys.argv[1], "w"), indent=1)
PY
  run "$CROWDSIM" probe --profile "$f"
  [ "$status" -eq 4 ]
  # It says the target never answered — which is connectivity, a different finding from a target that
  # answers 4xx — and does NOT go on to sample the pools.
  [[ "$output" == *"never answered"* ]]
  [[ "$output" == *"connectivity, not capacity"* ]]
  [[ "$output" != *"how much of each pool answers"* ]]
  [[ "$output" != *"the premise of every authed class"* ]]
}

@test "the sample is bounded per request, so one dead path cannot cost ten seconds" {
  # A sample request that times out is information — "this path did not answer" — not something to retry.
  # The budget is asserted against the source because a timing assertion is a flaky test.
  run grep -c 'POOL_SAMPLE_MAX_TIME' "$CROWDSIM"
  [ "$output" -ge 2 ]
  run bash -c "grep -A6 'pool_sample_check()' '$CROWDSIM' | grep -c -- '--retry'"
  [ "$output" -eq 0 ]
}
