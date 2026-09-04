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

test('generator_mbps is optional, but must be a positive number when present', () => {
  // It feeds the bandwidth estimate that warns before a run comes back generator_ok: false. A string or a
  // zero there would silently disable the warning, which is worse than not declaring it at all.
  const p = clone(example);
  assert.equal(validateProfile(p).summary.generator_mbps, 1000);
  delete p.safety.generator_mbps;
  assert.ok(validateProfile(p).ok);
  assert.equal(validateProfile(p).summary.generator_mbps, null);
  for (const bad of [0, -10, 'fast']) {
    p.safety.generator_mbps = bad;
    assert.ok(validateProfile(p).errors.some((e) => e.path === 'safety.generator_mbps'), String(bad));
  }
});

// ── per-class SLO (#43) ──────────────────────────────────────────────────────────────────────────────
test('a per-class threshold looser than the profile is refused: the brake may only get sharper', () => {
  // A brake that fires LATER than the profile asked for is worse than no brake, because somebody is
  // watching the outage it existed to cut short.
  const p = clone(example);
  p.slo.max_p95_ms = 800;
  p.classes[0].max_p95_ms = 3000;
  const r = validateProfile(p);
  assert.equal(r.ok, false);
  const e = r.errors.find((x) => x.path.includes('max_p95_ms'));
  assert.ok(e, JSON.stringify(r.errors));
  assert.match(e.message, /later than the profile/i);
});

test('a per-class failed rate looser than the profile is refused for the same reason', () => {
  const p = clone(example);
  p.slo.max_failed_rate = 0.02;
  p.classes[0].max_failed_rate = 0.5;
  const r = validateProfile(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((x) => x.path.includes('max_failed_rate')), JSON.stringify(r.errors));
});

test('a sharper per-class threshold is accepted without comment', () => {
  const p = clone(example);
  p.slo.max_p95_ms = 3000;
  p.classes[0].max_p95_ms = 800;
  const r = validateProfile(p);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(!r.warnings.some((w) => w.path.includes('max_p95_ms')), JSON.stringify(r.warnings));
});

test('a threshold tight enough to abort a healthy system is a warning, not a refusal', () => {
  // 20 ms is below what a healthy origin answers in over a real network, so the run would abort on the ramp
  // and read as a knee. It is still somebody\'s decision to make.
  const p = clone(example);
  p.classes[0].max_p95_ms = 20;
  const r = validateProfile(p);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => /abort/i.test(w.message) && w.path.includes('max_p95_ms')),
    JSON.stringify(r.warnings));
});

test('a per-class threshold that is not a number is an error', () => {
  const p = clone(example);
  p.classes[0].max_p95_ms = 'fast';
  assert.equal(validateProfile(p).ok, false);
});

test('the summary reports which per-class limits are in force', () => {
  const p = clone(example);
  p.slo.max_p95_ms = 3000;
  p.classes[0].max_p95_ms = 800;
  const cls = validateProfile(p).summary.classes.find((c) => c.name === p.classes[0].name);
  assert.equal(cls.max_p95_ms, 800, JSON.stringify(cls));
});

// ── the two fields nobody may generate for you (#42) ─────────────────────────────────────────────────
test('an allowlist declared and left empty is an error, not an empty allowlist', () => {
  // `crowdsim init` writes it empty on purpose — a generated allowlist would be the tool authorising a host
  // on somebody's behalf. So the file has to be refused until a human fills it in, or the emptiness would
  // just sit there until a run failed at the gate with no explanation of why the profile looked fine.
  const p = clone(example);
  p.safety.allow_hosts = [];
  const r = validateProfile(p);
  assert.equal(r.ok, false);
  const e = r.errors.find((x) => x.path === 'safety.allow_hosts');
  assert.ok(e, JSON.stringify(r.errors));
  assert.match(e.message, /empty/i);
});

test('a safe peak that is not a positive number is an error', () => {
  for (const bad of [null, 0, -1, 'fast']) {
    const p = clone(example);
    p.safety.safe_peak_rps = bad;
    assert.equal(validateProfile(p).ok, false, `safe_peak_rps: ${JSON.stringify(bad)}`);
  }
});

