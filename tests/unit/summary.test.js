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

// ── the ramp, step by step (#50) ────────────────────────────────────────────────────────────────────
// The aggregate p95 belongs to no rate the system was held at. These assert that the per-step table reaches
// the summary and the panel, and — the part that matters — that adding it changed no existing number.

const RAMP_CTX = Object.assign({}, CTX, {
  ramp: { steps: 3, startRps: 30, peakRps: 100, stepDur: '60s', holdDur: '120s' },
  durationMs: 300000,
});

function withSteps(extra) {
  return healthy(Object.assign({
    'http_reqs{step:s1}': count(1800, 30),
    'http_req_duration{step:s1}': trend({ med: 80, 'p(95)': 200, 'p(99)': 300, max: 400 }),
    'http_req_failed{step:s1}': rate(0, 1800, 0),
    'cs_over_guillotine{step:s1}': rate(0, 1800, 0),
    'http_reqs{step:peak}': count(12000, 100),
    'http_req_duration{step:peak}': trend({ med: 300, 'p(95)': 4200, 'p(99)': 9000, max: 12000 }),
    'http_req_failed{step:peak}': rate(0.04, 480, 11520),
    'cs_over_guillotine{step:peak}': rate(0.12, 1440, 10560),
  }, extra || {}));
}

test('the summary carries the ramp step by step, and the panel prints it as a table', () => {
  const out = buildSummary(withSteps(), RAMP_CTX);
  assert.equal(out.per_step.length, 2, 'only the steps that sent anything');
  assert.equal(out.per_step[0].step, 's1');
  assert.equal(out.per_step[1].step, 'peak');
  assert.equal(out.per_step[1].p95, 4200);
  const txt = renderSummaryText(out, RAMP_CTX);
  assert.match(txt, /per step/i);
  assert.match(txt, /4200 ms|4200/, 'the peak step is not in the table');
  // The requested rate has to be there: a table of latencies without the rates they belong to is the
  // aggregate again, in more rows. And a climbing step has to show the range it swept, since it never held
  // a single rate — only the hold did.
  assert.match(txt, /\b100\b/);
  assert.match(txt, /30→53/, 'the first step swept 30 → 53 and the table claims one rate');
  assert.match(txt, /held/, 'nothing marks the hold as the only sustained rate');
});

test('a run with no ramp context reports no steps, and every other number is untouched', () => {
  // Older callers, and the journey shape, may not supply a ramp. The summary must not sprout an empty table.
  const plain = buildSummary(healthy(), CTX);
  const stepped = buildSummary(withSteps(), RAMP_CTX);
  assert.equal(plain.per_step, null);
  for (const k of ['requests', 'failed_rate', 'dur', 'over_guillotine_rate', 'aborted', 'generator_ok']) {
    assert.deepEqual(stepped[k], plain[k], `${k} changed when the per-step block was added`);
  }
  assert.doesNotMatch(renderSummaryText(plain, CTX), /per step/i);
});

test('a step the run died inside is printed as partial, not as that rate\'s result', () => {
  const out = buildSummary(withSteps(), Object.assign({}, RAMP_CTX, { durationMs: 75000 }));
  const last = out.per_step[out.per_step.length - 1];
  assert.equal(last.partial, true);
  assert.match(renderSummaryText(out, RAMP_CTX), /partial/i);
});

// ── the knee, named (#51) ───────────────────────────────────────────────────────────────────────────

test('the summary names the knee, and the panel states it as one sentence', () => {
  const ctx = Object.assign({}, RAMP_CTX, {
    slo: { max_p95_ms: 1000, max_failed_rate: 0.05 }, abortDelay: '30s',
  });
  const out = buildSummary(withSteps(), ctx);
  assert.equal(out.knee.refused, undefined, JSON.stringify(out.knee));
  assert.equal(out.knee.clean.step, 's1');
  assert.equal(out.knee.crossed.step, 'peak');
  const txt = renderSummaryText(out, ctx);
  assert.match(txt, /knee/i);
  assert.match(txt, /crossed at 100/);
});

test('a run whose steps cannot support a knee prints the refusal, not a number', () => {
  // The whole point of #51: the refusal has to be as visible as the claim would have been, or somebody
  // reads the absence of a knee as "no knee found" and quotes the peak.
  const ctx = Object.assign({}, RAMP_CTX, {
    slo: { max_p95_ms: 1000 }, abortDelay: '30s',
    ramp: { steps: 3, startRps: 30, peakRps: 100, stepDur: '10s', holdDur: '20s' },
  });
  const out = buildSummary(withSteps(), ctx);
  assert.equal(out.knee.refused, true);
  const txt = renderSummaryText(out, ctx);
  assert.match(txt, /--abort-delay/, 'the panel hides the reason a knee was refused');
});

