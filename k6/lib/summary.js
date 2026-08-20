/*
 * summary.js — the run verdict, computed from k6's metric tree.
 *
 * This is the most important file in the repo to have tests for. Every other bug produces a run that
 * looks wrong; a bug here produces a run that looks RIGHT and is not — a confidently wrong capacity
 * number that someone will size infrastructure with. The three judgements it makes:
 *
 *   aborted            — the brake tripped: you found the knee (an outcome, not an error)
 *   generator_ok       — the generator held the requested rate; if false the run means NOTHING
 *   target_unreachable — near-total failure at near-zero latency: you never touched the target
 *
 * Pure and k6-free: node --test drives it with synthetic metric trees, including the ones you hope never
 * to see in production. ES2019-compatible.
 */

/** k6 omits metrics that never received a sample. Absent counter = 0 (a real result), absent gauge = null. */
export function metricValue(metrics, name, field, dflt) {
  const m = metrics && metrics[name];
  if (m && m.values && m.values[field] !== undefined) return m.values[field];
  return dflt === undefined ? null : dflt;
}

/**
 * Hit ratio for a cache metric, or null when the layer was never observed.
 * A Rate with no samples reports rate 0, which is indistinguishable from "everything missed" — and that
 * misreading is exactly how a wrong header name in a profile turns into "the cache is not working".
 */
export function cacheRate(metrics, name) {
  const seen = (metricValue(metrics, name, 'passes', 0) || 0) + (metricValue(metrics, name, 'fails', 0) || 0);
  return seen ? metricValue(metrics, name, 'rate') : null;
}

/**
 * Did a real threshold fail? The `>=0` thresholds are decoration: k6 only surfaces a tagged sub-metric
 * in the summary if some threshold mentions it, so the per-class breakdown is bought with thresholds
 * that can never fail. Counting those as "the brake tripped" would mark every run as aborted.
 */
import { abortedBy as abortedByLocal } from './brake.js';

export { abortedBy } from './brake.js';

export function brakeTripped(metrics) {
  return Object.keys(metrics || {}).some((key) => {
    const met = metrics[key];
    if (!met || !met.thresholds) return false;
    return Object.keys(met.thresholds).some((src) => !met.thresholds[src].ok && !/>=0$/.test(src));
  });
}

/**
 * More than 2% of iterations dropped means k6 could not start them at the requested rate: the
 * bottleneck was the generator or its network, not the system under test. Such a run looks exactly like
 * a healthy system absorbing the load, and it is the single most common way to get a load test wrong.
 */
export function generatorHeldRate(dropped, requests) {
  return !(dropped > 0.02 * Math.max(1, requests));
}

/**
 * A saturated target is SLOW before it errors — a knee shows up as latency climbing into the timeout.
 * Near-total failure at near-zero latency means connections refused or never routed: wrong address,
 * wrong port, firewall, or a container whose network namespace does not reach the target. Reporting
 * that as "the brake found the knee" would hand out a capacity number for a target never touched.
 */
export function targetUnreachable(failedRate, p95) {
  return failedRate > 0.9 && (p95 === null || p95 === undefined || p95 < 50);
}

/**
 * ctx = { runId, profileName, shape, baseUrl, rscMode, peakRps, guillotineMs,
 *         classNames[], cacheLabels[], shares{name:share} }
 */
export function buildSummary(metrics, ctx) {
  const g = (n, f, d) => metricValue(metrics, n, f, d);
  const cnt = (n) => g(n, 'count', 0);
  const labels = ctx.cacheLabels || [];
  const isMix = ctx.shape === 'mix';

  const perClass = {};
  for (const cls of ctx.classNames) {
    const cache = {};
    for (const label of labels) cache[label] = cacheRate(metrics, 'cache_hit_' + label + '{class:' + cls + '}');
    perClass[cls] = {
      p95: g('http_req_duration{class:' + cls + '}', 'p(95)'),
      p99: g('http_req_duration{class:' + cls + '}', 'p(99)'),
      med: g('http_req_duration{class:' + cls + '}', 'med'),
      failed: g('http_req_failed{class:' + cls + '}', 'rate'),
      over_guillotine: g('cs_over_guillotine{class:' + cls + '}', 'rate'),
      cache: cache,
      reqs: g('http_reqs{class:' + cls + '}', 'count', 0),
      rps_target: (isMix && ctx.shares[cls] !== undefined)
        ? Math.round(ctx.peakRps * ctx.shares[cls] * 10) / 10 : null,
    };
  }

  const cacheTotal = {};
  for (const label of labels) cacheTotal[label] = cacheRate(metrics, 'cache_hit_' + label);

  const mixTarget = {};
  for (const name of Object.keys(ctx.shares)) {
    mixTarget[name] = Math.round(ctx.peakRps * ctx.shares[name] * 10) / 10;
  }

  const out = {
    run_id: ctx.runId,
    profile: ctx.profileName || 'unnamed',
    shape: ctx.shape,
    base_url: ctx.baseUrl,
    rsc_mode: ctx.rscMode,
    peak_rps_user_target: ctx.peakRps,
    aborted: brakeTripped(metrics),
    // WHAT stopped it, not only that something did. "aborted: true" sends somebody to read a log; the class
    // and the number it reached is the answer they were going to look for.
    aborted_by: abortedByLocal(metrics),
    requests: cnt('http_reqs'),
    rps_avg: g('http_reqs', 'rate', 0),
    failed_rate: g('http_req_failed', 'rate', 0),
    dur: {
      p50: g('http_req_duration', 'med'), p95: g('http_req_duration', 'p(95)'),
      p99: g('http_req_duration', 'p(99)'), max: g('http_req_duration', 'max'),
    },
    guillotine_ms: ctx.guillotineMs,
    // The caveat travels with the numbers. A summary that does not say whether the caches were primed leaves
    // the first question in the room — "was it warm?" — with no answer in the file.
    warmup: ctx.warmup || null,
    is_warmup: Boolean(ctx.isWarmup),
    over_guillotine_rate: g('cs_over_guillotine', 'rate', 0),
    dropped_iterations: cnt('dropped_iterations'),
    e504: cnt('cs_504'), e502: cnt('cs_502'), e5xx: cnt('cs_5xx'), e404: cnt('cs_404'),
    cache: cacheTotal,
    per_class: perClass,
    mix_target: mixTarget,
  };

  out.generator_ok = generatorHeldRate(out.dropped_iterations, out.requests);
  out.target_unreachable = targetUnreachable(out.failed_rate, out.dur.p95);
  return out;
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(2) + '%');
const ms = (x) => (x === null || x === undefined ? 'n/a' : Math.round(x) + ' ms');
const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);

