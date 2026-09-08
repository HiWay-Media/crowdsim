/*
 * One run as a page with charts. These tests are about the two ways a chart lies:
 *
 *   · **geometry.** A wrong scale produces a beautiful, confident, wrong picture and never throws. So the
 *     domain, the ticks and the point coordinates are asserted as numbers, not eyeballed once.
 *   · **what gets drawn at all.** A latency curve from a generator-bound run looks exactly like a healthy
 *     system absorbing load; a 0% cache bar looks like a cache that answered and missed. Both are asserted
 *     to be absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport, rampChart, rampDomain, rateChart, classChart, cacheChart, outcomeChart,
  niceCeil, ticks, linear, stepLabel, esc,
} from '../../lib/report-html.mjs';

const step = (o) => Object.assign({
  step: 's1', index: 1, is_hold: false, requested_rps: 10, from_rps: 5, sustained: false,
  achieved_rps: 9.8, requests: 100, p50: 90, p95: 200, p99: 300,
  failed_rate: 0, over_guillotine_rate: 0, partial: false, per_class: {},
}, o);

const RUN = {
  run_id: '20260901T120000Z',
  profile: 'live-event',
  shape: 'mix',
  base_url: 'https://www.example.test',
  peak_rps_user_target: 120,
  aborted: true,
  aborted_by: { metric: 'http_req_duration', class: 'rsc_page', threshold: 'p(95)<700', value: 830.05 },
  requests: 3040,
  rps_avg: 56.2,
  failed_rate: 0,
  dur: { p50: 120, p95: 845, p99: 1048, max: 2000 },
  guillotine_ms: 1000,
  slo: { max_p95_ms: 700, max_failed_rate: 0.5, guillotine_ms: 1000, per_class: { rsc_page: { maxP95: 300 } } },
  over_guillotine_rate: 0.023,
  dropped_iterations: 0,
  e504: 0, e502: 0, e5xx: 0, e404: 0,
  cache: { proxy: 0.81, cdn: null },
  per_class: {
    rsc_page: { p95: 830, p99: 1000, med: 200, failed: 0, over_guillotine: 0.02, reqs: 1800, rps_target: 72 },
    html: { p95: 640, p99: 900, med: 180, failed: 0, over_guillotine: 0, reqs: 1240, rps_target: 48 },
  },
  per_step: [
    step({ step: 's1', requested_rps: 4, from_rps: 2, p95: 251 }),
    step({ step: 's2', requested_rps: 6, from_rps: 4, p95: 241 }),
    step({ step: 's3', requested_rps: 8, from_rps: 6, p95: 240 }),
    step({ step: 's4', requested_rps: 10, from_rps: 8, p95: 1025, partial: true, achieved_rps: 8 }),
  ],
  knee: {
    clean: { step: 's3', requested_rps: 8, from_rps: 6, achieved_rps: 7, p95: 240, sustained: false,
      caveat: 'this rate was swept through on the way up, not sustained' },
    crossed: { step: 's4', requested_rps: 10, p95: 1025, partial: true, class: null,
      why: 'p95 1025 ms crossed the SLO of 700 ms' },
    transient: [],
    summary: 'clean up to 8 req/s (swept, not sustained), crossed at 10 req/s',
  },
  generator_ok: true,
  target_unreachable: false,
  warmup: null,
  is_warmup: false,
};

const clone = () => JSON.parse(JSON.stringify(RUN));

// ── scales ───────────────────────────────────────────────────────────────────────────────────────────

test('an axis ends on a number somebody would say out loud', () => {
  assert.equal(niceCeil(890), 1000);
  assert.equal(niceCeil(251), 300);
  assert.equal(niceCeil(1025), 1500);
  assert.equal(niceCeil(7.2), 7.5);
});

test('a non-positive domain still has height: an axis from 0 to 0 puts every point on the baseline', () => {
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(-5), 1);
  assert.equal(niceCeil(NaN), 1);
});

test('ticks span the domain and carry no floating-point noise', () => {
  assert.deepEqual(ticks(1000, 4), [0, 250, 500, 750, 1000]);
  assert.deepEqual(ticks(0.3, 3), [0, 0.1, 0.2, 0.3]);
});

test('a linear scale maps the ends exactly, and a zero span does not divide by zero', () => {
  const y = linear([0, 100], [248, 24]);
  assert.equal(y(0), 248);
  assert.equal(y(100), 24);
  assert.equal(y(50), 136);
  assert.equal(linear([5, 5], [0, 100])(5), 0);
});

test('a step is labelled with the range it swept, and the hold with the rate it held', () => {
  assert.equal(stepLabel(step({ from_rps: 8, requested_rps: 10 })), '8→10');
  assert.equal(stepLabel(step({ is_hold: true, sustained: true, requested_rps: 10 })), '10 held');
  assert.equal(stepLabel(step({ from_rps: 10, requested_rps: 10 })), '10');
});

// ── the ramp domain: the SLO is in it, the read timeout only when it is close ─────────────────────────

test('the SLO is always inside the domain, so the limit line cannot fall off the top', () => {
  const rows = [step({ p95: 100 }), step({ p95: 120 })];
  const { yMax, hidden } = rampDomain(rows, { maxP95: 700, guillotineMs: 1000 });
  assert.ok(yMax >= 700, `yMax ${yMax}`);
  assert.deepEqual(hidden, [], 'the SLO must never be the hidden one');
});

test('a read timeout ten times the p95 is left off the scale, and reported as left off', () => {
  const rows = [step({ p95: 200 }), step({ p95: 240 })];
  const { yMax, hidden } = rampDomain(rows, { maxP95: 500, guillotineMs: 7000 });
  assert.ok(yMax < 7000, `yMax ${yMax}: the curve would be squashed into the bottom of the picture`);
  assert.deepEqual(hidden, [{ name: 'read timeout', value: 7000 }]);
});

test('a read timeout the run came close to joins the scale', () => {
  const { yMax, hidden } = rampDomain([step({ p95: 900 })], { maxP95: 700, guillotineMs: 1000 });
  assert.ok(yMax >= 1000, `yMax ${yMax}`);
  assert.deepEqual(hidden, []);
});

// ── the ramp chart ───────────────────────────────────────────────────────────────────────────────────

test('the ramp chart plots one point per step, in order, with the crossed one marked', () => {
  const svg = rampChart(RUN.per_step, { maxP95: 700, guillotineMs: 1000, knee: RUN.knee });
  const points = svg.match(/<circle[^>]*/g) || [];
  assert.equal(points.length, 4);
  // x increases monotonically: a chart whose points are in insertion order rather than ramp order would
  // draw a curve that goes backwards.
  const xs = points.map((p) => Number(/cx="([\d.]+)"/.exec(p)[1]));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `x went backwards at ${i}`);
  // a higher p95 is a smaller y: the axis is inverted, and getting that wrong draws the knee upside down
  const ys = points.map((p) => Number(/cy="([\d.]+)"/.exec(p)[1]));
  assert.ok(ys[3] < ys[2], 'the crossing must be drawn ABOVE the clean steps');
  assert.match(points[3], /partial/);
});

