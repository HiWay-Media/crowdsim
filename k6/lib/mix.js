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

/**
 * Where each class's peak rate comes from: an absolute rate it declares, or its share of what is left.
 *
 * WHY — a finding is usually about ONE class. The StreamWay+ campaign's answer is "the login saturates at
 * ~150 login/s", and to reproduce that with weights you set a global `--peak` and solve for the weight by
 * hand, in the wrong direction, every time the question changes. `rate_rps` says it directly.
 *
 * The two compose, and the composition is the whole design: the pinned classes get exactly what they ask
 * for, and the rest split WHAT IS LEFT by weight. So `--peak` keeps meaning the total — which is what the
 * safe-peak gate reads, and therefore what a per-class rate cannot be used to slip past.
 *
 * Returns absolute peak rates AND the equivalent shares, because everything downstream (the ramp, the VU
 * provisioning, `mix_target`) is expressed as a share of the peak: computing the share twice, once here and
 * once there, is how the two would eventually disagree.
 *
 * A pinned rate is the rate AT PEAK. The class still ramps with everybody else — pinning it flat from the
 * first step would put the total above the step's own total, and `--start`/`--steps` would stop meaning
 * anything.
 */
export function allocate(classes, peakRps) {
  const peak = Number(peakRps);
  if (!(peak > 0)) throw new Error('--peak must be a positive number of requests per second');

  const pinned = [];
  const weighted = [];
  var fixedTotal = 0;
  for (const c of classes) {
    const rate = Number(c.rate_rps);
    if (isFinite(rate) && rate > 0) {
      pinned.push(c);
      fixedTotal += rate;
    } else {
      weighted.push(c);
    }
  }

  // Refused, not scaled. Scaling the pinned rates down to fit would generate a run nobody asked for and
  // report it under the rate they did ask for — the class of wrong answer this tool exists to avoid.
  if (fixedTotal > peak) {
    throw new Error('the classes with a fixed rate_rps already ask for ' + Math.round(fixedTotal * 10) / 10
      + ' req/s, which is more than --peak ' + peak + '. --peak is the TOTAL: raise it, or lower the fixed '
      + 'rates. They are not scaled down to fit, because the run would then measure a rate nobody asked '
      + 'for and report it under the one they did.');
  }

  const rates = {};
  for (const c of pinned) rates[c.name] = Number(c.rate_rps);

  const remaining = peak - fixedTotal;
  const weightTotal = weighted.reduce(function (a, c) { return a + Number(c.weight || 0); }, 0);
  if (weighted.length && !(weightTotal > 0)) {
    throw new Error('the classes without a rate_rps have no positive weight, so there is nothing to split '
      + 'the remaining ' + Math.round(remaining * 10) / 10 + ' req/s by');
  }
  for (const c of weighted) rates[c.name] = remaining * (Number(c.weight) / weightTotal);

  const shareOf = {};
  for (const name of Object.keys(rates)) shareOf[name] = rates[name] / peak;

  var note = null;
  if (!weighted.length && fixedTotal < peak) {
    // Every class is pinned: --peak cannot be reached by construction, and saying nothing would leave
    // somebody reading "peak 500" next to a run that generated 200.
    note = 'every class declares a fixed rate_rps, so this run generates '
      + Math.round(fixedTotal * 10) / 10 + ' req/s and not the --peak of ' + peak
      + '. --peak is the ceiling here, not the target.';
  }

  return {
    rates: rates,
    shares: shareOf,
    fixed_total: Math.round(fixedTotal * 10) / 10,
    pinned: pinned.map(function (c) { return c.name; }),
    weighted: weighted.map(function (c) { return c.name; }),
    note: note,
  };
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
