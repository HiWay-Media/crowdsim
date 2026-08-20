/*
 * Unit tests for the run verdict.
 *
 * These feed buildSummary() the metric trees you hope never to see for real: dropped iterations, a
 * target that never answered, a cache layer that never spoke, classes that emitted nothing. Every one of
 * those, misread, produces a plausible capacity number that is wrong — which is worse than a crash.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  metricValue, cacheRate, brakeTripped, generatorHeldRate, targetUnreachable,
  buildSummary, renderSummaryText,
} from '../../k6/lib/summary.js';

const CTX = {
  runId: '20260805T101112Z',
  profileName: 'example',
  shape: 'mix',
  baseUrl: 'https://www.example.test',
  rscMode: 'repeat',
  peakRps: 100,
  guillotineMs: 7000,
  classNames: ['rsc_page', 'html'],
  cacheLabels: ['proxy', 'cdn'],
  shares: { rsc_page: 0.65, html: 0.35 },
};

const trend = (v) => ({ values: v });
const rate = (r, passes, fails) => ({ values: { rate: r, passes, fails } });
const count = (c, r) => ({ values: { count: c, rate: r } });

/** A run that completed cleanly. */
function healthy(extra) {
  return Object.assign({
    http_reqs: count(30000, 98.4),
    http_req_failed: rate(0.001, 30, 29970),
    http_req_duration: trend({ med: 120, 'p(95)': 800, 'p(99)': 1500, max: 4200 }),
    cs_over_guillotine: rate(0.002, 60, 29940),
    dropped_iterations: count(0),
    cs_504: count(0), cs_502: count(0), cs_5xx: count(0), cs_404: count(0),
    'http_reqs{class:rsc_page}': count(19500),
    'http_reqs{class:html}': count(10500),
    'http_req_duration{class:rsc_page}': trend({ med: 140, 'p(95)': 900, 'p(99)': 1600 }),
    'http_req_duration{class:html}': trend({ med: 90, 'p(95)': 500, 'p(99)': 800 }),
    'http_req_failed{class:rsc_page}': rate(0.001, 20, 19480),
    'http_req_failed{class:html}': rate(0, 0, 10500),
    'cs_over_guillotine{class:rsc_page}': rate(0.003, 58, 19442),
    'cs_over_guillotine{class:html}': rate(0, 0, 10500),
    'cache_hit_proxy': rate(0.82, 24600, 5400),
    'cache_hit_proxy{class:rsc_page}': rate(0.9, 17550, 1950),
    'cache_hit_proxy{class:html}': rate(0.67, 7035, 3465),
  }, extra || {});
}

test('a clean run: not aborted, generator held the rate, target was reached', () => {
  const out = buildSummary(healthy(), CTX);
  assert.equal(out.aborted, false);
  assert.equal(out.generator_ok, true);
  assert.equal(out.target_unreachable, false);
  assert.equal(out.requests, 30000);
  assert.equal(out.run_id, CTX.runId);
  assert.equal(out.guillotine_ms, 7000);
  assert.deepEqual(out.mix_target, { rsc_page: 65, html: 35 });
  assert.equal(out.per_class.rsc_page.rps_target, 65);
  assert.equal(out.per_class.rsc_page.p95, 900);
});

test('the decorative >=0 thresholds must never be read as "the brake tripped"', () => {
  // Per-class sub-metrics only appear in the summary if a threshold names them, so the breakdown is
  // bought with thresholds that cannot fail. Counting those would mark every single run as aborted.
  const m = healthy();
  m['http_req_duration{class:html}'].thresholds = { 'p(95)>=0': { ok: false } };
  assert.equal(brakeTripped(m), false);
  assert.equal(buildSummary(m, CTX).aborted, false);
});

test('a real failed threshold is the knee: aborted, and that is an outcome not an error', () => {
  const m = healthy();
  m['http_req_duration{class:rsc_page}'].thresholds = { 'p(95)<5000': { ok: false } };
  assert.equal(buildSummary(m, CTX).aborted, true);
  m['http_req_duration{class:rsc_page}'].thresholds = { 'p(95)<5000': { ok: true } };
  assert.equal(buildSummary(m, CTX).aborted, false);
});

test('generator_ok goes false past 2% dropped iterations — such a run means nothing', () => {
  assert.equal(generatorHeldRate(0, 1000), true);
  assert.equal(generatorHeldRate(20, 1000), true, '2% exactly is still acceptable');
  assert.equal(generatorHeldRate(21, 1000), false);
  assert.equal(generatorHeldRate(1, 0), false, 'dropping with no requests at all cannot be ok');
  const out = buildSummary(healthy({ dropped_iterations: count(4000) }), CTX);
  assert.equal(out.generator_ok, false);
  assert.match(renderSummaryText(out, CTX), /RESULT INVALID/);
});