test('the knee band spans exactly from the clean step to the crossed one', () => {
  const svg = rampChart(RUN.per_step, { maxP95: 700, knee: RUN.knee });
  const band = /<rect class="knee-band" x="([\d.]+)"[^>]*width="([\d.]+)"/.exec(svg);
  assert.ok(band, 'no knee band drawn');
  const xs = (svg.match(/<circle[^>]*cx="([\d.]+)"/g) || [])
    .map((p) => Number(/cx="([\d.]+)"/.exec(p)[1]));
  assert.equal(Number(band[1]).toFixed(1), xs[2].toFixed(1), 'the band must start at the clean step');
  assert.equal((Number(band[1]) + Number(band[2])).toFixed(1), xs[3].toFixed(1),
    'and end at the crossed step');
});

test('no knee, no band: a refusal draws no shaded region to read a rate off', () => {
  const svg = rampChart(RUN.per_step, { maxP95: 700, knee: { refused: true, reason: 'x', fix: 'y' } });
  assert.ok(!svg.includes('knee-band'));
});

test('a threshold the run never recorded is not drawn at all', () => {
  const svg = rampChart(RUN.per_step, { maxP95: null, guillotineMs: null, knee: null });
  assert.ok(!svg.includes('class="slo"'), 'an SLO line with no SLO behind it moves the knee for the reader');
  assert.ok(!svg.includes('class="guillotine"'));
});

