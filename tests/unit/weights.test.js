/*
 * Access log → class mix. The parsing is the easy part; these tests are about what the command refuses to
 * infer, and about the two denominators (classified vs counted) that decide whether the printed mix
 * describes the traffic or only the part of it the profile happened to recognise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine, tokenize, clfTime, globToRegExp, hasParam,
  classifyRequest, compileRules, weightsFromLog, suggestPatterns,
} from '../../lib/weights.mjs';

const line = (path, opts) => {
  const o = opts || {};
  const status = o.status === undefined ? 200 : o.status;
  const method = o.method || 'GET';
  const time = o.time || '01/Sep/2026:12:00:00 +0000';
  return `203.0.113.10 - - [${time}] "${method} ${path} HTTP/1.1" ${status} 5120 "-" "Mozilla/5.0"`;
};

const profile = {
  rsc: { param: '_rsc' },
  pools: {
    pages: ['/', '/news', '/teams/first-team'],
    searches: ['/search?q=alpha', '/search?q=beta'],
    assets: [],
  },
  classes: [
    { name: 'rsc_search', kind: 'rsc', pool: 'searches', weight: 1 },
    { name: 'rsc_page', kind: 'rsc', pool: 'pages', weight: 1 },
    { name: 'html', kind: 'plain', pool: 'pages', weight: 1 },
    { name: 'static', kind: 'plain', pool: 'assets', weight: 1, log_match: ['/_next/static/*'] },
  ],
};

// ── the format ───────────────────────────────────────────────────────────────────────────────────────

test('a quoted request and a bracketed timestamp are single tokens', () => {
  const t = tokenize(line('/news'));
  assert.equal(t[3], '01/Sep/2026:12:00:00 +0000');
  assert.equal(t[4], 'GET /news HTTP/1.1');
  assert.equal(t[5], '200');
});

test('the request is found by shape, not by column', () => {
  // A proxy that logs an extra field first must not shift the parse onto the wrong column.
  const shifted = `svc=edge 203.0.113.10 - - [01/Sep/2026:12:00:00 +0000] "GET /news HTTP/1.1" 200 12`;
  const rec = parseLine(shifted);
  assert.equal(rec.path, '/news');
  assert.equal(rec.status, 200);
});

test('an absolute-form target keeps the path and drops the origin', () => {
  assert.equal(parseLine(line('http://www.example.test/news?x=1')).path, '/news');
  assert.equal(parseLine(line('http://www.example.test/news?x=1')).query, 'x=1');
});

test('a line with nothing request-shaped in it does not parse, rather than parsing as /', () => {
  assert.equal(parseLine('this is not an access log at all'), null);
  assert.equal(parseLine(''), null);
});

test('--format reads the columns it was given and refuses the ones it was not', () => {
  const custom = '2026-09-01T12:00:00Z GET /news 200';
  const rec = parseLine(custom, ['time', 'method', 'path', 'status']);
  assert.equal(rec.path, '/news');
  assert.equal(rec.method, 'GET');
  assert.equal(rec.status, 200);
  // `request` expects "GET /x HTTP/1.1"; handed a bare path it must fail rather than invent a method.
  assert.equal(parseLine(custom, ['time', 'request', 'path', 'status']), null);
});

test('the CLF timestamp becomes sortable, and an unknown month does not', () => {
  assert.equal(clfTime('01/Sep/2026:12:00:00 +0000'), '2026-09-01T12:00:00');
  assert.equal(clfTime('01/Xxx/2026:12:00:00 +0000'), null);
  assert.equal(clfTime('-'), null);
});

// ── the rules ────────────────────────────────────────────────────────────────────────────────────────

test('a glob is anchored and its * spans slashes', () => {
  assert.ok(globToRegExp('/_next/static/*').test('/_next/static/chunks/app.js'));
  assert.ok(!globToRegExp('/_next/static/*').test('/x/_next/static/a.js'));
  assert.ok(!globToRegExp('/news').test('/news/latest'));
});

test('the navigation parameter counts whether or not it has a value', () => {
  assert.ok(hasParam('_rsc', '_rsc'));
  assert.ok(hasParam('a=1&_rsc=1dxlt', '_rsc'));
  assert.ok(!hasParam('a=1&x_rsc=1', '_rsc'));
  assert.ok(!hasParam('', '_rsc'));
});

test('kind is a hard filter: the same path is two different classes with and without _rsc', () => {
  const rules = compileRules(profile);
  assert.equal(classifyRequest({ path: '/news', query: '' }, rules), 'html');
  assert.equal(classifyRequest({ path: '/news', query: '_rsc=1dxlt' }, rules), 'rsc_page');
});

test('a pool entry that carries its own query still matches once the navigation param is removed', () => {
  const rules = compileRules(profile);
  assert.equal(classifyRequest({ path: '/search', query: 'q=alpha&_rsc=1dxlt' }, rules), 'rsc_search');
});

test('the first matching class in profile order wins', () => {
  // rsc_search is declared before rsc_page and both could claim /search via the pages pool if it were there.
  const p = {
    rsc: { param: '_rsc' },
    pools: { a: ['/search'], b: ['/search'] },
    classes: [
      { name: 'first', kind: 'rsc', pool: 'a', weight: 1 },
      { name: 'second', kind: 'rsc', pool: 'b', weight: 1 },
    ],
  };
  assert.equal(classifyRequest({ path: '/search', query: '_rsc' }, compileRules(p)), 'first');
});

test('path_prefix matches, and the pool is read through the prefix the class adds', () => {
  const p = {
    pools: { pages: ['/', '/news'] },
    classes: [{ name: 'proxied', pool: 'pages', path_prefix: '/page', weight: 1 }],
  };
  const rules = compileRules(p);
  assert.equal(classifyRequest({ path: '/page/news', query: '' }, rules), 'proxied');
  assert.equal(classifyRequest({ path: '/news', query: '' }, rules), null);
});

test('nothing is guessed: an asset with no rule declared for it stays unclassified', () => {
  const rules = compileRules(profile);
  assert.equal(classifyRequest({ path: '/favicon.ico', query: '' }, rules), null);
  assert.equal(classifyRequest({ path: '/_next/static/chunks/app.js', query: '' }, rules), 'static');
});

test('rsc.query is accepted as a spelling of rsc.param, so a profile that used it is not silently _rsc', () => {
  const rules = compileRules({ rsc: { query: 'x_nav' }, pools: {}, classes: [] });
  assert.equal(rules.rscParam, 'x_nav');
});

// ── the tally ────────────────────────────────────────────────────────────────────────────────────────

test('weights are the share of what was classified, renormalised to 100', () => {
  const r = weightsFromLog([
    line('/news'), line('/news'), line('/'),
    line('/news?_rsc=1dxlt'),
  ], profile);
  const by = Object.fromEntries(r.classes.map((c) => [c.name, c]));
  assert.equal(by.html.count, 3);
  assert.equal(by.rsc_page.count, 1);
  assert.equal(by.html.weight, 75);
  assert.equal(by.rsc_page.weight, 25);
  assert.equal(r.classified, 4);
  assert.equal(r.unclassified.count, 0);
});

test('unclassified is a share of the COUNTED requests, not of the classified ones', () => {
  const r = weightsFromLog([line('/news'), line('/favicon.ico')], profile);
  assert.equal(r.counted, 2);
  assert.equal(r.classified, 1);
  assert.equal(r.unclassified.count, 1);
  assert.equal(r.unclassified.share, 0.5);
  // and the mix still adds up to 100 over the part it describes — which is why the share above matters
  assert.equal(r.classes.find((c) => c.name === 'html').weight, 100);
});

test('a line that could not be parsed is counted apart from one that could not be classified', () => {
  const r = weightsFromLog(['garbage', line('/favicon.ico')], profile);
  assert.equal(r.unparsed, 1);
  assert.equal(r.unparsed_share, 0.5);
  assert.equal(r.unclassified.count, 1);
  assert.equal(r.counted, 1);
  assert.deepEqual(r.unparsed_samples, ['garbage']);
});

test('non-GET and non-2xx/3xx are excluded and reported, not folded into a class', () => {
  const r = weightsFromLog([
    line('/news', { method: 'POST' }),
    line('/news', { status: 404 }),
    line('/news', { status: 301 }),
    line('/news'),
  ], profile);
  assert.equal(r.skipped.method, 1);
  assert.equal(r.skipped.status, 1);
  assert.equal(r.counted, 2);
  assert.equal(r.classes.find((c) => c.name === 'html').count, 2);
});

test('a class the log never showed gets weight 0 rather than being dropped', () => {
  const r = weightsFromLog([line('/news')], profile);
  const stat = r.classes.find((c) => c.name === 'static');
  assert.equal(stat.count, 0);
  assert.equal(stat.weight, 0);
});

test('the window comes from the log’s own timestamps', () => {
  const r = weightsFromLog([
    line('/news', { time: '01/Sep/2026:09:15:00 +0000' }),
    line('/news', { time: '01/Sep/2026:10:45:30 +0000' }),
  ], profile);
  assert.equal(r.window.from, '2026-09-01T09:15:00');
  assert.equal(r.window.to, '2026-09-01T10:45:30');
});

test('the unclassified sample is capped, and says so instead of truncating quietly', () => {
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(line(`/unknown/${i}`));
  const r = weightsFromLog(lines, profile, { maxDistinct: 5, top: 3 });
  assert.equal(r.unclassified.count, 12);
  assert.equal(r.unclassified.capped, true);
  assert.equal(r.unclassified.top.length, 3);
});

test('suggested patterns collapse to the directory, and are only ever suggestions', () => {
  assert.deepEqual(
    suggestPatterns([
      { path: '/_next/static/chunks/a.js', count: 10 },
      { path: '/_next/static/chunks/b.js', count: 5 },
      { path: '/favicon.ico', count: 1 },
    ], 2),
    ['/_next/static/chunks/*', '/*'],
  );
});

test('an empty log produces zeroes, not a division by zero', () => {
  const r = weightsFromLog([], profile);
  assert.equal(r.lines, 0);
  assert.equal(r.counted, 0);
  assert.equal(r.unclassified.share, 0);
  assert.equal(r.classes.every((c) => c.weight === 0), true);
});
