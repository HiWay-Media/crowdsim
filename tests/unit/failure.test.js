/*
 * The failure mode: which class, which status code, what share — and it goes FIRST.
 *
 * One run's report opened with «ABORTED by the brake — stopped by class html p95». The news was 6.31%
 * 404s concentrated on the frontend classes alone. Both sentences were true: a class answering 404 at
 * volume drags a p95 with it, so the brake fired on latency. But a reader who starts at that headline
 * goes looking for a slow renderer, and the renderer was fine.
 *
 * Every ingredient was already in the summary. Nothing assembled them into the sentence a reader needs
 * first, which is why this file exists rather than a wording change in the report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { failureMode, HEADLINE_SHARE } from '../../k6/lib/failure.js';

// The run that produced this issue: a 4xx concentration whose p95 crossed the SLO.
const CONCENTRATED = {
  requests: 10000,
  failed_rate: 0.0631,
  e404: 631, e5xx: 0, e502: 0, e504: 0, denied: 0,
  per_class: {
    html:      { reqs: 4000, failed: 400, errors: { e404: 400, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
    rsc_page:  { reqs: 2310, failed: 231, errors: { e404: 231, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
    static:    { reqs: 2000, failed: 0,   errors: { e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
    api:       { reqs: 1690, failed: 0,   errors: { e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0 } },
  },
};

test('a clean run has no failure mode at all, rather than an empty heading', () => {
  assert.equal(failureMode({
    requests: 5000, failed_rate: 0, e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0,
    per_class: { html: { reqs: 5000, failed: 0, errors: { e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0 } } },
  }), null);
});

test('the dominant code is named, with its share of the whole run', () => {
  const f = failureMode(CONCENTRATED);
  assert.equal(f.code, '404');
  assert.equal(f.count, 631);
  assert.equal(Math.round(f.share * 10000) / 10000, 0.0631);
  assert.match(f.line, /6\.31%/);
  assert.match(f.line, /404/);
});

test('a concentration is named as one, and the classes are listed', () => {
  const f = failureMode(CONCENTRATED);
  assert.equal(f.concentrated, true);
  assert.deepEqual(f.classes.sort(), ['html', 'rsc_page']);
  assert.match(f.line, /html/);
  assert.match(f.line, /rsc_page/);
  assert.match(f.line, /concentrated/);
  // and it says how many of how many, because "two classes" means nothing without the denominator
  assert.match(f.line, /2 of 4/);
});

test('the same code spread evenly is a different finding, and does not claim concentration', () => {
  const even = {
    requests: 4000, failed_rate: 0.1,
    e404: 0, e5xx: 400, e502: 0, e504: 0, denied: 0,
    per_class: {
      a: { reqs: 1000, failed: 100, errors: { e404: 0, e5xx: 100, e502: 0, e504: 0, denied: 0 } },
      b: { reqs: 1000, failed: 100, errors: { e404: 0, e5xx: 100, e502: 0, e504: 0, denied: 0 } },
      c: { reqs: 1000, failed: 100, errors: { e404: 0, e5xx: 100, e502: 0, e504: 0, denied: 0 } },
      d: { reqs: 1000, failed: 100, errors: { e404: 0, e5xx: 100, e502: 0, e504: 0, denied: 0 } },
    },
  };
  const f = failureMode(even);
  assert.equal(f.code, '5xx');
  assert.equal(f.concentrated, false);
  assert.match(f.line, /every class/);
  assert.doesNotMatch(f.line, /concentrated on/, 'it may say it is NOT concentrated, never that it is');
});

test('a handful of errors in a large run is not a headline', () => {
  // Otherwise the line appears on every run and stops being read — the fate of any banner that is always
  // there. The threshold is a share, not a count: 3 in 10,000 is noise, 3 in 30 is the story.
  const f = failureMode({
    requests: 10000, failed_rate: 0.0003, e404: 3, e5xx: 0, e502: 0, e504: 0, denied: 0,
    per_class: { html: { reqs: 10000, failed: 3, errors: { e404: 3, e5xx: 0, e502: 0, e504: 0, denied: 0 } } },
  });
  assert.equal(f, null);
  assert.equal(HEADLINE_SHARE, 0.005);
});

test('the same handful IS a headline when the brake stopped the run', () => {
  // If a run was aborted, whatever failed is material by definition: it is what the abort was about.
  const f = failureMode({
    requests: 300, failed_rate: 0.01, aborted: true,
    e404: 3, e5xx: 0, e502: 0, e504: 0, denied: 0,
    per_class: { html: { reqs: 300, failed: 3, errors: { e404: 3, e5xx: 0, e502: 0, e504: 0, denied: 0 } } },
  });
  assert.ok(f);
  assert.equal(f.code, '404');
});

test('the codes are told apart, because they send you to different places', () => {
  const base = { requests: 1000, failed_rate: 0.2, e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0 };
  const cls = (errs) => ({ per_class: { a: { reqs: 1000, failed: 200, errors: Object.assign(
    { e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0 }, errs) } } });
  for (const [key, code] of [['e504', '504'], ['e502', '502'], ['e5xx', '5xx'], ['denied', '401/403'],
    ['e404', '404']]) {
    const s = Object.assign({}, base, { [key]: 200 }, cls({ [key]: 200 }));
    assert.equal(failureMode(s).code, code, key);
  }
});

test('a 504 outranks a 404 at the same count: a read timeout is the more specific finding', () => {
  const s = {
    requests: 1000, failed_rate: 0.2,
    e404: 100, e504: 100, e5xx: 100, e502: 0, denied: 0,
    per_class: { a: { reqs: 1000, failed: 200,
      errors: { e404: 100, e504: 100, e5xx: 100, e502: 0, denied: 0 } } },
  };
  // cs_5xx counts the 504s too, so picking by raw count alone would report "5xx" and lose the timeout.
  assert.equal(failureMode(s).code, '504');
});

test('failures with no code attached are still reported, as failures', () => {
  // http_req_failed can be non-zero with every counter at zero: a connection that never got a status.
  const f = failureMode({
    requests: 1000, failed_rate: 0.5, e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0,
    per_class: { a: { reqs: 1000, failed: 500, errors: { e404: 0, e5xx: 0, e502: 0, e504: 0, denied: 0 } } },
  });
  assert.ok(f);
  assert.equal(f.code, 'no status');
  assert.match(f.line, /never returned a status/);
});

test('it reads the summary and nothing else: no counter, no line', () => {
  assert.equal(failureMode(null), null);
  assert.equal(failureMode({}), null);
  assert.equal(failureMode({ requests: 0, per_class: {} }), null);
});
