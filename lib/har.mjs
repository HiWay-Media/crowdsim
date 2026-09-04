/*
 * har.mjs — turning a browser recording into a journey file.
 *
 * `--shape journey` is the mode that reproduces a visitor session: one document plus the fan-out the browser
 * actually performs. It needs a file of `{path, rsc[], static[]}` per page, and the instruction used to be
 * "record it with a real browser" with no way to turn that recording into the file. So the mode went unused,
 * and the mix shape carried load nobody clicks.
 *
 * A HAR export is exactly that recording, and every browser produces one.
 *
 * Three decisions here are about honesty rather than parsing, and each one is tested:
 *
 *  · **Third-party hosts are dropped.** Analytics, fonts and pixels are not your capacity problem, and
 *    generating them would point load at somebody else's infrastructure — from a tool whose entire premise
 *    is that you only hit hosts you have explicitly allowed.
 *  · **Per-request cache-busters are stripped, per-build ones are kept.** This is measured, not guessed from
 *    a list of parameter names: if a parameter's value VARIES across requests to the same path it is
 *    per-request noise, and keeping it would turn the recording into a pool of unique cold URLs — the pool
 *    that makes any cache look useless. A parameter that is constant is part of the URL the cache sees
 *    (a build hash), and removing it would measure a URL that does not exist.
 *  · **Failures are not recorded.** A 404 in a journey is a load test of your error page.
 *
 * Pure and dependency-free, so it is testable: no fs, no network. ES modules, node ≥ 18.
 */

/** Parameter names that are per-request by convention, used only when there is a single sample. */
const KNOWN_BUSTERS = new Set(['_', 't', 'ts', 'cb', 'cachebust', 'cache_bust', 'nocache', 'rand', 'random']);

/** A value that is a timestamp or a long random token, when we only ever saw it once. */
const LOOKS_GENERATED = /^(\d{10,13}|[0-9a-f]{16,}|[0-9a-f-]{32,})$/i;

const STATIC_EXT = /\.(css|js|mjs|cjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|txt)$/i;

const STATIC_MIME = /^(text\/css|application\/(javascript|x-javascript|json\+ld)|image\/|font\/|audio\/|video\/|application\/font)/i;

const DOC_MIME = /^text\/html/i;

/** Next.js says text/x-component for a React Server Components payload. */
const RSC_MIME = /^text\/x-component/i;

/**
 * @param {object} har            a parsed HAR document
 * @param {object} [opts]
 * @param {string} [opts.origin]  force the origin instead of inferring it from the documents
 * @param {string} [opts.rscQuery='_rsc'] the navigation query parameter this site uses
 * @param {number} [opts.maxPages=40]
 * @returns {{journey: object, report: object}}
 */
