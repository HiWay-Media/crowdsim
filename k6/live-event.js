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
 *
 * The arithmetic (ramp, shares, VU provisioning), the cache classification and the summary verdict live
 * in k6/lib/*.js so they can be unit-tested with `node --test` — a load generator whose maths is only
 * exercised by generating load is a generator nobody can trust. See tests/unit/.
 */

import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { usableClasses, shares, stages as mkStages, vus as mkVus, journeyPlan, rscQuery as mkRscQuery,
         classPath, DEFAULT_RSC_HASHES } from './lib/mix.js';
import { compileLayers, layerHit, statusBuckets, overGuillotine } from './lib/classify.js';
import { buildSummary, renderSummaryText } from './lib/summary.js';

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

const CLASS_DEFS = usableClasses(PROFILE.classes, SKIP);
// shares are recomputed over the REMAINING classes, so --peak stays the total you asked for
const SHARE = shares(CLASS_DEFS);

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
const RSC_OPTS   = {
  mode: RSC_MODE,
  param: RSC_CFG.param || '_rsc',
  hashes: (RSC_CFG.hashes && RSC_CFG.hashes.length) ? RSC_CFG.hashes : DEFAULT_RSC_HASHES,
};

const SLO = PROFILE.slo || {};
const MAX_5XX    = Number(__ENV.MAX_5XX    || SLO.max_failed_rate || 0.05);
const MAX_P95_MS = Number(__ENV.MAX_P95_MS || SLO.max_p95_ms      || 5000);
const GUILLOTINE = Number(SLO.guillotine_ms || 7000);   // proxy read timeout: past this you get a 504
const BRAKE_CLASS = SLO.brake_class || CLASS_DEFS[0].name;

// cache layers to classify, e.g. {label:"proxy", header:"X-Proxy-Cache", hit:"HIT|STALE|UPDATING"}
const CACHE_LAYERS = compileLayers(PROFILE.cache_headers).map((l) => {
  l.metric = new Rate('cache_hit_' + l.label);
  return l;
});
const CACHE_LABELS = CACHE_LAYERS.map((l) => l.label);

// ─────────────────────────────── metrics ─────────────────────────────────────────────────────────────
const c504     = new Counter('cs_504');
const c502     = new Counter('cs_502');
const c5xx     = new Counter('cs_5xx');
const c404     = new Counter('cs_404');
const ttfb     = new Trend('cs_ttfb', true);
const overSlo  = new Rate('cs_over_guillotine');

// ─────────────────────────────── options ─────────────────────────────────────────────────────────────
// The ramp and the VU provisioning come from k6/lib/mix.js (unit-tested there): "touch and go" is a
// HOLD_DUR of 0s, and maxVUs is sized on rate × timeout because at the knee requests do not complete.
const RAMP = { steps: STEPS, startRps: START_RPS, peakRps: PEAK_RPS, stepDur: STEP_DUR, holdDur: HOLD_DUR };
const stages = (share) => mkStages(Object.assign({ share: share }, RAMP));
const vus = (share) => mkVus({ peakRps: PEAK_RPS, share: share, timeout: TIMEOUT });

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
  // journey: 1 iteration = 1 visitor session. Requests per session come from the journey file, so the
  // session rate is derived from --peak (which is always in user requests/s). See lib/mix.js.
  const plan = journeyPlan(Object.assign({ pages: JOURNEY }, RAMP));
  scenarios.journey = {
    executor: 'ramping-arrival-rate',
    exec: 'fan_session',
    startRate: Math.round(plan.startSess),
    timeUnit: '1s',
    preAllocatedVUs: plan.pre,
    maxVUs: plan.max,
    stages: plan.stages,
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

// RSC_MODE=repeat replays reality (few distinct URLs); random is a cache-buster. See lib/mix.js.
const rscQuery = (path, idx) => mkRscQuery(path, idx, RSC_OPTS);

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const COUNTERS = { cs_504: c504, cs_502: c502, cs_404: c404, cs_5xx: c5xx };

function record(res, cls) {
  ttfb.add(res.timings.waiting, { class: cls });
  overSlo.add(overGuillotine(res.timings.duration, GUILLOTINE), { class: cls });
  for (const name of statusBuckets(res.status)) COUNTERS[name].add(1, { class: cls });

  for (const l of CACHE_LAYERS) {
    // null = the layer's header was absent: NOT a miss. Feeding it as 0 would report "0% hit ratio"
    // for a layer that was never in the path — see lib/classify.js.
    const hit = layerHit(l, res.headers);
    if (hit !== null) l.metric.add(hit, { class: cls });
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
  const path = classPath(c, pick(pool(c.pool)),
                         c.path_suffix_pool ? pick(pool(c.path_suffix_pool)) : undefined);

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
  // Everything that turns metrics into a verdict — aborted / generator_ok / target_unreachable and the
  // per-class table — lives in lib/summary.js, where node --test can feed it the metric trees you hope
  // never to see for real (dropped iterations, a target that never answered, a cache layer that never
  // spoke). This function only supplies the run context and writes the two outputs.
  const ctx = {
    runId: RUN_ID,
    profileName: PROFILE.name,
    shape: SHAPE,
    baseUrl: BASE_URL,
    rscMode: RSC_MODE,
    peakRps: PEAK_RPS,
    guillotineMs: GUILLOTINE,
    classNames: CLASS_NAMES,
    cacheLabels: CACHE_LABELS,
    shares: SHARE,
  };
  const out = buildSummary(data.metrics || {}, ctx);
  const res = { stdout: renderSummaryText(out, ctx) };
  res[SUMMARY_F] = JSON.stringify(out, null, 2);
  return res;
}
