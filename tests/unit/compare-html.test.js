/*
 * The delta, drawn.
 *
 * This tool measures deltas honestly and absolutes optimistically — it says so in its own source — and
 * the delta is the thing worth quoting. `compare` produced it as text or JSON and nothing drew it, while
 * `report --html` refused to draw two runs: *"--html reports one run. A delta between two runs is
 * `crowdsim compare`"*. That refusal is right for the reason it gives — two runs on one pair of axes
 * without compare's refusals is a picture of two different experiments — and it is not an argument
 * against drawing them WITH those refusals.
 *
 * So this file consumes exactly what `compare --json` prints. The refusals come from `compare` itself:
 * one of them changing cannot leave the picture behind, because there is no second implementation here to
 * leave behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompare } from '../../lib/compare-html.mjs';

const metric = (o) => Object.assign(
  { label: 'p95', unit: 'ms', a: 200, b: 320, change: 120, relative: 0.6, verdict: 'worse' }, o);

const cmp = (o) => Object.assign({
  a: { run_id: '20260901T100000Z', profile: 'site', base_url: 'https://a.test', shape: 'mix',
       peak: 40, aborted: false, generator_ok: true, requests: 12000 },
  b: { run_id: '20260902T100000Z', profile: 'site', base_url: 'https://a.test', shape: 'mix',
       peak: 40, aborted: false, generator_ok: true, requests: 12000 },
  refused: [],
  warnings: [],
  notes: [],
  overall: [metric()],
  per_class: [],
  layers: [],
}, o);

test('both runs are named, and which is the baseline', () => {
  const html = buildCompare(cmp(), {});
  assert.match(html, /20260901T100000Z/);
  assert.match(html, /20260902T100000Z/);
  assert.match(html, /baseline/i);
});

test('the delta is drawn as a delta, not as two absolute bars to subtract by eye', () => {
  const html = buildCompare(cmp({ overall: [metric({ label: 'p95', relative: 0.6 })] }), {});
  assert.match(html, /<svg/);
  // the bar is the CHANGE: a chart of two absolutes would leave the reader doing the arithmetic that is
  // the only honest number here
  assert.match(html, /class="delta/);
  assert.match(html, /60(\.0)?%/, 'the relative change is what is drawn');
});

test('a refusal from compare stops the drawing, and says which refusal', () => {
  const html = buildCompare(cmp({
    refused: [['different pool names: [\'pages\'] vs [\'pages\', \'api\']', []]],
    overall: [],
  }), {});
  assert.match(html, /not comparable/i);
  assert.match(html, /different pool names/);
  assert.doesNotMatch(html, /<svg/, 'nothing is drawn when compare refused');
});

test('a refusal expressed as an object is handled too: the shape comes from compare, not from here', () => {
  const html = buildCompare(cmp({ refused: [{ why: 'generator_ok: false', fix: ['repeat it'] }] }), {});
  assert.match(html, /not comparable/i);
  assert.match(html, /generator_ok/);
  assert.doesNotMatch(html, /<svg/);
});

test('warnings are shown without stopping the drawing: they are not refusals', () => {
  const html = buildCompare(cmp({ warnings: ['one of the runs has no resolved profile archived'] }), {});
  assert.match(html, /no resolved profile archived/);
  assert.match(html, /<svg/);
});

test('a metric with no relative change is drawn as unchanged, not as zero-width nothing', () => {
  const html = buildCompare(cmp({
    overall: [metric({ label: 'p50', a: 110, b: 110, change: 0, relative: null, verdict: 'same' })],
  }), {});
  assert.match(html, /p50/);
  assert.match(html, /same|unchanged/i);
});

test('better and worse are told apart, and not only by colour', () => {
  const html = buildCompare(cmp({
    overall: [
      metric({ label: 'p95', relative: -0.4, verdict: 'better' }),
      metric({ label: 'failed rate', unit: 'ratio', a: 0.01, b: 0.05, relative: 4, verdict: 'worse' }),
    ],
  }), {});
  assert.match(html, /better/);
  assert.match(html, /worse/);
  // a reader who cannot see colour still gets the direction from the text
  assert.match(html, /class="delta (better|worse)"/);
});

test('the caveats that travel with a delta are on the page', () => {
  const html = buildCompare(cmp(), {});
  assert.match(html, /same pool/i);
  assert.match(html, /colder than real traffic|synthetic/i);
});

test('the page fetches nothing and runs no script', () => {
  const html = buildCompare(cmp(), {});
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<!doctype html>/i);
});

test('nothing to compare at all is a page that says so', () => {
  const html = buildCompare(null, {});
  assert.match(html, /nothing to compare/i);
  assert.doesNotMatch(html, /<svg/);
});