test('the chart describes itself in words, for a screen reader and for when it does not render', () => {
  const svg = rampChart(RUN.per_step, { maxP95: 700, knee: RUN.knee });
  assert.match(svg, /role="img"/);
  const desc = /<desc[^>]*>([^<]*)</.exec(svg);
  assert.ok(desc, 'no <desc>');
  assert.match(desc[1], /8→10 req\/s: p95 1025 ms \(partial step\)/);
});

test('a single step is drawn centred rather than at x=0, and never as a line', () => {
  const svg = rampChart([step({ p95: 200 })], { maxP95: 700 });
  const points = svg.match(/<circle[^>]*/g) || [];
  assert.equal(points.length, 1);
  assert.ok(!svg.includes('class="line"'), 'one point is not a curve');
});

test('a step that emitted no p95 is left out, not drawn at zero', () => {
  const rows = [step({ p95: 200 }), step({ step: 's2', p95: null }), step({ step: 's3', p95: 400 })];
  const svg = rampChart(rows, { maxP95: 700 });
  assert.equal((svg.match(/<circle/g) || []).length, 2);
});

// ── requested against delivered ──────────────────────────────────────────────────────────────────────

test('the rate chart draws both bars per step, and the delivered one is absent when unknown', () => {
  const svg = rateChart([step({ achieved_rps: 9.8 }), step({ step: 's2', achieved_rps: null })]);
  assert.equal((svg.match(/class="bar asked"/g) || []).length, 2 + 1, 'two bars plus the legend swatch');
  assert.equal((svg.match(/class="bar got"/g) || []).length, 1 + 1, 'one bar plus the legend swatch');
});

// ── per class ────────────────────────────────────────────────────────────────────────────────────────

test('each class is drawn against its OWN limit, and marked when it is over it', () => {
  const svg = classChart(RUN.per_class, { maxP95: 700, classSlo: { rsc_page: { maxP95: 300 } } });
  // rsc_page: p95 830 against its own 300 → over; html: 640 against the profile's 700 → not over
  assert.equal((svg.match(/class="hbar over"/g) || []).length, 1);
  assert.match(svg, /300 ms \(own\)/);
  assert.match(svg, /700 ms/);
});

test('a class with no requests is not a bar at zero', () => {
  const svg = classChart({ html: { p95: 100, reqs: 10 }, ghost: { p95: null, reqs: 0 } }, { maxP95: 700 });
  assert.ok(svg.includes('html'));
  assert.ok(!svg.includes('ghost'));
});

// ── the cache ────────────────────────────────────────────────────────────────────────────────────────

test('a layer that never spoke is `unknown`, not a 0% bar', () => {
  const svg = cacheChart({ proxy: 0.81, cdn: null });
  assert.match(svg, /class="unknown"/);
  assert.match(svg, />unknown</);
  // and the one that did speak is a real bar with a real percentage
  assert.match(svg, /81\.00%/);
  assert.equal((svg.match(/class="hbar cache"/g) || []).length, 1);
});

test('a real 0% is a bar and says 0%, because a measured miss is not an absent header', () => {
  const svg = cacheChart({ proxy: 0 });
  assert.match(svg, /0\.00%/);
  assert.ok(!svg.includes('class="unknown"'));
});

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────

test('the page is self-contained: nothing is fetched, no script runs', () => {
  const html = buildReport(RUN);
  assert.ok(!/<script/i.test(html), 'a report should not execute anything');
  assert.ok(!/\ssrc=/i.test(html), 'no external resource');
  assert.ok(!/@import|url\(/i.test(html), 'no imported stylesheet or remote asset');
  assert.ok(!/<link/i.test(html));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>/);
});

