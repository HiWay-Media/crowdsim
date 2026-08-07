/*
 * What the page says about the machine the runs come from. (#49)
 *
 * The generator's own limits are the most common reason a run is invalid, and until now the page reported
 * k6's version, the allowlist and the output directory — nothing else. `doctor` and `doctor --bench` existed
 * only in a terminal, and the crowdsim version was in /api/env and shown nowhere, which is how a
 * three-release-old server served a current-looking page during the audit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { hostHealth, benchLine } from '../../gui/ui/src/lib/health.js';

test('a healthy host reports its version, its k6 and where it writes', () => {
  const rows = hostHealth({ version: '1.13.2', k6: 'k6 v0.52.0', out_dir: '/out', allow_targets: 'a.test' });
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(by.crowdsim.value, '1.13.2');
  assert.equal(by.crowdsim.tone, 'ok');
  assert.equal(by.k6.value, 'k6 v0.52.0');
  assert.equal(by.output.value, '/out');
});

test('an unknown version is called unknown, not hidden', () => {
  // The image used to report null here, which rendered as nothing at all — and a page that does not say
  // which version it is looks exactly like a current one.
  const by = Object.fromEntries(hostHealth({ version: null, k6: 'k6 v0.52.0' }).map((r) => [r.label, r]));
  assert.match(by.crowdsim.value, /unknown/i);
  assert.equal(by.crowdsim.tone, 'warn');
});

test('no k6 is the thing that stops a run, so it is marked as such', () => {
  const by = Object.fromEntries(hostHealth({ version: '1.13.2', k6: null }).map((r) => [r.label, r]));
  assert.match(by.k6.value, /not installed/i);
  assert.equal(by.k6.tone, 'bad');
});

test('no allowlist is stated as the refusal it will cause, not as an empty field', () => {
  const by = Object.fromEntries(hostHealth({ version: '1', k6: 'k6', allow_targets: null }).map((r) => [r.label, r]));
  assert.match(by.allowlist.value, /from the profile/i);
  assert.equal(by.allowlist.tone, 'note');
});

// ── the measured generator ceiling ───────────────────────────────────────────────────────────────────
test('a measured ceiling is shown with the units somebody reasons in', () => {
  const line = benchLine({ req_per_second: 45067.8, mbits_per_second: 16639.7, measured_at: '20260805T213235Z',
    virtualised: false });
  assert.match(line.text, /45068 req\/s/);
  assert.match(line.text, /16640 Mbit\/s/);
  assert.equal(line.tone, 'ok');
});

test('a ceiling measured inside a VM says so, and is not presented as a ceiling', () => {
  // 1.13.1 fixed the estimate silently trusting this number. The page must not undo that by showing it as
  // a plain fact: loopback inside a VM describes the VM, and that is the layer that throttles the run.
  const line = benchLine({ req_per_second: 44511, mbits_per_second: 16434, measured_at: '20260806T081629Z',
    virtualised: true, in_container: true });
  assert.equal(line.tone, 'warn');
  assert.match(line.text, /inside a container in a VM/i);
  assert.match(line.text, /says nothing about the path to a real target/i);
});

test('never measured says how to measure it, and never guesses', () => {
  const line = benchLine(null);
  assert.equal(line.tone, 'note');
  assert.match(line.text, /crowdsim doctor --bench/);
  assert.doesNotMatch(line.text, /[0-9]+ req\/s/);
});
