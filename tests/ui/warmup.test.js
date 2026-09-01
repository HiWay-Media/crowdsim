/*
 * The warm-up, as the page decides it. (#53)
 *
 * Two decisions, both about safety rather than about layout, which is why they live in a module instead of
 * inside JSX:
 *
 *  · a blank warm-up rate is not "no rate": the driver uses `--start`, and a page that showed 0 or nothing
 *    would be describing a run other than the one about to happen;
 *  · a warm-up is load, so the safe ceiling applies to it. A run whose peak is inside the ceiling and whose
 *    warm-up is above it is refused by the driver with exit 3 — the page has to say so before the click,
 *    and it has to say WHICH of the two rates is the problem. Told that a 60 req/s run was refused, nobody
 *    goes looking at the warm-up field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { warmupRate, pastSafeCeiling } from '../../gui/ui/src/lib/warmup.js';
import { SAFE_PEAK, WARMUP } from '../../gui/ui/src/lib/messages.js';

test('no warm-up is null, which is not the same as a warm-up at 0', () => {
  assert.equal(warmupRate({ peak: 60, start: 15 }), null);
  assert.equal(warmupRate({ peak: 60, start: 15, warmup: '' }), null);
  assert.equal(warmupRate({ peak: 60, start: 15, warmup: '   ' }), null);
});

test('a blank warm-up rate is the ramp’s own starting rate, the way the driver reads it', () => {
  assert.equal(warmupRate({ peak: 120, start: 15, warmup: '30s' }), 15);
  assert.equal(warmupRate({ peak: 120, start: 15, warmup: '30s', warmupPeak: '' }), 15);
});

test('an explicit warm-up rate wins, including one above the peak', () => {
  assert.equal(warmupRate({ peak: 60, start: 15, warmup: '30s', warmupPeak: 40 }), 40);
  assert.equal(warmupRate({ peak: 60, start: 15, warmup: '30s', warmupPeak: '200' }), 200);
});

test('within the ceiling stays within the ceiling', () => {
  const v = pastSafeCeiling({ peak: 60, start: 15, warmup: '30s' }, 150);
  assert.deepEqual(v, { past: false, rate: null, by: null });
});

test('a warm-up above the ceiling is past it, even when the peak is not', () => {
  const v = pastSafeCeiling({ peak: 60, start: 15, warmup: '30s', warmupPeak: 400 }, 150);
  assert.equal(v.past, true);
  assert.equal(v.by, 'warmup');
  assert.equal(v.rate, 400);
});

test('the peak above the ceiling is still the peak, and both above it says both', () => {
  assert.equal(pastSafeCeiling({ peak: 900, start: 15 }, 150).by, 'peak');
  const both = pastSafeCeiling({ peak: 900, start: 15, warmup: '30s', warmupPeak: 400 }, 150);
  assert.equal(both.by, 'both');
  assert.equal(both.rate, 900, 'the highest rate the run will ask for is the number to show');
});

test('the implied warm-up rate counts too: --start above the ceiling is load above the ceiling', () => {
  // No --warmup-peak, so the warm-up runs at --start. A peak of 100 is inside a ceiling of 150 and the
  // run is still refused, by the rate nobody typed into a field called "rate".
  const v = pastSafeCeiling({ peak: 100, start: 200, warmup: '30s' }, 150);
  assert.equal(v.past, true);
  assert.equal(v.by, 'warmup');
  assert.equal(v.rate, 200);
});

test('no declared ceiling is not a ceiling of zero', () => {
  assert.deepEqual(pastSafeCeiling({ peak: 100000, start: 15 }, null), { past: false, rate: null, by: null });
  assert.deepEqual(pastSafeCeiling({ peak: 100000, start: 15 }, undefined), { past: false, rate: null, by: null });
});

test('the sentence shown for a warm-up over the ceiling names the warm-up and both rates', () => {
  const msg = SAFE_PEAK.warmupOver(400, 150);
  assert.match(msg, /warm-up/i);
  assert.match(msg, /400/);
  assert.match(msg, /150/);
  assert.match(msg, /same gate/i, 'the reason it is refused must be in the sentence, not implied');
});

test('the warm-up explanation says what it is for: the numbers, not the speed', () => {
  assert.match(WARMUP.why, /p95/);
  assert.match(WARMUP.why, /thrown? away|throws those numbers away/);
  assert.match(WARMUP.rateDefault(15), /15/);
});
