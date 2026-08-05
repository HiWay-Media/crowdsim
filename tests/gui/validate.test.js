/*
 * Profile validation. The point of this pass is to catch, before a window is agreed, the profiles that
 * would RUN and mean something other than what their author intended.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../../lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const example = JSON.parse(fs.readFileSync(path.join(root, 'profiles/example.json'), 'utf8'));

const clone = (o) => JSON.parse(JSON.stringify(o));
const paths = (list) => list.map((e) => e.path);

test('the shipped example profile is valid — it is the documentation', () => {
  const v = validateProfile(example);
  assert.deepEqual(v.errors, [], JSON.stringify(v.errors, null, 2));
  assert.equal(v.ok, true);
});

test('the example ships an empty static pool, and validation says the class will be dropped', () => {
  const v = validateProfile(example);
  assert.ok(paths(v.warnings).includes('pools.static'));
  assert.ok(v.warnings.some((w) => /dropped and the mix renormalised/.test(w.message)));
});

test('the summary exposes the mix as shares, which is what the GUI draws', () => {
  const s = validateProfile(example).summary;
  const total = s.classes.reduce((a, c) => a + c.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(s.classes.find((c) => c.name === 'rsc_page').kind, 'rsc');
  assert.equal(s.default_target, 'edge');
  assert.equal(s.safe_peak_rps, 150);
  assert.deepEqual(s.cache_layers, ['proxy', 'cdn', 'souin']);
  assert.equal(s.classes.find((c) => c.name === 'html').pool_size, 6);
});

test('a profile with no classes or no positive weight is an error', () => {
  assert.ok(!validateProfile({}).ok);
  const p = clone(example);
  p.classes = p.classes.map((c) => Object.assign({}, c, { weight: 0 }));
  const v = validateProfile(p);
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => /positive number/.test(e.message)));
});

test('duplicate class names are an error: the metrics would silently merge', () => {
  const p = clone(example);
  p.classes.push(Object.assign({}, p.classes[0]));
  assert.ok(validateProfile(p).errors.some((e) => /duplicate class name/.test(e.message)));
});

test('a class pointing at a pool that does not exist is an error', () => {
  const p = clone(example);
  p.classes[0].pool = 'nowhere';
  assert.ok(validateProfile(p).errors.some((e) => /unknown pool "nowhere"/.test(e.message)));
});

test('an allowlist of "*" is rejected: it is not an allowlist', () => {
  const p = clone(example);
  p.safety.allow_hosts = ['*'];
  assert.ok(validateProfile(p).errors.some((e) => /not an allowlist/.test(e.message)));
});

test('allow_hosts entries are hostname globs, not URLs', () => {
  const p = clone(example);
  p.safety.allow_hosts = ['https://www.example.test/', 'www.example.test:443'];
  const v = validateProfile(p);
  assert.equal(v.errors.filter((e) => e.path === 'safety.allow_hosts').length, 2);
});

test('no allowlist at all is a warning, because the environment can still supply one', () => {
  const p = clone(example);
  delete p.safety.allow_hosts;
  const v = validateProfile(p);
  assert.ok(v.ok);
  assert.ok(v.warnings.some((w) => /CROWDSIM_ALLOW_TARGETS/.test(w.message)));
});

test('a brake class that is not in the mix is an error: nothing would abort the run', () => {
  const p = clone(example);
  p.slo.brake_class = 'gone';
  assert.ok(validateProfile(p).errors.some((e) => e.path === 'slo.brake_class'));
});

test('a read timeout below the p95 SLO is flagged: the brake would fire after the 504s', () => {
  const p = clone(example);
  p.slo.guillotine_ms = 3000;
  p.slo.max_p95_ms = 5000;
  assert.ok(validateProfile(p).warnings.some((w) => w.path === 'slo.guillotine_ms'));
});

test('a malformed bypass is an error: it is what keeps SNI and Host correct', () => {
  const p = clone(example);
  p.targets.list.edge.bypass = '203.0.113.10';
  assert.ok(validateProfile(p).errors.some((e) => /bypass must be "host=address"/.test(e.message)));
});

test('a default target that does not exist is an error', () => {
  const p = clone(example);
  p.targets.default = 'staging';
  assert.ok(validateProfile(p).errors.some((e) => e.path === 'targets.default'));
});

test('a target without base_url is a warning; a pool that is neither list nor @file is an error', () => {
  // The distinction is what makes it safe for `load` to refuse on errors: a target nobody selects breaks
  // nothing (and selecting it already fails with exit 2), while a malformed pool breaks every run.
  const p = clone(example);
  p.targets.list.broken = { host_header: 'x.test' };
  p.pools.weird = 42;
  const v = validateProfile(p);
  assert.ok(v.warnings.some((w) => w.path === 'targets.list.broken'));
  assert.ok(v.errors.some((e) => e.path === 'pools.weird'));
});

test('no named targets at all is a warning: a profile can be driven entirely by --base-url', () => {
  const p = clone(example);
  p.targets = {};
  const v = validateProfile(p);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.ok(v.warnings.some((w) => /--base-url/.test(w.message)));
});

test('an unresolved @file pool is accepted: the driver inlines it at run time', () => {
  const p = clone(example);
  p.pools.pages = '@pool-pages.json';
  const v = validateProfile(p);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.summary.pools.pages, null);
  p.pools.pages = 'pool-pages.json';
  assert.ok(validateProfile(p).errors.some((e) => /"@pool-pages.json"/.test(e.message)));
});

test('an invalid hit regex is an error rather than a crash at run time', () => {
  const p = clone(example);
  p.cache_headers[0].hit = '[unterminated';
  assert.ok(validateProfile(p).errors.some((e) => /valid regular expression/.test(e.message)));
});

test('documentation keys in pools are ignored, not validated as pools', () => {
  const p = clone(example);
  p.pools._note = 'free text';
  assert.ok(validateProfile(p).ok);
});
