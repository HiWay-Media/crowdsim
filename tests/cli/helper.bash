# Shared setup for the CLI suite.
#
# The suite must never generate load: `k6` is replaced by a stub on PATH and every load command runs with
# --dry-run, so what is asserted is the DECISION (gate passed or refused, which env the generator would
# get) and not a request. A CLI test that needs a real target is an e2e test — see tests/e2e/.

crowdsim_setup() {
  CROWDSIM_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  CROWDSIM="$CROWDSIM_ROOT/bin/crowdsim"
  FIXTURES="$BATS_TEST_DIRNAME/fixtures"
  export CROWDSIM_ROOT CROWDSIM FIXTURES
  export CROWDSIM_OUT="$BATS_TEST_TMPDIR/out"

  # The allowlist is an environment gate: a value leaking in from the developer's shell would make the
  # gate tests pass for the wrong reason.
  unset CROWDSIM_ALLOW_TARGETS
  unset CROWDSIM_SLACK_WEBHOOK

  mkdir -p "$BATS_TEST_TMPDIR/stub"
  cat > "$BATS_TEST_TMPDIR/stub/k6" <<'STUB'
#!/usr/bin/env bash
# Stub generator: records the invocation instead of sending anything.
printf 'STUB-K6 %s\n' "$*"
exit 0
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/k6"
  export PATH="$BATS_TEST_TMPDIR/stub:$PATH"
}

# ── a PATH without one tool ──────────────────────────────────────────────────────────────────────────
#
# Built from symlinks rather than by filtering $PATH: on a developer machine k6 usually lives in the same
# directory as python3 (both from brew), and docker is in /usr/local/bin on a Mac but /usr/bin on a Linux
# runner — filtering either would remove tools the driver needs and the test would pass for the wrong
# reason, at the wrong exit code.
#
# The list below is one list on purpose. It used to be copied into each helper, and each copy was missing
# `dirname` — which bin/crowdsim calls on its second line to find its own root. Every "without <tool>"
# test therefore died at exit 1 before reaching the check it was written for, and the thirteen failures
# were documented as failing by design rather than read as the bug they were.
CROWDSIM_TEST_TOOLS="bash sh dirname basename python3 curl sed awk tr date mkdir cat grep tee cut wc
  sort head tail column rm env ln cp mv touch find xargs uname sleep printf id stat"

# path_without <tool> [more tools...] — everything the driver needs except those, plus the stub k6 unless
# k6 itself is what is being removed.
path_without() {
  local dir="$BATS_TEST_TMPDIR/without-$(printf '%s-' "$@")" tool p want
  mkdir -p "$dir"
  for tool in $CROWDSIM_TEST_TOOLS node docker k6; do
    p="$(command -v "$tool" 2>/dev/null)" && ln -sf "$p" "$dir/$tool"
  done
  # the stub, not whatever k6 the developer has: this suite must never be able to generate load
  ln -sf "$BATS_TEST_TMPDIR/stub/k6" "$dir/k6"
  for want in "$@"; do rm -f "$dir/$want"; done
  printf '%s' "$dir"
}

path_without_k6()     { path_without k6; }
path_without_docker() { path_without docker; }
path_without_node()   { path_without node; }

# `column` comes from util-linux/bsdmainutils and is absent from busybox, which is what the published
# image is built on — so `crowdsim history` inside the container was the one subcommand that could not
# run at all.
path_without_column() { path_without column; }

# k6 is a stub on PATH for this suite; a test that needs the real one says so and skips otherwise, the way
# the e2e suite skips without docker. A red run that means "you don't have k6" teaches people to ignore red.
skip_unless_k6() {
  local real
  real="$(PATH="$(path_without_stub)" command -v k6 2>/dev/null || true)"
  if [ -z "$real" ]; then skip "needs the real k6, not the stub"; fi
  PATH="$(path_without_stub)"
  export PATH
}

# The PATH this suite was given, minus the stub directory it prepended.
path_without_stub() {
  printf '%s' "${PATH#"$BATS_TEST_TMPDIR/stub:"}"
}
