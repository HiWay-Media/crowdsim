import test from 'node:test';
import assert from 'node:assert/strict';
import { linearTrend, sloStatus, forecastP95 } from '../../lib/trend.mjs';

test('linearTrend: calculates slope for improving performance', () => {
  const runs = [
    { p95: 100 },
    { p95: 90 },
    { p95: 80 },
  ];
  const t = linearTrend(runs);
  assert(t.slope < 0, 'should have negative slope (improving)');
  assert(typeof t.intercept === 'number');
});

test('linearTrend: handles degrading performance', () => {
  const runs = [
    { p95: 50 },
    { p95: 75 },
    { p95: 100 },
  ];
  const t = linearTrend(runs);
  assert(t.slope > 0, 'should have positive slope (degrading)');
});

test('sloStatus: pass when all runs under threshold', () => {
  const runs = [{ p95: 100 }, { p95: 110 }];
  const s = sloStatus(runs, 150);
  assert.equal(s.status, 'pass');
  assert.equal(s.passing, 2);
});

test('sloStatus: fail when any run over threshold', () => {
  const runs = [{ p95: 100 }, { p95: 200 }];
  const s = sloStatus(runs, 150);
  assert.equal(s.status, 'fail');
  assert.equal(s.passing, 1);
});

test('forecastP95: predicts next value', () => {
  const trend = { slope: -10, intercept: 100 };
  const forecast = forecastP95(trend, 5);
  assert.equal(forecast, 50);
});