test('a valid run gets the curve, the knee, the classes and the cache', () => {
  const html = buildReport(RUN, { generatedBy: 'crowdsim 1.19.0' });
  assert.match(html, /p95 latency per ramp step/);
  assert.match(html, /clean up to 8 req\/s/);
  assert.match(html, /p95 per request class/);
  assert.match(html, /cache hit ratio per declared layer/);
  assert.match(html, /crowdsim 1\.19\.0/);
});

test('an invalid run gets NO latency chart — only the one that shows why it is invalid', () => {
  const p = clone();
  p.generator_ok = false;
  p.dropped_iterations = 812;
  const html = buildReport(p);
  assert.match(html, /DISCARD THIS RUN/);
  assert.ok(!html.includes('p95 latency per ramp step'), 'a curve from a generator-bound run is a lie');
  assert.ok(!html.includes('p95 per request class'));
  assert.match(html, /requested rate against the rate the generator delivered/);
  assert.ok(!html.includes('p95 (whole ramp)'), 'not even as a statistic');
});

test('a knee recorded next to a verdict that voids it is shown as not counting', () => {
  // knee() refuses on an invalid run, but an older summary — or an edited one — can carry both.
  const p = clone();
  p.generator_ok = false;
  const html = buildReport(p);
  assert.match(html, /This run recorded a knee, and it does not count/);
  assert.ok(!html.includes('the knee is in here'));
});

test('an unreachable target gets no latency chart either: a p95 of ~0 is not a fast system', () => {
  const p = clone();
  p.target_unreachable = true;
  p.failed_rate = 1;
  p.dur = { p50: 1, p95: 2, p99: 3, max: 4 };
  const html = buildReport(p);
  assert.match(html, /The target never answered/);
  assert.ok(!html.includes('p95 latency per ramp step'));
  assert.match(html, /Nothing about capacity/);
});

test('a run archived before the summary carried its thresholds says so, instead of drawing a guess', () => {
  const p = clone();
  delete p.slo;
  const html = buildReport(p);
  assert.match(html, /recorded no SLO/);
  assert.ok(!html.includes('class="slo"'));
});

test('a run with no per-step numbers says why there is no curve', () => {
  const p = clone();
  p.per_step = null;
  p.knee = { refused: true, reason: 'this run has no per-step numbers.', fix: 'use --shape mix.' };
  const html = buildReport(p);
  assert.match(html, /no per-step numbers/);
  assert.ok(!html.includes('p95 latency per ramp step'));
});

test('the caveats are on the page, and the missing warm-up is one of them', () => {
  const html = buildReport(RUN);
  assert.match(html, /Only the delta travels/);
  assert.match(html, /not a rate that was sustained/);
  assert.match(html, /No warm-up/);
  const warmed = clone();
  warmed.warmup = '30s at 20 req/s';
  assert.ok(!buildReport(warmed).includes('<strong>No warm-up.</strong>'));
});

test('every chart carries its own numbers as a table', () => {
  const html = buildReport(RUN);
  assert.ok((html.match(/<table>/g) || []).length >= 2);
  assert.match(html, /the same numbers/);
});

test('a value from the summary cannot inject markup into the page', () => {
  const p = clone();
  p.profile = '<img src=x onerror=alert(1)>';
  p.base_url = 'https://example.test/"><script>alert(2)</script>';
  const html = buildReport(p);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.match(html, /&lt;img src=x/);
  assert.equal(esc('<&">'), '&lt;&amp;&quot;&gt;');
});

test('an empty summary produces a page rather than throwing', () => {
  const html = buildReport({});
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Is this run valid/);
});

test('a run that shared its accounts says so among the caveats', () => {
  const p = clone();
  p.auth = { users: 50, vus: 400, sharing_note: '50 accounts for 400 virtual users: each account signs in from about 8 of them at once.' };
  const html = buildReport(p);
  assert.match(html, /The accounts were shared/);
  assert.match(html, /50 accounts for 400 virtual users/);
});

