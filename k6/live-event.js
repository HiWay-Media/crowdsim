/*
 * live-event.js — crowdsim load generator.
 *
 * WHY NOT hey/vegeta/wrk: those tools fire a flat list of URLs at a fixed rate. The load that actually
 *   breaks a modern SSR frontend is made of *chains*: one HTML document pulls N framework-level
 *   navigation requests (React Server Components, Turbo, Inertia, ...) plus M static assets, all served
 *   by the SAME single-threaded application process. Without the chains you measure a load that does
 *   not exist in production.
 *
 * crowdsim replays a REQUEST CLASS MIX that you measured on your own edge logs. The mix is data, not
 *   code: see profiles/example.json. Each class has a weight (its share of user requests/s), a request
 *   kind, and a URL pool. `--peak` is the total user req/s; every class gets `weight/total × peak`.
 *
 * CACHE MEASUREMENT: every response is classified against the cache headers declared in the profile
 *   (`cache_headers`), so you get a real hit ratio per layer per class — which is what you need to
 *   decide whether a shared micro-cache is worth deploying, instead of estimating it from logs.
 *
 * EMERGENCY BRAKE: thresholds with abortOnFail. The test climbs to the knee and stops. Holding an
 *   overloaded system in collapse hurts real users and adds no information.
 *
 * Every request carries `User-Agent: crowdsim/...` and `X-Crowdsim-Run: <RUN_ID>` so you can exclude
 *   the test from your own traffic forensics and recognise it in access logs.
 *
 * Not meant to be launched by hand: use `crowdsim load` (safety gates, preflight, reporting).
 */

import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// ─────────────────────────── config: everything comes from the driver ────────────────────────────────
const PROFILE_F  = __ENV.PROFILE    || '';           // resolved profile JSON (pools already inlined)
const BASE_URL   = __ENV.BASE_URL   || '';
const HOST_HDR   = __ENV.HOST_HEADER|| '';           // Host override (to hit an internal tier directly)
const RUN_ID     = __ENV.RUN_ID     || 'adhoc';
const SHAPE      = __ENV.SHAPE      || 'mix';        // mix | journey
const PEAK_RPS   = Number(__ENV.PEAK_RPS  || 60);    // total USER req/s at peak
const START_RPS  = Number(__ENV.START_RPS || 15);
const STEPS      = Number(__ENV.STEPS     || 4);
const STEP_DUR   = __ENV.STEP_DUR   || '60s';
const HOLD_DUR   = __ENV.HOLD_DUR   || '120s';
const RSC_MODE   = __ENV.RSC_MODE   || 'repeat';     // repeat (realistic) | random (cache-buster)
const TIMEOUT    = __ENV.TIMEOUT    || '10s';        // must exceed the proxy read timeout: we want to SEE 504s
const INSECURE   = (__ENV.INSECURE  || '0') === '1';
const ABORT_DELAY= __ENV.ABORT_DELAY|| '30s';        // grace period before the brake is evaluated
const JOURNEY_F  = __ENV.JOURNEY    || '';
const SUMMARY_F  = __ENV.SUMMARY_OUT|| 'summary.json';
// classes to skip, comma separated. Needed for targets that do not serve every route: hitting an
// application instance directly means the reverse-proxy-only routes answer 404, one class goes to 100%
// failed, and the brake trips at a couple of req/s making the target unusable.
const SKIP       = (__ENV.SKIP_CLASSES || '').split(',').filter((x) => x);

if (!PROFILE_F) throw new Error('PROFILE env var is required (path to a resolved profile JSON)');
if (!BASE_URL)  throw new Error('BASE_URL env var is required');

// ─────────────────────────── profile (init context: open() only here) ────────────────────────────────
const PROFILE = JSON.parse(open(PROFILE_F));

const CLASS_DEFS = (PROFILE.classes || []).filter((c) => SKIP.indexOf(c.name) === -1);
if (!CLASS_DEFS.length) throw new Error('profile has no usable classes (all skipped?)');

