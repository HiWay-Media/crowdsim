/*
 * classify.js — turning a response into evidence.
 *
 * Two things live here, both pure and both easy to get subtly wrong:
 *  · cache classification per layer, from the headers the profile declares;
 *  · the difference between "this layer missed" and "this layer never spoke", which is the difference
 *    between a cache that is not working and a profile that is looking at the wrong header name.
 *
 * ES2019-compatible: this runs in k6's runtime as well as in node --test.
 */

/** k6 canonicalises header names; profiles are written by humans. Compare in lowercase. */
export function lowerKeys(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) out[k.toLowerCase()] = headers[k];
  return out;
}

/**
 * Compile `cache_headers` from the profile. `hit` is a regex on the header VALUE — nginx says HIT,
 * a CDN says "Hit from cloudfront", RFC 9211 says `hit; detail=...`, so substring matching is the only
 * thing that works across layers. Default 'hit' rather than an exact match, on purpose.
 */
export function compileLayers(cacheHeaders) {
  return (cacheHeaders || [])
    .filter((l) => l && l.label && l.header)
    .map((l) => ({ label: l.label, header: String(l.header).toLowerCase(), re: new RegExp(l.hit || 'hit', 'i') }));
}

/**
 * 1 = hit, 0 = miss, null = the header was not in the response.
 * null must NOT be recorded as a miss: a Rate fed only zeroes reports "0% hit ratio", which reads as a
 * broken cache when the truth is that this layer was never in the path (or the header name is wrong).
 */
export function layerHit(layer, headers) {
  const lower = lowerKeys(headers);
  const v = lower[layer.header];
  if (v === undefined || v === null || v === '') return null;
  return layer.re.test(String(v)) ? 1 : 0;
}

/** Counter names to bump for a status code. 5xx is cumulative: a 504 is also a 5xx. */
export function statusBuckets(status) {
  const out = [];
  if (status === 504) out.push('cs_504');
  else if (status === 502) out.push('cs_502');
  else if (status === 404) out.push('cs_404');
  else if (status === 401 || status === 403) out.push('cs_denied');
  if (status >= 500) out.push('cs_5xx');
  return out;
}

/**
 * Did this request cross the reverse proxy's read timeout? Past it a real visitor gets a 504, so this
 * share — not the average latency — is the margin you actually have.
 */
export function overGuillotine(durationMs, guillotineMs) {
  return durationMs > guillotineMs ? 1 : 0;
}