/**
 * The one line that turns "it aborted" into something actionable. With per-class SLOs in the profile the
 * brake can trip for a class that is not the brake class and at a threshold the profile does not state, so
 * the panel has to name both — otherwise the only way to find out is the k6 log, which nobody keeps.
 */
export function abortAttribution(by) {
  if (!by || !by.threshold) return '';
  const where = by.class ? 'class ' + by.class : by.metric;
  const at = (by.value === null || by.value === undefined) ? '' : ', reached ' + Math.round(by.value);
  return '\n                stopped by ' + where + ' — ' + by.threshold + at;
}

export function renderSummaryText(out, ctx) {
  const labels = ctx.cacheLabels || [];
  const isMix = out.shape === 'mix';

  let tbl = `  ${pad('class', 14)}${rp(isMix ? 'target req/s' : 'requests', 14)}${rp('p50', 9)}` +
            `${rp('p95', 10)}${rp('p99', 10)}${rp('>SLO', 8)}${rp('failed', 9)}\n`;
  tbl += '  ' + '─'.repeat(74) + '\n';
  for (const cls of ctx.classNames) {
    const c = out.per_class[cls];
    if (!c || !c.reqs) continue;            // class not emitted by this shape: no empty rows
    tbl += `  ${pad(cls, 14)}${rp(c.rps_target === null ? c.reqs + ' req' : c.rps_target, 14)}` +
           `${rp(ms(c.med), 9)}${rp(ms(c.p95), 10)}${rp(ms(c.p99), 10)}` +
           `${rp(pct(c.over_guillotine), 8)}${rp(pct(c.failed), 9)}\n`;
  }

  const cacheLine = labels.length
    ? labels.map((l) => `${l} ${pct(out.cache[l])}`).join(' · ')
      + (labels.every((l) => out.cache[l] === null)
        ? '   ← n/a everywhere: no declared cache header was ever seen in a response' : '')
    : 'no cache_headers declared in the profile';

  return `
╔══════════════════════════════════════════════════════════════════════════════╗
║  crowdsim — run ${out.run_id}  ·  profile ${out.profile}
╚══════════════════════════════════════════════════════════════════════════════╝
  target        ${out.base_url}   shape=${out.shape}  rsc=${out.rsc_mode}  requested peak=${out.peak_rps_user_target} user req/s
  outcome       ${out.target_unreachable
      ? '⛔ TARGET NEVER ANSWERED — ' + pct(out.failed_rate) + ' failed at ~0 ms. This is NOT a knee:\n'
        + '                check the address, port, TLS and network path. Nothing here is a capacity number.'
      : (out.aborted ? '⛔ ABORTED by the brake (knee exceeded)' + abortAttribution(out.aborted_by)
                     : '✅ completed without crossing the thresholds')}
  volume        ${out.requests} requests · ${out.rps_avg.toFixed(1)} req/s avg
  latency       p50 ${ms(out.dur.p50)} · p95 ${ms(out.dur.p95)} · p99 ${ms(out.dur.p99)} · max ${ms(out.dur.max)}
  over ${out.guillotine_ms} ms  ${pct(out.over_guillotine_rate)}   ← the proxy read timeout, i.e. where 504s come from
  errors        504: ${out.e504}   502: ${out.e502}   5xx total: ${out.e5xx}   404: ${out.e404}
  failed rate   ${pct(out.failed_rate)}
  generator     ${out.generator_ok ? '✅ held the rate' : '⛔ DID NOT hold: ' + out.dropped_iterations + ' iterations dropped → RESULT INVALID'}
  cache         ${cacheLine}

  ── per class ──
${tbl}`;
}
