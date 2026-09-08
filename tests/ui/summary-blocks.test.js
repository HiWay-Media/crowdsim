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
