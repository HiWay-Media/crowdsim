/*
 * Unit tests for response classification. The interesting case is not "was it a hit" — it is telling a
 * MISS apart from a layer that never answered, because those two produce the same number (0) and
 * opposite conclusions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerKeys, compileLayers, layerHit, statusBuckets, overGuillotine } from '../../k6/lib/classify.js';

const LAYERS = compileLayers([
  { label: 'proxy', header: 'X-Proxy-Cache', hit: 'HIT|STALE|UPDATING|REVALIDATED' },
  { label: 'cdn', header: 'X-Cache', hit: 'Hit' },
  { label: 'souin', header: 'Cache-Status', hit: 'hit' },
]);
const [proxy, cdn, souin] = LAYERS;

test('header lookup is case-insensitive: k6 canonicalises, humans do not', () => {
  assert.deepEqual(lowerKeys({ 'X-Proxy-Cache': 'HIT' }), { 'x-proxy-cache': 'HIT' });
  assert.equal(layerHit(proxy, { 'x-proxy-cache': 'HIT' }), 1);
  assert.equal(layerHit(proxy, { 'X-PROXY-CACHE': 'HIT' }), 1);
});

test('an absent header is null, NOT a miss', () => {
  // This is the whole point. A Rate fed 0 reports "0% hit ratio", which reads as a broken cache when
  // the truth may be "you are hitting the origin directly" or "the header name in the profile is wrong".
  assert.equal(layerHit(proxy, { 'x-cache': 'Hit from cloudfront' }), null);
  assert.equal(layerHit(proxy, {}), null);
  assert.equal(layerHit(proxy, { 'x-proxy-cache': '' }), null);
  assert.equal(layerHit(proxy, { 'x-proxy-cache': 'MISS' }), 0, 'present-and-miss is 0, not null');
});

test('hit patterns match how each layer actually phrases itself', () => {
  assert.equal(layerHit(proxy, { 'x-proxy-cache': 'STALE' }), 1);
  assert.equal(layerHit(proxy, { 'x-proxy-cache': 'BYPASS' }), 0);
  assert.equal(layerHit(cdn, { 'x-cache': 'Hit from cloudfront' }), 1);
  assert.equal(layerHit(cdn, { 'x-cache': 'Miss from cloudfront' }), 0);
  assert.equal(layerHit(souin, { 'cache-status': 'Souin; hit; ttl=42' }), 1, 'RFC 9211 form');
  assert.equal(layerHit(souin, { 'cache-status': 'Souin; fwd=uri-miss' }), 0);
});

test('a layer without a hit pattern falls back to matching "hit"', () => {
  const [plain] = compileLayers([{ label: 'x', header: 'CDN-Cache' }]);
  assert.equal(layerHit(plain, { 'cdn-cache': 'HIT' }), 1);
  assert.equal(layerHit(plain, { 'cdn-cache': 'miss' }), 0);
});

test('incomplete cache_headers entries are dropped instead of crashing the run', () => {
  assert.equal(compileLayers([{ label: 'a' }, { header: 'B' }, null]).length, 0);
  assert.equal(compileLayers(undefined).length, 0);
});

test('5xx counting is cumulative: a 504 is also a 5xx', () => {
  assert.deepEqual(statusBuckets(504), ['cs_504', 'cs_5xx']);
  assert.deepEqual(statusBuckets(502), ['cs_502', 'cs_5xx']);
  assert.deepEqual(statusBuckets(503), ['cs_5xx']);
  assert.deepEqual(statusBuckets(404), ['cs_404']);
  assert.deepEqual(statusBuckets(200), []);
  assert.deepEqual(statusBuckets(0), [], 'a k6 transport error must not be counted as a server error');
});

test('the guillotine is a strict threshold: it is the proxy read timeout, not a rounding', () => {
  assert.equal(overGuillotine(7001, 7000), 1);
  assert.equal(overGuillotine(7000, 7000), 0);
  assert.equal(overGuillotine(12, 7000), 0);
});
