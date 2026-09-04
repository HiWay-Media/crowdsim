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
import { brakeThresholds } from './lib/brake.js';
import { stepPlan, stepAt } from './lib/steps.js';
import { usableClasses, allocate, stages as mkStages, vus as mkVus, journeyPlan, rscQuery as mkRscQuery,
         classPath, DEFAULT_RSC_HASHES } from './lib/mix.js';
import {
  parseUsersCsv, pickUser, tokenRequest, logoutRequest, shouldLogout, parseToken, bearer,
  needsRelogin, expiryFrom, signupPayload, validateAuth, usesAuth,
  credentialsRefusal, accountSharingNote,
} from './lib/auth.js';
import { compileLayers, layerHit, statusBuckets, overGuillotine } from './lib/classify.js';
import { thinkTime, thinkSeconds } from './lib/session.js';
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
// A warm-up primes the caches in front of the target and is NOT the measurement: it runs without a brake,
// and its numbers go to their own file so nothing can fold them into the run that follows. A run against a
// cold cache measures a cold cache, and that number travels into documents as though it described the
// system at rest — which is why people already run twice and discard the first, without recording that
// they did.
const WARMUP     = __ENV.WARMUP === '1';
// What the measured run says about the warm-up that preceded it: "30s at 20 req/s", or nothing at all.
const WARMED_BY  = __ENV.WARMED_BY  || '';
// classes to skip, comma separated. Needed for targets that do not serve every route: hitting an
// application instance directly means the reverse-proxy-only routes answer 404, one class goes to 100%
// failed, and the brake trips at a couple of req/s making the target unusable.
const SKIP       = (__ENV.SKIP_CLASSES || '').split(',').filter((x) => x);

if (!PROFILE_F) throw new Error('PROFILE env var is required (path to a resolved profile JSON)');
if (!BASE_URL)  throw new Error('BASE_URL env var is required');

// ─────────────────────────── profile (init context: open() only here) ────────────────────────────────
const PROFILE = JSON.parse(open(PROFILE_F));

// Authenticated classes need a token endpoint and credentials. Checked HERE, in the init context: a
// profile that is missing them would otherwise produce a class at 100% failures and a run that reads
// like a capacity result.
const CLASS_DEFS = usableClasses(PROFILE.classes, SKIP);
// shares are recomputed over the REMAINING classes, so --peak stays the total you asked for
// Where each class's peak rate comes from: its own `rate_rps`, or its share of what the pinned classes
// leave. The shares come out of the same arithmetic so the ramp cannot disagree with the rates — and
// `--peak` stays the total, which is what the safe-peak gate reads. See k6/lib/mix.js.
const ALLOC = allocate(CLASS_DEFS, PEAK_RPS);
const SHARE = ALLOC.shares;
if (ALLOC.note) console.warn('crowdsim: ' + ALLOC.note);

// ── authenticated classes ────────────────────────────────────────────────────────────────────────────
// Everything here reads CLASS_DEFS, not PROFILE.classes: --skip-classes has already been applied, so a
// run that skips the login class needs no credentials and must not fail looking for them.
const AUTH = PROFILE.auth || {};
const AUTH_ERRORS = validateAuth({ auth: PROFILE.auth, classes: CLASS_DEFS }, __ENV);
if (AUTH_ERRORS.length) {
  throw new Error('profile: ' + AUTH_ERRORS.join('; '));
}
// Credentials come from a path, and the environment variable wins: a profile gets copied around and
// shared, a secret should not travel with it.
const USERS_PATH = __ENV.CROWDSIM_AUTH_USERS || AUTH.users_csv || '';
// Read the file ONLY when a class in THIS run signs in. CROWDSIM_AUTH_USERS is normally set once for a
// whole environment (a Nomad job, a CI runner) and open() on a missing path throws in the init context:
// without this guard, setting it there would break every anonymous run on that scheduler.
const NEEDS_AUTH = usesAuth(CLASS_DEFS);
// open() at the top of the init context, like the profile above: reading the file inside the SharedArray
// callback would tie a file read to the lifetime of a lazily-built shared object.
const USERS_CSV = NEEDS_AUTH && USERS_PATH ? readUsersFile(USERS_PATH) : '';

