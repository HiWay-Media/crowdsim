/*
 * Unit tests for naming the knee. (#51)
 *
 * With the ramp reported step by step, the answer everybody came for is computable: *clean up to 90 req/s,
 * crossed at 120*. Until now the tool said "completed" or "aborted" and the reader converted that into a
 * capacity figure by hand — usually by rounding up to `--peak`, which is the one rate nobody measured the
 * system surviving.
 *
 * Most of these tests are about the REFUSALS. A knee inferred from one step is a straight line through one
 * point, and it will be quoted with the same confidence as a real one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { knee } from '../../k6/lib/knee.js';

const SLO = { maxP95: 1000, maxFailed: 0.05 };
const OK = { generatorOk: true, targetUnreachable: false, stepDur: '60s', abortDelay: '30s' };

/** A step row as lib/steps.js produces it. */
function step(o) {
  return Object.assign({
    step: 's1', index: 1, is_hold: false, sustained: false, from_rps: 30, requested_rps: 60,
    achieved_rps: 45, requests: 2700, p50: 90, p95: 200, p99: 300,
    failed_rate: 0, over_guillotine_rate: 0, partial: false, per_class: {},
  }, o);
}

test('the knee is the last clean step and the first one that crossed, both rates named', () => {
  const rows = [
    step({ step: 's1', from_rps: 30, requested_rps: 60, p95: 200 }),
    step({ step: 's2', index: 2, from_rps: 60, requested_rps: 90, p95: 400 }),
    step({ step: 's3', index: 3, from_rps: 90, requested_rps: 120, p95: 4200 }),
  ];
  const k = knee(rows, Object.assign({}, OK, SLO));
  assert.equal(k.refused, undefined);
  assert.equal(k.clean.step, 's2');
  assert.equal(k.clean.requested_rps, 90);
  assert.equal(k.crossed.step, 's3');
  assert.equal(k.crossed.requested_rps, 120);
  assert.equal(k.crossed.p95, 4200);
  assert.match(k.crossed.why, /p95/);
});

test('a run that never crossed says so, and does not pretend the peak is the knee', () => {
  // This is the common case and the easiest to misreport: "it survived 120" is true, "the knee is at 120"
  // is not — nothing was measured breaking.
  const rows = [
    step({ step: 's1', requested_rps: 60, p95: 200 }),
    step({ step: 'peak', index: 2, is_hold: true, sustained: true, from_rps: 120, requested_rps: 120, p95: 400 }),
  ];
  const k = knee(rows, Object.assign({}, OK, SLO));
  assert.equal(k.crossed, null);
  assert.equal(k.clean.step, 'peak');
  assert.equal(k.clean.sustained, true);
  assert.match(k.summary, /did not find it/i);
  assert.match(k.summary, /above this peak/i, 'a run that never crossed must place the knee above the peak');
  assert.doesNotMatch(k.summary, /crossed at/, 'nothing crossed, so nothing may be reported as crossing');
});

test('a clean rate from a sustained hold is stated differently from one merely swept through', () => {
  // A climbing step passed through its rate on the way up; the hold is the only part of a run that held one.
  // "This system handles 90 req/s" from a step that touched 90 for a few seconds is the tool's own
  // averaging trap, one level up.
  const swept = knee([
    step({ step: 's1', requested_rps: 60, p95: 200 }),
    step({ step: 's2', index: 2, from_rps: 60, requested_rps: 90, p95: 400 }),
    step({ step: 's3', index: 3, from_rps: 90, requested_rps: 120, p95: 4200 }),
  ], Object.assign({}, OK, SLO));
  assert.equal(swept.clean.sustained, false);
  assert.match(swept.clean.caveat, /swept|passed through|not sustained/i);

  const held = knee([
    step({ step: 's1', requested_rps: 60, p95: 200 }),
    step({ step: 'peak', index: 2, is_hold: true, sustained: true, from_rps: 90, requested_rps: 90, p95: 400 }),
  ], Object.assign({}, OK, SLO));
  assert.equal(held.clean.sustained, true);
  assert.equal(held.clean.caveat, null);
});

test('a step is judged on its failed rate as well as its latency', () => {
  const rows = [
    step({ step: 's1', requested_rps: 60, p95: 200, failed_rate: 0 }),
    step({ step: 's2', index: 2, requested_rps: 90, p95: 300, failed_rate: 0.4 }),
  ];
  const k = knee(rows, Object.assign({}, OK, SLO));
  assert.equal(k.crossed.step, 's2');
  assert.match(k.crossed.why, /failed/i);
});

