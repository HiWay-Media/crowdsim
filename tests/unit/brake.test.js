/*
 * The brake, per class. (#43)
 *
 * There was one p95 and one brake_class, so a server-rendered document and a static asset were held to the
 * same threshold — too strict for the assets or too lax for the renderer, and in practice the second: the
 * class that actually falls over has its numbers diluted by everything cheap.
 *
 * The rule this file pins down: a per-class threshold may make the brake SHARPER, never later.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classSlo, brakeThresholds, abortedBy } from '../../k6/lib/brake.js';

const SLO = { max_p95_ms: 5000, max_failed_rate: 0.05, brake_class: 'html' };

test('a class without its own SLO inherits the profile\'s', () => {
  assert.deepEqual(classSlo({ name: 'static' }, SLO), { maxP95: 5000, maxFailed: 0.05, own: false });
});

test('a class with its own SLO uses it', () => {
  const cls = { name: 'html', max_p95_ms: 800, max_failed_rate: 0.01 };
  assert.deepEqual(classSlo(cls, SLO), { maxP95: 800, maxFailed: 0.01, own: true });
});

test('one of the two can be declared without the other', () => {
  assert.deepEqual(classSlo({ name: 'html', max_p95_ms: 800 }, SLO),
    { maxP95: 800, maxFailed: 0.05, own: true });
  assert.deepEqual(classSlo({ name: 'html', max_failed_rate: 0.2 }, SLO),
    { maxP95: 5000, maxFailed: 0.2, own: true });
});

// ── the thresholds handed to k6 ──────────────────────────────────────────────────────────────────────
test('with no per-class SLO the thresholds are exactly what they were', () => {
  // The regression that matters most: a profile that declares nothing must behave identically.
  const t = brakeThresholds({
    classDefs: [{ name: 'html' }, { name: 'static' }],
    slo: SLO, maxP95: 5000, maxFailed: 0.05, abortDelay: '30s', cacheLabels: ['proxy'], shape: 'mix',
  });
  const aborting = Object.keys(t).filter((k) => (t[k] || []).some((x) => x && x.abortOnFail));
  assert.deepEqual(aborting.sort(), ['http_req_duration{class:html}', 'http_req_failed']);
});

test('a class with its own SLO gets its own aborting threshold', () => {
  const t = brakeThresholds({
    classDefs: [{ name: 'html', max_p95_ms: 800 }, { name: 'static', max_p95_ms: 200 }],
    slo: SLO, maxP95: 5000, maxFailed: 0.05, abortDelay: '30s', cacheLabels: [], shape: 'mix',
  });
  const html = t['http_req_duration{class:html}'].find((x) => x && x.abortOnFail);
  const stat = t['http_req_duration{class:static}'].find((x) => x && x.abortOnFail);
  assert.equal(html.threshold, 'p(95)<800');
  assert.equal(stat.threshold, 'p(95)<200', 'the first class to cross its own threshold stops the run');
});

test('a per-class failed rate aborts too, and the decorative sub-metrics survive', () => {
  const t = brakeThresholds({
    classDefs: [{ name: 'html', max_failed_rate: 0.01 }],
    slo: SLO, maxP95: 5000, maxFailed: 0.05, abortDelay: '30s', cacheLabels: ['proxy'], shape: 'mix',
  });
  const failed = t['http_req_failed{class:html}'].find((x) => x && x.abortOnFail);
  assert.equal(failed.threshold, 'rate<0.01');
  // The `>=0` thresholds exist only to surface per-class sub-metrics; losing them empties the summary.
  assert.ok(t['http_req_failed{class:html}'].includes('rate>=0'));
  assert.ok(t['cache_hit_proxy{class:html}'].includes('rate>=0'));
  assert.ok(t['http_reqs{class:html}'].includes('count>=0'));
});

test('the abort delay is on every aborting threshold, or the brake fires during the ramp', () => {
  const t = brakeThresholds({
    classDefs: [{ name: 'html', max_p95_ms: 800 }],
    slo: SLO, maxP95: 5000, maxFailed: 0.05, abortDelay: '10s', cacheLabels: [], shape: 'mix',
  });
  for (const key of Object.keys(t)) {
    for (const th of t[key]) {
      if (th && th.abortOnFail) assert.equal(th.delayAbortEval, '10s', key);
    }
  }
});

test('a skipped class gets no threshold at all', () => {
  const t = brakeThresholds({
    classDefs: [{ name: 'html', max_p95_ms: 800 }],
    slo: SLO, maxP95: 5000, maxFailed: 0.05, abortDelay: '30s', cacheLabels: [], shape: 'mix',
  });
  assert.equal(t['http_req_duration{class:static}'], undefined,
    'a class dropped for an empty pool or skip_classes must not be mentioned');
});

test('the journey shape keeps its own class', () => {
  const t = brakeThresholds({
    classDefs: [{ name: 'html' }], slo: SLO, maxP95: 5000, maxFailed: 0.05,
    abortDelay: '30s', cacheLabels: [], shape: 'journey',
  });
  assert.ok(t['http_req_duration{class:journey}']);
});

// ── which class stopped the run ──────────────────────────────────────────────────────────────────────
test('the summary can say what stopped the run, not just that it stopped', () => {
  // "aborted: true" sends somebody to read a log. "aborted by rsc_page: p95 1204 ms against 800" does not.
  const metrics = {
    'http_req_duration{class:rsc_page}': {
      values: { 'p(95)': 1204.4 },
      thresholds: { 'p(95)<800': { ok: false } },
    },
    'http_req_duration{class:html}': { values: { 'p(95)': 300 }, thresholds: { 'p(95)<800': { ok: true } } },
  };
  assert.deepEqual(abortedBy(metrics), {
    metric: 'http_req_duration', class: 'rsc_page', threshold: 'p(95)<800', value: 1204.4,
  });
});

test('the overall failed-rate brake is attributed to the run, not to a class', () => {
  const metrics = { http_req_failed: { values: { rate: 0.3 }, thresholds: { 'rate<0.05': { ok: false } } } };
  assert.deepEqual(abortedBy(metrics),
    { metric: 'http_req_failed', class: null, threshold: 'rate<0.05', value: 0.3 });
});

test('a decorative threshold never counts as the cause, and a clean run has no cause', () => {
  assert.equal(abortedBy({ 'http_reqs{class:html}': { thresholds: { 'count>=0': { ok: false } } } }), null);
  assert.equal(abortedBy({}), null);
  assert.equal(abortedBy(null), null);
});

// ── priming, not testing (#44) ───────────────────────────────────────────────────────────────────────
test('a warm-up has no brake: it is priming a cache, not looking for a knee', () => {
  // A warm-up that aborts on the profile's SLO would abort exactly when it is doing its job — the first
  // requests into a cold cache are the slow ones. It still needs the decorative thresholds, or its own log
  // would have no per-class breakdown to read.
  const t = brakeThresholds({
    classDefs: [{ name: 'html', max_p95_ms: 800 }],
    slo: SLO, maxP95: 5000, maxFailed: 0.05, abortDelay: '30s', cacheLabels: ['proxy'], shape: 'mix',
    priming: true,
  });
  for (const key of Object.keys(t)) {
    for (const th of t[key]) {
      assert.ok(!(th && th.abortOnFail), `${key} still aborts during a warm-up`);
    }
  }
  assert.ok(t['http_req_duration{class:html}'].includes('p(95)>=0'));
  assert.ok(t['cache_hit_proxy{class:html}'].includes('rate>=0'));
});

// ── the per-step sub-metrics have to be asked for ───────────────────────────────────────────────────
// k6 only puts a tagged sub-metric in the summary if a threshold mentions it. That is why the per-class
// `p(95)>=0` entries exist, and why the per-step table needs the same trick. The danger is obvious: a
// threshold that can fail would turn the ramp itself into a brake.

test('per-step sub-metrics are surfaced by thresholds that cannot fail or abort', () => {
  const t = brakeThresholds({
    classDefs: [{ name: 'html' }, { name: 'rsc_page' }],
    slo: { max_p95_ms: 2500, max_failed_rate: 0.05 },
    maxP95: 2500, maxFailed: 0.05, abortDelay: '30s', cacheLabels: [], shape: 'mix',
    stepTags: ['s1', 's2', 'peak'],
  });
  for (const tag of ['s1', 's2', 'peak']) {
    for (const m of [`http_req_duration{step:${tag}}`, `http_req_failed{step:${tag}}`,
                     `http_reqs{step:${tag}}`, `cs_over_guillotine{step:${tag}}`]) {
      assert.ok(t[m], `${m} has no threshold, so it will not appear in the summary`);
      for (const entry of t[m]) {
        const th = typeof entry === 'string' ? entry : entry.threshold;
        assert.match(th, />=0/, `${m}: ${th} can fail, and a ramp step is not a brake`);
        if (typeof entry !== 'string') {
          assert.equal(entry.abortOnFail, undefined, `${m} would abort the run`);
        }
      }
    }
  }
  // and per class within a step, for the classes the profile declares
  assert.ok(t['http_req_duration{step:s1,class:html}']);
  assert.ok(t['http_req_failed{step:s1,class:html}']);
});

test('no step tags means no step thresholds: the run is unchanged', () => {
  const base = {
    classDefs: [{ name: 'html' }], slo: {}, maxP95: 2500, maxFailed: 0.05,
    abortDelay: '30s', cacheLabels: [], shape: 'mix',
  };
  const without = brakeThresholds(base);
  const withEmpty = brakeThresholds(Object.assign({}, base, { stepTags: [] }));
  assert.deepEqual(withEmpty, without);
  assert.equal(Object.keys(without).some((k) => k.includes('step:')), false);
});