test('enough accounts is also stated, because silence would read as "no login happened"', () => {
  const p = clone();
  p.auth = { users: 400, vus: 400, sharing_note: null };
  const html = buildReport(p);
  assert.match(html, /400 account\(s\) signed in/);
  assert.ok(!html.includes('The accounts were shared'));
});

test('an anonymous run gets no accounts caveat at all', () => {
  const html = buildReport(clone());
  assert.ok(!html.includes('account(s) signed in'));
  assert.ok(!html.includes('The accounts were shared'));
});

// ── concurrent users on the page (#62) ───────────────────────────────────────────────────────────────

test('a journey run shows both concurrency numbers and why they can be trusted', () => {
  const p = clone();
  p.shape = 'journey';
  p.concurrency = { derived: 3000, observed: 2900, sessions_per_sec: 100, mean_session_seconds: 30,
    agree: true, note: null, caveat: 'This is the concurrency this mix implies at the reading pauses this profile declares (2000-6000 ms).' };
  p.think_time = { source: 'declared', min_ms: 2000, max_ms: 6000, mean_ms: 4000, samples: [] };
  const html = buildReport(p);
  assert.match(html, /Concurrent users/);
  assert.match(html, /3000/);
  assert.match(html, /2900/);
  assert.match(html, /The two methods agree/);
  assert.match(html, /reading pauses were declared/);
});

test('a disagreement is a banner, not a footnote, and no average is shown', () => {
  const p = clone();
  p.concurrency = { derived: 3000, observed: 900, sessions_per_sec: 100, mean_session_seconds: 30,
    agree: false, note: 'the two methods disagree by more than 25%', caveat: null };
  const html = buildReport(p);
  assert.match(html, /These two do not agree/);
  assert.ok(!html.includes('1950'));
});

test('a refused concurrency says so instead of showing a number', () => {
  const p = clone();
  p.concurrency = { refused: true, reason: 'the brake stopped this run', fix: 'read the knee instead.' };
  const html = buildReport(p);
  assert.match(html, /No concurrency figure from this run/);
  assert.match(html, /the brake stopped this run/);
  assert.ok(!html.includes('in flight'));
});

test('a mix run has no concurrency section at all', () => {
  assert.ok(!buildReport(clone()).includes('Concurrent users'));
});

test('a run that created accounts says so, and that removing them is not this tool’s job (#65)', () => {
  const p = clone();
  p.signup = { class: 'signup', created: 2970, failed: 12, email_glob: 'load+RUN-*@example.test' };
  const html = buildReport(p);
  assert.match(html, /accounts created/);
  assert.match(html, /2970/);
  assert.match(html, /they still exist/);
  assert.match(html, /will not delete them/);
  assert.match(html, /load\+RUN-\*@example\.test/);
  assert.match(html, /signups-20260901T120000Z\.json/);
});

test('a run that created nothing gets no accounts caveat', () => {
  const html = buildReport(clone());
  assert.ok(!html.includes('accounts created'));
  assert.ok(!html.includes('will not delete them'));
});

// ── the failure mode, and both rates (#74, #71) ──────────────────────────────────────────────────────

test('the page names the failure mode before it names the brake', () => {
  const html = buildReport({
    run_id: '20260908T101500Z', profile: 'p', base_url: 'https://x.test', shape: 'mix',
    peak_rps_user_target: 60, requests: 10000, dropped_iterations: 0,
    generator_ok: true, target_unreachable: false, aborted: true,
    aborted_by: { class: 'html', threshold: 'p(95)<700', value: 768 },
    failed_rate: 0.0631, dur: { p50: 100, p95: 768, p99: 900, max: 1200 },
    failure_mode: {
      code: '404', count: 631, share: 0.0631, classes: ['html'], class_count: 4, concentrated: true,
      line: '6.31% of requests answered 404 (paths this target does not serve), concentrated on 1 of 4 '
        + 'classes: html.',
    },
  });
  assert.match(html, /Failure mode/);
  assert.match(html, /6\.31% of requests answered 404/);
  // before the knee, which is where the brake's own reason lives
  assert.ok(html.indexOf('Failure mode') < html.indexOf('The knee') || !/The knee/.test(html));
});

