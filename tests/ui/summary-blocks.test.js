/*
 * What the page shows of a summary — and what it silently does not.
 *
 * The GUI rendered `knee` and nothing else that had been added to the summary since 1.21.0. The
 * `failure_mode` one is the same wrong answer as #74, still live on the page: a run that completed
 * without crossing its thresholds while serving 32% 404s on one class read as a pass, in the place most
 * people look.
 *
 * The last test here is the one that matters most: it fails when the summary grows a top-level block the
 * page neither renders nor explicitly decides to leave out. A block absent on purpose is fine; a block
 * absent because nobody noticed is how six of them accumulated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { failureModeText, deliveryText, dropDiagnosisText, RENDERED, DELIBERATELY_NOT_RENDERED }
  from '../../gui/ui/src/lib/summary-blocks.js';
import { kneeText, stepCurve, rateAxis } from '../../gui/ui/src/lib/runs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── the failure mode: first, and never invented ──────────────────────────────────────────────────────

test('a failure mode is shown as the headline, with the class and the code', () => {
  const t = failureModeText({
    code: '404', share: 0.323, classes: ['rsc_page'], class_count: 3, concentrated: true,
    line: '32.30% of requests answered 404 (paths this target does not serve), concentrated on 1 of 3 '
      + 'classes: rsc_page.',
  });
  assert.ok(t);
  assert.match(t.headline, /404/);
  assert.match(t.detail, /rsc_page/);
  assert.equal(t.tone, 'warn');
});

test('a clean run has no failure-mode block at all, rather than an empty banner', () => {
  assert.equal(failureModeText(null), null);
  assert.equal(failureModeText(undefined), null);
});

test('the wording comes from the summary and is not rebuilt on the page', () => {
  // The panel, the markdown report, the HTML page and now this one all quote `line`. Four renderings of
  // the same sentence is four chances to disagree while somebody decides something.
  const line = 'anything at all, even a sentence this file has never seen';
  assert.match(failureModeText({ code: '5xx', line: line }).detail, /never seen/);
});

// ── requested versus delivered ───────────────────────────────────────────────────────────────────────

test('both rates are shown, with the fan-out between them', () => {
  const t = deliveryText({ requested_rps: 60, delivered_rps: 76, fan_out: 1.25,
    note: 'a fan-out of 1.25 HTTP requests per user request' });
  assert.match(t.headline, /60/);
  assert.match(t.headline, /76/);
  assert.match(t.detail, /1\.25/);
});

test('a refused delivered rate is stated as a refusal, not as a blank', () => {
  const t = deliveryText({ refused: true, reason: 'the target could not absorb the requested rate.' });
  assert.match(t.headline, /not measured/i);
  assert.match(t.detail, /could not absorb/);
  assert.equal(t.tone, 'warn');
});

test('no delivery block means no section', () => {
  assert.equal(deliveryText(null), null);
});

// ── why the rate was not held ────────────────────────────────────────────────────────────────────────

test('a saturated target is not presented as a discard', () => {
  const t = dropDiagnosisText({ verdict: 'target', discard: false,
    reason: 'the target could not absorb the requested rate.', fix: 'Measure it below that rate.' });
  assert.match(t.headline, /TARGET/);
  assert.doesNotMatch(t.headline, /DISCARD/i);
  assert.equal(t.tone, 'warn');
});

test('a starved generator is presented as a discard, in those words', () => {
  const t = dropDiagnosisText({ verdict: 'generator', discard: true,
    reason: 'the generator did not keep the schedule.', fix: 'Move it closer.' });
  assert.match(t.headline, /DISCARD/);
  assert.equal(t.tone, 'bad');
});

test('a run that held its rate says nothing here', () => {
  assert.equal(dropDiagnosisText(null), null);
});

// ── the drift guard ──────────────────────────────────────────────────────────────────────────────────

test('every top-level block the GENERATOR produces is either rendered or deliberately not', async () => {
  // Asked of buildSummary itself, not of a stored fixture. A fixture is a snapshot of what the summary
  // looked like when somebody last updated it — and this drift is exactly the thing a stale snapshot
  // cannot see: the archived summary-good.json predates six of the blocks this test exists for.
  const { buildSummary } = await import('../../k6/lib/summary.js');
  const metrics = {
    http_reqs: { values: { count: 100, rate: 10 } },
    http_req_duration: { values: { med: 10, 'p(95)': 20, 'p(99)': 30, max: 40 } },
    http_req_failed: { values: { rate: 0 } },
    dropped_iterations: { values: { count: 0 } },
    vus: { values: { max: 5 } },
  };
  const summary = buildSummary(metrics, {
    runId: '20260908T120000Z', profileName: 'p', shape: 'mix', baseUrl: 'http://x.test',
    rscMode: 'repeat', peakRps: 10, shares: { html: 1 }, classNames: ['html'], cacheLabels: [],
    guillotineMs: 5000, slo: { max_p95_ms: 700, max_failed_rate: 0.05 }, classSlo: {},
    durationMs: 60000, abortDelay: '5s',
  });
  const known = new Set([...RENDERED, ...DELIBERATELY_NOT_RENDERED]);
  const unaccounted = Object.keys(summary).filter((k) => !known.has(k));
  assert.deepEqual(unaccounted, [],
    'these summary blocks are neither rendered nor listed as deliberately left out — add them to '
    + 'gui/ui/src/lib/summary-blocks.js, with a reason if the page should not show them');
});

test('the two lists do not overlap, or a block is both shown and not shown', () => {
  const both = RENDERED.filter((k) => DELIBERATELY_NOT_RENDERED.includes(k));
  assert.deepEqual(both, []);
});

test('the blocks this release is about are in the RENDERED list, not the other one', () => {
  for (const k of ['failure_mode', 'delivery', 'drop_diagnosis', 'knee']) {
    assert.ok(RENDERED.includes(k), `${k} must be rendered, it is a verdict about the run`);
  }
});

// ── the knee plot's axis, which #78 asked for and 1.34.0 did not deliver (#83) ────────────────────────
// `--peak` is total USER req/s and one user request becomes several HTTP requests, so the rate the target
// had to survive is the larger one. The banners say both; the plot mapped `requested_rps` with an
// unlabelled axis, which is the same wrong answer 1.29.0 removed from the text, moved onto the chart.
// A chart is worse than a sentence here: a wrong scale does not throw, it draws a convincing picture.

test('the curve carries both rates per point, so the plot can label its axis', () => {
  const pts = stepCurve([
    { step: 's1', requested_rps: 20, achieved_rps: 25, p95: 100, partial: false },
    { step: 's2', requested_rps: 40, achieved_rps: 50, p95: 200, partial: false },
  ]);
  assert.deepEqual(pts.map((p) => p.rate), [20, 40]);
  assert.deepEqual(pts.map((p) => p.delivered), [25, 50]);
});

test('a step with no delivered rate carries null, never the requested one repeated', () => {
  const pts = stepCurve([{ step: 's1', requested_rps: 20, p95: 100, partial: false }]);
  assert.equal(pts[0].delivered, null);
});

test('the axis label names which rate is plotted, and where it came from', () => {
  const measured = rateAxis({ requested_rps: 60, delivered_rps: 76, fan_out: 1.25 });
  assert.match(measured.label, /requested/);
  assert.match(measured.title, /76/);
  assert.match(measured.title, /1\.25/);

  // A refused delivery must not silently become "requested = delivered" on the axis.
  const refused = rateAxis({ refused: true, reason: 'the target could not absorb the requested rate.' });
  assert.match(refused.label, /requested/);
  assert.match(refused.title, /not measured|could not absorb/);
  assert.equal(rateAxis(null).label, 'requested req/s');
});

test('the knee badge carries the delivered rates in its own right, not via the summary sentence', () => {
  // Asserted with NO `summary` on purpose: the first version of this test passed because the sentence I
  // handed it happened to contain the number. The cell stays the requested pair — it is one column of a
  // narrow table — and the delivered pair belongs in the title, derived from the knee.
  const t = kneeText({
    clean: { requested_rps: 60, achieved_rps: 76 },
    crossed: { requested_rps: 80, achieved_rps: 99 },
  });
  assert.equal(t.text, '60 → 80');
  assert.match(t.title, /76/);
  assert.match(t.title, /99/);
  assert.match(t.title, /delivered/i);
});

test('a knee with no delivered rate reads exactly as it did before', () => {
  // The history table is narrow and the badge is one cell: a run archived before 1.29.0 has no delivered
  // rate, and inventing a second number for it would be worse than showing one.
  const t = kneeText({ clean: { requested_rps: 60 }, crossed: { requested_rps: 80 } });
  assert.equal(t.text, '60 → 80');
  assert.doesNotMatch(t.title, /delivered/i, 'no delivered rate means no claim about one');
});