// k6's own message for a missing file is `stat <path>: no such file or directory`, which is accurate and
// says nothing about what to do. A run refused at init should name the fix in one sentence.
function readUsersFile(path) {
  try {
    return open(path);
  } catch (e) {
    throw new Error(
      `credentials file not found: ${path}. The login/authed classes need a \`username,password\` CSV: ` +
      'point CROWDSIM_AUTH_USERS at one, or drop the authenticated classes with ' +
      '--skip-classes. In a container or a Nomad allocation the file has to be mounted or rendered ' +
      'there, and the path is the one inside it.');
  }
}
const USERS = new SharedArray('users', function () { return parseUsersCsv(USERS_CSV); });

// A file that parsed to nothing is refused HERE, in the init context, where it costs a second. Left to
// run time it costs the campaign: pickUser() returns null, login() sends nothing, and a class with no
// requests is dropped from the per-step table and filtered out of the per-class one — so the run would
// complete, clean, with its authenticated half missing. See lib/auth.js.
const CREDS_REFUSAL = credentialsRefusal(USERS, CLASS_DEFS, USERS_PATH);
if (CREDS_REFUSAL) throw new Error(CREDS_REFUSAL);


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

// Reading pauses: declared in the profile, or the default this tool has always used. Resolved once here so
// the value the run USES is the value the summary reports — two readings of the same profile would
// eventually disagree, and the concurrency figure rests on this number.
const THINK = thinkTime((PROFILE.journey || {}).think_time);

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
// 401/403 have their own counter because an authenticated class that starts being REFUSED — a token
// that stopped working, a rate limit, an account locked out — is not a 5xx and not a 404: without this
// the run reports zero errors while the class is measuring nothing. Found while smoke-testing the login
// classes on a real platform.
const cDenied  = new Counter('cs_denied');
// A login that answers 200 with a body we cannot read a token from is not an HTTP error, so no
// status counter catches it: without this the authenticated requests are skipped and the run reads
// as green while nothing was ever authenticated.
const cAuthFail = new Counter('cs_auth_fail');
const ttfb     = new Trend('cs_ttfb', true);
const overSlo  = new Rate('cs_over_guillotine');

// ─────────────────────────────── options ─────────────────────────────────────────────────────────────
// The ramp and the VU provisioning come from k6/lib/mix.js (unit-tested there): "touch and go" is a
// HOLD_DUR of 0s, and maxVUs is sized on rate × timeout because at the knee requests do not complete.
const RAMP = { steps: STEPS, startRps: START_RPS, peakRps: PEAK_RPS, stepDur: STEP_DUR, holdDur: HOLD_DUR };
const stages = (share) => mkStages(Object.assign({ share: share }, RAMP));
const vus = (share) => mkVus({ peakRps: PEAK_RPS, share: share, timeout: TIMEOUT });

// How many VUs will be signing in, so the account count can be compared against it. `pickUser` assigns by
// `vuId % users.length`: fewer accounts than VUs means each account is used by several at once, and some
// identity providers serialise work per subject. usersNeeded() has always been able to answer this; until
// 1.20.4 nothing asked it.
const AUTH_VUS = CLASS_DEFS
  .filter(function (c) { return c.kind === 'login' || c.kind === 'authed'; })
  .reduce(function (n, c) { return n + vus(SHARE[c.name]).pre; }, 0);
const SHARING_NOTE = accountSharingNote(USERS.length, AUTH_VUS);
if (SHARING_NOTE) console.warn('crowdsim: ' + SHARING_NOTE);

const scenarios = {};
let JOURNEY_VU_CEILING = 0;
let JOURNEY_SESSION_RATE = 0;
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
  // Kept for the summary: sessions in flight against the ceiling we provisioned. If they meet, the
  // observed concurrency is our own configuration and not a measurement — see k6/lib/session.js.
  JOURNEY_VU_CEILING = plan.max;
  JOURNEY_SESSION_RATE = plan.sessRate;
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
// Built in lib/brake.js, where node --test can feed it the profiles you hope never to see. A class may
// declare its own max_p95_ms / max_failed_rate and gets its own aborting threshold — the run stops on the
// FIRST class to cross its own. Sharper, never later: validate refuses a per-class limit that would delay
// the brake past what the profile asked for.
// The ramp's steps, from the same stages() the scenarios are built from (lib/steps.js). Every request is
// tagged with the step it happened in, so the summary can report the rate at which this system left its SLO
// instead of one p95 averaged over every rate the run passed through.
const STEP_PLAN = stepPlan(RAMP);
const STEP_TAGS = (STEP_PLAN || []).map((s) => s.tag);

const thresholds = brakeThresholds({
  classDefs: CLASS_DEFS,
  slo: Object.assign({}, SLO, { brake_class: BRAKE_CLASS }),
  maxP95: MAX_P95_MS,
  maxFailed: MAX_5XX,
  abortDelay: ABORT_DELAY,
  cacheLabels: CACHE_LABELS,
  shape: SHAPE,
  priming: WARMUP,
  stepTags: STEP_TAGS,
});

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

