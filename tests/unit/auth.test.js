/*
 * Unit tests for the authenticated classes. These cover the failure modes that would otherwise be
 * reported as capacity results: a token that expires mid-ramp, every VU sharing one account, a signup
 * that measures conflicts instead of writes, and a profile that is missing what it needs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsersCsv, pickUser, usersNeeded, tokenRequest, logoutRequest, shouldLogout,
  parseToken, bearer, needsRelogin, expiryFrom, signupPayload, validateAuth,
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
  assert.equal(errs.length, 3, 'token_url, client_id and the credentials file');
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
