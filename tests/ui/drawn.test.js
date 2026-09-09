/*
 * Which drawn page the page offers, and when it declines to.
 *
 * The archive can hand over the trend and a comparison can hand over the delta (#90). Both are produced
 * by the CLI and handed through, so the only decisions left here are *whether to offer them* — and both
 * of those decisions can be wrong in the same direction the rest of this tool refuses: offering a picture
 * of something that is not there.
 *
 *  · a trend through one run is a straight line through one point, which is the knee's own refusal;
 *  · a delta `compare` has refused must not be offered as a drawing, or the page invites somebody to
 *    look at two different experiments on one pair of axes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { trendOffer, deltaOffer } from '../../gui/ui/src/lib/drawn.js';

const run = (id, extra) => Object.assign({ run_id: id, generator_ok: true }, extra || {});

test('two runs or more is a trend', () => {
  const o = trendOffer([run('20260901T101500Z'), run('20260901T121500Z')]);
  assert.equal(o.offered, true);
  assert.equal(o.reason, null);
});

test('one run is not a trend, and it says so rather than drawing a point', () => {
  // The same refusal the knee makes about a single completed step: one point is not a curve.
  const o = trendOffer([run('20260901T101500Z')]);
  assert.equal(o.offered, false);
  assert.match(o.reason, /one run|one point/i);
});

test('an empty archive offers nothing', () => {
  for (const rows of [[], null, undefined]) {
    assert.equal(trendOffer(rows).offered, false);
  }
});

test('runs that are all discards still make a trend, and the page does not hide them', () => {
  // A discard is marked on the drawn page, not filtered out of it: "the knee did not move" and "every
  // run was thrown away" are different findings, and only one of them is visible if they are hidden.
  const o = trendOffer([run('20260901T101500Z', { generator_ok: false }),
    run('20260901T121500Z', { generator_ok: false })]);
  assert.equal(o.offered, true);
});

test('a comparison the CLI accepted can be drawn', () => {
  const o = deltaOffer({ refused: [], a: '20260901T101500Z', b: '20260901T121500Z' });
  assert.equal(o.offered, true);
  assert.equal(o.reason, null);
});

test('a comparison the CLI refused is not offered as a drawing', () => {
  const o = deltaOffer({ refused: [['different pool names', []]], a: 'x', b: 'y' });
  assert.equal(o.offered, false);
  assert.match(o.reason, /refus/i);
});

test('nothing to compare yet offers nothing', () => {
  for (const r of [null, undefined, {}]) {
    assert.equal(deltaOffer(r).offered, false);
  }
});

test('the reasons are sentences, because they appear where the button would have been', () => {
  for (const reason of [trendOffer([run('a')]).reason, deltaOffer({ refused: [['x', []]] }).reason]) {
    assert.ok(reason.length > 25, `too terse to explain anything: ${reason}`);
    assert.match(reason, /[.]$/, `not a sentence: ${reason}`);
  }
});