const COUNTERS = { cs_504: c504, cs_502: c502, cs_404: c404, cs_5xx: c5xx, cs_denied: cDenied };

function record(res, cls, step) {
  // The step tag is the one the REQUEST carried, passed in rather than recomputed: at a step boundary the
  // clock has moved on by the time the response is back, and a request must not be counted in one step by
  // http_req_duration and in the next by cs_over_guillotine.
  const t = step ? { class: cls, step: step } : { class: cls };
  ttfb.add(res.timings.waiting, t);
  overSlo.add(overGuillotine(res.timings.duration, GUILLOTINE), t);
  for (const name of statusBuckets(res.status)) COUNTERS[name].add(1, t);

  for (const l of CACHE_LAYERS) {
    // null = the layer's header was absent: NOT a miss. Feeding it as 0 would report "0% hit ratio"
    // for a layer that was never in the path — see lib/classify.js.
    const hit = layerHit(l, res.headers);
    if (hit !== null) l.metric.add(hit, t);
  }
}

/**
 * The step this request belongs to, by elapsed run time — the one thing that cannot be known at build time.
 * Requests still in flight after the last stage get no step tag: crediting them to the peak would move the
 * slowest requests of the run into the step people quote.
 */
function stepTag() {
  if (!STEP_PLAN) return undefined;
  const s = stepAt(exec.instance.currentTestRunDuration, STEP_PLAN);
  return s ? s.tag : undefined;
}

function tagsFor(cls, name) {
  const t = { class: cls, name: name };
  const st = stepTag();
  if (st) t.step = st;
  return t;
}

function get(url, headers, cls, name) {
  const tags = tagsFor(cls, name);
  const res = http.get(abs(url), { headers, tags: tags, timeout: TIMEOUT });
  record(res, cls, tags.step);
  return res;
}

// The token endpoint lives on the identity provider, which is a different host from the site under
// test: an absolute URL must not be prefixed with BASE_URL.
function abs(url) {
  return /^https?:\/\//.test(url) ? url : BASE_URL + url;
}

// `wantBody` asks k6 for the response body for THIS request only. The run sets
// discardResponseBodies globally (headers are the measurement, bodies are RAM), and with bodies
// discarded res.body is undefined — so a token could never be read out of the login response.
function post(url, body, headers, cls, name, wantBody) {
  const tags = tagsFor(cls, name);
  const params = { headers, tags: tags, timeout: TIMEOUT };
  if (wantBody) params.responseType = 'text';
  const res = http.post(abs(url), body, params);
  record(res, cls, tags.step);
  return res;
}

// ─────────────────────────── authenticated state, per virtual user ───────────────────────────────────
// Module scope in k6 is per-VU, which is exactly the lifetime a session needs: VU 7 keeps its own
// account and its own token for the whole run.
let TOKEN = null;
let REFRESH = null;
let TOKEN_EXP = 0;

/**
 * Sign in and keep the token. Returns false when the token endpoint did not give one, so the caller can
 * skip the authenticated request instead of sending a request with no credentials — which would be
 * recorded as a 401 and read as "the API rejects us under load".
 */
function login(cls, name) {
  const user = pickUser(USERS, exec.vu.idInTest);
  if (!user) return false;
  const req = tokenRequest(AUTH, user);
  const res = post(req.url, req.body, Object.assign(baseHeaders(), req.headers), cls, name, true);
  const parsed = parseToken(res.body, AUTH.token_path, AUTH.refresh_path);
  if (parsed.error) {
    TOKEN = null;
    cAuthFail.add(1, tagsFor(cls, name));
    return false;
  }
  TOKEN = parsed.token;
  REFRESH = parsed.refreshToken;
  TOKEN_EXP = expiryFrom(Date.now(), parsed.expiresIn);
  if (shouldLogout(AUTH)) {
    const out = logoutRequest(AUTH, REFRESH);
    if (out) post(out.url, out.body, Object.assign(baseHeaders(), out.headers), cls, name + ' logout');
  }
  return true;
}

// ─────────────────────────── SHAPE=mix — one generic executor, driven by the profile ─────────────────
const BY_NAME = {};
for (const c of CLASS_DEFS) BY_NAME[c.name] = c;

