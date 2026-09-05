/*
 * The terminal and the page must not disagree about what a run was.
 *
 * `crowdsim history --json` is python3 inside the driver; the GUI's history endpoint is
 * gui/server/lib/history.js. Two implementations of one record is exactly the shape of bug where a page
 * shows one number and the terminal another while somebody is deciding something — so the two are run
 * against one fixture and compared field by field, rather than each being tested against its own idea of
 * the truth.
 *
 * The driver is spawned for real: asserting against a hand-written expectation would only prove that the
 * expectation and the JS agree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readHistory } from '../../gui/server/lib/history.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CROWDSIM = path.join(ROOT, 'bin', 'crowdsim');

const HEADER = 'run_id\tprofile\tbase_url\tshape\tpeak\taborted\treqs\trps\tfailed\tp95\te504\tgen_ok\tknee_clean\tknee_crossed';
const ROWS = [
  '20260901T101500Z\tsite-a\thttps://a.test\tmix\t40\tFalse\t1000\t39.8\t0.001\t210\t0\tTrue\t30\t40',
  '20260901T111500Z\tsite-b\thttps://b.test\tmix\t60\tTrue\t900\t55.1\t0.06\t5100\t12\tTrue\t40\t50',
  // a discard, and a run written before the knee columns existed
  '20260901T121500Z\tsite-a\thttps://a.test\tmix\t80\tFalse\t400\t20\t0.002\t300\t0\tFalse\t\t',
  '20260801T101500Z\told\thttps://a.test\tmix\t20\tFalse\t100\t19\t0\t150\t0\tTrue',
];

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-history-'));
  fs.writeFileSync(path.join(dir, 'history.tsv'), [HEADER, ...ROWS].join('\n') + '\n');
  return dir;
}

test('the CLI and the GUI read history.tsv into the same records', () => {
  const dir = fixtureDir();
  const cli = JSON.parse(execFileSync(CROWDSIM, ['history', '--json'], {
    env: { ...process.env, CROWDSIM_OUT: dir },
    encoding: 'utf8',
  }));
  const gui = readHistory(dir);

  assert.equal(cli.length, gui.length, 'same number of runs');
  assert.deepEqual(cli.map((r) => r.run_id), gui.map((r) => r.run_id), 'same order, newest first');
  for (let i = 0; i < cli.length; i++) {
    assert.deepEqual(Object.keys(cli[i]).sort(), Object.keys(gui[i]).sort(),
      `same fields for ${cli[i].run_id}`);
    assert.deepEqual(cli[i], gui[i], `same values for ${cli[i].run_id}`);
  }
});

test('a knee that was never recorded is null on both sides, and never 0', () => {
  // 0 req/s is a claim about the system. "This run predates the knee" is not the same statement, and a
  // chart that plots one as the other is convincing and false.
  const dir = fixtureDir();
  const cli = JSON.parse(execFileSync(CROWDSIM, ['history', '--json'], {
    env: { ...process.env, CROWDSIM_OUT: dir },
    encoding: 'utf8',
  }));
  const old = cli.find((r) => r.run_id === '20260801T101500Z');
  const discard = cli.find((r) => r.run_id === '20260901T121500Z');
  for (const r of [old, discard]) {
    assert.equal(r.knee_clean, null);
    assert.equal(r.knee_crossed, null);
  }
  assert.equal(discard.generator_ok, false);
});

test('--last and the filters narrow the same records rather than a different shape', () => {
  const dir = fixtureDir();
  const one = JSON.parse(execFileSync(CROWDSIM, ['history', '--json', '--last', '1'], {
    env: { ...process.env, CROWDSIM_OUT: dir }, encoding: 'utf8',
  }));
  const all = readHistory(dir);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], all[0], 'the newest record, unchanged by having been filtered');
});
