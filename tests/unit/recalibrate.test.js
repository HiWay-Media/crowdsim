/*
 * Recalibration: when a ramp's first step is already past capacity, what to try next.
 *
 * On a six-run campaign two runs were thrown away because `--start` was above what the system could
 * serve. crowdsim diagnoses that correctly and says so — *lower --start until the first step survives* —
 * after the window has been spent, and then somebody edits the command and runs it again. A ramp that
 * never completed a step measured nothing, so the entire output of those runs was a sentence telling the
 * operator to do arithmetic the tool had already done.
 *
 * The policy lives here, pure, because the interesting part is what it REFUSES. Recalibration is a way to
 * spend fewer runs, never a way to reach a rate a gate refuses — and never a way to retry a failure that
 * is not about capacity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recalibrate, RECALIBRATE_FACTOR, MAX_ATTEMPTS } from '../../k6/lib/recalibrate.js';

const kneeRefused = (reason) => ({ refused: true, reason: reason, fix: 'x' });
const NO_STEP = kneeRefused('no step ran to completion: the run ended inside its first one, so the ramp '
  + 'already starts at or above this system\'s capacity.');

test('the first step not surviving is the one case worth retrying, lower', () => {
  const r = recalibrate({ knee: NO_STEP, start: 40, peak: 120, attempt: 1 });
  assert.equal(r.retry, true);
  assert.equal(r.start, 20, 'halved');
  assert.equal(r.peak, 60, 'the ramp keeps its shape: peak comes down with start');
  assert.equal(RECALIBRATE_FACTOR, 0.5);
  assert.match(r.why, /first step/);
});

test('the ramp keeps its shape, so the run that survives is still a ramp', () => {
  // Lowering only --start would leave a ramp that climbs from 1 to 120 in the same number of steps: the
  // second step would be past capacity instead of the first, which is not progress.
  const r = recalibrate({ knee: NO_STEP, start: 40, peak: 120, attempt: 1 });
  assert.equal(r.peak / r.start, 3, 'the same start:peak ratio as the run that failed');
});

test('it stops at the floor rather than converging on zero', () => {
  const r = recalibrate({ knee: NO_STEP, start: 2, peak: 6, attempt: 1, floor: 2 });
  assert.equal(r.retry, false);
  assert.match(r.reason, /floor/);
  assert.match(r.reason, /2 req\/s/);
});

test('it stops after a bounded number of attempts', () => {
  const r = recalibrate({ knee: NO_STEP, start: 40, peak: 120, attempt: MAX_ATTEMPTS });
  assert.equal(r.retry, false);
  assert.match(r.reason, /attempt/);
  assert.equal(MAX_ATTEMPTS, 3);
});

test('a rounded-down rate never becomes zero, and never repeats the rate that just failed', () => {
  const r = recalibrate({ knee: NO_STEP, start: 1, peak: 2, attempt: 1, floor: 1 });
  // halving 1 gives 0.5, which rounds to 1 — the same run again. That is a loop, not a recalibration.
  assert.equal(r.retry, false);
  assert.match(r.reason, /floor|already/);
});

// ── the refusals: everything that is not a capacity problem ──────────────────────────────────────────

test('a generator-bound run is not retried lower: the generator is the bottleneck', () => {
  const r = recalibrate({ knee: kneeRefused('the generator did not hold the requested rate, so no step '
    + 'measured the rate it claims.'), start: 40, peak: 120, attempt: 1 });
  assert.equal(r.retry, false);
  assert.match(r.reason, /generator/);
});

test('an unreachable target is not retried lower: that is connectivity', () => {
  const r = recalibrate({ knee: kneeRefused('the target never really answered: that is connectivity, not '
    + 'capacity.'), start: 40, peak: 120, attempt: 1 });
  assert.equal(r.retry, false);
  assert.match(r.reason, /connectivity|answer/);
});

test('a run whose failure is 404s is not a capacity problem, whatever the knee says', () => {
  // The pool names paths this tier does not serve. Retrying at half the rate produces the same 404s at
  // half the rate — a second wasted run, which is the thing this feature exists to stop.
  const r = recalibrate({
    knee: NO_STEP, start: 40, peak: 120, attempt: 1,
    failureMode: { code: '404', share: 0.32, concentrated: true, classes: ['rsc_page'] },
  });
  assert.equal(r.retry, false);
  assert.match(r.reason, /404/);
  assert.match(r.reason, /pool|serve/);
});

test('a 5xx concentration IS capacity-shaped and is retried', () => {
  const r = recalibrate({
    knee: NO_STEP, start: 40, peak: 120, attempt: 1,
    failureMode: { code: '5xx', share: 0.4, concentrated: false, classes: ['html'] },
  });
  assert.equal(r.retry, true);
});

test('a run that DID complete a step is never retried: it has a curve to read', () => {
  for (const knee of [
    { clean: { requested_rps: 40 }, crossed: { requested_rps: 60 } },
    kneeRefused('only one step ran to completion: one point is not a curve.'),
  ]) {
    const r = recalibrate({ knee: knee, start: 40, peak: 120, attempt: 1 });
    assert.equal(r.retry, false, JSON.stringify(knee).slice(0, 40));
  }
});

test('no knee at all is not a reason to generate more load', () => {
  for (const knee of [null, undefined, {}]) {
    assert.equal(recalibrate({ knee: knee, start: 40, peak: 120, attempt: 1 }).retry, false);
  }
});

test('the safe peak is never exceeded by a recalibration, in either direction', () => {
  // A retry only ever goes DOWN, so it cannot climb past a ceiling — but the arithmetic is asserted
  // rather than assumed, because a sign error here would turn a brake into an accelerator.
  const r = recalibrate({ knee: NO_STEP, start: 40, peak: 120, attempt: 1, safePeak: 100 });
  assert.ok(r.peak < 120);
  assert.ok(r.peak <= 100);
  assert.ok(r.start < 40);
});