const WEIGHT_TOTAL = CLASS_DEFS.reduce((a, c) => a + Number(c.weight || 0), 0);
if (!(WEIGHT_TOTAL > 0)) throw new Error('profile classes have no positive weight');
// shares are recomputed over the REMAINING classes, so --peak stays the total you asked for
const SHARE = {};
for (const c of CLASS_DEFS) SHARE[c.name] = Number(c.weight) / WEIGHT_TOTAL;

const POOLS = new SharedArray('pools', function () { return [PROFILE.pools || {}]; });
function pool(name) {
  const p = POOLS[0][name];
  return (p && p.length) ? p : ['/'];
}

const JOURNEY = new SharedArray('journey', function () {
  if (!JOURNEY_F) return [];
  const j = JSON.parse(open(JOURNEY_F));
  return j.pages || [];
});

// Navigation-request query hashes. On a Next.js app the `_rsc` value depends on route+build, NOT on the
// individual request: a real event showed tens of thousands of RSC requests collapsing onto ~13 distinct
// hashes. RSC_MODE=repeat reproduces that repetitiveness — it is the premise of any "a shared micro-cache
// would absorb X% of this" claim. RSC_MODE=random measures the opposite hypothesis.
const RSC_CFG    = PROFILE.rsc || {};
const RSC_PARAM  = RSC_CFG.param || '_rsc';
const RSC_HASHES = (RSC_CFG.hashes && RSC_CFG.hashes.length) ? RSC_CFG.hashes
                 : ['1dxlt', '9y2af', 'b7k0q', 'c3m8w', 'd1p5r', 'e6t2v', 'f4h9n',
                    'g8j3s', 'h2l7x', 'j5n1z', 'k9q4b', 'm3s6d', 'p7v0g'];

const SLO = PROFILE.slo || {};
const MAX_5XX    = Number(__ENV.MAX_5XX    || SLO.max_failed_rate || 0.05);
const MAX_P95_MS = Number(__ENV.MAX_P95_MS || SLO.max_p95_ms      || 5000);
const GUILLOTINE = Number(SLO.guillotine_ms || 7000);   // proxy read timeout: past this you get a 504
const BRAKE_CLASS = SLO.brake_class || CLASS_DEFS[0].name;

// cache layers to classify, e.g. {label:"proxy", header:"X-Proxy-Cache", hit:"HIT|STALE|UPDATING"}
const CACHE_LAYERS = (PROFILE.cache_headers || []).map((l) => ({
  label: l.label, header: String(l.header).toLowerCase(), re: new RegExp(l.hit || 'hit', 'i'),
  metric: new Rate('cache_hit_' + l.label),
}));

// ─────────────────────────────── metrics ─────────────────────────────────────────────────────────────
const c504     = new Counter('cs_504');
const c502     = new Counter('cs_502');
const c5xx     = new Counter('cs_5xx');
const c404     = new Counter('cs_404');
const ttfb     = new Trend('cs_ttfb', true);
const overSlo  = new Rate('cs_over_guillotine');

// ─────────────────────────────── options ─────────────────────────────────────────────────────────────
function stages(share) {
  const out = [];
  for (let i = 1; i <= STEPS; i++) {
    const r = START_RPS + ((PEAK_RPS - START_RPS) * i) / STEPS;
    out.push({ target: Math.max(1, Math.round(r * share)), duration: STEP_DUR });
  }
  // "touch and go": climb and leave, without holding the peak
  if (!/^0s?$/.test(HOLD_DUR)) {
    out.push({ target: Math.max(1, Math.round(PEAK_RPS * share)), duration: HOLD_DUR });
  }
  return out;
}

// concurrency to provision: at the knee, requests stay in flight until the timeout cuts them
function vus(share) {
  const peak = PEAK_RPS * share;
  const tmo = parseFloat(TIMEOUT) || 10;
  return { pre: Math.max(10, Math.ceil(peak * 1.5)), max: Math.max(50, Math.ceil(peak * tmo * 1.3)) };
}

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