export function harToJourney(har, opts) {
  const o = opts || {};
  const rscParam = o.rscQuery || '_rsc';
  const maxPages = o.maxPages || 40;
  const entries = ((har && har.log && har.log.entries) || []).filter((e) => e && e.request && e.request.url);

  const report = {
    entries: entries.length,
    kept: 0,
    dropped: { third_party: 0, third_party_hosts: [], not_get: 0, failed: 0, unparseable: 0, no_document: 0 },
    stripped_params: [],
    pages: 0,
  };

  if (!entries.length) {
    return { journey: { origin: o.origin || null, pages: [] }, report };
  }

  // ── 1. which host is the site under test ──────────────────────────────────────────────────────────
  // The documents decide, not the first entry: a recording often starts on a redirect or a preflight.
  const parsed = [];
  for (const e of entries) {
    let url;
    try {
      url = new URL(e.request.url);
    } catch (err) {
      report.dropped.unparseable++;
      continue;
    }
    parsed.push({ e, url, kind: resourceKind(e, url, rscParam) });
  }

  let origin = o.origin || null;
  if (!origin) {
    const docHosts = new Map();
    for (const p of parsed) {
      if (p.kind !== 'document') continue;
      docHosts.set(p.url.origin, (docHosts.get(p.url.origin) || 0) + 1);
    }
    origin = [...docHosts.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || null;
  }
  if (!origin) {
    // No HTML document anywhere: this is a recording of an API session, or the filter was on when it was
    // saved. Saying so beats writing an empty journey and letting a run measure nothing.
    report.dropped.no_document = parsed.length;
    return { journey: { origin: null, pages: [] }, report };
  }

  // ── 2. same origin only, GET only, successful only ─────────────────────────────────────────────────
  const mine = [];
  const foreign = new Set();
  for (const p of parsed) {
    if (p.url.origin !== origin) {
      report.dropped.third_party++;
      foreign.add(p.url.host);
      continue;
    }
    if (String(p.e.request.method || 'GET').toUpperCase() !== 'GET') {
      report.dropped.not_get++;
      continue;
    }
    const status = (p.e.response && p.e.response.status) || 0;
    if (status >= 400 || status === 0) {
      report.dropped.failed++;
      continue;
    }
    mine.push(p);
  }
  report.dropped.third_party_hosts = [...foreign].sort();

  // ── 3. which query parameters are per-request noise ────────────────────────────────────────────────
  const seen = new Map();          // "path|param" -> Set of values
  for (const p of mine) {
    for (const [k, v] of p.url.searchParams) {
      const key = `${p.url.pathname}|${k}`;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(v);
    }
  }
  const busters = new Set();
  for (const [key, values] of seen) {
    const param = key.slice(key.indexOf('|') + 1);
    if (param === rscParam) { busters.add(key); continue; }   // the generator re-adds this one itself
    if (values.size > 1) { busters.add(key); continue; }      // measured: it varies per request
    const only = [...values][0];
    if (KNOWN_BUSTERS.has(param.toLowerCase()) || LOOKS_GENERATED.test(only)) busters.add(key);
  }
  report.stripped_params = [...new Set([...busters].map((k) => k.slice(k.indexOf('|') + 1)))].sort();

  const pathOf = (url) => {
    const kept = [];
    for (const [k, v] of url.searchParams) {
      if (busters.has(`${url.pathname}|${k}`)) continue;
      kept.push([k, v]);
    }
    if (!kept.length) return url.pathname || '/';
    const qs = kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return `${url.pathname || '/'}?${qs}`;
  };

  // ── 4. group the fan-out under the document that pulled it ─────────────────────────────────────────
  const pages = [];
  let current = null;
  for (const p of mine) {
    const path = pathOf(p.url);
    if (p.kind === 'document') {
      if (pages.length >= maxPages) break;
      current = { path, rsc: [], static: [] };
      pages.push(current);
      report.kept++;
      continue;
    }
    if (!current) continue;              // fan-out recorded before any document: nothing to attach it to
    const bucket = p.kind === 'rsc' ? current.rsc : p.kind === 'static' ? current.static : null;
    if (!bucket) continue;
    if (bucket.indexOf(path) === -1) bucket.push(path);
    report.kept++;
  }

  // A document requested twice is one page. Keep the richest recording of it: a second visit is usually
  // served from the browser cache and would look like a page with no fan-out at all.
  const byPath = new Map();
  for (const page of pages) {
    const prev = byPath.get(page.path);
    const weight = (p) => p.rsc.length + p.static.length;
    if (!prev || weight(page) > weight(prev)) byPath.set(page.path, page);
  }
  const finalPages = [...byPath.values()];
  report.pages = finalPages.length;

  // The pauses this recording contains, so the generator does not have to invent them. `measured: true` is
  // what makes a concurrency figure say "reading pauses you measured" instead of naming the tool's default.
  const pauses = thinkPauses(mine);
  report.think_pauses = pauses.length;

  const journey = {
    // The origin travels with the file: a journey is data about one site, and a journey recorded against
    // staging tells you nothing about production's routes.
    origin,
    rsc_query: rscParam,
    pages: finalPages,
  };
  if (pauses.length) journey.think_time = { samples: pauses, measured: true };

  return { journey, report };
}

/**
 * The reading pauses the recording actually contains.
 *
 * A session's duration is the fan-out plus the pauses, and concurrency is sessions/s x that duration — so
 * the pause is not a cosmetic detail, it is half of the number. The generator's default is a uniform
 * 1-5 s that nobody measured; a browser recording knows better, and it is sitting in the HAR.
 *
 * The pause between two pages is the gap between the LAST byte of everything the first page pulled and the
 * request for the next document. Anything not plausible as a human pause is dropped rather than smoothed:
 * a negative gap (overlapping requests), and anything past five minutes (the tab was left open, or the
 * recording spans a coffee break).
 */
export function thinkPauses(entries) {
  const docs = [];
  for (const p of entries) {
    const started = Date.parse((p.e && p.e.startedDateTime) || '');
    if (!isFinite(started)) continue;
    const ended = started + (Number(p.e.time) || 0);
    if (p.kind === 'document') docs.push({ started, ended, last: ended });
    else if (docs.length) {
      const cur = docs[docs.length - 1];
      if (ended > cur.last) cur.last = ended;
    }
  }
  const out = [];
  for (let i = 1; i < docs.length; i++) {
    const gap = Math.round(docs[i].started - docs[i - 1].last);
    if (gap > 0 && gap <= 300000) out.push(gap);
  }
  return out;
}

/** document | rsc | static | other */
function resourceKind(entry, url, rscParam) {
  const mime = String((entry.response && entry.response.content && entry.response.content.mimeType) || '');
  const type = String(entry._resourceType || '').toLowerCase();

  if (url.searchParams.has(rscParam) || RSC_MIME.test(mime)) return 'rsc';
  if (type === 'document' || (DOC_MIME.test(mime) && type !== 'fetch' && type !== 'xhr')) return 'document';
  if (type === 'stylesheet' || type === 'script' || type === 'image' || type === 'font' || type === 'media') {
    return 'static';
  }
  if (STATIC_MIME.test(mime) || STATIC_EXT.test(url.pathname)) return 'static';
  return 'other';
}