test('an invalid run still gets its failure mode: what broke is not a latency claim', () => {
  // The no-charts rule exists because latency from a generator-bound run describes the generator. A 404
  // does not become untrue because the generator was short.
  const html = buildReport({
    run_id: '20260908T101500Z', profile: 'p', base_url: 'https://x.test', shape: 'mix',
    peak_rps_user_target: 60, requests: 900, dropped_iterations: 400,
    generator_ok: false, target_unreachable: false,
    failed_rate: 0.2, dur: { p50: 10, p95: 20, p99: 30, max: 40 },
    failure_mode: { code: '404', count: 180, share: 0.2, classes: ['html'], class_count: 2,
      concentrated: true, line: '20.00% of requests answered 404, concentrated on 1 of 2 classes: html.' },
  });
  assert.match(html, /DISCARD THIS RUN/);
  assert.match(html, /Failure mode/);
  assert.match(html, /20\.00% of requests answered 404/);
});

test('a clean run gets no failure-mode heading at all', () => {
  const html = buildReport({
    run_id: '20260908T101500Z', profile: 'p', base_url: 'https://x.test', shape: 'mix',
    peak_rps_user_target: 60, requests: 10000, dropped_iterations: 0,
    generator_ok: true, target_unreachable: false, failure_mode: null,
    failed_rate: 0, dur: { p50: 100, p95: 200, p99: 300, max: 400 },
  });
  assert.doesNotMatch(html, /Failure mode/);
});

test('the page prints both rates, and the fan-out that separates them', () => {
  const html = buildReport({
    run_id: '20260908T101500Z', profile: 'p', base_url: 'https://x.test', shape: 'mix',
    peak_rps_user_target: 60, requests: 10000, dropped_iterations: 0,
    generator_ok: true, target_unreachable: false,
    failed_rate: 0, dur: { p50: 100, p95: 200, p99: 300, max: 400 },
    delivery: { requested_rps: 60, delivered_rps: 76, step: 's4', fan_out: 1.25,
      note: 'a fan-out of 1.25 HTTP requests per user request, measured over the step this rate was held at.' },
  });
  assert.match(html, /Requested and delivered/);
  assert.match(html, /60 req\/s requested/);
  assert.match(html, /76 req\/s arrived at the target/);
  assert.match(html, /fan-out of 1\.25/);
});

test('a refused delivered rate is stated as a refusal, not as a missing number', () => {
  const html = buildReport({
    run_id: '20260908T101500Z', profile: 'p', base_url: 'https://x.test', shape: 'mix',
    peak_rps_user_target: 60, requests: 900, dropped_iterations: 400,
    generator_ok: false, target_unreachable: false,
    failed_rate: 0, dur: { p50: 100, p95: 200, p99: 300, max: 400 },
    delivery: { refused: true, reason: 'the generator did not hold the requested rate, so what arrived '
      + 'measures the generator and not the mix.', fix: 'Move the generator closer.' },
  });
  assert.match(html, /No delivered rate from this run/);
  assert.match(html, /measures the generator and not the mix/);
  assert.doesNotMatch(html, /req\/s arrived at the target/);
});

// ── the drawn report says WHY the rate was not held, and cannot drift again (#84) ────────────────────
// The GUI got two exhaustive lists and a guard in 1.34.0; the report was left without one, and by then
// it was already missing `drop_diagnosis` — so the artefact most likely to reach a ticket still said
// DISCARD THIS RUN for a target that had simply saturated, which is the advice 1.32.0 exists to correct.

