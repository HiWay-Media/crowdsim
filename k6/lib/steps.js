/*
 * steps.js — which step of the ramp a request belongs to, and which steps a run may report. (#50)
 *
 * A run climbs from --start to --peak in --steps steps and then holds. Until this file existed, the summary
 * reported one p50/p95/p99 over all of it, so the number people quote described a mixture of rates — mostly
 * rates below the one they believed they had measured. The knee is the rate at which latency leaves the SLO,
 * and it was already inside every single run, averaged away before anybody saw it.
 *
 * Two rules earn this file its tests:
 *
 *  · The boundaries come from the same stages() the ramp is built from. Computed twice, they disagree once,
 *    and a per-step table whose steps do not match the ramp is worse than no table: it is wrong with
 *    authority.
 *  · A step is only a measurement of its rate if the run actually held that rate for the whole step. A step
 *    cut short by the brake is a fraction of one — usually the worst fraction, since the brake fires while
 *    latency is climbing — so it is reported and marked, never quoted as the rate's result.
 *
 * ES2019, no imports from k6: this runs under `node --test` as well as inside the generator.
 */
import { stages, isZeroDuration } from './mix.js';

/**
 * A k6 duration in milliseconds, or null when it cannot be read. Null, not 0: a zero would collapse every
 * boundary onto the same instant and credit the entire run to step 1 — an aggregate wearing a table's
 * clothes, which is precisely the thing this file exists to end.
 */
export function durationMs(d) {
  const s = String(d === undefined || d === null ? '' : d).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  if (!/^(\d+(\.\d+)?(h|m|s|ms))+$/.test(s)) return null;
  var total = 0;
  var re = /(\d+(?:\.\d+)?)(h|ms|m|s)/g;
  var mt;
  while ((mt = re.exec(s)) !== null) {
    var n = parseFloat(mt[1]);
    if (mt[2] === 'h') total += n * 3600000;
    else if (mt[2] === 'm') total += n * 60000;
    else if (mt[2] === 's') total += n * 1000;
    else total += n;
  }
  return Math.round(total);
}

/**
 * The ramp as a list of steps with time boundaries and the rate each one asks for, in total user req/s.
 * Returns null when a duration cannot be parsed — see durationMs.
 */
export function stepPlan(o) {
  const stepMs = durationMs(o.stepDur);
  const holdZero = isZeroDuration(o.holdDur);
  const holdMs = holdZero ? 0 : durationMs(o.holdDur);
  if (!stepMs || (!holdZero && !holdMs)) return null;

  const st = stages({
    steps: o.steps, startRps: o.startRps, peakRps: o.peakRps,
    stepDur: o.stepDur, holdDur: o.holdDur, share: 1,
  });
  const plan = [];
  var at = 0;
  for (var i = 0; i < st.length; i++) {
    const isHold = !holdZero && i === st.length - 1;
    const dur = isHold ? holdMs : stepMs;
    // A k6 stage is a linear ramp from the previous target to its own, so a climbing step does not measure
    // one rate: it sweeps a range. Calling such a step "120 req/s" is the same averaging this file exists to
    // end, one level down — so the range is carried and the table prints it.
    const from = i === 0 ? Math.max(1, Math.round(o.startRps)) : st[i - 1].target;
    plan.push({
      index: i + 1,
      fromRps: isHold ? st[i].target : from,
      sustained: isHold,
      // The tag travels on every request as a k6 tag, so it has to be short and stable. "peak" for the hold
      // because that is what a reader is looking for in the table.
      tag: isHold ? 'peak' : 's' + (i + 1),
      rateRps: st[i].target,
      startMs: at,
      endMs: at + dur,
      isHold: isHold,
    });
    at += dur;
  }
  return plan;
}

/**
 * The step a request belongs to, by elapsed run time. A boundary belongs to the step that starts there: at
 * 60s exactly, the ramp has already moved on.
 *
 * Past the end of the plan: null. k6 keeps requests in flight while the last stage drains, and crediting
 * those to the peak would put the slowest requests of the run into the step people quote.
 */
export function stepAt(elapsedMs, plan) {
  if (!plan || !plan.length) return null;
  for (var i = 0; i < plan.length; i++) {
    if (elapsedMs >= plan[i].startMs && elapsedMs < plan[i].endMs) return plan[i];
  }
  return null;
}

function val(metrics, name, field, dflt) {
  const m = metrics[name];
  if (!m || !m.values || m.values[field] === undefined) return dflt;
  return m.values[field];
}

/**
 * The per-step block of the summary: one row per step that actually ran, with the rate it was asked to hold
 * and what came back.
 *
 * A step with no requests is dropped rather than reported: a row of zeros reads as a step that was fast.
 */
export function perStep(metrics, plan, opts) {
  if (!plan || !plan.length) return null;
  const o = opts || {};
  const ranMs = Number(o.durationMs) || 0;
  const classNames = o.classNames || [];
  const rows = [];

  for (var i = 0; i < plan.length; i++) {
    const s = plan[i];
    const tag = '{step:' + s.tag + '}';
    const reqs = val(metrics, 'http_reqs' + tag, 'count', 0);
    if (!reqs) continue;

    // Partial: the run ended before this step's window closed. The brake is the usual reason, and it fires
    // when latency is already climbing — so this row is a fraction of the step, biased towards its worst
    // part. It is reported because it is evidence, and marked because it is not a result.
    const partial = ranMs > 0 && ranMs < s.endMs;
    // Over THIS step's window, not the run's. k6's `rate` on a tagged sub-metric divides the count by the
    // whole test duration, so it reports 1.7 req/s for a step that delivered 7.5 — a number that looks like
    // a catastrophic generator and is an artefact of the divisor. Measured on a real run before being fixed.
    const endedMs = partial ? ranMs : s.endMs;
    const windowS = Math.max(0.001, (endedMs - s.startMs) / 1000);
    const row = {
      step: s.tag,
      index: s.index,
      is_hold: s.isHold,
      requested_rps: s.rateRps,
      from_rps: s.fromRps,
      sustained: Boolean(s.sustained),
      achieved_rps: Math.round((reqs / windowS) * 10) / 10,
      requests: reqs,
      p50: val(metrics, 'http_req_duration' + tag, 'med', null),
      p95: val(metrics, 'http_req_duration' + tag, 'p(95)', null),
      p99: val(metrics, 'http_req_duration' + tag, 'p(99)', null),
      failed_rate: val(metrics, 'http_req_failed' + tag, 'rate', null),
      over_guillotine_rate: val(metrics, 'cs_over_guillotine' + tag, 'rate', null),
      partial: partial,
    };
    if (partial) {
      row.note = 'partial: the run ended inside this step, so these numbers are a fraction of it — not a '
        + 'measurement of ' + s.rateRps + ' req/s';
    }
    const per = {};
    for (var c = 0; c < classNames.length; c++) {
      const ct = '{step:' + s.tag + ',class:' + classNames[c] + '}';
      const p95 = val(metrics, 'http_req_duration' + ct, 'p(95)', null);
      // Absent, not zero: a class that emitted nothing in this step never ran in it, and a zero would read
      // as a class that was fast.
      if (p95 === null) continue;
      per[classNames[c]] = {
        p50: val(metrics, 'http_req_duration' + ct, 'med', null),
        p95: p95,
        p99: val(metrics, 'http_req_duration' + ct, 'p(99)', null),
        failed_rate: val(metrics, 'http_req_failed' + ct, 'rate', null),
      };
    }
    row.per_class = per;
    rows.push(row);
  }
  return rows;
}