test('a profile that declares no safety block at all keeps its existing behaviour', () => {
  // Absent is not the same as declared-and-empty: an allowlist can legitimately come from
  // CROWDSIM_ALLOW_TARGETS, and the gate in the driver is what decides either way.
  const p = clone(example);
  delete p.safety;
  const r = validateProfile(p);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── the placeholders a drafted profile carries ──────────────────────────────────────────────────────
// `crowdsim init` writes TODO markers where a human has to decide, and `validate` is what stops that draft
// from being run as if it were finished. A TODO that reaches a run is not a typo: "TODO-number-of-ms" as an
// SLO makes every threshold pass, and a run that cannot brake is a run that hurts somebody for nothing.

test('a TODO left in the profile is an error naming the field, not a passing profile', () => {
  const p = clone(example);
  p.slo.max_p95_ms = 'TODO-number-of-ms';
  const r = validateProfile(p);
  const e = r.errors.find(x => x.path === 'slo.max_p95_ms');
  assert.ok(e, 'a TODO SLO passed validation: ' + JSON.stringify(r.errors));
  assert.match(e.message, /TODO|number/i);
});

test('a TODO anywhere else is reported too, with the path that carries it', () => {
  const p = clone(example);
  p.name = 'TODO-name-this-profile';
  const r = validateProfile(p);
  assert.ok(r.errors.some(x => x.path === 'name'), JSON.stringify(r.errors));
});

test('a TODO inside a _comment is not an error: that is where the instructions live', () => {
  const p = clone(example);
  p._comment = 'TODO: read this before running it';
  p.classes[0]._comment = 'TODO: weight from your edge log';
  const r = validateProfile(p);
  assert.equal(r.errors.filter(x => /TODO/i.test(x.message)).length, 0, JSON.stringify(r.errors));
});

test('a non-numeric read timeout is an error: it is the field the 504s depend on', () => {
  const p = clone(example);
  p.slo.guillotine_ms = 'soon';
  const r = validateProfile(p);
  assert.ok(r.errors.some(x => x.path === 'slo.guillotine_ms'), JSON.stringify(r.errors));
});

test('a field refused for what it is is not also reported as a TODO: one diagnosis per field', () => {
  const p = clone(example);
  p.slo.max_p95_ms = 'TODO-number-of-ms';
  const r = validateProfile(p);
  assert.equal(r.errors.filter(x => x.path === 'slo.max_p95_ms').length, 1,
    JSON.stringify(r.errors.filter(x => x.path === 'slo.max_p95_ms')));
});

// ── log_match: how `crowdsim weights` recognises a class in an access log ────────────────────────────

test('log_match must be a list of patterns, not a single pattern', () => {
  const p = clone(example);
  p.classes[0].log_match = '/news/*';
  const r = validateProfile(p);
  assert.ok(r.errors.some((x) => x.path === 'classes[0].log_match'), JSON.stringify(r.errors));
});

test('a pattern that does not start with / is refused, because it could never match', () => {
  const p = clone(example);
  p.classes[0].log_match = ['*.css'];
  const r = validateProfile(p);
  assert.ok(r.errors.some((x) => x.path === 'classes[0].log_match[0]'), JSON.stringify(r.errors));
});

test('a valid log_match is accepted and changes nothing about the run', () => {
  const p = clone(example);
  p.classes[0].log_match = ['/news/*', '/'];
  const r = validateProfile(p);
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  assert.ok(!r.warnings.some((w) => /log_match/.test(w.path)));
});

test('an empty log_match warns rather than passing as a rule', () => {
  const p = clone(example);
  p.classes[0].log_match = [];
  const r = validateProfile(p);
  assert.ok(r.warnings.some((x) => x.path === 'classes[0].log_match'), JSON.stringify(r.warnings));
});

test('rsc.query is the wrong key and the run would silently use _rsc: warn, naming the value lost', () => {
  const p = clone(example);
  delete p.rsc.param;
  p.rsc.query = 'x_nav';
  const r = validateProfile(p);
  const w = r.warnings.find((x) => x.path === 'rsc.query');
  assert.ok(w, JSON.stringify(r.warnings));
  assert.match(w.message, /x_nav/);
  // with the right key spelled correctly there is nothing to say
  const q = clone(example);
  q.rsc.param = 'x_nav';
  assert.ok(!validateProfile(q).warnings.some((x) => x.path === 'rsc.query'));
});

// ── authenticated classes ───────────────────────────────────────────────────────────────────────────
// The rules come from k6/lib/auth.js, so a profile cannot pass the lint and then fail at run time.

const authBase = {
  name: 'auth-example',
  targets: { default: 'edge', list: { edge: { base_url: 'https://www.example.test' } } },
  pools: { api: ['/api/me'] },
};

test('the new kinds are accepted', () => {
  const r = validateProfile({
    ...authBase,
    auth: { token_url: 'https://auth.example.test/token', client_id: 'web', users_csv: 'u.csv' },
    classes: [
      { name: 'login', kind: 'login', weight: 1 },
      { name: 'api', kind: 'authed', weight: 1, pool: 'api' },
    ],
  });
  assert.deepEqual(r.errors, []);
});

test('an unknown kind names the ones that exist', () => {
  const r = validateProfile({ ...authBase, classes: [{ name: 'x', kind: 'websocket', weight: 1, pool: 'api' }] });
  assert.ok(r.errors.some((e) => /login, authed, signup/.test(e.message)));
});

test('login and signup do not need a pool, every other kind does', () => {
  const r = validateProfile({
    ...authBase,
    auth: { token_url: 'x', client_id: 'web', users_csv: 'u.csv' },
    classes: [
      { name: 'login', kind: 'login', weight: 1 },
      { name: 'reg', kind: 'signup', weight: 1, signup: { url: '/api/register' } },
    ],
  });
  assert.deepEqual(r.errors, [], 'their URL comes from the auth block, not from a pool');

  const missing = validateProfile({ ...authBase, classes: [{ name: 'html', weight: 1 }] });
  assert.ok(missing.errors.some((e) => /needs a pool/.test(e.message)));
});

test('a missing token endpoint is an error, not a surprise at run time', () => {
  const r = validateProfile({ ...authBase, classes: [{ name: 'login', kind: 'login', weight: 1 }] });
  assert.ok(r.errors.some((e) => /token_url/.test(e.message)));
  assert.ok(r.errors.some((e) => /client_id/.test(e.message)));
});

test('an authed class without a login class is refused: the token has no source', () => {
  const r = validateProfile({
    ...authBase,
    auth: { token_url: 'x', client_id: 'web', users_csv: 'u.csv' },
    classes: [{ name: 'api', kind: 'authed', weight: 1, pool: 'api' }],
  });
  assert.ok(r.errors.some((e) => /needs a `login` class/.test(e.message)));
});

test('credentials missing from the profile are a WARNING: the path normally arrives at run time', () => {
  const r = validateProfile({
    ...authBase,
    auth: { token_url: 'x', client_id: 'web' },
    classes: [{ name: 'login', kind: 'login', weight: 1 }],
  });
  assert.deepEqual(r.errors, [], 'CROWDSIM_AUTH_USERS is passed when the run starts');
  assert.ok(r.warnings.some((w) => /CROWDSIM_AUTH_USERS/.test(w.message)));
});

test('logout without an endpoint is an error: sessions would pile up silently', () => {
  const r = validateProfile({
    ...authBase,
    auth: { token_url: 'x', client_id: 'web', users_csv: 'u.csv', logout: true },
    classes: [{ name: 'login', kind: 'login', weight: 1 }],
  });
  assert.ok(r.errors.some((e) => /logout_url/.test(e.message)));
});

test('the shipped example profile has no errors', () => {
  assert.deepEqual(validateProfile(example).errors, []);
});