test('a saturated target is not drawn as a plain discard', () => {
  const html = buildReport({
    run_id: '20260908T101500Z', profile: 'p', base_url: 'https://x.test', shape: 'mix',
    peak_rps_user_target: 24, requests: 19, dropped_iterations: 15,
    generator_ok: false, target_unreachable: false,
    failed_rate: 0, dur: { p50: 400, p95: 900, p99: 1000, max: 1100 },
    drop_diagnosis: {
      verdict: 'target', generator_bound: false, discard: false, retry_lower: true,
      reason: 'the target could not absorb the requested rate: every virtual user was in flight.',
      fix: 'Measure it properly below that rate.',
    },
  });
  assert.match(html, /could not absorb/);
  assert.match(html, /TARGET/);
  // the run is still not a source of latency charts, but it is not a wasted window either
  assert.doesNotMatch(html, /DISCARD THIS RUN/);
});

test('a starved generator is still drawn as a discard, in those words', () => {
  const html = buildReport({
    run_id: '20260908T101500Z', profile: 'p', base_url: 'https://x.test', shape: 'mix',
    peak_rps_user_target: 24, requests: 900, dropped_iterations: 400,
    generator_ok: false, target_unreachable: false,
    failed_rate: 0, dur: { p50: 10, p95: 20, p99: 30, max: 40 },
    drop_diagnosis: {
      verdict: 'generator', generator_bound: true, discard: true, retry_lower: false,
      reason: 'the generator did not keep the schedule while the target answered promptly.',
      fix: 'Move the generator closer to the target.',
    },
  });
  assert.match(html, /DISCARD THIS RUN/);
  assert.match(html, /did not keep the schedule/);
});

test('a run that held its rate says nothing about why it did not', () => {
  const html = buildReport({
    run_id: '20260908T101500Z', profile: 'p', base_url: 'https://x.test', shape: 'mix',
    peak_rps_user_target: 24, requests: 900, dropped_iterations: 0,
    generator_ok: true, target_unreachable: false, drop_diagnosis: null,
    failed_rate: 0, dur: { p50: 10, p95: 20, p99: 30, max: 40 },
  });
  assert.doesNotMatch(html, /could not absorb/);
  assert.doesNotMatch(html, /DISCARD THIS RUN/);
});

test('the error counters reach the page: p95 per class is not the only thing a class did', () => {
  const html = buildReport({
    run_id: '20260908T101500Z', profile: 'p', base_url: 'https://x.test', shape: 'mix',
    peak_rps_user_target: 24, requests: 10000, dropped_iterations: 0,
    generator_ok: true, target_unreachable: false,
    failed_rate: 0.0223, dur: { p50: 10, p95: 20, p99: 30, max: 40 },
    e504: 0, e502: 2, e5xx: 2, e404: 474, denied: 7, authFail: 0,
    per_class: { html: { reqs: 6000, failed: 0.03, p95: 20, cache: {},
      errors: { e504: 0, e502: 1, e5xx: 1, e404: 474, denied: 7 } } },
  });
  assert.match(html, /474/);
  assert.match(html, /404/);
  assert.match(html, /401\/403|denied/i);
});

test('every block buildSummary produces is either drawn or deliberately not', async () => {
  // The same guard the GUI has, asked of buildSummary itself rather than a fixture: six blocks
  // accumulated in the GUI because nothing noticed, and the report had no reason to be different.
  const { buildSummary } = await import('../../k6/lib/summary.js');
  const { DRAWN, DELIBERATELY_NOT_DRAWN } = await import('../../lib/report-html.mjs');
  const summary = buildSummary({
    http_reqs: { values: { count: 100, rate: 10 } },
    http_req_duration: { values: { med: 10, 'p(95)': 20, 'p(99)': 30, max: 40 } },
    http_req_failed: { values: { rate: 0 } },
    dropped_iterations: { values: { count: 0 } },
    vus: { values: { max: 5 } },
  }, {
    runId: '20260908T120000Z', profileName: 'p', shape: 'mix', baseUrl: 'http://x.test',
    rscMode: 'repeat', peakRps: 10, shares: { html: 1 }, classNames: ['html'], cacheLabels: [],
    guillotineMs: 5000, slo: { max_p95_ms: 700, max_failed_rate: 0.05 }, classSlo: {},
    durationMs: 60000, abortDelay: '5s',
  });
  const known = new Set([...DRAWN, ...DELIBERATELY_NOT_DRAWN]);
  const unaccounted = Object.keys(summary).filter((k) => !known.has(k));
  assert.deepEqual(unaccounted, [],
    'these summary blocks are neither drawn nor listed as deliberately left out — add them to '
    + 'lib/report-html.mjs, with a reason if the page should not draw them');
  assert.deepEqual(DRAWN.filter((k) => DELIBERATELY_NOT_DRAWN.includes(k)), [],
    'a block cannot be both drawn and not drawn');
});

