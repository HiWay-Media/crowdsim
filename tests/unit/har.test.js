/*
 * HAR → journey. The parsing is the easy part; these tests are about the three judgements.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harToJourney } from '../../lib/har.mjs';

/** Minimal HAR entry. */
function entry(url, opts) {
  const o = opts || {};
  return {
    request: { method: o.method || 'GET', url },
    response: { status: o.status === undefined ? 200 : o.status, content: { mimeType: o.mime || 'text/html' } },
    _resourceType: o.type,
  };
}

const har = (...entries) => ({ log: { entries } });

const SITE = 'https://www.example.test';

test('documents become pages, and the fan-out lands under the document that pulled it', () => {
  const { journey } = harToJourney(har(
    entry(`${SITE}/`, { type: 'document' }),
    entry(`${SITE}/app.css`, { type: 'stylesheet', mime: 'text/css' }),
    entry(`${SITE}/app.js`, { type: 'script', mime: 'application/javascript' }),
    entry(`${SITE}/news?_rsc=1a2b3c`, { mime: 'text/x-component', type: 'fetch' }),
    entry(`${SITE}/news`, { type: 'document' }),
    entry(`${SITE}/hero.webp`, { type: 'image', mime: 'image/webp' }),
  ));

  assert.equal(journey.origin, SITE);
  assert.equal(journey.pages.length, 2);
  assert.deepEqual(journey.pages[0], {
    path: '/',
    rsc: ['/news'],
    static: ['/app.css', '/app.js'],
  });
  assert.deepEqual(journey.pages[1], { path: '/news', rsc: [], static: ['/hero.webp'] });
});

test('the navigation query is stripped: the generator adds it back itself', () => {
  // Recording `_rsc=1a2b3c` verbatim would pin the run to one build's hash. rscQuery() in k6/lib decides
  // that value, and whether it repeats or is randomised, because that choice is the experiment.
  const { journey } = harToJourney(har(
    entry(`${SITE}/`, { type: 'document' }),
    entry(`${SITE}/teams?_rsc=abc123`, { mime: 'text/x-component' }),
    entry(`${SITE}/teams?_rsc=def456`, { mime: 'text/x-component' }),
  ));
  assert.deepEqual(journey.pages[0].rsc, ['/teams']);
  assert.equal(journey.rsc_query, '_rsc');
});

test('third-party hosts are dropped, and named in the report', () => {
  // Generating this traffic would point load at somebody else's infrastructure, from a tool that refuses to
  // hit a host nobody allowlisted.
  const { journey, report } = harToJourney(har(
    entry(`${SITE}/`, { type: 'document' }),
    entry('https://www.google-analytics.com/collect?v=1', { type: 'image', mime: 'image/gif' }),
    entry('https://fonts.gstatic.com/s/inter.woff2', { type: 'font', mime: 'font/woff2' }),
    entry(`${SITE}/app.css`, { type: 'stylesheet', mime: 'text/css' }),
  ));
  assert.deepEqual(journey.pages[0].static, ['/app.css']);
  assert.equal(report.dropped.third_party, 2);
  assert.deepEqual(report.dropped.third_party_hosts, ['fonts.gstatic.com', 'www.google-analytics.com']);
});

test('a parameter that varies per request is stripped; one that is constant is kept', () => {
  // This is the difference between a cache-buster and a build hash, and it is measured rather than guessed
  // from a list of names: keeping the first turns the recording into a pool of unique cold URLs, and
  // dropping the second measures a URL that does not exist.
  const { journey, report } = harToJourney(har(
    entry(`${SITE}/`, { type: 'document' }),
    entry(`${SITE}/api/live?poll=1&t=1754400000`, { type: 'fetch', mime: 'application/json' }),
    entry(`${SITE}/api/live?poll=1&t=1754400005`, { type: 'fetch', mime: 'application/json' }),
    entry(`${SITE}/app.js?build=9f2c1`, { type: 'script', mime: 'application/javascript' }),
  ));
  assert.ok(journey.pages[0].static.includes('/app.js?build=9f2c1'), journey.pages[0].static);
  assert.ok(report.stripped_params.includes('t'), report.stripped_params);
  assert.ok(!report.stripped_params.includes('build'), report.stripped_params);
});

test('a single-sample parameter that looks generated is stripped anyway', () => {
  const { report } = harToJourney(har(
    entry(`${SITE}/`, { type: 'document' }),
    entry(`${SITE}/a.js?_=1754400000123`, { type: 'script', mime: 'application/javascript' }),
  ));
  assert.deepEqual(report.stripped_params, ['_']);
});

test('failures and non-GET requests are not recorded', () => {
  // A 404 in a journey is a load test of the error page; a POST is a write, and this tool does not send
  // writes at a production system.
  const { journey, report } = harToJourney(har(
    entry(`${SITE}/`, { type: 'document' }),
    entry(`${SITE}/missing.css`, { type: 'stylesheet', mime: 'text/css', status: 404 }),
    entry(`${SITE}/api/cart`, { method: 'POST', type: 'xhr', mime: 'application/json' }),
    entry(`${SITE}/ok.css`, { type: 'stylesheet', mime: 'text/css' }),
  ));
  assert.deepEqual(journey.pages[0].static, ['/ok.css']);
  assert.equal(report.dropped.failed, 1);
  assert.equal(report.dropped.not_get, 1);
});

