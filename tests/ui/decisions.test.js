/*
 * The decisions the front end makes, tested where they live.
 *
 * These six used to be spread through the components as hooks and inline expressions, which is why two of
 * them shipped wrong and were found by screenshotting the page. They are the same category as k6/lib: the
 * part that can be wrong, separated from the part that draws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runToShow, shouldClearResult } from '../../gui/ui/src/lib/runs.js';
import { parseHash, formatHash, TAB_IDS } from '../../gui/ui/src/lib/hash.js';
import { orderPair, deltaCell, valueCell, mayRenderNumbers } from '../../gui/ui/src/lib/compare.js';
import { hostAllowed, allowlistVerdict } from '../../gui/ui/src/lib/allowlist.js';

// ── which run the page shows when it loads ───────────────────────────────────────────────────────────
test('the active run wins, because something is happening right now', () => {
  const active = { id: 'r2', status: 'running' };
  const runs = [{ id: 'r2', status: 'running' }, { id: 'r1', status: 'done' }];
  assert.deepEqual(runToShow({ active, runs }), { run: active, follow: true });
});

test('with nothing running, the newest run is shown — a reload must not lose the result', () => {
  const runs = [{ id: 'r2', status: 'done' }, { id: 'r1', status: 'done' }];
  assert.deepEqual(runToShow({ active: null, runs }), { run: runs[0], follow: false });
});

test('an empty archive shows nothing and follows nothing', () => {
  assert.deepEqual(runToShow({ active: null, runs: [] }), { run: null, follow: false });
  assert.deepEqual(runToShow({}), { run: null, follow: false });
  assert.deepEqual(runToShow(null), { run: null, follow: false });
});

// ── when a result stops belonging to what is on the form ─────────────────────────────────────────────
test('switching profile clears the result: it belonged to the profile it came from', () => {
  assert.equal(shouldClearResult({ reason: 'profile-selected', from: 'a.json', to: 'b.json' }), true);
});

test('the first profile load clears nothing — this exact bug shipped', () => {
  // The effect that loads a profile also ran on mount, wiping the run just restored from the server and
  // leaving a page that looked like nothing had ever happened. Found by dumping the DOM, not by a test.
  assert.equal(shouldClearResult({ reason: 'profile-loaded', from: null, to: 'a.json' }), false);
  assert.equal(shouldClearResult({ reason: 'profile-selected', from: 'a.json', to: 'a.json' }), false);
});

test('starting a new run clears the previous result, because a stale result beside a new run is a trap', () => {
  assert.equal(shouldClearResult({ reason: 'run-started' }), true);
});

// ── the tab, and the comparison pair, in the URL fragment ────────────────────────────────────────────
test('the fragment carries the tab, so a reload lands where you were', () => {
  assert.deepEqual(parseHash('#history'), { tab: 'history', pair: null });
  assert.deepEqual(parseHash('#profiles'), { tab: 'profiles', pair: null });
});

test('an unknown or empty fragment falls back to the run tab rather than a blank page', () => {
  for (const h of ['', '#', '#nope', '#history/../run', null, undefined]) {
    assert.equal(parseHash(h).tab, 'run', `fragment ${JSON.stringify(h)}`);
  }
  assert.deepEqual(TAB_IDS, ['run', 'profiles', 'history']);
});

test('a comparison has an address, and only a well-formed pair is honoured', () => {
  const a = '20260805T090000Z';
  const b = '20260805T093000Z';
  assert.deepEqual(parseHash(`#history=${a},${b}`), { tab: 'history', pair: [a, b] });
  assert.equal(formatHash('history', [a, b]), `history=${a},${b}`);
  assert.equal(formatHash('run', null), 'run');

  // Anything that is not two run ids is not a pair: these values end up in a request the server turns
  // into a spawn argv, and the page should not be the first place that stops caring.
  for (const bad of [`#history=${a}`, `#history=${a},nope`, '#history=,', `#history=${a},${b},${a}`,
    '#history=--help,x']) {
    assert.equal(parseHash(bad).pair, null, `fragment ${bad}`);
    assert.equal(parseHash(bad).tab, 'history', 'the tab still resolves');
  }
});

// ── which of two ticked runs is A ────────────────────────────────────────────────────────────────────
test('the older run is A, so a before/after reads in one direction', () => {
  // history rows arrive newest first — the order the archive is read in.
  const rows = [{ run_id: 'c' }, { run_id: 'b' }, { run_id: 'a' }];
  assert.deepEqual(orderPair(['c', 'a'], rows), ['a', 'c']);
  assert.deepEqual(orderPair(['a', 'c'], rows), ['a', 'c'], 'ticking order must not change the direction');
});

test('a pair that is not two runs is not comparable', () => {
  const rows = [{ run_id: 'b' }, { run_id: 'a' }];
  assert.equal(orderPair(['a'], rows), null);
  assert.equal(orderPair([], rows), null);
  assert.equal(orderPair(['a', 'ghost'], rows), null, 'a run that is not in the archive');
});

// ── how a delta is painted ───────────────────────────────────────────────────────────────────────────
test('lower latency is better, a higher hit ratio is better, and the server decides which', () => {
  assert.equal(deltaCell({ change: -60, unit: 'ms', relative: -0.3, verdict: 'better' }).tone, 'ok');
  assert.equal(deltaCell({ change: 60, unit: 'ms', relative: 0.43, verdict: 'worse' }).tone, 'bad');
  assert.equal(deltaCell({ change: 0, unit: 'ms', relative: 0, verdict: 'same' }).tone, 'note');
});

test('a header that never appeared is n/a, and is never painted as 0%', () => {
  // The distinction the whole classification chain preserves, from k6/lib/classify.js outward: a layer that
  // never spoke is unknown, not a miss, and a hit ratio of "0%" next to it would be a lie with a colour.
  assert.equal(valueCell(null, 'ratio'), 'n/a');
  assert.equal(valueCell(0, 'ratio'), '0.00%');
  assert.equal(deltaCell({ change: null, unit: 'ratio', relative: null, verdict: 'unknown' }).text, '—');
  assert.equal(deltaCell({ change: null, unit: 'ratio', relative: null, verdict: 'unknown' }).tone, 'note');
});

test('milliseconds keep the precision the number deserves', () => {
  assert.equal(valueCell(0.8694, 'ms'), '0.87 ms');
  assert.equal(valueCell(140.54, 'ms'), '141 ms');
  assert.equal(deltaCell({ change: -0.07, unit: 'ms', relative: -0.08, verdict: 'better' }).text,
    '-0.07 ms (-8%)');
  assert.equal(deltaCell({ change: -60, unit: 'ms', relative: -0.3, verdict: 'better' }).text,
    '-60 ms (-30%)');
});

test('a refused comparison renders no numbers at all', () => {
  // A delta between two runs that were not the same experiment looks exactly like an answer, so the page
  // must not be able to show one by accident — the refusal is the whole result.
  assert.equal(mayRenderNumbers({ refused: [], overall: [] }), true);
  assert.equal(mayRenderNumbers({ refused: [{ reason: 'generator_ok: false' }] }), false);
  assert.equal(mayRenderNumbers(null), false);
});

// ── the allowlist verdict shown before a run ─────────────────────────────────────────────────────────
test('the allowlist preview matches the gate the CLI will apply, globs included', () => {
  assert.equal(hostAllowed('www.example.test', ['www.example.test']), true);
  assert.equal(hostAllowed('10.0.0.11', ['10.0.0.*']), true);
  assert.equal(hostAllowed('evil.test', ['www.example.test']), false);
  assert.equal(hostAllowed('wwwXexample.test', ['www.example.test']), false, 'a dot is not any character');
  assert.equal(hostAllowed('sub.www.example.test', ['www.example.test']), false);
});

test('no allowlist is not an allowlist, and the page says so rather than guessing', () => {
  assert.equal(hostAllowed('www.example.test', []), false);
  assert.equal(allowlistVerdict(null, ['a']).state, 'unknown', 'no host chosen yet');
  assert.equal(allowlistVerdict('www.example.test', []).state, 'refused');
  assert.equal(allowlistVerdict('www.example.test', ['www.example.test']).state, 'authorised');
  assert.match(allowlistVerdict('nope.test', ['www.example.test']).text, /exit 3/,
    'the consequence, not just the verdict');
});