test('near-total failure at near-zero latency is an unreachable target, not a knee', () => {
  assert.equal(targetUnreachable(1, 3), true);
  assert.equal(targetUnreachable(0.95, null), true);
  assert.equal(targetUnreachable(0.95, 4800), false, 'slow and failing IS a knee');
  assert.equal(targetUnreachable(0.5, 10), false, 'half failing fast is not "never answered"');
  const out = buildSummary(healthy({
    http_req_failed: rate(1, 30000, 0),
    http_req_duration: trend({ med: 2, 'p(95)': 4, 'p(99)': 6, max: 40 }),
  }), CTX);
  assert.equal(out.target_unreachable, true);
  const txt = renderSummaryText(out, CTX);
  assert.match(txt, /TARGET NEVER ANSWERED/);
  assert.doesNotMatch(txt, /ABORTED by the brake/, 'it must not be presented as a capacity result');
});

test('a cache layer that never appeared is n/a, not 0%', () => {
  const out = buildSummary(healthy(), CTX);
  assert.equal(out.cache.proxy, 0.82);
  assert.equal(out.cache.cdn, null, 'no X-Cache in any response: unknown, not "missed everything"');
  assert.equal(out.per_class.html.cache.cdn, null);
  assert.match(renderSummaryText(out, CTX), /cdn n\/a/);
});

test('a layer that answered and always missed is 0%, and says so', () => {
  const out = buildSummary(healthy({ cache_hit_cdn: rate(0, 0, 30000) }), CTX);
  assert.equal(out.cache.cdn, 0);
  assert.match(renderSummaryText(out, CTX), /cdn 0\.00%/);
});

test('when no declared header was ever seen, the summary says why', () => {
  const m = healthy();
  delete m.cache_hit_proxy;
  delete m['cache_hit_proxy{class:rsc_page}'];
  delete m['cache_hit_proxy{class:html}'];
  const out = buildSummary(m, CTX);
  assert.match(renderSummaryText(out, CTX), /no declared cache header was ever seen/);
});

test('absent counters are 0 (a result), absent trends are null (unknown)', () => {
  const out = buildSummary({}, CTX);
  assert.equal(out.requests, 0);
  assert.equal(out.e504, 0);
  assert.equal(out.dropped_iterations, 0);
  assert.equal(out.dur.p95, null);
  assert.equal(metricValue({}, 'nope', 'count', 0), 0);
  assert.equal(metricValue({}, 'nope', 'p(95)'), null);
  assert.equal(cacheRate({}, 'cache_hit_x'), null);
});

test('classes that emitted nothing are left out of the table, not printed as zeroes', () => {
  const m = healthy();
  m['http_reqs{class:html}'] = count(0);
  const out = buildSummary(m, CTX);
  const txt = renderSummaryText(out, CTX);
  assert.match(txt, /rsc_page/);
  assert.doesNotMatch(txt.split('── per class ──')[1], /html/);
});

test('journey shape reports request counts instead of a per-class target rate', () => {
  const ctx = Object.assign({}, CTX, { shape: 'journey', classNames: ['journey'] });
  const out = buildSummary(healthy({ 'http_reqs{class:journey}': count(1234) }), ctx);
  assert.equal(out.per_class.journey.rps_target, null);
  assert.match(renderSummaryText(out, ctx), /1234 req/);
});

// ── who tripped the brake ───────────────────────────────────────────────────────────────────────────
// The panel is what people read; the summary file is what they read later, if at all. A run that aborted
// without saying which class crossed which threshold sends everybody to the k6 log to find out, and with
// per-class SLOs in the profile "the brake tripped" is no longer enough information to act on.

test('an aborted run names the class and the threshold that stopped it, in the panel', () => {
  const m = healthy({
    'http_req_duration{class:rsc_page}': {
      values: { med: 300, 'p(95)': 465, 'p(99)': 484, max: 500 },
      thresholds: { 'p(95)<300': { ok: false }, 'p(95)>=0': { ok: true } },
    },
  });
  const out = buildSummary(m, CTX);
  assert.equal(out.aborted, true);
  assert.deepEqual(out.aborted_by,
    { metric: 'http_req_duration', class: 'rsc_page', threshold: 'p(95)<300', value: 465 });
  const txt = renderSummaryText(out, CTX);
  assert.match(txt, /ABORTED by the brake/);
  assert.match(txt, /rsc_page/, 'the panel does not say which class tripped it');
  assert.match(txt, /p\(95\)<300/, 'the panel does not say which threshold was crossed');
});

test('a run stopped by the overall threshold does not invent a class', () => {
  const m = healthy({
    http_req_failed: {
      values: { rate: 0.12, passes: 3600, fails: 26400 },
      thresholds: { 'rate<0.05': { ok: false } },
    },
  });
  const out = buildSummary(m, CTX);
  assert.equal(out.aborted, true);
  assert.equal(out.aborted_by.class, null);
  const txt = renderSummaryText(out, CTX);
  assert.match(txt, /rate<0\.05/);
  assert.doesNotMatch(txt, /class null|class undefined/);
});

test('a decorative >=0 threshold is never reported as the cause', () => {
  // Those thresholds exist only to make the per-class sub-metrics appear in the summary. Reporting one as
  // the brake would mark every healthy run as aborted.
  const m = healthy({
    'http_req_duration{class:html}': {
      values: { med: 120, 'p(95)': 800, 'p(99)': 1500, max: 4200 },
      thresholds: { 'p(95)>=0': { ok: false } },
    },
  });
  const out = buildSummary(m, CTX);
  assert.equal(out.aborted_by, null);
  assert.match(renderSummaryText(out, CTX), /completed without crossing/);
});