test('the same document visited twice is one page, keeping the richer recording', () => {
  // The second visit is served from the browser cache and would otherwise look like a page whose fan-out is
  // free — which is exactly the flattering measurement this tool exists to avoid.
  const { journey } = harToJourney(har(
    entry(`${SITE}/`, { type: 'document' }),
    entry(`${SITE}/a.css`, { type: 'stylesheet', mime: 'text/css' }),
    entry(`${SITE}/b.css`, { type: 'stylesheet', mime: 'text/css' }),
    entry(`${SITE}/other`, { type: 'document' }),
    entry(`${SITE}/`, { type: 'document' }),
  ));
  assert.equal(journey.pages.length, 2);
  const home = journey.pages.find((p) => p.path === '/');
  assert.deepEqual(home.static, ['/a.css', '/b.css']);
});

test('a recording with no HTML document produces no journey, and says so', () => {
  // Better than an empty file that a run would happily execute, measuring nothing.
  const { journey, report } = harToJourney(har(
    entry('https://api.example.test/v1/things', { type: 'xhr', mime: 'application/json' }),
  ));
  assert.equal(journey.origin, null);
  assert.deepEqual(journey.pages, []);
  assert.ok(report.dropped.no_document > 0);
});

test('the origin travels with the file, and can be forced', () => {
  const { journey } = harToJourney(har(
    entry(`${SITE}/`, { type: 'document' }),
    entry('https://staging.example.test/only-here.css', { type: 'stylesheet', mime: 'text/css' }),
  ), { origin: 'https://staging.example.test' });
  assert.equal(journey.origin, 'https://staging.example.test');
  assert.equal(journey.pages.length, 0, 'no document was recorded on the forced origin');
});

test('an empty or malformed HAR is handled, not thrown', () => {
  assert.deepEqual(harToJourney({}).journey.pages, []);
  assert.deepEqual(harToJourney(har()).journey.pages, []);
  const { report } = harToJourney(har({ request: { url: 'not a url', method: 'GET' } }));
  assert.equal(report.dropped.unparseable, 1);
});

// ── the reading pauses the recording contains (#64) ──────────────────────────────────────────────────
// Session duration is the fan-out plus the pauses, and concurrency is sessions/s × that duration: the
// pause is half of the number. The generator's default is a uniform 1-5 s nobody measured; the browser
// knows better and it is in the HAR already.

const at = (iso, ms, extra) => Object.assign(entry(`${SITE}/x`, extra || {}), {
  startedDateTime: iso, time: ms,
});

test('the pause is the gap between the last byte of a page and the next document', () => {
  const har = { log: { entries: [
    Object.assign(entry(`${SITE}/`, { type: 'document' }), { startedDateTime: '2026-09-01T12:00:00.000Z', time: 200 }),
    Object.assign(entry(`${SITE}/app.css`, { type: 'stylesheet', mime: 'text/css' }), { startedDateTime: '2026-09-01T12:00:00.300Z', time: 500 }),
    // last byte of page 1 = 12:00:00.800 ; next document at 12:00:04.800 → a 4 s pause
    Object.assign(entry(`${SITE}/news`, { type: 'document' }), { startedDateTime: '2026-09-01T12:00:04.800Z', time: 100 }),
    Object.assign(entry(`${SITE}/live`, { type: 'document' }), { startedDateTime: '2026-09-01T12:00:07.400Z', time: 100 }),
  ] } };
  const { journey, report } = harToJourney(har);
  assert.deepEqual(journey.think_time.samples, [4000, 2500]);
  assert.equal(journey.think_time.measured, true);
  assert.equal(report.think_pauses, 2);
});

test('an implausible pause is dropped, not smoothed', () => {
  const har = { log: { entries: [
    Object.assign(entry(`${SITE}/`, { type: 'document' }), { startedDateTime: '2026-09-01T12:00:00.000Z', time: 100 }),
    // the tab was left open for an hour: not a reading pause
    Object.assign(entry(`${SITE}/news`, { type: 'document' }), { startedDateTime: '2026-09-01T13:00:00.000Z', time: 100 }),
    Object.assign(entry(`${SITE}/live`, { type: 'document' }), { startedDateTime: '2026-09-01T13:00:02.000Z', time: 100 }),
  ] } };
  const { journey } = harToJourney(har);
  assert.deepEqual(journey.think_time.samples, [1900]);
});

test('a recording with one page carries no think time at all, rather than an empty one', () => {
  const har = { log: { entries: [
    Object.assign(entry(`${SITE}/`, { type: 'document' }), { startedDateTime: '2026-09-01T12:00:00.000Z', time: 100 }),
  ] } };
  const { journey } = harToJourney(har);
  assert.equal(journey.think_time, undefined);
});
