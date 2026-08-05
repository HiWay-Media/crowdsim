/*
 * mix.js — how a profile becomes a k6 execution plan.
 *
 * Everything in here is PURE: no k6 imports, no globals, no randomness that is not injected. That is
 * deliberate — this is the arithmetic that decides how much load you actually generate, and a mistake
 * in it does not throw, it silently produces the wrong test. It is unit-tested in tests/unit/mix.test.js
 * and imported unchanged by k6/live-event.js, so the tested code IS the running code.
 *
 * Keep it ES2019-compatible (no optional chaining, no ??): it runs inside k6's JS runtime, not Node.
 */

/** Classes the run will actually generate, in profile order, minus the skipped ones. */
export function usableClasses(classes, skip) {
  const skipList = skip || [];
  const out = (classes || []).filter((c) => skipList.indexOf(c.name) === -1);
  if (!out.length) throw new Error('profile has no usable classes (all skipped?)');
  return out;
}

/**
 * Share of the total user rate per class. Recomputed over the REMAINING classes so that --peak keeps
 * meaning "total user req/s" even when a class was skipped or dropped for an empty pool. Without the
 * renormalisation, skipping a class would quietly lower the load you think you are applying.
 */
export function shares(classes) {
  const total = classes.reduce((a, c) => a + Number(c.weight || 0), 0);
  if (!(total > 0)) throw new Error('profile classes have no positive weight');
  const out = {};
  for (const c of classes) out[c.name] = Number(c.weight) / total;
  return out;
}

/** "0s" / "0" means: climb and leave, do not hold the peak (that is what --touch-and-go sets). */
export function isZeroDuration(d) {
  return /^0s?$/.test(String(d || '').trim());
}

/**
 * Ramp for one class: `steps` linear steps from startRps to peakRps, then the hold.
 * Rounded per step with a floor of 1: a class with a tiny share must still send something, otherwise
 * the mix silently loses its long tail.
 */
export function stages(o) {
  const share = o.share === undefined ? 1 : o.share;
  const steps = Math.max(1, Number(o.steps) || 1);
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const r = o.startRps + ((o.peakRps - o.startRps) * i) / steps;
    out.push({ target: Math.max(1, Math.round(r * share)), duration: o.stepDur });
  }
  if (!isZeroDuration(o.holdDur)) {
    out.push({ target: Math.max(1, Math.round(o.peakRps * share)), duration: o.holdDur });
  }
  return out;
}

/**
 * VUs to provision. At the knee requests do not complete, they sit in flight until the timeout cuts
 * them, so the concurrency needed is rate × timeout — not rate × a healthy response time. Provision for
 * the healthy case and k6 runs out of VUs exactly when the target starts queueing: the generator then
 * fails to deliver the rate, and the run is invalid for the most avoidable of reasons.
 */
export function vus(o) {
  const peak = o.peakRps * (o.share === undefined ? 1 : o.share);
  const tmo = parseFloat(o.timeout) || 10;
  return {
    pre: Math.max(10, Math.ceil(peak * 1.5)),
    max: Math.max(50, Math.ceil(peak * tmo * 1.3)),
  };
}

/** Requests per visitor session implied by a recorded journey: 1 document + fan-out + ~2 navigations. */
export function requestsPerSession(pages) {
  if (!pages || !pages.length) return 5;
  const per = pages.map((p) => (p.rsc || []).length + (p.static || []).length);
  const avg = per.reduce((a, b) => a + b, 0) / per.length;
  return 1 + avg + 2;
}

/** Session-rate ramp for --shape journey: the peak is in user requests/s, sessions are derived. */
export function journeyPlan(o) {
  const perSession = requestsPerSession(o.pages);
  const sessRate = Math.max(1, o.peakRps / perSession);
  const startSess = Math.max(1, o.startRps / perSession);
  return {
    perSession,
    sessRate,
    startSess,
    stages: stages({
      steps: o.steps, startRps: startSess, peakRps: sessRate,
      stepDur: o.stepDur, holdDur: o.holdDur, share: 1,
    }),
    pre: Math.max(20, Math.ceil(sessRate * 10)),
    max: Math.max(100, Math.ceil(sessRate * 60)),
  };
}

export const DEFAULT_RSC_HASHES = [
  '1dxlt', '9y2af', 'b7k0q', 'c3m8w', 'd1p5r', 'e6t2v', 'f4h9n',
  'g8j3s', 'h2l7x', 'j5n1z', 'k9q4b', 'm3s6d', 'p7v0g',
];

/**
 * The navigation-request URL. On a Next.js build the `_rsc` value depends on route+build, NOT on the
 * individual request, so tens of thousands of navigations collapse onto a handful of distinct URLs —
 * which is the entire premise of "a shared micro-cache would absorb most of this".
 *   mode=repeat (default) replays that. mode=random is a real cache-buster: it measures what the load
 * WOULD cost if the parameter were per-request, i.e. the hypothesis you usually want to disprove.
 * `rand` is injected so the random branch is testable instead of merely plausible.
 */
export function rscQuery(path, idx, o) {
  const cfg = o || {};
  const param = cfg.param || '_rsc';
  const sep = String(path).indexOf('?') === -1 ? '?' : '&';
  if (cfg.mode === 'random') {
    const rand = cfg.rand || Math.random;
    return path + sep + param + '=' + rand().toString(36).slice(2, 8);
  }
  const hashes = (cfg.hashes && cfg.hashes.length) ? cfg.hashes : DEFAULT_RSC_HASHES;
  return path + sep + param + '=' + hashes[Math.abs(idx | 0) % hashes.length];
}

/** The path a class requests: pool entry, optional suffix pool, optional prefix. */
export function classPath(cls, poolPick, suffixPick) {
  let path = poolPick;
  if (cls.path_suffix_pool && suffixPick !== undefined) path += suffixPick;
  if (cls.path_prefix) path = cls.path_prefix + (path === '/' ? '/' : path);
  return path;
}
