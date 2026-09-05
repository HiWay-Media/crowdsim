/*
 * The premise of an `authed` class: that its endpoint actually requires the token.
 *
 * This exists because a real run was green while measuring nothing. An `authed` class was pointed at an
 * endpoint that answers 200 with no `Authorization` header at all, so the class sent an anonymous GET
 * wearing a bearer token and reported p50 63 ms as an authenticated read. The login was proven; the read
 * was not, and the summary had no way to say so.
 *
 * The rule asserted here: a 401/403 to a request sent WITHOUT the token is the only evidence that the
 * class measures what it claims. Everything else is either a refusal or an explicit unknown — never a
 * quiet pass, because a quiet pass is the whole failure shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { authedTargets, premiseVerdict, renderPremise } from '../../lib/premise.mjs';

// ── which paths to try ───────────────────────────────────────────────────────────────────────────────

const PROFILE = {
  pools: { pages: ['/', '/live'], api: ['/api/me', '/api/entitlements'] },
  classes: [
    { name: 'html', kind: 'plain', pool: 'pages' },
    { name: 'login', kind: 'login' },
    { name: 'authed_api', kind: 'authed', pool: 'api' },
  ],
};

test('one path per authed class, and nothing else is probed', () => {
  const { targets, skipped } = authedTargets(PROFILE);
  assert.deepEqual(targets, [{ class: 'authed_api', pool: 'api', path: '/api/me' }]);
  assert.deepEqual(skipped, []);
});

test('a profile with no authed class has nothing to check, and says nothing', () => {
  const { targets } = authedTargets({ classes: [{ name: 'html', kind: 'plain', pool: 'pages' }] });
  assert.deepEqual(targets, []);
  assert.equal(renderPremise([]), null, 'no section at all rather than an empty heading');
});

test('an authed class with no usable pool is reported, not silently skipped', () => {
  // It cannot be probed AND it cannot run: a class with no URLs sends nothing and vanishes from every
  // table, which is the same invisibility bug the credentials refusal was written for.
  const { targets, skipped } = authedTargets({
    pools: { api: [] },
    classes: [
      { name: 'no_pool', kind: 'authed' },
      { name: 'empty_pool', kind: 'authed', pool: 'api' },
      { name: 'ghost_pool', kind: 'authed', pool: 'nope' },
    ],
  });
  assert.deepEqual(targets, []);
  assert.equal(skipped.length, 3);
  for (const s of skipped) assert.match(s.reason, /pool/);
});

// ── the verdict on one anonymous request ─────────────────────────────────────────────────────────────

test('401 or 403 without the token is the premise holding — the only thing that verifies it', () => {
  for (const status of [401, 403]) {
    const v = premiseVerdict({ status });
    assert.equal(v.verdict, 'verified');
    assert.equal(v.usable, true);
    assert.match(v.headline, /refused the request without a token/);
  }
});

test('200 without the token is the bug: the class measures an anonymous GET', () => {
  const v = premiseVerdict({ status: 200 });
  assert.equal(v.verdict, 'public');
  assert.equal(v.usable, false);
  assert.equal(v.refuse, true);
  assert.match(v.headline, /does not require the token/);
  assert.match(v.why, /anonymous GET/);
  // and it must not be softened into a hint: this is the failure shape the tool exists to avoid
  assert.doesNotMatch(v.why + v.headline, /probably|might|may be/i);
});

test('404 is the pool being wrong, which is a different fix and says so', () => {
  const v = premiseVerdict({ status: 404 });
  assert.equal(v.verdict, 'missing');
  assert.equal(v.refuse, true);
  assert.match(v.headline, /does not exist on this target/);
  assert.match(v.why, /100% failed/);
});

test('a redirect is not a refusal, and is not counted as one', () => {
  // A 302 to a login page looks like a wall; a 302 to a canonical URL that is then public looks the same
  // from here. Claiming either would be a guess, so it is an unknown with the next step named.
  const v = premiseVerdict({ status: 302 });
  assert.equal(v.verdict, 'unknown');
  assert.equal(v.usable, false);
  assert.equal(v.refuse, false, 'a redirect must not stop a probe');
  assert.match(v.why, /redirect/);
});

test('5xx and a request that never landed are unknown, never verified', () => {
  assert.equal(premiseVerdict({ status: 500 }).verdict, 'unknown');
  assert.equal(premiseVerdict({ status: 0 }).verdict, 'unknown');
  assert.equal(premiseVerdict({ error: 'connection refused' }).verdict, 'unknown');
  for (const o of [{ status: 500 }, { status: 0 }, { error: 'x' }]) {
    assert.notEqual(premiseVerdict(o).usable, true);
  }
});

// ── the section that gets printed ────────────────────────────────────────────────────────────────────

test('a verified premise is stated, because "no warning" is not evidence', () => {
  const r = renderPremise([{ class: 'authed_api', path: '/api/me', status: 401 }]);
  assert.equal(r.refused, false);
  assert.equal(r.verified, 1);
  assert.match(r.text, /authed_api/);
  assert.match(r.text, /\/api\/me/);
  assert.match(r.text, /refused the request without a token/);
});

test('one public endpoint refuses the whole section and names the class', () => {
  const r = renderPremise([
    { class: 'authed_api', path: '/api/me', status: 401 },
    { class: 'whoami', path: '/api/auth/whoami', status: 200 },
  ]);
  assert.equal(r.refused, true);
  assert.match(r.text, /whoami/);
  assert.match(r.text, /does not require the token/);
  assert.equal(r.verified, 1, 'the class that did verify is still reported as verified');
});

test('an unknown warns and does not refuse', () => {
  const r = renderPremise([{ class: 'authed_api', path: '/api/me', status: 302 }]);
  assert.equal(r.refused, false);
  assert.equal(r.verified, 0);
  assert.match(r.text, /could not be verified/);
});

test('a skipped class appears in the section even though nothing was requested for it', () => {
  const r = renderPremise([], [{ class: 'no_pool', reason: 'names no pool' }]);
  assert.equal(r.refused, true);
  assert.match(r.text, /no_pool/);
});
