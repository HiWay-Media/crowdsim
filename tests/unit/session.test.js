/*
 * Sessions: think time, and how many visitors a rate implies.
 *
 * Two things are asserted here that would otherwise be plausible and wrong:
 *
 *  · **the default does not move.** A profile that declares no think time must generate exactly the traffic
 *    it generated before this existed, or every archived run stops being comparable with a new one.
 *  · **the two concurrency methods are never merged.** Little's law over a rate, and a count of sessions in
 *    flight, are two measurements of the same thing. Averaging them would hide the case where they
 *    disagree — which is the case that means the run cannot answer the question at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  thinkTime, thinkSeconds, derivedConcurrency, concurrency, concurrencyCaveat,
  DEFAULT_THINK_MS, AGREEMENT_MARGIN,
} from '../../k6/lib/session.js';

// ── think time ───────────────────────────────────────────────────────────────────────────────────────

test('a profile that declares nothing keeps the traffic it always generated', () => {
  // `sleep(1 + Math.random() * 4)` was the behaviour: 1000-5000 ms.
  const tt = thinkTime(undefined);
  assert.equal(tt.source, 'default');
  assert.equal(tt.min_ms, 1000);
  assert.equal(tt.max_ms, 5000);
  assert.deepEqual(DEFAULT_THINK_MS, { min: 1000, max: 5000 });
  // and the range maps onto the same seconds, at both ends
  assert.equal(thinkSeconds(tt, () => 0), 1);
  assert.equal(thinkSeconds(tt, () => 0.999999), 4.999996);
});

test('a declared range is used, and its midpoint is the mean a concurrency figure rests on', () => {
  const tt = thinkTime({ min_ms: 2000, max_ms: 8000 });
  assert.equal(tt.source, 'declared');
  assert.equal(tt.mean_ms, 5000);
  assert.equal(thinkSeconds(tt, () => 0.5), 5);
});

test('measured samples are picked from, not fitted to a range', () => {
  const tt = thinkTime({ samples: [500, 12000, 3000], measured: true });
  assert.equal(tt.source, 'measured');
  assert.equal(tt.min_ms, 500);
  assert.equal(tt.max_ms, 12000);
  assert.equal(tt.mean_ms, 5167);
  // every draw is one of the samples — a uniform range between 500 and 12000 would return values
  // nobody ever observed, which is the difference between a measurement and a shape.
  for (const r of [0, 0.34, 0.5, 0.99]) {
    assert.ok(tt.samples.includes(thinkSeconds(tt, () => r) * 1000), `draw at ${r}`);
  }
});

test('a nonsense range falls back to the default rather than sleeping for a negative time', () => {
  for (const bad of [{ min_ms: 5000, max_ms: 1000 }, { min_ms: -1, max_ms: 10 }, { min_ms: 'a', max_ms: 'b' },
    { samples: ['x', null] }, {}]) {
    assert.equal(thinkTime(bad).source, 'default', JSON.stringify(bad));
  }
});

// ── Little's law ─────────────────────────────────────────────────────────────────────────────────────

test('concurrency is the arrival rate times how long each one stays', () => {
  // The campaign's own arithmetic: sessions/s x mean session duration.
  assert.equal(derivedConcurrency(120, 60), 7200);
  assert.equal(derivedConcurrency(2.5, 40), 100);
});

test('a rate or a duration that is not there produces no number at all', () => {
  assert.equal(derivedConcurrency(0, 60), null);
  assert.equal(derivedConcurrency(120, 0), null);
  assert.equal(derivedConcurrency(NaN, 60), null);
  assert.equal(derivedConcurrency(120, undefined), null);
});

// ── the two methods, side by side ────────────────────────────────────────────────────────────────────

test('the two methods are reported separately and agree within the margin', () => {
  const c = concurrency({ sessionsPerSec: 100, meanSessionSeconds: 30, observedPeak: 2900, vuCeiling: 6000 });
  assert.equal(c.derived, 3000);
  assert.equal(c.observed, 2900);
  assert.equal(c.agree, true);
  assert.equal(c.note, null);
  assert.equal(AGREEMENT_MARGIN, 0.25);
});

test('a disagreement past the margin IS the finding, and neither number is blessed', () => {
  const c = concurrency({ sessionsPerSec: 100, meanSessionSeconds: 30, observedPeak: 900, vuCeiling: 6000 });
  assert.equal(c.derived, 3000);
  assert.equal(c.observed, 900);
  assert.equal(c.agree, false);
  assert.match(c.note, /disagree by more than 25%/);
  assert.match(c.note, /should be quoted until they agree/);
  // and nothing anywhere is their average
  assert.ok(!Object.values(c).includes(1950));
});

test('sessions in flight at the VU ceiling is our provisioning, not the system’s concurrency', () => {
  // The number that would otherwise be quoted as a capacity figure is the number we chose ourselves.
  const c = concurrency({ sessionsPerSec: 100, meanSessionSeconds: 30, observedPeak: 1000, vuCeiling: 1000 });
  assert.equal(c.vu_bound, true);
  assert.match(c.note, /the provisioning and not a measurement/);
  assert.equal(c.agree, null, 'no agreement is claimed when one side is void');
});

test('a run with neither a rate nor a duration is refused, naming the shape that has sessions', () => {
  const c = concurrency({ sessionsPerSec: 0, meanSessionSeconds: 0 });
  assert.equal(c.refused, true);
  assert.match(c.reason, /neither a session rate nor a session duration/);
  assert.match(c.fix, /--shape journey/);
});

// ── the caveat that travels with the number ──────────────────────────────────────────────────────────

test('the caveat names the pace, because the pace is what the number rests on', () => {
  const conc = concurrency({ sessionsPerSec: 10, meanSessionSeconds: 30, observedPeak: 300, vuCeiling: 900 });
  const dflt = concurrencyCaveat(conc, thinkTime(undefined));
  assert.match(dflt, /default reading pause/);
  assert.match(dflt, /nobody measured/);

  const measured = concurrencyCaveat(conc, thinkTime({ samples: [1000, 4000], measured: true }));
  assert.match(measured, /reading pauses you measured/);
  assert.match(measured, /1000-4000 ms/);

  // it is a conversion, not a headcount — the sentence has to say so either way
  for (const c of [dflt, measured]) assert.match(c, /not a\s+headcount|conversion of a rate/);
  assert.equal(concurrencyCaveat({ refused: true }, thinkTime(undefined)), null);
});

// ── the refusals: the same conditions under which a knee is refused ──────────────────────────────────
// A concurrency figure gets quoted in rooms this tool is not in, so these are refusals rather than
// footnotes. Each one came from a real run: the first version of this feature reported "derived 3, in
// flight 50" for a ramp the brake had cut, and called it a disagreement — the derived number was garbage
// by construction, not evidence of anything.

test('a generator that did not hold the rate has no concurrency to report', () => {
  const c = concurrency({ sessionsPerSec: 100, meanSessionSeconds: 30, observedPeak: 900, generatorOk: false });
  assert.equal(c.refused, true);
  assert.match(c.reason, /did not hold the requested rate/);
  assert.equal(c.derived, undefined, 'no number is offered alongside a refusal');
});

test('a run the brake stopped never held a steady state, and concurrency is a property of one', () => {
  const c = concurrency({ sessionsPerSec: 100, meanSessionSeconds: 30, observedPeak: 900, aborted: true });
  assert.equal(c.refused, true);
  assert.match(c.reason, /never held a steady state/);
  assert.match(c.fix, /--hold at a rate below it/);
});

test('an unreachable target: sessions that fail instantly are not visitors', () => {
  const c = concurrency({ sessionsPerSec: 100, meanSessionSeconds: 0.001, targetUnreachable: true });
  assert.equal(c.refused, true);
  assert.match(c.reason, /never really answered/);
});

test('a clean run is not refused', () => {
  const c = concurrency({ sessionsPerSec: 100, meanSessionSeconds: 30, observedPeak: 2900,
    vuCeiling: 6000, aborted: false, generatorOk: true, targetUnreachable: false });
  assert.ok(!c.refused);
  assert.equal(c.derived, 3000);
});