const scenarios = {};
if (SHAPE === 'mix') {
  for (const c of CLASS_DEFS) {
    const v = vus(SHARE[c.name]);
    scenarios[c.name] = {
      executor: 'ramping-arrival-rate',
      exec: 'run_class',
      env: { CLASS: c.name },
      startRate: Math.max(1, Math.round(START_RPS * SHARE[c.name])),
      timeUnit: '1s',
      preAllocatedVUs: v.pre,
      maxVUs: v.max,
      stages: stages(SHARE[c.name]),
      tags: { class: c.name },
    };
  }
} else {
  // journey: 1 iteration = 1 visitor session. Requests per session come from the journey file.
  const perSession = JOURNEY.length
    ? (1 + avg(JOURNEY.map((p) => (p.rsc || []).length + (p.static || []).length)) + 2)
    : 5;
  const sessRate  = Math.max(1, PEAK_RPS / perSession);
  const startSess = Math.max(1, START_RPS / perSession);
  scenarios.journey = {
    executor: 'ramping-arrival-rate',
    exec: 'fan_session',
    startRate: Math.round(startSess),
    timeUnit: '1s',
    preAllocatedVUs: Math.max(20, Math.ceil(sessRate * 10)),
    maxVUs: Math.max(100, Math.ceil(sessRate * 60)),
    stages: (function () {
      const out = [];
      for (let i = 1; i <= STEPS; i++) {
        const r = startSess + ((sessRate - startSess) * i) / STEPS;
        out.push({ target: Math.max(1, Math.round(r)), duration: STEP_DUR });
      }
      out.push({ target: Math.round(sessRate), duration: HOLD_DUR });
      return out;
    })(),
    tags: { class: 'journey' },
  };
}

// ── emergency brake + per-class sub-metrics ─────────────────────────────────────────────────────────
// In k6 a tagged sub-metric only shows up in the summary if a threshold mentions it. The `>=0`
// thresholds below are no-ops: they exist to surface p95 / errors / cache hit ratio PER CLASS, which is
// the breakdown you compare against your edge-log measurements.
const CLASS_NAMES = CLASS_DEFS.map((c) => c.name).concat(SHAPE === 'journey' ? ['journey'] : []);
const thresholds = {
  http_req_failed: [{ threshold: `rate<${MAX_5XX}`, abortOnFail: true, delayAbortEval: ABORT_DELAY }],
};
thresholds[`http_req_duration{class:${BRAKE_CLASS}}`] = [
  { threshold: `p(95)<${MAX_P95_MS}`, abortOnFail: true, delayAbortEval: ABORT_DELAY },
];
for (const cls of CLASS_NAMES) {
  const k = `http_req_duration{class:${cls}}`;
  thresholds[k] = (thresholds[k] || []).concat(['p(95)>=0']);
  thresholds[`http_req_failed{class:${cls}}`] = ['rate>=0'];
  thresholds[`cs_over_guillotine{class:${cls}}`] = ['rate>=0'];
  thresholds[`http_reqs{class:${cls}}`] = ['count>=0'];   // lets the summary skip classes never emitted
  for (const l of CACHE_LAYERS) thresholds[`cache_hit_${l.label}{class:${cls}}`] = ['rate>=0'];
}

