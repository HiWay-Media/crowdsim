/*
 * Unit tests for the ramp's steps. (#50)
 *
 * The tool reports one p50/p95/p99 for a whole run. A run that climbs 30 → 120 req/s therefore quotes a
 * latency that belongs to no rate the system was ever held at: it is a mixture, dominated by the cheap early
 * steps. The knee — the thing this tool is named after — is already inside a single run and gets averaged
 * away before anybody sees it.
 *
 * These tests pin down the two halves that can be wrong: which step a request belongs to, and which steps a
 * finished run is allowed to report as measurements.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { durationMs, stepPlan, stepAt, perStep } from '../../k6/lib/steps.js';
import { stages } from '../../k6/lib/mix.js';

const RAMP = { steps: 3, startRps: 30, peakRps: 120, stepDur: '60s', holdDur: '120s' };

test('a k6 duration becomes milliseconds, and an unparseable one says so instead of becoming zero', () => {
  assert.equal(durationMs('60s'), 60000);
  assert.equal(durationMs('2m'), 120000);
  assert.equal(durationMs('1m30s'), 90000);
  assert.equal(durationMs('500ms'), 500);
  assert.equal(durationMs('1h'), 3600000);
  assert.equal(durationMs('45'), 45000, 'a bare number is seconds, as k6 reads it');
  // A zero would silently collapse every boundary onto the same instant, and every request would land in
  // step 1 — a per-step table that is really the aggregate, wearing a table's clothes.
  assert.equal(durationMs('soon'), null);
  assert.equal(durationMs(''), null);
  assert.equal(durationMs(undefined), null);
});

test('the plan is built from the same stages() the ramp is, so the boundaries cannot drift', () => {
  const plan = stepPlan(RAMP);
  const st = stages(Object.assign({ share: 1 }, RAMP));
  assert.equal(plan.length, st.length, 'one entry per stage, hold included');
  assert.deepEqual(plan.map((s) => s.rateRps), st.map((s) => s.target));
  // A stage is a linear ramp from the previous target to its own, so a step does not measure ONE rate: it
  // sweeps a range. Saying "20 req/s" about a step that swept 15 → 20 is the same kind of averaging this
  // whole file exists to end, one level down.
  assert.deepEqual(plan.map((s) => s.fromRps), [30, 60, 90, 120]);
  assert.equal(plan[3].fromRps, plan[3].rateRps, 'the hold is the only step at a single, sustained rate');
  assert.deepEqual(plan.map((s) => s.startMs), [0, 60000, 120000, 180000]);
  assert.deepEqual(plan.map((s) => s.endMs), [60000, 120000, 180000, 300000]);
});

test('the hold is its own step, and named as the one at peak', () => {
  const plan = stepPlan(RAMP);
  const hold = plan[plan.length - 1];
  assert.equal(hold.isHold, true);
  assert.equal(hold.rateRps, 120);
  assert.match(hold.tag, /peak/);
  // It is the only part of the run where the requested rate was sustained rather than passed through.
  assert.equal(plan.filter((s) => s.isHold).length, 1);
});

test('--hold 0s leaves no hold step: climb and leave', () => {
  const plan = stepPlan(Object.assign({}, RAMP, { holdDur: '0s' }));
  assert.equal(plan.length, 3);
  assert.equal(plan.some((s) => s.isHold), false);
  assert.equal(plan[2].rateRps, 120, 'the last climbing step still arrives at the peak');
});

test('--steps 1 is one step at the peak plus the hold, not an empty plan', () => {
  const plan = stepPlan(Object.assign({}, RAMP, { steps: 1 }));
  assert.equal(plan.length, 2);
  assert.equal(plan[0].rateRps, 120);
});

test('a request is attributed by elapsed time, boundaries included', () => {
  const plan = stepPlan(RAMP);
  assert.equal(stepAt(0, plan).tag, plan[0].tag);
  assert.equal(stepAt(59999, plan).tag, plan[0].tag);
  // The boundary belongs to the step that starts there: at 60s exactly the ramp has already moved on.
  assert.equal(stepAt(60000, plan).tag, plan[1].tag);
  assert.equal(stepAt(299999, plan).tag, plan[3].tag);
});

test('past the end of the plan a request has no step, rather than being credited to the peak', () => {
  // k6 keeps requests in flight past the last stage while they drain. Counting them at the peak rate would
  // put the slowest requests of the run into the step people quote.
  const plan = stepPlan(RAMP);
  assert.equal(stepAt(300000, plan), null);
  assert.equal(stepAt(999999, plan), null);
});

test('an unparseable step duration produces no plan at all', () => {
  // Better no per-step table than one where every request is in step 1.
  assert.equal(stepPlan(Object.assign({}, RAMP, { stepDur: 'soon' })), null);
  assert.equal(stepPlan(Object.assign({}, RAMP, { holdDur: 'later' })), null);
});

// ── which steps a finished run may report ───────────────────────────────────────────────────────────
const trend = (v) => ({ values: v });
const rate = (r, passes, fails) => ({ values: { rate: r, passes, fails } });
const count = (c, r) => ({ values: { count: c, rate: r } });

function metricsFor(steps) {
  const m = {};
  for (const [tag, v] of Object.entries(steps)) {
    m[`http_req_duration{step:${tag}}`] = trend({ med: v.p50, 'p(95)': v.p95, 'p(99)': v.p99, max: v.p99 });
    m[`http_req_failed{step:${tag}}`] = rate(v.failed, 0, 0);
    m[`http_reqs{step:${tag}}`] = count(v.reqs, v.achieved);
    m[`cs_over_guillotine{step:${tag}}`] = rate(v.over || 0, 0, 0);
  }
  return m;
}

test('a completed run reports every step, with the rate it was asked to hold', () => {
  const plan = stepPlan(RAMP);
  const m = metricsFor({
    s1: { p50: 80, p95: 200, p99: 300, failed: 0, reqs: 1800, achieved: 30 },
    s2: { p50: 90, p95: 240, p99: 400, failed: 0, reqs: 3600, achieved: 60 },
    s3: { p50: 140, p95: 900, p99: 1800, failed: 0.001, reqs: 5400, achieved: 90 },
    peak: { p50: 300, p95: 4200, p99: 9000, failed: 0.04, reqs: 14400, achieved: 120 },
  });
  const rows = perStep(m, plan, { durationMs: 300000 });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.requested_rps), [60, 90, 120, 120]);
  assert.deepEqual(rows.map((r) => r.partial), [false, false, false, false]);
  assert.equal(rows[3].p95, 4200);
  // Achieved is requests over THIS step's window. k6's own `rate` on a tagged sub-metric divides by the
  // whole test duration, which reports 1.7 req/s for a step that delivered 7.5 — measured, not supposed.
  assert.equal(rows[0].achieved_rps, 30, '1800 requests over 60 s');
  assert.equal(rows[3].achieved_rps, 120, '14400 requests over the 120 s hold');
  assert.equal(rows[0].sustained, false, 'a climbing step swept 30 → 60');
  assert.equal(rows[3].sustained, true, 'only the hold sustained its rate');
});

test('a run stopped by the brake marks the step it died in partial, and only that one', () => {
  // A partial step is not a measurement of its rate: it is a fraction of one, usually the worst fraction,
  // since the brake fires when latency is already climbing.
  const plan = stepPlan(RAMP);
  const m = metricsFor({
    s1: { p50: 80, p95: 200, p99: 300, failed: 0, reqs: 1800, achieved: 30 },
    s2: { p50: 400, p95: 5200, p99: 9000, failed: 0.2, reqs: 900, achieved: 45 },
  });
  const rows = perStep(m, plan, { durationMs: 75000 });
  assert.equal(rows.length, 2, 'steps that never ran are absent, not zeroed');
  assert.deepEqual(rows.map((r) => r.partial), [false, true]);
  assert.match(rows[1].note, /partial/i);
  // The achieved rate of a partial step is over the part that ran, not over the window it never filled:
  // 900 requests in the 15 s it lasted is 60 req/s, not the 12 req/s a 75 s divisor would report.
  assert.equal(rows[1].achieved_rps, 60);
});

test('a step with no requests at all is dropped rather than reported as perfect', () => {
  const plan = stepPlan(RAMP);
  const m = metricsFor({
    s1: { p50: 80, p95: 200, p99: 300, failed: 0, reqs: 1800, achieved: 30 },
    s2: { p50: 0, p95: 0, p99: 0, failed: 0, reqs: 0, achieved: 0 },
  });
  const rows = perStep(m, plan, { durationMs: 300000 });
  assert.deepEqual(rows.map((r) => r.step), ['s1']);
});

test('no plan means no per-step block, never an empty one that reads as "no steps crossed"', () => {
  assert.equal(perStep({}, null, { durationMs: 1000 }), null);
  assert.equal(perStep({}, [], { durationMs: 1000 }), null);
});

test('the per-class numbers of a step are carried when they were tagged', () => {
  const plan = stepPlan(RAMP);
  const m = metricsFor({ s1: { p50: 80, p95: 200, p99: 300, failed: 0, reqs: 1800, achieved: 30 } });
  m['http_req_duration{step:s1,class:html}'] = trend({ med: 90, 'p(95)': 260, 'p(99)': 400, max: 500 });
  m['http_req_failed{step:s1,class:html}'] = rate(0.01, 0, 0);
  const rows = perStep(m, plan, { durationMs: 300000, classNames: ['html', 'rsc_page'] });
  assert.equal(rows[0].per_class.html.p95, 260);
  assert.equal(rows[0].per_class.html.failed_rate, 0.01);
  // rsc_page emitted nothing in that step: absent, not zero. A zero here would read as a class that was
  // fast, when it is a class that never ran.
  assert.equal(rows[0].per_class.rsc_page, undefined);
});
