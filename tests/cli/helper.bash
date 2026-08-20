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

# A PATH with the tools the driver needs and NO k6, to test the "k6 is not installed" path.
# Built from symlinks rather than by filtering $PATH: on a developer machine k6 usually lives in the same
# directory as python3 (both from brew), so filtering would remove python3 too and the test would pass
# for the wrong reason — at the wrong exit code.
path_without_k6() {
  local dir="$BATS_TEST_TMPDIR/nok6" tool p
  mkdir -p "$dir"
  for tool in bash sh python3 curl sed tr date mkdir cat grep tee cut wc column rm env docker; do
    p="$(command -v "$tool" 2>/dev/null)" && ln -sf "$p" "$dir/$tool"
  done
  rm -f "$dir/k6"
  printf '%s' "$dir"
}

# A PATH with the tools the driver needs and NO docker, to test the "docker is not installed" path.
# Filtering a directory out of $PATH would not do: docker lives in /usr/local/bin on a developer's Mac
# but in /usr/bin on a Linux CI runner, alongside everything else the driver needs.
path_without_docker() {
  local dir="$BATS_TEST_TMPDIR/nodocker" tool p
  mkdir -p "$dir"
  for tool in bash sh python3 curl sed tr date mkdir cat grep tee cut wc column rm env node; do
    p="$(command -v "$tool" 2>/dev/null)" && ln -sf "$p" "$dir/$tool"
  done
  ln -sf "$BATS_TEST_TMPDIR/stub/k6" "$dir/k6"
  rm -f "$dir/docker"
  printf '%s' "$dir"
}

# A PATH with the tools the driver needs and NO node, to test the degraded validation path. Same symlink
# approach as path_without_k6, and for the same reason: filtering $PATH would take python3 with it.
path_without_node() {
  local dir="$BATS_TEST_TMPDIR/nonode" tool p
  mkdir -p "$dir"
  for tool in bash sh python3 curl sed tr date mkdir cat grep tee cut wc column rm env k6 docker; do
    p="$(command -v "$tool" 2>/dev/null)" && ln -sf "$p" "$dir/$tool"
  done
  # the stub k6 must still be reachable: this tests missing node, not missing k6
  ln -sf "$BATS_TEST_TMPDIR/stub/k6" "$dir/k6"
  rm -f "$dir/node"
  printf '%s' "$dir"
}

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

# A PATH with the tools the driver needs and NO `column`. Not a hypothetical: `column` comes from
# util-linux/bsdmainutils and is absent from busybox, which is what the published image is built on — so
# `crowdsim history` inside the container was the one subcommand that could not run at all.
path_without_column() {
  local dir="$BATS_TEST_TMPDIR/nocolumn" tool p
  mkdir -p "$dir"
  for tool in bash sh python3 curl sed tr date mkdir cat grep tee cut wc rm env node docker; do
    p="$(command -v "$tool" 2>/dev/null)" && ln -sf "$p" "$dir/$tool"
  done
  ln -sf "$BATS_TEST_TMPDIR/stub/k6" "$dir/k6"
  rm -f "$dir/column"
  printf '%s' "$dir"
}
