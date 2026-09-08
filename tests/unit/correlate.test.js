/*
 * Server-side series, aligned to the run's own steps — and never promoted to a cause.
 *
 * Every number crowdsim produces is measured from outside: latency, failed rate, cache hit ratio, the
 * knee. That is the right place to measure what users experience and the wrong place to answer the
 * question that follows immediately — *why*. A run ends with a defensible knee and cannot tell a
 * saturated app tier from a CPU quota being throttled, and those have different fixes: one is a rewrite,
 * the other is one line of configuration.
 *
 * So a series can be HANDED to a run (never fetched — see INTENT.md), and this file lines it up with the
 * steps. What it must never do is say the series explains the latency. A counter that rose during the
 * same minutes is a correlation, and this project's whole discipline is not promoting those.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { correlate, runStartMs } from '../../k6/lib/correlate.js';

// A run that started at 10:00:00Z with three 60s steps.
const RUN_ID = '20260908T100000Z';
const T0 = Date.UTC(2026, 8, 8, 10, 0, 0);
const STEPS = [
  { step: 's1', requested_rps: 20, start_ms: 0, end_ms: 60000, p95: 120, partial: false },
  { step: 's2', requested_rps: 40, start_ms: 60000, end_ms: 120000, p95: 180, partial: false },
  { step: 's3', requested_rps: 60, start_ms: 120000, end_ms: 180000, p95: 900, partial: false },
];
// A counter that only moves in the last step — the shape of a quota being hit.
const SERIES = [
  { t: T0 + 10000, v: 0 }, { t: T0 + 40000, v: 0 },
  { t: T0 + 70000, v: 0 }, { t: T0 + 100000, v: 2 },
  { t: T0 + 130000, v: 40 }, { t: T0 + 160000, v: 95 },
];

test('a run id is the run\'s start, which is what makes an external series alignable', () => {
  assert.equal(runStartMs(RUN_ID), T0);
  assert.equal(runStartMs('nonsense'), null);
  assert.equal(runStartMs(undefined), null);
});

test('each step gets the samples that fall inside its own window', () => {
  const c = correlate(STEPS, SERIES, { runId: RUN_ID, label: 'cpu_throttled_periods' });
  assert.equal(c.label, 'cpu_throttled_periods');
  assert.equal(c.steps.length, 3);
  assert.deepEqual(c.steps.map((s) => s.samples), [2, 2, 2]);
  assert.deepEqual(c.steps.map((s) => s.max), [0, 2, 95]);
  assert.deepEqual(c.steps.map((s) => s.step), ['s1', 's2', 's3']);
});

test('a step with no samples is absent, not zero', () => {
  // Zero is a measurement. "Nobody recorded anything in this window" is not the same statement, and a
  // chart that plots one as the other is exactly the failure this project keeps refusing.
  const sparse = [{ t: T0 + 130000, v: 40 }];
  const c = correlate(STEPS, sparse, { runId: RUN_ID, label: 'x' });
  assert.equal(c.steps.length, 1);
  assert.equal(c.steps[0].step, 's3');
});

test('the output says it is a correlation, in those words, and does not claim a cause', () => {
  const c = correlate(STEPS, SERIES, { runId: RUN_ID, label: 'cpu_throttled_periods' });
  assert.match(c.caveat, /correlation/i);
  assert.match(c.caveat, /not a cause/i);
  for (const forbidden of [/\bcaused\b/i, /\bbecause\b/i, /explains/i, /due to/i]) {
    assert.doesNotMatch(c.caveat, forbidden);
  }
});

test('a series that never overlaps the run is refused, not silently empty', () => {
  const elsewhere = [{ t: T0 - 7200000, v: 5 }, { t: T0 + 7200000, v: 9 }];
  const c = correlate(STEPS, elsewhere, { runId: RUN_ID, label: 'x' });
  assert.equal(c.refused, true);
  assert.match(c.reason, /outside this run/);
  assert.equal(c.steps, undefined);
});

test('a run with no per-step numbers has no windows to align to', () => {
  for (const steps of [null, [], undefined]) {
    const c = correlate(steps, SERIES, { runId: RUN_ID, label: 'x' });
    assert.equal(c.refused, true);
    assert.match(c.reason, /per-step/);
  }
});

test('a run id that is not a timestamp cannot anchor a series', () => {
  const c = correlate(STEPS, SERIES, { runId: 'not-a-run', label: 'x' });
  assert.equal(c.refused, true);
  assert.match(c.reason, /run id/);
});

test('an empty or unusable series is refused rather than reported as flat', () => {
  for (const series of [null, [], [{ t: 'x', v: 'y' }]]) {
    const c = correlate(STEPS, series, { runId: RUN_ID, label: 'x' });
    assert.equal(c.refused, true);
  }
});

test('a partial step is aligned too, and carries its own warning forward', () => {
  // The brake fires inside a step, and that is precisely the window somebody wants to look at.
  const withPartial = STEPS.concat([
    { step: 's4', requested_rps: 80, start_ms: 180000, end_ms: 210000, p95: 4000, partial: true },
  ]);
  const series = SERIES.concat([{ t: T0 + 190000, v: 300 }]);
  const c = correlate(withPartial, series, { runId: RUN_ID, label: 'x' });
  const last = c.steps[c.steps.length - 1];
  assert.equal(last.step, 's4');
  assert.equal(last.partial, true);
});

test('the label is required: a series with no name is a column of numbers', () => {
  const c = correlate(STEPS, SERIES, { runId: RUN_ID });
  assert.equal(c.refused, true);
  assert.match(c.reason, /label|name/);
});
