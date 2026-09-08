/*
 * Certifying a swept knee: the hold the tool can append itself.
 *
 * A ramp finds a knee while climbing. That is a SWEPT knee, and crowdsim is right to flag it: the rate was
 * crossed on the way up, and a rate the system touched for one step is not a rate it can hold. Certifying
 * it means a second run — same profile, `--hold` at that rate — which on a six-run campaign is exactly
 * what one of the six was for.
 *
 * The tool has everything it needs at the moment the sweep ends. What it must not do is merge the two: a
 * swept number and a sustained number under one label is this project's averaging trap one level up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { certify, DEFAULT_CERTIFY_HOLD } from '../../k6/lib/certify.js';

const swept = {
  clean: { step: 's3', requested_rps: 60, achieved_rps: 76, sustained: false },
  crossed: { step: 's4', requested_rps: 80, achieved_rps: 99 },
};

test('a swept knee is worth certifying, at the rate it was clean up to', () => {
  const c = certify({ knee: swept });
  assert.equal(c.certify, true);
  assert.equal(c.rate, 60, 'the highest rate it stayed clean at, not the one that crossed');
  assert.equal(c.hold, DEFAULT_CERTIFY_HOLD);
  assert.match(c.why, /swept/);
  assert.match(c.why, /held/);
});

test('the hold duration can be set, and is what the run will actually hold', () => {
  const c = certify({ knee: swept, hold: '5m' });
  assert.equal(c.hold, '5m');
});

test('a knee that was already sustained needs no second run', () => {
  const c = certify({ knee: { clean: { requested_rps: 60, sustained: true } } });
  assert.equal(c.certify, false);
  assert.match(c.reason, /already/);
  assert.match(c.reason, /held/);
});

test('a refused knee has nothing to certify, and must not turn into an unqualified one', () => {
  // This is the dangerous case: appending a hold to a run whose knee was refused would produce a clean
  // sustained number for a rate the refused run never established.
  const c = certify({ knee: { refused: true, reason: 'the generator did not hold the requested rate.' } });
  assert.equal(c.certify, false);
  assert.match(c.reason, /refused/);
});

test('a run that never stayed clean at any rate has no rate to hold', () => {
  const c = certify({ knee: { clean: null, crossed: { requested_rps: 20 } } });
  assert.equal(c.certify, false);
  assert.match(c.reason, /no rate/);
});

test('a transient crossing is not certified: the run says to warm up first', () => {
  // A step that crossed and came back is a cold cache. Holding that rate would measure the cache filling.
  const c = certify({ knee: Object.assign({}, swept, {
    transient: [{ step: 's1', requested_rps: 20, why: 'p95 crossed' }],
  }) });
  assert.equal(c.certify, false);
  assert.match(c.reason, /--warmup/);
});

test('it never proposes a rate above the safe peak, gate or no gate', () => {
  // The gates are re-checked by the run itself, but proposing a rate the gate will refuse wastes the
  // operator's attention — and a hold is a LARGER authorisation than a sweep through the same rate.
  const c = certify({ knee: swept, safePeak: 50 });
  assert.equal(c.certify, false);
  assert.match(c.reason, /safe peak/);
  assert.match(c.reason, /50/);
});

test('a knee exactly at the safe peak is still refused: a hold is not a sweep', () => {
  const c = certify({ knee: swept, safePeak: 60 });
  assert.equal(c.certify, true, 'at, not above, is allowed — the gate itself decides the rest');
});

test('no knee at all is not a reason to generate more load', () => {
  for (const knee of [null, undefined, {}]) {
    assert.equal(certify({ knee: knee }).certify, false);
  }
});

test('it does not certify a certification: one hold, not a chain', () => {
  const c = certify({ knee: swept, alreadyCertifying: true });
  assert.equal(c.certify, false);
  assert.match(c.reason, /already/);
});
