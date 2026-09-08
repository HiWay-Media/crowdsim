/*
 * Requested versus delivered: the two rates a ramp has, and why one of them alone is wrong.
 *
 * `--peak` is deliberately the total USER requests per second. One user request in the mix fans out into
 * several HTTP requests, so what arrives at the target is a different, larger number: on one campaign 60
 * requested arrived as roughly 76 delivered, consistently enough that every report was translated by
 * hand before it could be quoted.
 *
 * Both numbers are true and they answer different questions — what did we drive, and what did it take.
 * A knee quoted as 60 when the system fell over at 76 is not conservative: it is wrong in the direction
 * that gets capacity bought.
 *
 * The fan-out is a property of the MIX, not of the run. Which is why two runs whose fan-out differs are
 * not comparable, and why this file refuses to report one for a run that could not hold its rate: there,
 * delivered/requested measures the generator, not the profile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { delivery, FAN_OUT_TOLERANCE, comparableFanOut } from '../../k6/lib/delivery.js';

// Three complete steps at a fan-out of 1.25, the shape that produced this.
const ROWS = [
  { step: 's1', requested_rps: 20, achieved_rps: 25, requests: 1500, partial: false },
  { step: 's2', requested_rps: 40, achieved_rps: 50, requests: 3000, partial: false },
  { step: 's3', requested_rps: 60, achieved_rps: 75, requests: 4500, partial: false },
];

test('delivered is measured, and the fan-out comes out of the two', () => {
  const d = delivery(ROWS, { generatorOk: true });
  assert.equal(d.requested_rps, 60, 'the highest rate the ramp asked for');
  assert.equal(d.delivered_rps, 75, 'measured at that step, not computed from the fan-out');
  assert.equal(d.fan_out, 1.25);
  assert.match(d.note, /HTTP requests per user request/);
});

test('the fan-out is an aggregate, not an average of per-step ratios', () => {
  // Averaging ratios weights a 2 req/s step the same as a 200 req/s one. The aggregate is total
  // delivered over total requested, which is the number that describes the traffic.
  const uneven = [
    { step: 's1', requested_rps: 1, achieved_rps: 3, requests: 60, partial: false },
    { step: 's2', requested_rps: 100, achieved_rps: 120, requests: 7200, partial: false },
  ];
  const d = delivery(uneven, { generatorOk: true });
  const meanOfRatios = (3 / 1 + 120 / 100) / 2;   // 2.1 — nonsense
  assert.notEqual(d.fan_out, Math.round(meanOfRatios * 100) / 100);
  assert.equal(d.fan_out, Math.round((123 / 101) * 100) / 100);
});

test('a partial step is never the one quoted: it is a fraction of a step, biased to its worst part', () => {
  const withPartial = ROWS.concat([
    { step: 's4', requested_rps: 80, achieved_rps: 40, requests: 300, partial: true },
  ]);
  const d = delivery(withPartial, { generatorOk: true });
  assert.equal(d.requested_rps, 60);
  assert.equal(d.delivered_rps, 75);
});

test('a generator that did not hold the rate has no fan-out to report', () => {
  // delivered/requested there measures the generator's shortfall, not the profile's fan-out — and
  // reporting it as the mix's property is how a broken run teaches somebody a wrong constant.
  const d = delivery(ROWS, { generatorOk: false });
  assert.equal(d.refused, true);
  assert.match(d.reason, /did not hold the requested rate/);
  assert.equal(d.fan_out, undefined, 'no number is offered alongside a refusal');
});

test('an unreachable target delivers nothing worth a ratio', () => {
  const d = delivery(ROWS, { generatorOk: true, targetUnreachable: true });
  assert.equal(d.refused, true);
  assert.match(d.reason, /never really answered/);
});

test('no complete step means no delivered rate, and no fallback to the requested one', () => {
  // The failure this is written against: quietly reporting the requested rate wearing the delivered
  // label, which is the original bug with an extra step.
  const d = delivery([{ step: 's1', requested_rps: 20, achieved_rps: 4, requests: 50, partial: true }],
    { generatorOk: true });
  assert.equal(d.refused, true);
  assert.equal(d.delivered_rps, undefined);
  assert.equal(d.requested_rps, undefined);
});

test('no rows at all is a refusal, not a fan-out of 1', () => {
  for (const rows of [null, [], undefined]) {
    assert.equal(delivery(rows, { generatorOk: true }).refused, true);
  }
});

// ── comparability ────────────────────────────────────────────────────────────────────────────────────

test('two runs at the same fan-out are comparable', () => {
  const c = comparableFanOut(1.25, 1.27);
  assert.equal(c.comparable, true);
  assert.equal(c.reason, null);
});

test('a fan-out that moved means the mix moved, and the two runs are not the same experiment', () => {
  const c = comparableFanOut(1.25, 1.9);
  assert.equal(c.comparable, false);
  assert.match(c.reason, /fan-out/);
  assert.match(c.reason, /1.25/);
  assert.match(c.reason, /1.9/);
  assert.equal(FAN_OUT_TOLERANCE, 0.1);
});

test('a missing fan-out on either side is unknown, not comparable-by-default', () => {
  // A run archived before this existed has no fan-out. Treating that as "the same" would silently
  // compare two experiments; treating it as different would refuse every old run. It says so instead.
  for (const pair of [[null, 1.25], [1.25, undefined], [null, null]]) {
    const c = comparableFanOut(pair[0], pair[1]);
    assert.equal(c.comparable, null, JSON.stringify(pair));
    assert.match(c.reason, /cannot be checked|does not record/);
  }
});

// ── a ratio below one is not a fan-out ───────────────────────────────────────────────────────────────
// Found by running it: a slow-origin run reported «fan-out 0.77×». The generator was fine — the TARGET
// could not keep up, so fewer HTTP requests completed than user requests were asked for. A fan-out is
// HTTP requests *per* user request and cannot be less than one; a ratio under one measures the target
// throttling us, and printing it as a property of the mix is the confident wrong answer.

test('fewer delivered than requested is reported as a shortfall, never as a fan-out', () => {
  const throttled = [
    { step: 's1', requested_rps: 2, achieved_rps: 1.8, requests: 14, partial: false },
    { step: 's2', requested_rps: 3, achieved_rps: 2.3, requests: 18, partial: false },
  ];
  const d = delivery(throttled, { generatorOk: true });
  // both rates are still facts, and still reported
  assert.equal(d.requested_rps, 3);
  assert.equal(d.delivered_rps, 2.3);
  // but the ratio is not offered as a fan-out
  assert.equal(d.fan_out, null);
  assert.equal(d.shortfall, true);
  assert.match(d.note, /fewer/);
  assert.match(d.note, /did not keep up/);
  assert.doesNotMatch(d.note, /fan-out of 0/);
});

test('a fan-out of exactly one is a fan-out, not a shortfall', () => {
  const flat = [{ step: 's1', requested_rps: 10, achieved_rps: 10, requests: 600, partial: false }];
  const d = delivery(flat, { generatorOk: true });
  assert.equal(d.fan_out, 1);
  assert.ok(!d.shortfall);
});

test('a shortfall is not comparable to a fan-out, and comparability says so', () => {
  const c = comparableFanOut(null, 1.25);
  assert.equal(c.comparable, null);
});

test('the pair quoted is the one the knee quotes: the SUSTAINED step, not the climbing one', () => {
  // Found by running it. A ramp with a hold has two complete rows at the top rate: the climbing step that
  // passed through it, and the hold that held it. Picking the first gave «12 requested → 11 arrived» in
  // the panel while the knee, reading the hold, said «12 requested, 12 delivered» — two numbers for one
  // thing in one output, which is the disagreement this project refuses everywhere else.
  const withHold = [
    { step: 's1', requested_rps: 6, achieved_rps: 6, requests: 48, partial: false },
    { step: 's2', requested_rps: 12, achieved_rps: 11, requests: 88, partial: false },
    { step: 's2h', requested_rps: 12, achieved_rps: 12, requests: 72, partial: false, sustained: true },
  ];
  const d = delivery(withHold, { generatorOk: true });
  assert.equal(d.step, 's2h', 'the held step, which is the rate worth quoting');
  assert.equal(d.requested_rps, 12);
  assert.equal(d.delivered_rps, 12);
});

test('the ratio is measured on the same rows the quoted pair comes from', () => {
  // Third thing found by running this. The pair was read off the hold (12 → 12) while the ratio was an
  // aggregate over every complete step, including the climbing ones that lag — so the panel printed
  // «12 requested → 12 arrived (fewer arrived than asked for)», contradicting itself in one line.
  // A hold is where a rate is actually held, so when there is one, that is what the ratio describes.
  const withHold = [
    { step: 's1', requested_rps: 6, achieved_rps: 5, requests: 40, partial: false },
    { step: 's2', requested_rps: 12, achieved_rps: 11, requests: 88, partial: false },
    { step: 's2h', requested_rps: 12, achieved_rps: 15, requests: 90, partial: false, sustained: true },
  ];
  const d = delivery(withHold, { generatorOk: true });
  assert.equal(d.delivered_rps, 15);
  assert.equal(d.fan_out, 1.25, 'from the held step alone, not dragged down by the ramp');
  assert.ok(!d.shortfall);
  assert.match(d.note, /held/);
});

test('with no hold at all the ratio is the aggregate over the steps that completed, and says so', () => {
  const d = delivery(ROWS, { generatorOk: true });
  assert.equal(d.fan_out, 1.25);
  assert.match(d.note, /steps that completed/);
});

test('the tolerance in `compare` is the same one this module defines', () => {
  // `compare` is python3 inside the driver, on purpose: it must work without node. That means the rule
  // exists in two languages, and the only thing keeping them together is this assertion.
  const src = readFileSync(new URL('../../bin/crowdsim', import.meta.url), 'utf8');
  const m = src.match(/FAN_OUT_TOLERANCE = ([0-9.]+)/);
  assert.ok(m, 'compare no longer names a fan-out tolerance');
  assert.equal(Number(m[1]), FAN_OUT_TOLERANCE);
});

test('a delivered rate refused for a saturated target does not blame the generator either', () => {
  const d = delivery(ROWS, {
    generatorOk: false,
    dropDiagnosis: { verdict: 'target', discard: false, retry_lower: true },
  });
  assert.equal(d.refused, true);
  assert.match(d.reason, /target could not absorb/);
  assert.doesNotMatch(d.reason, /measures the generator/);
});

test('and for a starved generator it says what it always said', () => {
  const d = delivery(ROWS, {
    generatorOk: false,
    dropDiagnosis: { verdict: 'generator', discard: true },
  });
  assert.match(d.reason, /did not hold the requested rate/);
});
