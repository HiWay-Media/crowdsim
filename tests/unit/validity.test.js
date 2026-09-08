/*
 * Why the generator did not hold the rate — and it is not always the generator.
 *
 * `generatorHeldRate()` is one line: dropped_iterations > 2% of requests. k6 drops an iteration when the
 * arrival-rate executor has no free VU, and that happens for two OPPOSITE reasons:
 *
 *   · the generator is starved — CPU, network, a container inside a VM. The run is garbage.
 *   · every VU is blocked waiting on a target that stopped keeping up. The target saturated, which is
 *     the finding.
 *
 * The tool reported both as "THE GENERATOR DID NOT HOLD THE RATE — discard this run, move the generator
 * closer to the target". Measured: a run at 12 req/s against a single-worker origin with a 300 ms delay —
 * a target that cannot serve 12 req/s by construction — said exactly that, on a completely healthy
 * generator. The advice was wrong and the run was the answer.
 *
 * `generator_ok` keeps its meaning (the generator did not deliver the requested rate — true in both
 * cases). What this file adds is WHICH of the two, from evidence the run already records, and it says
 * `unknown` rather than guessing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropDiagnosis, DROP_SHARE } from '../../k6/lib/validity.js';

test('no material drops is not a diagnosis at all', () => {
  const d = dropDiagnosis({ dropped: 0, requests: 10000, p95: 100, vusMax: 10, vuCeiling: 100 });
  assert.equal(d, null);
  const few = dropDiagnosis({ dropped: 5, requests: 10000, p95: 100, vusMax: 10, vuCeiling: 100 });
  assert.equal(few, null, 'below the share that makes a run generator-bound at all');
  assert.equal(DROP_SHARE, 0.02);
});

test('drops with the target answering fast and VUs to spare: the generator is the bottleneck', () => {
  const d = dropDiagnosis({
    dropped: 400, requests: 1000, p95: 30, maxP95: 1000, guillotineMs: 5000,
    vusMax: 40, vuCeiling: 200,
  });
  assert.equal(d.verdict, 'generator');
  assert.equal(d.generator_bound, true);
  assert.match(d.reason, /generator/);
  assert.match(d.fix, /closer to the target|bigger host/);
  // and it is a discard
  assert.equal(d.discard, true);
});

test('drops with VUs pinned at the ceiling and latency climbing: the TARGET could not absorb it', () => {
  // This is the run that was mislabelled. The generator started every session it could; they were all
  // waiting on the target.
  const d = dropDiagnosis({
    dropped: 400, requests: 1000, p95: 1400, maxP95: 700, guillotineMs: 5000,
    vusMax: 200, vuCeiling: 200,
  });
  assert.equal(d.verdict, 'target');
  assert.equal(d.generator_bound, false);
  assert.equal(d.discard, false, 'a saturated target is a capacity finding, not a wasted window');
  assert.match(d.reason, /target/);
  assert.doesNotMatch(d.reason, /move the generator/);
  assert.match(d.fix, /--recalibrate|lower --start|below/);
});

test('latency past the SLO is enough on its own: a queue is a queue', () => {
  const d = dropDiagnosis({
    dropped: 300, requests: 1000, p95: 900, maxP95: 700, guillotineMs: 5000,
    vusMax: 90, vuCeiling: 200,
  });
  assert.equal(d.verdict, 'target');
});

test('VUs pinned at the ceiling is enough on its own, even inside the SLO', () => {
  // Every session in flight and still dropping: the rate cannot be started, and the reason the VUs are
  // busy is the target holding them.
  const d = dropDiagnosis({
    dropped: 300, requests: 1000, p95: 200, maxP95: 700, guillotineMs: 5000,
    vusMax: 199, vuCeiling: 200,
  });
  assert.equal(d.verdict, 'target');
});

test('with neither signal available it says unknown and keeps the conservative verdict', () => {
  // An older summary has no VU ceiling and no SLO. Guessing there would be the whole bug again.
  const d = dropDiagnosis({ dropped: 400, requests: 1000, p95: null });
  assert.equal(d.verdict, 'unknown');
  assert.equal(d.discard, true, 'unknown fails towards discarding, which is the safe direction');
  assert.match(d.reason, /cannot be told|cannot tell/);
});

test('an unreachable target is never diagnosed as either: that is connectivity', () => {
  const d = dropDiagnosis({
    dropped: 400, requests: 1000, p95: 3, maxP95: 700, vusMax: 200, vuCeiling: 200,
    targetUnreachable: true,
  });
  assert.equal(d.verdict, 'unreachable');
  assert.equal(d.discard, true);
  assert.match(d.reason, /never really answered|connectivity/);
});

test('the verdict is what decides whether a lower rate is worth trying', () => {
  // --recalibrate exists to spend fewer windows. A saturated target is exactly the case a lower --start
  // measures properly; a starved generator would produce the same starved generator.
  const target = dropDiagnosis({ dropped: 400, requests: 1000, p95: 1400, maxP95: 700,
    vusMax: 200, vuCeiling: 200 });
  const generator = dropDiagnosis({ dropped: 400, requests: 1000, p95: 30, maxP95: 700,
    vusMax: 40, vuCeiling: 200 });
  assert.equal(target.retry_lower, true);
  assert.equal(generator.retry_lower, false);
});

test('a container inside a VM is named when it is the likely cause, and only then', () => {
  // Measured and documented three times over: the Docker network layer on macOS and Windows saturates
  // before the target does. If we know we are in one, the generator verdict should say so.
  const d = dropDiagnosis({ dropped: 400, requests: 1000, p95: 30, maxP95: 700,
    vusMax: 40, vuCeiling: 200, virtualisedGenerator: true });
  assert.equal(d.verdict, 'generator');
  assert.match(d.fix, /container inside a VM|VM/);
  const plain = dropDiagnosis({ dropped: 400, requests: 1000, p95: 30, maxP95: 700,
    vusMax: 40, vuCeiling: 200 });
  assert.doesNotMatch(plain.fix, /VM/);
});
