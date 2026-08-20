/*
 * brake.js — which thresholds stop a run, and what stopped it. (#43)
 *
 * There used to be one `slo.max_p95_ms` and one `brake_class`, so a server-rendered document and a static
 * asset were judged by the same number. That is either too strict for the assets or too lax for the
 * renderer, and in practice it is the second: the class that actually falls over has its p95 diluted by
 * everything cheap that answers in two milliseconds.
 *
 * The rule, and the reason this file has tests: a per-class threshold may make the brake SHARPER, never
 * later. A brake that fires later than the profile asked for is worse than no brake, because somebody is
 * watching the outage it was supposed to cut short. `lib/validate.mjs` refuses that shape; here it is only
 * translated into what k6 understands.
 *
 * ES2019-compatible: this runs in k6's runtime and in node --test.
 */

/** The SLO in force for one class: its own where it declares one, the profile's otherwise. */
export function classSlo(cls, slo) {
  const c = cls || {};
  const s = slo || {};
  const hasP95 = c.max_p95_ms !== undefined && c.max_p95_ms !== null;
  const hasFailed = c.max_failed_rate !== undefined && c.max_failed_rate !== null;
  return {
    maxP95: hasP95 ? Number(c.max_p95_ms) : Number(s.max_p95_ms),
    maxFailed: hasFailed ? Number(c.max_failed_rate) : Number(s.max_failed_rate),
    own: hasP95 || hasFailed,
  };
}

/**
 * The whole thresholds object k6 is given.
 *
 * Two kinds live in here and they must not be confused:
 *  · ABORTING thresholds — the brake. The run stops on the first one crossed.
 *  · `>=0` thresholds — decorative, and load-bearing anyway: in k6 a tagged sub-metric only appears in the
 *    summary if some threshold mentions it, so these are what make the per-class table exist. Counting one
 *    of them as "the brake tripped" would mark every run as aborted.
 */
export function brakeThresholds(opts) {
  const o = opts || {};
  const classDefs = o.classDefs || [];
  const cacheLabels = o.cacheLabels || [];
  // A warm-up primes a cache; it is not looking for a knee. Aborting on the profile's SLO would stop it
  // exactly when it is doing its job, because the first requests into a cold cache are the slow ones.
  const priming = Boolean(o.priming);
  const abort = priming ? {} : { abortOnFail: true, delayAbortEval: o.abortDelay };
  const brakeClass = (o.slo && o.slo.brake_class) || (classDefs[0] && classDefs[0].name);

  const t = {};
  // The overall failed rate is a property of the run, not of a class: a target that stops answering fails
  // every class at once, and that is the one case where the whole run is the right unit.
  if (!priming) t.http_req_failed = [Object.assign({ threshold: 'rate<' + o.maxFailed }, abort)];

  const names = classDefs.map((c) => c.name);
  if (o.shape === 'journey') names.push('journey');

  for (const cls of names) {
    const def = classDefs.filter((c) => c.name === cls)[0] || { name: cls };
    const own = classSlo(def, o.slo);
    const durKey = 'http_req_duration{class:' + cls + '}';
    const failKey = 'http_req_failed{class:' + cls + '}';

    // The class the profile nominates keeps its aborting threshold even without declaring one of its own,
    // so a profile that says nothing behaves exactly as it did.
    const abortsOnP95 = own.own || cls === brakeClass;
    const p95Limit = own.own ? own.maxP95 : o.maxP95;

    t[durKey] = [];
    if (abortsOnP95 && !priming) t[durKey].push(Object.assign({ threshold: 'p(95)<' + p95Limit }, abort));
    t[durKey].push('p(95)>=0');

    t[failKey] = [];
    // Only a class that declared its own failed rate aborts on it: the overall one already covers the run,
    // and adding a per-class abort where nobody asked for one would make the brake fire sooner than the
    // profile says — sharper is welcome, surprising is not.
    if (!priming && def.max_failed_rate !== undefined && def.max_failed_rate !== null) {
      t[failKey].push(Object.assign({ threshold: 'rate<' + Number(def.max_failed_rate) }, abort));
    }
    t[failKey].push('rate>=0');

    t['cs_over_guillotine{class:' + cls + '}'] = ['rate>=0'];
    t['http_reqs{class:' + cls + '}'] = ['count>=0'];
    for (const label of cacheLabels) t['cache_hit_' + label + '{class:' + cls + '}'] = ['rate>=0'];
  }
  return t;
}

/**
 * What stopped the run: the metric, the class if it was one class's threshold, the expression and the value
 * it reached. `aborted: true` sends somebody to read a log; this sentence does not.
 */
export function abortedBy(metrics) {
  const all = metrics || {};
  const keys = Object.keys(all);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const met = all[key] || {};
    const crossed = Object.keys(met.thresholds || {}).filter((src) => {
      return !met.thresholds[src].ok && !/>=0$/.test(src);
    });
    if (!crossed.length) continue;

    const m = /^([a-z_0-9]+)(\{class:([^}]+)\})?$/.exec(key);
    const threshold = crossed[0];
    // The value the expression is about: p(95)<800 → p(95), rate<0.05 → rate.
    const field = /^([a-z0-9()]+)\s*[<>]/.exec(threshold);
    const values = met.values || {};
    return {
      metric: m ? m[1] : key,
      class: m && m[3] ? m[3] : null,
      threshold: threshold,
      value: field ? values[field[1]] : null,
    };
  }
  return null;
}
