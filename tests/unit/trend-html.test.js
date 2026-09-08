/*
 * The knee over time, as a page that can be handed to somebody.
 *
 * `crowdsim history` exists to answer one question — does the knee move — and answered it as a table. The
 * GUI plots it; the CLI had nothing to hand over, and `report --html` draws exactly one run. So the trend,
 * which is the only claim in this tool that survives the caveat about absolutes being optimistic, was the
 * one thing that could not be attached to a ticket.
 *
 * The refusals are the point, as everywhere else here: runs at different profiles, targets, shapes or
 * fan-outs are not points on one line, because they are not the same experiment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparableRuns, trendSeries, buildTrend } from '../../lib/trend-html.mjs';

const run = (o) => Object.assign({
  run_id: '20260901T100000Z', profile: 'site', base_url: 'https://a.test', shape: 'mix',
  peak: 60, aborted: false, generator_ok: true,
  knee_clean: 40, knee_crossed: 60, knee_clean_delivered: 50, knee_crossed_delivered: 75,
  fan_out: 1.25,
}, o);

// ── which runs belong on one line ────────────────────────────────────────────────────────────────────

test('runs at the same profile, target, shape and fan-out are one series', () => {
  const rows = [run({ run_id: '20260901T100000Z' }), run({ run_id: '20260902T100000Z' })];
  const { series, refused } = comparableRuns(rows);
  assert.equal(series.length, 1);
  assert.equal(series[0].runs.length, 2);
  assert.deepEqual(refused, []);
});

test('a different profile is a different experiment, and gets its own series', () => {
  const rows = [run({}), run({ run_id: '20260902T100000Z', profile: 'other' })];
  const { series } = comparableRuns(rows);
  assert.equal(series.length, 2);
  assert.deepEqual(series.map((s) => s.runs.length), [1, 1]);
});

test('a different target or shape splits them too', () => {
  for (const diff of [{ base_url: 'https://b.test' }, { shape: 'journey' }]) {
    const rows = [run({}), run(Object.assign({ run_id: '20260902T100000Z' }, diff))];
    assert.equal(comparableRuns(rows).series.length, 2, JSON.stringify(diff));
  }
});

test('a fan-out that moved is refused within an otherwise matching group', () => {
  // One user request became a different number of HTTP requests, so the mix is not the same — the rule
  // and the tolerance come from k6/lib/delivery.js, not from a second copy here.
  const rows = [run({}), run({ run_id: '20260902T100000Z', fan_out: 1.9 })];
  const { series, refused } = comparableRuns(rows);
  assert.equal(series.length, 1, 'the first run still forms a series');
  assert.equal(refused.length, 1);
  assert.match(refused[0].why, /fan-out/);
  assert.match(refused[0].why, /1\.9/);
});

test('a run with no fan-out is not silently mixed in: it is unknown, and said so', () => {
  const rows = [run({}), run({ run_id: '20260902T100000Z', fan_out: null })];
  const { refused } = comparableRuns(rows);
  assert.equal(refused.length, 1);
  assert.match(refused[0].why, /does not record|cannot be checked/);
});

test('a discard never joins the line', () => {
  const rows = [run({}), run({ run_id: '20260902T100000Z', generator_ok: false })];
  const { series, refused } = comparableRuns(rows);
  assert.equal(series[0].runs.length, 1);
  assert.equal(refused.length, 1);
  assert.match(refused[0].why, /generator/);
});

// ── the points ───────────────────────────────────────────────────────────────────────────────────────

test('a point carries both rates, because a knee is two numbers', () => {
  const pts = trendSeries([run({})]);
  assert.equal(pts[0].clean, 40);
  assert.equal(pts[0].clean_delivered, 50);
  assert.equal(pts[0].crossed, 60);
  assert.equal(pts[0].crossed_delivered, 75);
});

test('a refused knee is a GAP, not a zero', () => {
  // A knee of 0 req/s is a claim about the system. "This run could not support one" is not the same
  // statement, and a line through zero is a line through a claim nobody made.
  const pts = trendSeries([run({ knee_clean: null, knee_crossed: null })]);
  assert.equal(pts[0].clean, null);
  assert.equal(pts[0].crossed, null);
});

test('a run that stayed clean throughout has a clean rate and no crossing', () => {
  const pts = trendSeries([run({ knee_crossed: null, knee_crossed_delivered: null })]);
  assert.equal(pts[0].clean, 40);
  assert.equal(pts[0].crossed, null);
});

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────

test('the page draws one series and names what it is', () => {
  const html = buildTrend([run({}), run({ run_id: '20260902T100000Z', knee_clean: 50 })], {});
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /site/);
  assert.match(html, /a\.test/);
  assert.match(html, /knee/i);
  assert.match(html, /<svg/);
});

test('the page fetches nothing and runs no script', () => {
  const html = buildTrend([run({}), run({ run_id: '20260902T100000Z' })], {});
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\/(?!a\.test)/);
});

test('one run is not a trend, and the page says so instead of drawing a dot', () => {
  const html = buildTrend([run({})], {});
  assert.match(html, /one run is not a trend|at least two/i);
  assert.doesNotMatch(html, /<polyline/);
});

test('the refusals are on the page, with the runs they excluded', () => {
  const html = buildTrend([run({}), run({ run_id: '20260902T100000Z', generator_ok: false })], {});
  assert.match(html, /20260902T100000Z/);
  assert.match(html, /generator/);
});

test('no runs at all is a page that says so, not an empty chart', () => {
  const html = buildTrend([], {});
  assert.match(html, /no runs/i);
  assert.doesNotMatch(html, /<polyline/);
});