export const options = {
  scenarios,
  discardResponseBodies: true,          // we need headers, not bodies: saves RAM on the generator
  insecureSkipTLSVerify: INSECURE,
  noConnectionReuse: false,             // browsers reuse connections; disabling it would inflate cost
  hosts: (function () {
    // the driver passes BYPASS=host=ip to skip a CDN while keeping SNI and Host correct
    if (!__ENV.BYPASS) return {};
    const [h, ip] = __ENV.BYPASS.split('=');
    const o = {}; o[h] = ip; return o;
  })(),
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ─────────────────────────────── request helpers ─────────────────────────────────────────────────────
const UA = `crowdsim/1.0 (+https://github.com/hiway-media/crowdsim; run=${RUN_ID})`;
const EXTRA_HEADERS = PROFILE.headers || {};

function baseHeaders() {
  const h = {
    'User-Agent': UA,
    'X-Crowdsim-Run': RUN_ID,
    'Accept-Encoding': 'gzip, br',
  };
  for (const k of Object.keys(EXTRA_HEADERS)) h[k] = EXTRA_HEADERS[k];
  if (HOST_HDR) h.Host = HOST_HDR;
  return h;
}

// Next.js React Server Components navigation request. Kept as a first-class kind because it is the
// request type that flat load tools cannot reproduce and that dominates real event traffic.
function rscHeaders(path) {
  const h = baseHeaders();
  h.RSC = '1';
  h['Next-Router-Prefetch'] = '1';
  h.Accept = 'text/x-component';
  h['Next-Router-State-Tree'] = encodeURIComponent(JSON.stringify(['', { children: [path, {}] }]));
  return h;
}

function rscQuery(path, idx) {
  const sep = path.includes('?') ? '&' : '?';
  if (RSC_MODE === 'random') {
    // a real cache-buster: a fresh value per request. Measures what it WOULD cost if the parameter were
    // per-request, which is the hypothesis you usually want to disprove — not a replay of reality.
    return `${path}${sep}${RSC_PARAM}=${Math.random().toString(36).slice(2, 8)}`;
  }
  return `${path}${sep}${RSC_PARAM}=${RSC_HASHES[(idx | 0) % RSC_HASHES.length]}`;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function record(res, cls) {
  ttfb.add(res.timings.waiting, { class: cls });
  overSlo.add(res.timings.duration > GUILLOTINE ? 1 : 0, { class: cls });
  const s = res.status;
  if (s === 504) c504.add(1, { class: cls });
  else if (s === 502) c502.add(1, { class: cls });
  else if (s === 404) c404.add(1, { class: cls });
  if (s >= 500) c5xx.add(1, { class: cls });

  const h = res.headers || {};
  // k6 canonicalises header names; look them up case-insensitively to stay profile-agnostic
  const lower = {};
  for (const k of Object.keys(h)) lower[k.toLowerCase()] = h[k];
  for (const l of CACHE_LAYERS) {
    const v = lower[l.header];
    if (v) l.metric.add(l.re.test(v) ? 1 : 0, { class: cls });
  }
}

function get(url, headers, cls, name) {
  const res = http.get(BASE_URL + url, { headers, tags: { class: cls, name: name }, timeout: TIMEOUT });
  record(res, cls);
  return res;
}

// ─────────────────────────── SHAPE=mix — one generic executor, driven by the profile ─────────────────
const BY_NAME = {};
for (const c of CLASS_DEFS) BY_NAME[c.name] = c;

export function run_class() {
  const c = BY_NAME[__ENV.CLASS];
  const i = exec.scenario.iterationInTest;
  let path = pick(pool(c.pool));
  if (c.path_suffix_pool) path += pick(pool(c.path_suffix_pool));
  if (c.path_prefix) path = c.path_prefix + (path === '/' ? '/' : path);

  if (c.kind === 'rsc') {
    get(rscQuery(path, i), rscHeaders(c.rsc_state_path || path), c.name, c.label || c.name);
  } else {
    get(path, baseHeaders(), c.name, c.label || c.name);
  }
}

// ─────────────────────────── SHAPE=journey — the visitor who clicks around ───────────────────────────
export function fan_session() {
  const pages = JOURNEY.length ? JOURNEY : pool('pages').map((p) => ({ path: p, rsc: [], static: [] }));
  let cur = pick(pages);

  // 1) landing: the HTML plus everything the browser pulls with it, IN PARALLEL
  get(cur.path, baseHeaders(), 'html', 'HTML');
  fanout(cur);

  // 2) 2-4 "clicks": in-app navigation without reloading the document. On a real event this is the bulk.
  const clicks = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < clicks; i++) {
    sleep(1 + Math.random() * 4);                  // visitor think time
    const next = pick(pages);
    get(rscQuery(next.path, i), rscHeaders(next.path), 'rsc_page', 'nav');
    fanout(next, true);                            // prefetch the links of the new view
    cur = next;
  }
}

function fanout(page, prefetchOnly) {
  const reqs = [];
  for (const r of (page.rsc || []).slice(0, prefetchOnly ? 4 : 8)) {
    reqs.push(['GET', BASE_URL + rscQuery(r, reqs.length),
               null, { headers: rscHeaders(r), tags: { class: 'rsc_page', name: 'prefetch' },
                       timeout: TIMEOUT }]);
  }
  if (!prefetchOnly) {
    for (const s of (page.static || []).slice(0, 6)) {
      reqs.push(['GET', BASE_URL + s,
                 null, { headers: baseHeaders(), tags: { class: 'static', name: 'static' },
                         timeout: TIMEOUT }]);
    }
  }
  if (!reqs.length) return;
  const rs = http.batch(reqs);                     // batch = concurrent, like a browser
  for (let i = 0; i < rs.length; i++) record(rs[i], reqs[i][3].tags.class);
}

// ─────────────────────────────── summary ─────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m = data.metrics || {};
  // Counters with no events do not appear in the summary at all: 0 is a result, not "n/a" → default 0
  const g = (n, f, dflt) => (m[n] && m[n].values && m[n].values[f] !== undefined
    ? m[n].values[f] : (dflt === undefined ? null : dflt));
  const cnt = (n) => g(n, 'count', 0);

  // did the brake trip? any threshold with abortOnFail that failed (the `>=0` ones are decoration)
  const anyThresholdFailed = Object.values(m).some((met) => met && met.thresholds &&
    Object.entries(met.thresholds).some(([src, t]) => !t.ok && !/>=0$/.test(src)));

  // A Rate that was never fed reports 0, which would read as "the cache missed everything" when the
  // truth is "that layer's header never appeared" — e.g. you are hitting the origin directly, or the
  // header name in the profile is wrong. Distinguish the two: no observations → null → "n/a".
  const cacheRate = (metric) => {
    const seen = (g(metric, 'passes', 0) || 0) + (g(metric, 'fails', 0) || 0);
    return seen ? g(metric, 'rate') : null;
  };

  const perClass = {};
  for (const cls of CLASS_NAMES) {
    const cache = {};
    for (const l of CACHE_LAYERS) cache[l.label] = cacheRate(`cache_hit_${l.label}{class:${cls}}`);
    perClass[cls] = {
      p95: g(`http_req_duration{class:${cls}}`, 'p(95)'),
      p99: g(`http_req_duration{class:${cls}}`, 'p(99)'),
      med: g(`http_req_duration{class:${cls}}`, 'med'),
      failed: g(`http_req_failed{class:${cls}}`, 'rate'),
      over_guillotine: g(`cs_over_guillotine{class:${cls}}`, 'rate'),
      cache: cache,
      reqs: g(`http_reqs{class:${cls}}`, 'count', 0),
      rps_target: (SHAPE === 'mix' && SHARE[cls] !== undefined)
        ? Math.round(PEAK_RPS * SHARE[cls] * 10) / 10 : null,
    };
  }

  const cacheTotal = {};
  for (const l of CACHE_LAYERS) cacheTotal[l.label] = cacheRate(`cache_hit_${l.label}`);

  const out = {
    run_id: RUN_ID,
    profile: PROFILE.name || 'unnamed',
    shape: SHAPE,
    base_url: BASE_URL,
    rsc_mode: RSC_MODE,
    peak_rps_user_target: PEAK_RPS,
    aborted: anyThresholdFailed,
    requests: cnt('http_reqs'),
    rps_avg: g('http_reqs', 'rate', 0),
    failed_rate: g('http_req_failed', 'rate', 0),
    dur: {
      p50: g('http_req_duration', 'med'), p95: g('http_req_duration', 'p(95)'),
      p99: g('http_req_duration', 'p(99)'), max: g('http_req_duration', 'max'),
    },
    guillotine_ms: GUILLOTINE,
    over_guillotine_rate: g('cs_over_guillotine', 'rate', 0),
    dropped_iterations: cnt('dropped_iterations'),
    e504: cnt('cs_504'), e502: cnt('cs_502'), e5xx: cnt('cs_5xx'), e404: cnt('cs_404'),
    cache: cacheTotal,
    per_class: perClass,
    mix_target: Object.fromEntries(CLASS_DEFS.map((c) =>
      [c.name, Math.round(PEAK_RPS * SHARE[c.name] * 10) / 10])),
  };

  // If the achieved rate is far below target, the bottleneck is the GENERATOR or its network, not the
  // system under test — and the run must be discarded, not interpreted. This is the single most common
  // way to get a confidently wrong answer out of a load test.
  out.generator_ok = !(out.dropped_iterations > 0.02 * Math.max(1, out.requests));

  // Almost everything failed AND it failed instantly. A saturated target is slow before it errors: a
  // knee shows up as latency climbing into the timeout. Near-zero latency with near-total failure means
  // the connections were refused or never routed — wrong address, wrong port, firewall, or a container
  // whose network namespace does not reach the target. Reporting that as "the brake found the knee"
  // would hand you a capacity number for a target you never touched.
  out.target_unreachable = out.failed_rate > 0.9 && (out.dur.p95 === null || out.dur.p95 < 50);

  const pct = (x) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(2) + '%');
  const ms  = (x) => (x === null || x === undefined ? 'n/a' : Math.round(x) + ' ms');
  const pad = (s, n) => String(s).padEnd(n);
  const rp  = (s, n) => String(s).padStart(n);

  let tbl = `  ${pad('class', 14)}${rp(SHAPE === 'mix' ? 'target req/s' : 'requests', 14)}${rp('p50', 9)}` +
            `${rp('p95', 10)}${rp('p99', 10)}${rp('>SLO', 8)}${rp('failed', 9)}\n`;
  tbl += '  ' + '─'.repeat(74) + '\n';
  for (const cls of CLASS_NAMES) {
    const c = perClass[cls];
    if (!c.reqs) continue;              // class not emitted by this shape: do not print empty rows
    tbl += `  ${pad(cls, 14)}${rp(c.rps_target === null ? c.reqs + ' req' : c.rps_target, 14)}` +
           `${rp(ms(c.med), 9)}${rp(ms(c.p95), 10)}${rp(ms(c.p99), 10)}` +
           `${rp(pct(c.over_guillotine), 8)}${rp(pct(c.failed), 9)}\n`;
  }

  const cacheLine = CACHE_LAYERS.length
    ? CACHE_LAYERS.map((l) => `${l.label} ${pct(cacheTotal[l.label])}`).join(' · ')
      + (CACHE_LAYERS.every((l) => cacheTotal[l.label] === null)
         ? '   ← n/a everywhere: no declared cache header was ever seen in a response' : '')
    : 'no cache_headers declared in the profile';

  const txt = `
╔══════════════════════════════════════════════════════════════════════════════╗
║  crowdsim — run ${RUN_ID}  ·  profile ${out.profile}
╚══════════════════════════════════════════════════════════════════════════════╝
  target        ${BASE_URL}   shape=${SHAPE}  rsc=${RSC_MODE}  requested peak=${PEAK_RPS} user req/s
  outcome       ${out.target_unreachable
      ? '⛔ TARGET NEVER ANSWERED — ' + pct(out.failed_rate) + ' failed at ~0 ms. This is NOT a knee:\n'
        + '                check the address, port, TLS and network path. Nothing here is a capacity number.'
      : (out.aborted ? '⛔ ABORTED by the brake (knee exceeded)'
                     : '✅ completed without crossing the thresholds')}
  volume        ${out.requests} requests · ${out.rps_avg.toFixed(1)} req/s avg
  latency       p50 ${ms(out.dur.p50)} · p95 ${ms(out.dur.p95)} · p99 ${ms(out.dur.p99)} · max ${ms(out.dur.max)}
  over ${GUILLOTINE} ms  ${pct(out.over_guillotine_rate)}   ← the proxy read timeout, i.e. where 504s come from
  errors        504: ${out.e504}   502: ${out.e502}   5xx total: ${out.e5xx}   404: ${out.e404}
  failed rate   ${pct(out.failed_rate)}
  generator     ${out.generator_ok ? '✅ held the rate' : '⛔ DID NOT hold: ' + out.dropped_iterations + ' iterations dropped → RESULT INVALID'}
  cache         ${cacheLine}

  ── per class ──
${tbl}`;
  const res = { stdout: txt };
  res[SUMMARY_F] = JSON.stringify(out, null, 2);
  return res;
}