test('a run with no ramp has no knee field to misread', () => {
  const out = buildSummary(healthy(), CTX);
  assert.equal(out.knee, null);
  assert.doesNotMatch(renderSummaryText(out, CTX), /knee/i);
});

// ── the thresholds travel with the numbers (report --html) ───────────────────────────────────────────

test('the summary records the limits the run was judged against', () => {
  const out = buildSummary(healthy(), Object.assign({}, CTX, {
    slo: { max_p95_ms: 700, max_failed_rate: 0.05 },
    classSlo: { rsc_page: { maxP95: 300 } },
  }));
  assert.equal(out.slo.max_p95_ms, 700);
  assert.equal(out.slo.max_failed_rate, 0.05);
  assert.equal(out.slo.guillotine_ms, out.guillotine_ms);
  assert.deepEqual(out.slo.per_class, { rsc_page: { maxP95: 300 } });
});

test('a caller that declares no SLO gets nulls, not zeroes: a limit of 0 would be a limit', () => {
  const out = buildSummary(healthy(), Object.assign({}, CTX, { slo: undefined, classSlo: undefined }));
  assert.equal(out.slo.max_p95_ms, null);
  assert.equal(out.slo.max_failed_rate, null);
  assert.deepEqual(out.slo.per_class, {});
});

test('the accounts a run signed in with travel in the summary, and null when it did not', () => {
  const withAuth = buildSummary(healthy(), Object.assign({}, CTX, {
    auth: { users: 50, vus: 400, sharing_note: '50 accounts for 400 virtual users' },
  }));
  assert.equal(withAuth.auth.users, 50);
  assert.equal(withAuth.auth.vus, 400);
  assert.match(withAuth.auth.sharing_note, /50 accounts/);
  // an anonymous run says nothing rather than reporting zero accounts, which would read as a failed login
  assert.equal(buildSummary(healthy(), CTX).auth, null);
});

// ── concurrent users: the unit a requirement is written in (#62) ─────────────────────────────────────

const journeyMetrics = (extra) => Object.assign(healthy(), {
  iterations: count(9000, 100),                       // 100 sessions/s
  iteration_duration: trend({ avg: 30000, med: 29000 }),   // 30 s per session
  vus: { values: { value: 2900, min: 10, max: 2900 } },
}, extra || {});

test('a journey run converts its rate into concurrent users, both ways, and never merges them', () => {
  const out = buildSummary(journeyMetrics(), Object.assign({}, CTX, {
    shape: 'journey', thinkTime: { source: 'default', min_ms: 1000, max_ms: 5000, mean_ms: 3000, samples: [] },
    // The rate the run DROVE, not the completed-iteration rate: see k6/lib/session.js.
    sessionRate: 100, vuCeiling: 6000,
  }));
  assert.equal(out.concurrency.derived, 3000, '100 sessions/s x 30 s');
  assert.equal(out.concurrency.observed, 2900, 'sessions in flight');
  assert.equal(out.concurrency.agree, true);
  assert.match(out.concurrency.caveat, /conversion of a rate/);
  assert.equal(out.think_time.source, 'default');
});

test('the mix shape reports no concurrency at all rather than a guess', () => {
  // No session means no session duration: rate/duration arithmetic over a class mix would be a number
  // with nothing behind it.
  const out = buildSummary(journeyMetrics(), Object.assign({}, CTX, { shape: 'mix' }));
  assert.equal(out.concurrency, null);
  assert.equal(out.think_time, null);
});

test('sessions in flight against the ceiling we provisioned is not reported as capacity', () => {
  const out = buildSummary(journeyMetrics({ vus: { values: { value: 1000, min: 10, max: 1000 } } }),
    Object.assign({}, CTX, { shape: 'journey', sessionRate: 100, vuCeiling: 1000 }));
  assert.equal(out.concurrency.vu_bound, true);
  assert.match(out.concurrency.note, /provisioning and not a measurement/);
});

test('the panel prints both concurrency numbers and why they can be trusted', () => {
  const ctx = Object.assign({}, CTX, { shape: 'journey', sessionRate: 100, vuCeiling: 6000,
    thinkTime: { source: 'declared', min_ms: 2000, max_ms: 6000, mean_ms: 4000, samples: [] } });
  const out = buildSummary(journeyMetrics(), ctx);
  const text = renderSummaryText(out, ctx);
  assert.match(text, /── concurrent users ──/);
  assert.match(text, /derived\s+3000/);
  assert.match(text, /in flight\s+2900/);
  assert.match(text, /Little's law/);
  assert.match(text, /the two methods agree/);
});

test('the panel says nothing about concurrency for a mix run', () => {
  const ctx = Object.assign({}, CTX, { shape: 'mix' });
  const text = renderSummaryText(buildSummary(healthy(), ctx), ctx);
  assert.ok(!text.includes('concurrent users'));
});