test('a class that crossed its own limit is the knee, and is named', () => {
  // Per-class SLOs make the brake sharper; the knee has to use the same rule, or the summary would report a
  // knee above the rate at which the run actually aborted.
  const rows = [
    step({ step: 's1', requested_rps: 60, p95: 200 }),
    step({
      step: 's2', index: 2, requested_rps: 90, p95: 400, failed_rate: 0,
      per_class: { rsc_page: { p95: 900, failed_rate: 0 }, html: { p95: 300, failed_rate: 0 } },
    }),
  ];
  const k = knee(rows, Object.assign({}, OK, SLO, { classSlo: { rsc_page: { maxP95: 800 } } }));
  assert.equal(k.crossed.step, 's2');
  assert.equal(k.crossed.class, 'rsc_page');
  assert.match(k.crossed.why, /rsc_page/);
});

test('a partial step can be the one that crossed, but never the clean one', () => {
  // The brake fires while latency is climbing, so a partial step is biased towards its worst part: good
  // enough to say "it broke in here", never good enough to say "it survived this".
  const rows = [
    step({ step: 's1', requested_rps: 60, p95: 200 }),
    step({ step: 's2', index: 2, requested_rps: 90, p95: 300 }),
    step({ step: 's3', index: 3, requested_rps: 120, p95: 400, partial: true }),
  ];
  const k = knee(rows, Object.assign({}, OK, SLO));
  assert.equal(k.clean.step, 's2', 'a partial step was quoted as a rate the system survived');
  const broke = knee([
    step({ step: 's1', requested_rps: 60, p95: 200 }),
    step({ step: 's2', index: 2, requested_rps: 90, p95: 300 }),
    step({ step: 's3', index: 3, requested_rps: 120, p95: 5000, partial: true }),
  ], Object.assign({}, OK, SLO));
  assert.equal(broke.crossed.step, 's3');
  assert.equal(broke.crossed.partial, true);
});

// ── the refusals ────────────────────────────────────────────────────────────────────────────────────
test('fewer than two completed steps is a refusal: one point is not a curve', () => {
  const k = knee([step({ step: 's1' })], Object.assign({}, OK, SLO));
  assert.equal(k.refused, true);
  assert.match(k.reason, /curve/i, 'the refusal does not explain why one step is not enough');
  assert.match(k.reason, /step/i);
  assert.match(k.fix, /--steps|--step-dur/);
  assert.equal(k.clean, undefined);
});

test('a generator that did not hold the rate refuses a knee, since it has no numbers at all', () => {
  const rows = [step({ step: 's1' }), step({ step: 's2', index: 2, requested_rps: 90 })];
  const k = knee(rows, Object.assign({}, OK, SLO, { generatorOk: false }));
  assert.equal(k.refused, true);
  assert.match(k.reason, /generator/i);
});

test('an unreachable target refuses a knee: that is connectivity, not capacity', () => {
  const rows = [step({ step: 's1' }), step({ step: 's2', index: 2 })];
  const k = knee(rows, Object.assign({}, OK, SLO, { targetUnreachable: true }));
  assert.equal(k.refused, true);
  assert.match(k.reason, /reach|connectivity/i);
});

test('steps shorter than the abort delay refuse a knee: the brake was never evaluated in them', () => {
  // With --abort-delay 30s and --step-dur 10s, a step can pass while already crossing — the threshold is
  // not evaluated yet. A knee read off those steps is a knee the brake would never have agreed with.
  const rows = [step({ step: 's1' }), step({ step: 's2', index: 2 })];
  const k = knee(rows, Object.assign({}, OK, SLO, { stepDur: '10s', abortDelay: '30s' }));
  assert.equal(k.refused, true);
  assert.match(k.reason, /--abort-delay/, 'the refusal must name the flag it is about');
  assert.match(k.fix, /--step-dur|--abort-delay/);
});

test('no per-step data at all is a refusal, not a knee of null', () => {
  assert.equal(knee(null, Object.assign({}, OK, SLO)).refused, true);
  assert.equal(knee([], Object.assign({}, OK, SLO)).refused, true);
});

test('the refusal always says what to change, in one sentence each', () => {
  const cases = [
    knee([step({})], Object.assign({}, OK, SLO)),
    knee([step({}), step({ index: 2 })], Object.assign({}, OK, SLO, { generatorOk: false })),
    knee([step({}), step({ index: 2 })], Object.assign({}, OK, SLO, { targetUnreachable: true })),
    knee([step({}), step({ index: 2 })], Object.assign({}, OK, SLO, { stepDur: '5s' })),
    knee(null, Object.assign({}, OK, SLO)),
  ];
  for (const k of cases) {
    assert.equal(k.refused, true);
    assert.ok(k.reason && k.reason.length > 20, 'a refusal with no reason is an error message');
    assert.ok(k.fix && k.fix.length > 10, `no fix offered for: ${k.reason}`);
  }
});