// ── the outcome chart: which class answered what (#85) ───────────────────────────────────────────────
// «Concentrated on 2 of 5 classes» is the whole distinction the failure-mode line makes — the same code
// on some classes and not others points at a pool or a route, spread evenly it points at the system — and
// it was prose next to a chart of p95. This is the one thing a chart is actually for.

test('each class gets a bar per outcome, from counts', () => {
  const svg = outcomeChart({
    html:   { reqs: 1000, errors: { e404: 200, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
    static: { reqs: 1000, errors: { e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
  });
  assert.match(svg, /<svg/);
  assert.match(svg, /html/);
  assert.match(svg, /static/);
  // the counts, not a share recomputed here: failure_mode.share and these bars must not disagree
  assert.match(svg, /200/);
  assert.match(svg, /800/, 'the 2xx remainder is requests minus the coded failures');
});

test('a class with no requests stays absent, not a bar of height zero', () => {
  // A zero bar reads as a class that was fine. A class that never ran is a different statement, and this
  // project has been caught by that conversion more than once.
  const svg = outcomeChart({
    ran:     { reqs: 10, errors: { e404: 1, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
    skipped: { reqs: 0, errors: { e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
  });
  assert.match(svg, /ran/);
  assert.doesNotMatch(svg, /skipped/);
});

test('a run where nothing failed draws no outcome chart at all', () => {
  assert.equal(outcomeChart({
    html: { reqs: 1000, errors: { e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
  }), '');
  assert.equal(outcomeChart({}), '');
  assert.equal(outcomeChart(null), '');
});

test('a 504 is not double-counted inside 5xx', () => {
  // cs_5xx counts the 504s and 502s too. Stacking the raw counters would draw more failures than the
  // class had, and a stack that exceeds its own total is a chart that cannot be read.
  const svg = outcomeChart({
    api: { reqs: 100, errors: { e404: 0, e5xx: 30, e502: 10, e504: 20, denied: 0 } },
  });
  // 30 total 5xx of which 10 are 502 and 20 are 504, so the "other 5xx" band is 0 and the total failed
  // is 30 — never 60.
  assert.doesNotMatch(svg, /\b60\b/);
  assert.match(svg, /70/, 'the 2xx remainder is 100 - 30');
});

test('the stack never exceeds the class total, whatever the counters say', () => {
  // A counter can be larger than the request count if a metric is tagged oddly. The chart must clamp
  // rather than draw a bar past its own axis, which would look like a scale problem in the page.
  const svg = outcomeChart({
    odd: { reqs: 10, errors: { e404: 99, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
  });
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /width="-/, 'no negative widths');
});

test('the bands are distinguishable without colour, because the page gets printed', () => {
  // e5xx is the superset, so "other 5xx" needs a total above the 502s and 504s to exist at all.
  const svg = outcomeChart({
    html: { reqs: 100, errors: { e404: 10, e5xx: 10, e502: 0, e504: 5, denied: 5 } },
  });
  // each band carries its own class so the stylesheet can hatch it, and its own <title> for a reader
  for (const band of ['ok', 'e404', 'e5xx', 'e504', 'denied']) {
    assert.match(svg, new RegExp(`band ${band}`), band);
  }
  assert.match(svg, /<title>/);
});

test('the chart names what it is, for a reader who cannot see it', () => {
  const svg = outcomeChart({
    html: { reqs: 100, errors: { e404: 10, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
  });
  assert.match(svg, /role="img"/);
  assert.match(svg, /<desc[^>]*>/);
  assert.match(svg, /html/);
});
