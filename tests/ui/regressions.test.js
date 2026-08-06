/*
 * One test per front-end bug that actually shipped.
 *
 * This project's rule is that a fixed bug starts from a test that reproduces it. These four were fixed
 * without one, because until now there was nowhere to put it — they were found by screenshotting the page
 * and reading the DOM. The names say what the bug was, not which function it lived in: the next person needs
 * the trap, not the call stack.
 *
 * Each of these fails against the code as it was, and passes against the code as it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runToShow, shouldClearResult } from '../../gui/ui/src/lib/runs.js';
import { parseHash, formatHash } from '../../gui/ui/src/lib/hash.js';
import { orderPair } from '../../gui/ui/src/lib/compare.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.resolve(here, '../../gui/ui/src', rel), 'utf8');

test('1.10.0: reloading the page threw away the finished run', () => {
  // The effect that loads a profile also cleared the last result — and it runs on first load, so the run
  // just restored from the server was wiped and the page looked like nothing had ever happened.
  //
  // The distinction the fix rests on: arriving at a profile is not choosing one.
  assert.equal(shouldClearResult({ reason: 'profile-loaded', from: null, to: 'live-event.json' }), false);
  assert.equal(shouldClearResult({ reason: 'profile-selected', from: null, to: 'live-event.json' }), false);
  assert.equal(shouldClearResult({ reason: 'profile-selected', from: 'a.json', to: 'b.json' }), true);

  // …and the restored run really is the finished one, not nothing.
  const runs = [{ id: 'r2', status: 'done' }];
  assert.deepEqual(runToShow({ active: null, runs }), { run: runs[0], follow: false });

  // The effect must not have grown the clearing back.
  const panel = src('components/RunPanel.jsx');
  const profileEffect = panel.slice(panel.indexOf('api.profile(profileName)'), panel.indexOf('}, [profileName]);'));
  assert.doesNotMatch(profileEffect, /setSummary\(null\)|setArtifacts\(null\)/,
    'the profile-loading effect must not clear the result: it also runs on first load');
});

test('1.10.0: the comparison pair had no defined direction', () => {
  // Ticking B then A produced "A = the newer run", so a before/after read backwards half the time.
  const rows = [{ run_id: 'newest' }, { run_id: 'middle' }, { run_id: 'oldest' }];
  assert.deepEqual(orderPair(['newest', 'oldest'], rows), ['oldest', 'newest']);
  assert.deepEqual(orderPair(['oldest', 'newest'], rows), ['oldest', 'newest']);
});

test('1.7.0: the tab lived only in React state, so a reload lost it', () => {
  assert.equal(parseHash('#history').tab, 'history');
  assert.equal(formatHash('history', null), 'history');
  // And a comparison can be linked to, which is the same fix taken one step further.
  const pair = ['20260805T090000Z', '20260805T093000Z'];
  assert.deepEqual(parseHash(`#${formatHash('history', pair)}`), { tab: 'history', pair });
});

test('1.7.0: a run id printed inline was never recognised, so a probe result was unreachable', () => {
  // Server-side (gui/server/lib/runner.js), but it is in this list because of how it was found: the page was
  // missing a table, and nothing else noticed. The regression test lives with the code it protects —
  // tests/gui/preview.test.js, "the run id is picked up from both shapes the driver prints it in" — and this
  // assertion is here so the shape of the bug stays visible from the front-end side too.
  const runner = fs.readFileSync(path.resolve(here, '../../gui/server/lib/runner.js'), 'utf8');
  const match = /const m = (\/[^;]+\/)\.exec\(line\)/.exec(runner);
  assert.ok(match, 'the run-id pattern moved: update this test with it');
  const re = new RegExp(match[1].slice(1, -1));
  assert.ok(re.test('  run       20260805T101112Z'), 'the shape `load` prints');
  assert.ok(re.test('run: 20260805T101112Z  base: http://127.0.0.1:8099  path: /'), 'the shape `probe` prints');
  assert.ok(!re.test('this run will not tell you 20260805T101112Z'), 'and not prose that merely says "run"');
});