test('a run that aborted inside its first step is told to lower --start, not to add steps', () => {
  // Measured: a slow origin with --start 1 --steps 4 died in step 1, and the refusal advised raising
  // --steps. More steps do not help a ramp whose FIRST rate is already past the knee; the useful sentence
  // is that the run began above capacity.
  const k = knee([step({ step: 's1', from_rps: 1, requested_rps: 2, p95: 5000, partial: true })],
                 Object.assign({}, OK, SLO));
  assert.equal(k.refused, true);
  assert.match(k.reason, /no step ran to completion/i, 'reads as "only 0 step ran to completion"');
  assert.match(k.fix, /--start/);
  assert.doesNotMatch(k.fix, /raise --steps/);
});

test('one completed step out of several is still a refusal, and says so in words', () => {
  const k = knee([step({ step: 's1', p95: 200 }), step({ step: 's2', index: 2, p95: 5000, partial: true })],
                 Object.assign({}, OK, SLO));
  assert.equal(k.refused, true);
  assert.match(k.reason, /one step/i);
  assert.match(k.fix, /--step/);
});

// ── a crossing that the system recovers from is not a knee ──────────────────────────────────────────
// Measured, not imagined. A real run against a slow origin: step s1 (1→2 req/s) came back at p95 736 ms
// against a 700 ms SLO, then s2 and s3 — at the SAME rate or higher — came back at 611 and 609 ms. The first
// version of this file called that "the ramp starts above this system's capacity: lower --start", which is
// exactly the kind of confident wrong sentence the tool exists not to produce. The 736 ms was a cold start.
//
// So a knee is a crossing the system does not come back from. A crossing undone by a later step at an equal
// or higher rate is evidence of a cold cache or of noise, and it is reported as that.

test('a crossing undone at a higher rate is not the knee: it is a cold start, and is named as one', () => {
  const rows = [
    step({ step: 's1', from_rps: 1, requested_rps: 2, p95: 736 }),
    step({ step: 's2', index: 2, from_rps: 2, requested_rps: 2, p95: 611 }),
    step({ step: 'peak', index: 3, is_hold: true, sustained: true, from_rps: 2, requested_rps: 2, p95: 609 }),
  ];
  const k = knee(rows, Object.assign({}, OK, { maxP95: 700, maxFailed: 0.05 }));
  assert.equal(k.crossed, null, 'a transient crossing was reported as the knee');
  assert.equal(k.clean.step, 'peak', 'the clean rate must be the highest one the run actually held');
  assert.match(k.summary, /did not find it/i);
  // and the blip is not swept under the carpet: it is the reason to warm up.
  assert.equal(k.transient.length, 1);
  assert.equal(k.transient[0].step, 's1');
  assert.match(k.note, /warm|cold/i);
});

test('a crossing that persists to the end of the run IS the knee, even with a blip earlier', () => {
  const rows = [
    step({ step: 's1', from_rps: 1, requested_rps: 2, p95: 736 }),   // cold start
    step({ step: 's2', index: 2, from_rps: 2, requested_rps: 4, p95: 300 }),
    step({ step: 's3', index: 3, from_rps: 4, requested_rps: 6, p95: 900 }),
    step({ step: 's4', index: 4, from_rps: 6, requested_rps: 8, p95: 4000 }),
  ];
  const k = knee(rows, Object.assign({}, OK, { maxP95: 700, maxFailed: 0.05 }));
  assert.equal(k.crossed.step, 's3', 'the knee is the first crossing that is never undone');
  assert.equal(k.clean.step, 's2');
  assert.equal(k.transient.length, 1);
});

test('every step crossing, with no recovery, still means the ramp starts too high', () => {
  const rows = [
    step({ step: 's1', from_rps: 1, requested_rps: 2, p95: 5000 }),
    step({ step: 's2', index: 2, from_rps: 2, requested_rps: 4, p95: 6000 }),
  ];
  const k = knee(rows, Object.assign({}, OK, { maxP95: 700, maxFailed: 0.05 }));
  assert.equal(k.clean, null);
  assert.equal(k.crossed.step, 's1');
  assert.match(k.summary, /starts (at or )?above/i);
  assert.match(k.summary, /--start/);
});