export function run_class() {
  const c = BY_NAME[__ENV.CLASS];
  const i = exec.scenario.iterationInTest;
  const path = classPath(c, pick(pool(c.pool)),
                         c.path_suffix_pool ? pick(pool(c.path_suffix_pool)) : undefined);

  const label = c.label || c.name;

  if (c.kind === 'rsc') {
    get(rscQuery(path, i), rscHeaders(c.rsc_state_path || path), c.name, label);
  } else if (c.kind === 'login') {
    login(c.name, label);
  } else if (c.kind === 'authed') {
    // A token issued at the start of a ramp expires while the ramp is still climbing: without this the
    // class would collapse to 100% failures and trip the brake for a reason that is not the system's.
    if (needsRelogin(0, TOKEN, TOKEN_EXP, Date.now()) && !login(c.name, label + ' login')) return;
    const res = get(path, bearer(baseHeaders(), TOKEN), c.name, label);
    if (needsRelogin(res.status, TOKEN, TOKEN_EXP, Date.now())) TOKEN = null;
  } else if (c.kind === 'signup') {
    const s = c.signup || {};
    const payload = signupPayload(s, `${exec.vu.idInTest}-${i}`, RUN_ID);
    const headers = Object.assign(baseHeaders(), { 'Content-Type': 'application/json' },
                                  s.headers || {});
    post(s.url, JSON.stringify(payload.body), headers, c.name, label);
  } else {
    get(path, baseHeaders(), c.name, label);
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
    sleep(thinkSeconds(THINK));                    // visitor think time: see k6/lib/session.js
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
               null, { headers: rscHeaders(r), tags: tagsFor('rsc_page', 'prefetch'),
                       timeout: TIMEOUT }]);
  }
  if (!prefetchOnly) {
    for (const s of (page.static || []).slice(0, 6)) {
      reqs.push(['GET', BASE_URL + s,
                 null, { headers: baseHeaders(), tags: tagsFor('static', 'static'),
                         timeout: TIMEOUT }]);
    }
  }
  if (!reqs.length) return;
  const rs = http.batch(reqs);                     // batch = concurrent, like a browser
  for (let i = 0; i < rs.length; i++) record(rs[i], reqs[i][3].tags.class, reqs[i][3].tags.step);
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
    warmup: WARMUP ? 'this run IS the warm-up' : (WARMED_BY || null),
    isWarmup: WARMUP,
    classNames: CLASS_NAMES,
    cacheLabels: CACHE_LABELS,
    shares: SHARE,
    ramp: RAMP,
    // The knee is judged against the same limits as the brake, per-class ones included: a knee computed
    // from the profile SLO alone would sit above the rate at which the run actually aborted.
    // The rates this run aimed at, per class, and where each came from: a finding about one class gets
    // quoted as that class's rate, so it has to be in the file rather than recomputed from a weight.
    allocation: { rates: ALLOC.rates, pinned: ALLOC.pinned, fixed_total: ALLOC.fixed_total,
                  note: ALLOC.note },
    // Both needed to turn a rate into concurrent users, and to say whether that number is a measurement.
    thinkTime: THINK,
    vuCeiling: JOURNEY_VU_CEILING,
    sessionRate: JOURNEY_SESSION_RATE,
    slo: { max_p95_ms: MAX_P95_MS, max_failed_rate: MAX_5XX },
    // Recorded rather than only logged: how many accounts the run had, and whether they were shared. A
    // login ceiling measured with 50 accounts across 400 VUs is partly a statement about 50 accounts.
    auth: NEEDS_AUTH ? { users: USERS.length, vus: AUTH_VUS, sharing_note: SHARING_NOTE } : null,
    classSlo: CLASS_DEFS.reduce(function (acc, c) {
      if (c.max_p95_ms !== undefined && c.max_p95_ms !== null) {
        acc[c.name] = acc[c.name] || {}; acc[c.name].maxP95 = Number(c.max_p95_ms);
      }
      if (c.max_failed_rate !== undefined && c.max_failed_rate !== null) {
        acc[c.name] = acc[c.name] || {}; acc[c.name].maxFailed = Number(c.max_failed_rate);
      }
      return acc;
    }, {}),
    abortDelay: ABORT_DELAY,
    // How long the run actually lasted: a step whose window the run never reached the end of is a fraction
    // of that step, not a measurement of its rate.
    durationMs: (data.state && data.state.testRunDurationMs) || 0,
  };
  const out = buildSummary(data.metrics || {}, ctx);
  const res = { stdout: renderSummaryText(out, ctx) };
  res[SUMMARY_F] = JSON.stringify(out, null, 2);
  return res;
}
