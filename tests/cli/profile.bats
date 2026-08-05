#!/usr/bin/env bats
#
# Profile and target resolution: what the generator is actually handed. A profile that resolves wrongly
# produces a run that measures the wrong thing under the right label, which is the hardest kind of wrong
# to notice afterwards.

load helper.bash
setup() { crowdsim_setup; }

resolved() { cat "$CROWDSIM_OUT"/profile-*.json; }

@test "inline pools reach the generator, documentation keys do not" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$(resolved)" == *'"/news"'* ]]
  [[ "$(resolved)" != *"documentation key"* ]]
}

@test "an @file pool reference is inlined (this is what discover writes)" {
  run "$CROWDSIM" load --profile "$FIXTURES/pool-file.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$(resolved)" == *"/from-file"* ]]
}

@test "an @file pool pointing at nothing is an error, not an empty pool" {
  run "$CROWDSIM" load --profile "$FIXTURES/missing-pool-file.json" --peak 10 --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" == *"points at a missing file"* ]]
}

@test "a class referencing a pool that does not exist is an error" {
  # Caught twice, deliberately: by the shared validator before anything runs (which is what reports it
  # now), and by resolve_profile on a machine with no node. Either way the pool is named.
  run "$CROWDSIM" load --profile "$FIXTURES/unknown-pool.json" --peak 10 --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown pool"* ]]
  [[ "$output" == *"nowhere"* ]]
}

@test "a class with an empty pool is dropped loudly and the mix renormalised" {
  # There is no honest fallback: pointing the class at another pool would measure the wrong request type
  # under the right label — a rendered 404 counted as a static asset.
  run "$CROWDSIM" load --profile "$FIXTURES/empty-pool.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"class skipped: static (pool 'static' is empty)"* ]]
  [[ "$output" == *"the mix is renormalised over the rest"* ]]
  # the class is gone from what the generator receives (the now-unused pool may stay: it is inert data)
  [[ "$(resolved)" != *'"name": "static"'* ]]
  [[ "$(resolved)" == *'"name": "html"'* ]]
}

@test "a profile whose every class lost its pool refuses to run" {
  run "$CROWDSIM" load --profile "$FIXTURES/all-empty-pools.json" --peak 10 --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" == *"every class was dropped"* ]]
}

@test "the default target from the profile is used when --target is absent" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"target 'local' → http://127.0.0.1:8099"* ]]
  [[ "$output" == *"BASE_URL=http://127.0.0.1:8099"* ]]
}

@test "an unknown target exits 2 and lists the ones that exist" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --target staging --peak 10 --dry-run
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown target: staging"* ]]
  [[ "$output" == *"local"* ]]
}

@test "a target without base_url exits 2" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --target nourl --peak 10 --dry-run
  [ "$status" -eq 2 ]
  [[ "$output" == *"has no base_url"* ]]
}

@test "host_header and bypass are passed through: CDN skipped, SNI and Host kept correct" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --target hostheader --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"HOST_HEADER=www.example.test"* ]]
  [[ "$output" == *"BYPASS=www.example.test=10.0.0.11"* ]]
}

@test "a target's skip_classes is applied by default and overridable on the command line" {
  # Hitting an app instance directly means proxy-only routes 404: that class would go to 100% failed and
  # trip the brake at a couple of req/s, making the target look far weaker than it is.
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --target hostheader --peak 10 --dry-run
  [[ "$output" == *"SKIP_CLASSES=proxy_only"* ]]

  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --target hostheader --peak 10 --dry-run \
    --skip-classes html
  [[ "$output" == *"SKIP_CLASSES=html"* ]]
}

@test "--base-url wins over the profile's targets" {
  CROWDSIM_ALLOW_TARGETS='127.0.0.1' run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" \
    --base-url http://127.0.0.1:8082 --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"BASE_URL=http://127.0.0.1:8082"* ]]
}

@test "ramp parameters and rsc mode reach the generator verbatim" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 40 --start 5 --steps 6 \
    --step-dur 45s --hold 90s --rsc-mode random --max-5xx 0.02 --max-p95 3000 --dry-run
  [ "$status" -eq 0 ]
  for expected in "PEAK_RPS=40" "START_RPS=5" "STEPS=6" "STEP_DUR=45s" "HOLD_DUR=90s" \
                  "RSC_MODE=random" "MAX_5XX=0.02" "MAX_P95_MS=3000"; do
    [[ "$output" == *"$expected"* ]] || { echo "missing: $expected"; false; }
  done
}

@test "--touch-and-go is a steep ramp with no hold and a faster brake" {
  # A 504 needs a queue and a queue needs time: this is the cheapest preset that still produces errors,
  # not a way to make a load test harmless.
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 40 --touch-and-go --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"STEPS=3"* ]]
  [[ "$output" == *"STEP_DUR=20s"* ]]
  [[ "$output" == *"HOLD_DUR=0s"* ]]
  [[ "$output" == *"ABORT_DELAY=10s"* ]]
}

@test "JOURNEY is only passed in journey shape, and a missing journey file exits 2" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [[ "$output" != *"JOURNEY="* ]]

  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --shape journey --dry-run
  [ "$status" -eq 2 ]
  [[ "$output" == *"needs journey.file"* ]]
}

@test "--dry-run really does not invoke the generator" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" != *"STUB-K6"* ]]
}

@test "a target can declare insecure, instead of remembering --insecure on every run" {
  # A node reached by address presents a certificate for a name it is not being called by. Forgetting the
  # flag on such a target produces a wall of TLS failures that reads exactly like an outage.
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --target insecure-node --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"INSECURE=1"* ]]
}

@test "a target that does not declare it keeps TLS verification on" {
  run "$CROWDSIM" load --profile "$FIXTURES/minimal.json" --peak 10 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"INSECURE=0"* ]]
}
