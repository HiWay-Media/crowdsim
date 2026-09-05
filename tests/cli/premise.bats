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
