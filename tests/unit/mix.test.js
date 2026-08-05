/*
 * Unit tests for the load arithmetic. These are the numbers that decide how much traffic you generate:
 * a bug here does not throw, it produces a test that measured something other than what you asked for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  usableClasses, shares, stages, vus, isZeroDuration, requestsPerSession, journeyPlan,
  rscQuery, classPath, DEFAULT_RSC_HASHES,
} from '../../k6/lib/mix.js';

const CLASSES = [
  { name: 'rsc_page', weight: 43.2 },
  { name: 'html', weight: 23.2 },
  { name: 'rsc_search', weight: 22.9 },
  { name: 'static', weight: 9.8 },
  { name: 'proxy_only', weight: 0.9 },
];

test('shares sum to 1 and keep the measured proportions', () => {
  const s = shares(CLASSES);
  assert.equal(Object.keys(s).length, 5);
  assert.ok(Math.abs(Object.values(s).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(s.rsc_page - 0.432) < 1e-9);
});

test('skipping a class renormalises the mix, so --peak still means the total', () => {
  // The app-instance target skips proxy-only routes. If the shares were not renormalised, asking for
  // 100 req/s would silently generate 99.1 — and every comparison against another target would be off.
  const kept = usableClasses(CLASSES, ['proxy_only']);
  const s = shares(kept);
  assert.equal(Object.keys(s).length, 4);
  assert.ok(Math.abs(Object.values(s).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(s.rsc_page > 0.432, 'the remaining classes must absorb the skipped share');
});

test('a profile with every class skipped is an error, not an empty run', () => {
  assert.throws(() => usableClasses(CLASSES, CLASSES.map((c) => c.name)), /no usable classes/);
});

test('classes without positive weight are rejected instead of dividing by zero', () => {
  assert.throws(() => shares([{ name: 'a', weight: 0 }]), /no positive weight/);
  assert.throws(() => shares([{ name: 'a' }]), /no positive weight/);
});

test('the ramp climbs to the peak in the requested number of steps, then holds', () => {
  const st = stages({ steps: 4, startRps: 20, peakRps: 60, stepDur: '60s', holdDur: '120s', share: 1 });
  assert.equal(st.length, 5);
  assert.deepEqual(st.map((s) => s.target), [30, 40, 50, 60, 60]);
  assert.equal(st[4].duration, '120s');
});

test('hold=0s means climb and leave: no hold stage at all (--touch-and-go)', () => {
  const st = stages({ steps: 3, startRps: 10, peakRps: 40, stepDur: '20s', holdDur: '0s', share: 1 });
  assert.equal(st.length, 3);
  assert.equal(st[st.length - 1].target, 40);
  assert.ok(isZeroDuration('0s') && isZeroDuration('0') && !isZeroDuration('30s'));
});

test('a class with a tiny share still sends at least 1 req/s', () => {
  // proxy_only is 0.9% of the mix: at peak 60 its share is 0.54 req/s. Rounding to 0 would drop the
  // long tail of the mix silently, and the tail is often the expensive part.
  const st = stages({ steps: 2, startRps: 5, peakRps: 60, stepDur: '30s', holdDur: '60s', share: 0.009 });
  assert.ok(st.every((s) => s.target >= 1), JSON.stringify(st));
});

test('maxVUs is provisioned on rate x timeout, not on a healthy response time', () => {
  // At the knee requests sit in flight until the timeout cuts them. Sizing VUs for the healthy case
  // makes k6 run out of VUs exactly when the target starts queueing: the generator then fails to hold
  // the rate and the run is invalid for the most avoidable reason there is.
  const v = vus({ peakRps: 100, share: 1, timeout: '10s' });
  assert.equal(v.pre, 150);
  assert.equal(v.max, 1300);
  const small = vus({ peakRps: 1, share: 0.01, timeout: '10s' });
  assert.equal(small.pre, 10, 'floors keep tiny classes runnable');
  assert.equal(small.max, 50);
});

test('journey: the peak stays in user requests/s, sessions are derived from the fan-out', () => {
  const pages = [{ path: '/', rsc: ['/a', '/b'], static: ['/s1'] }, { path: '/x', rsc: ['/c'], static: [] }];
  assert.equal(requestsPerSession(pages), 1 + 2 + 2);          // 1 doc + avg fan-out 2 + ~2 navigations
  assert.equal(requestsPerSession([]), 5);                      // no journey file: conservative default
  const plan = journeyPlan({ pages, peakRps: 50, startRps: 10, steps: 2, stepDur: '30s', holdDur: '60s' });
  assert.equal(plan.perSession, 5);
  assert.equal(plan.sessRate, 10);
  assert.equal(plan.stages.length, 3);
  assert.equal(plan.stages[plan.stages.length - 1].target, 10);
});

test('rsc repeat mode collapses onto the profile hashes — the premise of any cache claim', () => {
  const urls = new Set();
  for (let i = 0; i < 500; i++) urls.add(rscQuery('/news', i, { mode: 'repeat', hashes: ['aa', 'bb'] }));
  assert.deepEqual([...urls].sort(), ['/news?_rsc=aa', '/news?_rsc=bb']);
});

test('rsc random mode is a real cache-buster: a distinct URL per request', () => {
  let n = 0;
  const rand = () => 0.123456789 + (n++) * 1e-6;              // injected: deterministic, still distinct
  const a = rscQuery('/news', 0, { mode: 'random', rand });
  const b = rscQuery('/news', 0, { mode: 'random', rand });
  assert.notEqual(a, b);
  assert.match(a, /^\/news\?_rsc=[a-z0-9]+$/);
});

test('rsc keeps an existing query string instead of corrupting it', () => {
  const u = rscQuery('/search?q=alpha', 0, { mode: 'repeat', hashes: ['aa'] });
  assert.equal(u, '/search?q=alpha&_rsc=aa');
});

test('rsc respects a custom param name and defaults to the shipped hashes', () => {
  assert.equal(rscQuery('/', 1, { param: '_flight', hashes: ['zz'] }), '/?_flight=zz');
  assert.equal(rscQuery('/', 0, {}), '/?_rsc=' + DEFAULT_RSC_HASHES[0]);
  assert.equal(rscQuery('/', -3, { hashes: ['a', 'b'] }), '/?_rsc=b', 'a negative index must not yield undefined');
});

test('classPath applies suffix pool and prefix without producing a double slash', () => {
  assert.equal(classPath({ name: 'a' }, '/news'), '/news');
  assert.equal(classPath({ path_suffix_pool: 'p' }, '/news', '/page/2'), '/news/page/2');
  assert.equal(classPath({ path_prefix: '/page' }, '/news'), '/page/news');
  assert.equal(classPath({ path_prefix: '/page' }, '/'), '/page/');
});
