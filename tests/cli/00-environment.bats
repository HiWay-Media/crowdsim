# The canary for the suite itself.
#
# bats notices a failing assertion inside a test through errexit. Under bash 3.2 — still the /bin/bash on
# every macOS — a failing `[[ ... ]]` does NOT trip errexit, and this suite is written almost entirely in
# `[[ ]]`: every content assertion in it becomes a no-op and 90-odd tests report ok no matter what the
# driver prints. That is not a weaker suite, it is a suite that cannot fail, which is worse than none.
#
# It already cost us one: a bandwidth expectation of "140 Mbit/s" against a driver that correctly prints
# 141 survived every local run and failed in CI.
#
# This file is named to sort first, and asserts with `[ ]` and `case`, both of which DO trip errexit on
# 3.2 — so on a machine where the rest of the suite is decorative, at least this test says so.

@test "the suite runs under a bash that can fail: bats needs >= 4 for a [[ ]] assertion to count" {
  [ -n "${BASH_VERSINFO[0]}" ]
  [ "${BASH_VERSINFO[0]}" -ge 4 ] || {
    printf 'bash %s cannot fail a [[ ]] assertion: every content check in tests/cli is a no-op.\n' \
      "${BASH_VERSION}" >&2
    printf 'Run the suite with bash >= 4 (macOS: brew install bash). `make test-cli` does this for you.\n' >&2
    return 1
  }
}

@test "and proves it: a failing [[ ]] mid-test really does fail a test here" {
  # If this passes, errexit propagation is broken and every other assertion in the suite is worthless.
  run bash -c 'set -e; [[ "hello" == *"NOPE"* ]]; echo reached'
  [ "$status" -ne 0 ]
  [ "$output" != "reached" ]
}
