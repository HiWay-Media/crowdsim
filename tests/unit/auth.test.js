/*
 * Unit tests for the authenticated classes. These cover the failure modes that would otherwise be
 * reported as capacity results: a token that expires mid-ramp, every VU sharing one account, a signup
 * that measures conflicts instead of writes, and a profile that is missing what it needs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseUsersCsv, pickUser, usersNeeded, tokenRequest, logoutRequest, shouldLogout,
  parseToken, bearer, needsRelogin, expiryFrom, signupPayload, validateAuth, usesAuth,
  credentialsRefusal, accountSharingNote,
  signupIdentity, signupManifest, dig,
} from '../../k6/lib/auth.js';

test('parseUsersCsv skips comments, blanks and a header, and accepts semicolons', () => {
  const users = parseUsersCsv([
    '# throwaway accounts for load tests',
    'username,password',
    'user1@example.test,pw-one',
    '',
    'user2@example.test;pw-two',
    'broken-line-without-password',
  ].join('\n'));
  assert.deepEqual(users, [
    { username: 'user1@example.test', password: 'pw-one' },
    { username: 'user2@example.test', password: 'pw-two' },
  ]);
});

test('a password containing the separator survives', () => {
  const users = parseUsersCsv('u@example.test,pw,with,commas');
  assert.equal(users[0].password, 'pw,with,commas');
});

test('pickUser is deterministic and spreads VUs over the pool', () => {
  const users = [{ username: 'a' }, { username: 'b' }, { username: 'c' }];
  assert.equal(pickUser(users, 1).username, 'a');
  assert.equal(pickUser(users, 4).username, 'a');   // wraps around
  assert.equal(pickUser(users, 2).username, 'b');
  assert.equal(pickUser(users, 1).username, 'a');   // same VU, same account: reproducible
  assert.equal(pickUser([], 1), null);
});

test('usersNeeded turns a login rate into a number of accounts', () => {
  assert.equal(usersNeeded(150, 30), 4500);
  assert.equal(usersNeeded(0, 30), 1);
});

test('tokenRequest builds a password grant, and only sends the secret when there is one', () => {
  const req = tokenRequest(
    { token_url: 'https://auth.example.test/token', client_id: 'web' },
    { username: 'u@example.test', password: 'p w&x' });
  assert.equal(req.url, 'https://auth.example.test/token');
  assert.equal(req.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(req.body.includes('grant_type=password'));
  assert.ok(req.body.includes('password=p%20w%26x'), 'the password must be url-encoded');
  assert.ok(!req.body.includes('client_secret'));

  const conf = tokenRequest(
    { token_url: 'x', client_id: 'web', client_secret: 's3cr3t' }, { username: 'u', password: 'p' });
  assert.ok(conf.body.includes('client_secret=s3cr3t'));
});

test('parseToken reports a bad response instead of throwing', () => {
  assert.equal(parseToken('{"access_token":"abc","expires_in":300}').token, 'abc');
  assert.equal(parseToken('{"access_token":"abc","expires_in":300}').expiresIn, 300);
  assert.match(parseToken('<html>502</html>').error, /not JSON/);
  assert.match(parseToken('{"error":"invalid_grant","error_description":"bad password"}').error, /bad password/);
  assert.match(parseToken('{"token_type":"Bearer"}').error, /no access_token/);
});

// The k6 runtime returns undefined for res.body when response bodies are discarded (which the run
// does globally) and JSON.parse of undefined yields undefined instead of throwing: reading .error off
// it aborted the scenario mid-ramp.
test('parseToken treats an absent body as an empty one, not as an exception', () => {
  // Node throws on JSON.parse(undefined) and lands in the "not JSON" branch; the k6 runtime returns
  // undefined instead, which is why the non-object guard exists. Both must yield an error, never a throw.
  assert.ok(parseToken(undefined, 'data.access_token').error);
  assert.ok(parseToken(null, 'data.access_token').error);
  assert.match(parseToken('null').error, /empty/);
  assert.match(parseToken('"a string"').error, /empty/);
});

test('bearer does not mutate the shared base headers', () => {
  const base = { 'User-Agent': 'crowdsim' };
  const h = bearer(base, 'abc');
  assert.equal(h.Authorization, 'Bearer abc');
  assert.equal(base.Authorization, undefined, 'the base headers are shared between classes');
});

test('needsRelogin covers the three ways a token stops working', () => {
  const now = 1_000_000;
  assert.equal(needsRelogin(200, null, 0, now), true, 'no token yet');
  assert.equal(needsRelogin(401, 'abc', now + 60_000, now), true, 'rejected');
  assert.equal(needsRelogin(200, 'abc', now + 1_000, now), true, 'about to expire: refresh before it does');
  assert.equal(needsRelogin(200, 'abc', now + 60_000, now), false, 'still valid');
  assert.equal(needsRelogin(200, 'abc', 0, now), false, 'no expiry known: keep using it');
});

test('expiryFrom turns expires_in into an absolute instant', () => {
  assert.equal(expiryFrom(1000, 300), 1000 + 300_000);
  assert.equal(expiryFrom(1000, 0), 0, 'unknown expiry stays unknown, it does not become "now"');
});

test('signupPayload makes every identity unique', () => {
  const tmpl = { email_pattern: 'crowdsim+{tag}@example.test', body: { email: '{email}', name: 'load-{tag}' } };
  const a = signupPayload(tmpl, 1, 'run7');
  const b = signupPayload(tmpl, 2, 'run7');
  assert.notEqual(a.email, b.email, 'reusing an address measures the conflict, not the write');
  assert.equal(a.body.email, a.email);
  assert.equal(a.body.name, 'load-run7-1');
});

test('validateAuth stays quiet for anonymous profiles', () => {
  assert.deepEqual(validateAuth({ classes: [{ name: 'html', kind: 'html' }] }, {}), []);
});

test('validateAuth says what to fix', () => {
  const errs = validateAuth({ classes: [{ name: 'login', kind: 'login' }] }, {});
  // Two, not three: with no client_id the mode defaults to `form`, an application login endpoint,
  // which needs no client. The password grant is the one that demands it — covered further down.
  assert.equal(errs.length, 2, 'the token URL and the credentials file');
  assert.ok(errs.some((e) => /token_url/.test(e)));
  assert.ok(errs.some((e) => /CROWDSIM_AUTH_USERS/.test(e)));

  // the env variable is enough: credentials do not have to live in the profile
  const ok = validateAuth(
    { auth: { token_url: 'x', client_id: 'web' }, classes: [{ name: 'login', kind: 'login' }] },
    { CROWDSIM_AUTH_USERS: '/run/secrets/users.csv' });
  assert.deepEqual(ok, []);
});

test('an authed class without a login class is rejected: the token has no source', () => {
  const errs = validateAuth(
    { auth: { token_url: 'x', client_id: 'web', users_csv: 'u.csv' },
      classes: [{ name: 'api', kind: 'authed' }] }, {});
  assert.ok(errs.some((e) => /needs a `login` class/.test(e)));
});

test('logout is refused without an endpoint, so sessions cannot pile up silently', () => {
  const errs = validateAuth(
    { auth: { token_url: 'x', client_id: 'web', users_csv: 'u.csv', logout: true },
      classes: [{ name: 'login', kind: 'login' }] }, {});
  assert.ok(errs.some((e) => /logout_url/.test(e)));
  assert.equal(shouldLogout({ logout: true, logout_url: 'https://auth.example.test/logout' }), true);
  assert.equal(shouldLogout({ logout: true }), false);
  assert.equal(logoutRequest({ client_id: 'web' }, null), null);
});

test('usesAuth is the single answer to "does this profile sign in"', () => {
  assert.equal(usesAuth([{ kind: 'html' }, { kind: 'rsc' }]), false);
  assert.equal(usesAuth([{ kind: 'html' }, { kind: 'login' }]), true);
  assert.equal(usesAuth([{ kind: 'authed' }]), true);
  assert.equal(usesAuth([{ kind: 'signup' }]), true);
  assert.equal(usesAuth([]), false);
  assert.equal(usesAuth(undefined), false, 'a profile with no classes must not crash the guard');
  assert.equal(usesAuth([null]), false);
});

// ── two ways to sign in, and they measure different things ──────────────────────────────────────────

test('mode "form" posts to the application endpoint, with no OAuth fields', () => {
  // What a real platform's login looks like: the app takes username/password and talks to the identity
  // provider server-side. Sending grant_type or client_id here would be wrong — that is not its API.
  const r = tokenRequest(
    { token_url: 'https://www.example.test/api/auth/login' },
    { username: 'u@example.test', password: 'p' });
  assert.equal(r.body, 'username=u%40example.test&password=p');
  assert.ok(!r.body.includes('grant_type'));
  assert.ok(!r.body.includes('client_id'));
});

test('a client_id switches to the password grant, unless mode says otherwise', () => {
  const grant = tokenRequest({ token_url: 'x', client_id: 'web' }, { username: 'u', password: 'p' });
  assert.ok(grant.body.includes('grant_type=password'));
  const forced = tokenRequest({ token_url: 'x', client_id: 'web', mode: 'form' },
                              { username: 'u', password: 'p' });
  assert.ok(!forced.body.includes('grant_type'), 'mode wins over the presence of a client_id');
});

test('field names and extra fields are configurable, because login APIs disagree', () => {
  const r = tokenRequest(
    { token_url: 'x', fields: { username: 'email', password: 'pass', extra: { device: 'web' } } },
    { username: 'u@example.test', password: 'p' });
  assert.ok(r.body.includes('email=u%40example.test'));
  assert.ok(r.body.includes('pass=p'));
  assert.ok(r.body.includes('device=web'));
});

test('a JSON login body is supported, with the right content type', () => {
  const r = tokenRequest({ token_url: 'x', body: 'json' }, { username: 'u', password: 'p' });
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(r.body), { username: 'u', password: 'p' });
});

test('the token can be nested: an app endpoint wraps its payload', () => {
  const body = JSON.stringify({ data: { access_token: 'abc', expires_in: 900 } });
  const parsed = parseToken(body, 'data.access_token');
  assert.equal(parsed.token, 'abc');
  assert.equal(parsed.expiresIn, 900, 'expires_in is found under data too');
  // guessing the wrong path must say which path was tried, not "login failed"
  assert.match(parseToken(body).error, /no access_token/);
  assert.match(parseToken(body, 'token.value').error, /no token\.value/);
});

test('dig walks a dotted path and never throws on a missing branch', () => {
  assert.equal(dig({ a: { b: { c: 1 } } }, 'a.b.c'), 1);
  assert.equal(dig({ a: null }, 'a.b.c'), undefined);
  assert.equal(dig({}, ''), undefined);
});

test('client_id is required only for the password grant', () => {
  const form = validateAuth(
    { auth: { token_url: 'https://www.example.test/api/auth/login', users_csv: 'u.csv' },
      classes: [{ name: 'login', kind: 'login' }] }, {});
  assert.deepEqual(form, [], 'an application endpoint needs no client');

  const grant = validateAuth(
    { auth: { token_url: 'x', mode: 'password_grant', users_csv: 'u.csv' },
      classes: [{ name: 'login', kind: 'login' }] }, {});
  assert.ok(grant.some((e) => /client_id is required/.test(e)));

  const bogus = validateAuth(
    { auth: { token_url: 'x', mode: 'magic', users_csv: 'u.csv' },
      classes: [{ name: 'login', kind: 'login' }] }, {});
  assert.ok(bogus.some((e) => /must be "form"/.test(e)));
});

// ── the audit of 2026-09-04: three ways the authenticated classes go quiet ───────────────────────────

test('a credentials file that yields NO accounts is refused, not run', () => {
  // The bug this replaces: pickUser() returns null, login() returns false without sending anything, and
  // run_class ignores the return value — so the login class emits zero requests. A class with no requests
  // is DROPPED from per_step ("a row of zeros reads as a step that was fast") and filtered out of the
  // per-class table. The run then completes, clean, with the entire authenticated half never attempted.
  const classes = [{ name: 'login', kind: 'login' }];
  const msg = credentialsRefusal([], classes, '/secrets/users.csv');
  assert.ok(msg, 'zero accounts must refuse the run');
  assert.match(msg, /\/secrets\/users\.csv/, 'it names the file it read');
  assert.match(msg, /no accounts/i);
  // the shapes that produce it, from a file that looks fine
  assert.equal(parseUsersCsv('username,password\n').length, 0, 'header only');
  assert.equal(parseUsersCsv('# nothing here\n\n').length, 0, 'comments only');
  assert.equal(parseUsersCsv('alice bob\ncarol dave\n').length, 0, 'space-separated, no separator');
  assert.ok(credentialsRefusal(parseUsersCsv('username,password\n'), classes, 'x.csv'));
});

test('a profile that does not sign in is never refused for credentials', () => {
  assert.equal(credentialsRefusal([], [{ name: 'html', kind: 'plain' }], ''), null);
  assert.equal(credentialsRefusal([], [], ''), null);
  // and one account is enough to proceed: sharing is a caveat, not a refusal
  assert.equal(credentialsRefusal([{ username: 'a', password: 'b' }],
    [{ name: 'login', kind: 'login' }], 'x.csv'), null);
});

test('fewer accounts than virtual users is stated, because part of the result is then per-account', () => {
  // pickUser assigns by `vuId % users.length`, so 50 accounts across 400 VUs means every account is
  // signing in from 8 VUs at once. Some identity providers serialise work per subject: the ceiling you
  // measure is then partly theirs and partly your account count. usersNeeded() was written for exactly
  // this question and was never asked — it is now.
  assert.match(accountSharingNote(1, 10), /^1 account for 10 virtual users/, 'one account, not "1 accounts"');
  const note = accountSharingNote(50, 400);
  assert.ok(note, '50 accounts for 400 VUs must say so');
  assert.match(note, /50/);
  assert.match(note, /400/);
  assert.match(note, /8/, 'it names how many VUs share one account');
  // enough accounts, nothing to say
  assert.equal(accountSharingNote(400, 400), null);
  assert.equal(accountSharingNote(500, 400), null);
  assert.equal(accountSharingNote(0, 400), null, 'zero is the refusal above, not a sharing note');
});

test('a CSV header of email,password is not an account that can never log in', () => {
  // Only `username`/`user` were skipped. An `email,password` header became a credential, so one account
  // in the rotation failed every single time — with 50 accounts that is 2% of logins failing forever,
  // inside the same order of magnitude as max_failed_rate.
  assert.deepEqual(parseUsersCsv('email,password\na@x.test,pw\n'), [{ username: 'a@x.test', password: 'pw' }]);
  assert.deepEqual(parseUsersCsv('Email;Password\na@x.test;pw\n'), [{ username: 'a@x.test', password: 'pw' }]);
  // a real account whose password happens to be the word is still an account
  assert.equal(parseUsersCsv('bob,password\n').length, 1);
});

test('a signup template substitutes every placeholder, not just the first', () => {
  // String.replace with a string pattern replaces ONE occurrence, so a template that used {tag} twice
  // sent a body with a literal `{tag}` in it — a 400 from the API, read as the write path rejecting load.
  const out = signupPayload({
    email_pattern: 'u+{tag}@example.test',
    body: { email: '{email}', username: 'u-{tag}', note: '{tag}/{tag}', confirm: '{email} {email}' },
  }, 7, 'RUN');
  assert.equal(out.email, 'u+RUN-7@example.test');
  assert.equal(out.body.note, 'RUN-7/RUN-7');
  assert.equal(out.body.confirm, 'u+RUN-7@example.test u+RUN-7@example.test');
  assert.ok(!JSON.stringify(out.body).includes('{tag}'));
  assert.ok(!JSON.stringify(out.body).includes('{email}'));
});

// ── the accounts a signup run leaves behind (#65) ────────────────────────────────────────────────────

test('one run’s accounts are exactly the ones carrying its run id, and that is the cleanup key', () => {
  const id = signupIdentity({ email_pattern: 'load+{tag}@example.test' }, '20260904T120000Z');
  assert.equal(id.tag_prefix, '20260904T120000Z-');
  assert.equal(id.email_glob, 'load+20260904T120000Z-*@example.test');
  // the default pattern still produces a usable glob
  assert.equal(signupIdentity({}, 'RUN').email_glob, 'crowdsim+RUN-*@example.test');
  // and the glob matches what signupPayload actually sends
  const sent = signupPayload({ email_pattern: 'load+{tag}@example.test' }, '7-3', '20260904T120000Z');
  assert.equal(sent.email, 'load+20260904T120000Z-7-3@example.test');
  assert.ok(sent.email.startsWith('load+' + id.tag_prefix));
});

test('the manifest records what exists, and never a password', () => {
  const m = signupManifest({
    runId: '20260904T120000Z', className: 'signup', target: 'https://www.example.test',
    template: { url: '/api/auth/register', email_pattern: 'load+{tag}@example.test',
                password: 'throwaway-do-not-record', body: { password: 'also-not-recorded' } },
    emails: ['load+20260904T120000Z-1-0@example.test', 'load+20260904T120000Z-2-0@example.test'],
    failed: 3,
  });
  assert.equal(m.run_id, '20260904T120000Z');
  assert.equal(m.target, 'https://www.example.test');
  assert.equal(m.signup_url, '/api/auth/register');
  assert.equal(m.created, 2);
  assert.equal(m.failed, 3);
  assert.equal(m.emails.length, 2);
  assert.equal(m.email_glob, 'load+20260904T120000Z-*@example.test');
  // THE ASSERTION THAT MATTERS: no credential reaches this file, from any of the places one could hide
  const blob = JSON.stringify(m);
  assert.ok(!blob.includes('throwaway-do-not-record'), 'the template password must not be recorded');
  assert.ok(!blob.includes('also-not-recorded'), 'nor a password inside the body template');
  assert.ok(!/"password"/.test(blob), 'no password field at all');
});

test('the manifest says the accounts exist, that the tool will not delete them, and where it belongs', () => {
  const m = signupManifest({ runId: 'RUN', template: {} });
  assert.match(m._comment, /EXIST on the target/);
  assert.match(m._comment, /will not delete them/);
  assert.match(m._comment, /No password is recorded/i);
  assert.match(m._comment, /gitignored/);
});

test('a truncated list does not make the manifest useless: the glob still sweeps', () => {
  const m = signupManifest({ runId: 'RUN', template: {}, emails: [], created: 2970 });
  assert.equal(m.created, 2970, 'the count is what the run reported, not what the list happens to hold');
  assert.deepEqual(m.emails, []);
  assert.equal(m.email_glob, 'crowdsim+RUN-*@example.test');
});

test('junk in the list is dropped rather than written out as an identity', () => {
  const m = signupManifest({ runId: 'RUN', template: {}, emails: ['a@example.test', '', null, 42] });
  assert.deepEqual(m.emails, ['a@example.test']);
});

test('a signup-only profile needs no credentials: it creates accounts, it does not sign in', () => {
  // Introduced in 1.20.4 and found by running a signup class against a real endpoint: the refusal used
  // usesAuth(), which is true for `signup` too, so a registration run was refused for a credentials file
  // it has no use for. validateAuth() had always drawn the line correctly.
  const signupOnly = [{ name: 'signup', kind: 'signup' }, { name: 'html', kind: 'plain' }];
  assert.equal(credentialsRefusal([], signupOnly, ''), null);
  // and the line stays where it belongs: anything that SIGNS IN still needs accounts
  assert.ok(credentialsRefusal([], [{ name: 'login', kind: 'login' }], 'x.csv'));
  assert.ok(credentialsRefusal([], [{ name: 'a', kind: 'authed' }, { name: 'l', kind: 'login' }], 'x.csv'));
  // a profile that does both: the login half still decides
  assert.ok(credentialsRefusal([], [{ name: 'signup', kind: 'signup' },
    { name: 'login', kind: 'login' }], 'x.csv'));
});

// ── the half of #67 that is checkable without a target ───────────────────────────────────────────────
// `probe` verifies the premise by asking the target. Everything it needs a target for stays there — but a
// class with no URLs at all is wrong on paper, and a run that starts with it sends nothing for that class
// and then leaves it out of every table, which is the same invisibility the credentials refusal exists for.

test('an authed class that names no pool is refused before a target is involved', () => {
  const errs = validateAuth({
    auth: { token_url: 'https://x.test/token', mode: 'form', users_csv: '/tmp/u.csv' },
    pools: { api: ['/api/me'] },
    classes: [{ name: 'login', kind: 'login' }, { name: 'authed_api', kind: 'authed' }],
  }, {});
  assert.ok(errs.some((e) => /authed_api/.test(e) && /pool/.test(e)), errs.join(' | '));
});

test('an authed class whose pool is empty or absent is refused for the same reason', () => {
  for (const pools of [{ api: [] }, { other: ['/x'] }]) {
    const errs = validateAuth({
      auth: { token_url: 'https://x.test/token', mode: 'form', users_csv: '/tmp/u.csv' },
      pools,
      classes: [{ name: 'login', kind: 'login' }, { name: 'authed_api', kind: 'authed', pool: 'api' }],
    }, {});
    assert.ok(errs.some((e) => /authed_api/.test(e) && /pool/.test(e)), JSON.stringify(pools));
  }
});

test('a well-formed authed class is not refused', () => {
  const errs = validateAuth({
    auth: { token_url: 'https://x.test/token', mode: 'form', users_csv: '/tmp/u.csv' },
    pools: { api: ['/api/me'] },
    classes: [{ name: 'login', kind: 'login' }, { name: 'authed_api', kind: 'authed', pool: 'api' }],
  }, {});
  assert.deepEqual(errs, []);
});

test('membership is only claimed when the pools were actually handed over', () => {
  // The generator calls validateAuth with a SUBSET of the profile — `{ auth, classes }`, because
  // --skip-classes has already been applied to the class list. 1.24.0 added the pool-membership check
  // and read `profile.pools` from that subset, where it does not exist: every authenticated run died in
  // k6's init context with "draws from the pool \"api\", which is not in this profile", and the profile
  // was fine. It shipped because no test and no suite ever ran an authenticated class against a target.
  //
  // Two things fix it: the call site passes pools (k6/live-event.js), and this function does not claim a
  // pool is missing when it was never shown any pools.
  const errs = validateAuth({
    auth: { token_url: 'https://x.test/token', mode: 'form', users_csv: '/tmp/u.csv' },
    classes: [{ name: 'login', kind: 'login' }, { name: 'authed_api', kind: 'authed', pool: 'api' }],
  }, {});
  assert.deepEqual(errs, [], errs.join(' | '));

  // A class that names NO pool is still wrong on paper, pools or no pools.
  const errs2 = validateAuth({
    auth: { token_url: 'https://x.test/token', mode: 'form', users_csv: '/tmp/u.csv' },
    classes: [{ name: 'login', kind: 'login' }, { name: 'authed_api', kind: 'authed' }],
  }, {});
  assert.ok(errs2.some((e) => /names no pool/.test(e)), errs2.join(' | '));
});

test('the generator hands validateAuth its pools', () => {
  // Asserted against the source, because the failure above was invisible from every other angle: the
  // unit tests passed, the CLI suite passed, and the profile was valid.
  const src = readFileSync(new URL('../../k6/live-event.js', import.meta.url), 'utf8');
  const call = src.match(/validateAuth\(\{[^}]*\}/);
  assert.ok(call, 'validateAuth is no longer called with an object literal — check this test');
  assert.match(call[0], /pools/, 'live-event.js calls validateAuth without pools: every authed run dies');
});
