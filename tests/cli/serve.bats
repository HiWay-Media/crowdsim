#!/usr/bin/env bats
#
# `serve`: what the driver hands to the GUI server.
#
# The GUI spawns `bin/crowdsim` for every run, so the one thing it must not be wrong about is which driver.
# The server can search — CROWDSIM_BIN, $CROWDSIM_ROOT/bin/crowdsim, its own checkout, PATH — but a search
# can find a different copy from the one somebody chose to run, and inside the published image it found a
# path that did not exist at all: the page started, said nothing, and every run died with `spawn ENOENT`
# after the click. Thirty releases, found by somebody running the container.
#
# So `serve` names itself. `node` is a stub here: what is asserted is the environment handed over, not a
# server coming up.

load helper.bash

setup() {
  crowdsim_setup
  # A stub node that prints the environment the driver exported and exits, instead of serving.
  cat > "$BATS_TEST_TMPDIR/stub/node" <<'STUB'
#!/usr/bin/env bash
printf 'NODE-RAN %s\n' "$1"
printf 'CROWDSIM_BIN=%s\n' "${CROWDSIM_BIN:-<unset>}"
printf 'CROWDSIM_OUT=%s\n' "${CROWDSIM_OUT:-<unset>}"
exit 0
STUB
  chmod +x "$BATS_TEST_TMPDIR/stub/node"
  mkdir -p "$CROWDSIM_ROOT/gui/ui/dist" 2>/dev/null || true
}

@test "serve hands the GUI the absolute path of the driver that was invoked" {
  run "$CROWDSIM" serve
  [ "$status" -eq 0 ]
  case "$output" in
    *"CROWDSIM_BIN=$CROWDSIM_ROOT/bin/crowdsim"*) ;;
    *) printf 'serve did not name itself as the driver:\n%s\n' "$output" >&2; return 1;;
  esac
}

@test "an explicit CROWDSIM_BIN from the caller still wins" {
  # Somebody running two versions side by side, or pointing the page at a wrapper, has said what they mean.
  run env CROWDSIM_BIN=/opt/other/crowdsim "$CROWDSIM" serve
  [ "$status" -eq 0 ]
  case "$output" in
    *"CROWDSIM_BIN=/opt/other/crowdsim"*) ;;
    *) printf 'serve overrode an explicit CROWDSIM_BIN:\n%s\n' "$output" >&2; return 1;;
  esac
}

@test "a relative invocation still exports an absolute path" {
  # `./crowdsim serve` from bin/ is how a shell usually calls it, and a relative path in the environment
  # would resolve against the server's working directory rather than the caller's.
  cd "$CROWDSIM_ROOT/bin"
  run ./crowdsim serve
  [ "$status" -eq 0 ]
  case "$output" in
    *"CROWDSIM_BIN=/"*) ;;
    *) printf 'the exported path is not absolute:\n%s\n' "$output" >&2; return 1;;
  esac
}

@test "serve without node says so, and says the CLI does not need it" {
  run env PATH="$(path_without_node)" "$CROWDSIM" serve
  [ "$status" -eq 5 ]
  case "$output" in
    *"needs node"*) ;;
    *) printf 'the refusal does not name node:\n%s\n' "$output" >&2; return 1;;
  esac
}
