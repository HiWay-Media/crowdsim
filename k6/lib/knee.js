/*
 * knee.js — the rate this system survived, and the rate at which it stopped. (#51)
 *
 * With the ramp reported step by step (lib/steps.js), the sentence everybody actually came for is
 * computable: *clean up to 90 req/s, crossed at 120*. Before this file the tool said "completed" or
 * "aborted" and left the reader to convert that into a capacity figure by hand — which in practice means
 * rounding up to `--peak`, the one rate nobody measured the system surviving.
 *
 * The value here is in what it REFUSES. A knee is a claim about somebody's capacity that will be quoted in
 * rooms this tool is not in, and every refusal below exists because the alternative is a confident number
 * with nothing behind it:
 *
 *  · one completed step is a straight line through one point;
 *  · a generator that did not hold the rate has no numbers at all;
 *  · an unreachable target is connectivity, not capacity;
 *  · steps shorter than the abort delay are steps the brake was never evaluated in, so a knee read off them
 *    is a knee the brake itself would not have agreed with.
 *
 * ES2019, no k6 imports: runs under `node --test` and inside the generator.
 */
import { durationMs } from './steps.js';

function refuse(reason, fix) {
  return { refused: true, reason: reason, fix: fix };
}

/**
 * Did this step stay inside the SLO? Returns null when it did, or { why, class } when it did not.
 * Per-class limits are checked too: they make the brake sharper, so a knee that ignored them would sit above
 * the rate at which the run actually aborted.
 */
function crossedAt(row, o) {
  const classSlo = o.classSlo || {};
  const names = Object.keys(row.per_class || {});
  for (var i = 0; i < names.length; i++) {
    const cls = names[i];
    const limits = classSlo[cls];
    if (!limits) continue;
    const c = row.per_class[cls];
    if (limits.maxP95 !== undefined && c.p95 !== null && c.p95 > limits.maxP95) {
      return { class: cls, why: 'class ' + cls + ' p95 ' + Math.round(c.p95) + ' ms crossed its own limit of '
        + limits.maxP95 + ' ms' };
    }
    if (limits.maxFailed !== undefined && c.failed_rate !== null && c.failed_rate > limits.maxFailed) {
      return { class: cls, why: 'class ' + cls + ' failed ' + (c.failed_rate * 100).toFixed(2)
        + '% against its own limit of ' + (limits.maxFailed * 100).toFixed(2) + '%' };
    }
  }
  if (row.p95 !== null && row.p95 !== undefined && o.maxP95 && row.p95 > o.maxP95) {
    return { class: null, why: 'p95 ' + Math.round(row.p95) + ' ms crossed the SLO of ' + o.maxP95 + ' ms' };
  }
  if (row.failed_rate !== null && row.failed_rate !== undefined && o.maxFailed !== undefined
      && row.failed_rate > o.maxFailed) {
    return { class: null, why: 'failed rate ' + (row.failed_rate * 100).toFixed(2) + '% crossed the SLO of '
      + (o.maxFailed * 100).toFixed(2) + '%' };
  }
  return null;
}

/**
 * The knee, or a refusal. Never an estimate: see the header.
 *
 * opts: { maxP95, maxFailed, classSlo, generatorOk, targetUnreachable, stepDur, abortDelay }
 */
export function knee(rows, opts) {
  const o = opts || {};
  if (!rows || !rows.length) {
    return refuse('this run has no per-step numbers, so there is nothing to read a knee from.',
      'A journey run does not ramp in steps. For a knee, use --shape mix with --steps.');
  }
  if (o.generatorOk === false) {
    return refuse('the generator did not hold the requested rate, so no step measured the rate it claims.',
      'Move the generator closer to the target — a generator-bound run has no numbers to correct.');
  }
  if (o.targetUnreachable === true) {
    return refuse('the target never really answered: that is connectivity, not capacity.',
      'Run `crowdsim probe` against the same target and fix the path before generating load.');
  }

  // The brake is not evaluated during the abort delay, so a step shorter than it can pass while already
  // crossing. Reading a knee off those steps means reporting a knee the brake would not have agreed with.
  const stepMs = durationMs(o.stepDur);
  const delayMs = durationMs(o.abortDelay);
  if (stepMs && delayMs && stepMs < delayMs) {
    return refuse('each step lasts ' + o.stepDur + ' but the brake is not evaluated for the first '
      + o.abortDelay + ' (--abort-delay), so a step can pass while it is already crossing.',
      'Make --step-dur longer than --abort-delay, or lower --abort-delay if the target is warm.');
  }

  const complete = rows.filter(function (r) { return !r.partial; });
  if (complete.length < 2) {
    // Two different situations, and the same advice would be wrong for one of them. Nothing completed at
    // all means the ramp's FIRST rate was already past the knee — more steps would not help, a lower
    // starting rate would. Measured on a slow origin, where the old wording said "raise --steps".
    if (!complete.length) {
      return refuse('no step ran to completion: the run ended inside its first one, so the ramp already '
        + 'starts at or above this system\'s capacity.',
        'Lower --start (and --peak with it) until the first step survives, then ramp from there.');
    }
    return refuse('only one step ran to completion: one point is not a curve, and a knee from it would be '
      + 'a straight line through a single measurement.',
      'Give the ramp more room below the knee: a lower --start, more --steps, or a longer --step-dur.');
  }

  // A KNEE IS A CROSSING THE SYSTEM DOES NOT COME BACK FROM.
  //
  // Measured, not theorised: a real run against a slow origin returned p95 736 ms at 1→2 req/s and then 611
  // and 609 ms at the same rate. The first version of this file called that "the ramp starts above this
  // system's capacity — lower --start". It was a cold start. So the crossed step is the first one after which
  // no step comes back inside the SLO, and a crossing that IS undone at an equal or higher rate is reported
  // as what it is: a cold cache, or noise, and a reason to use --warmup.
  const verdicts = rows.map(function (r) { return crossedAt(r, o); });
  var firstPersistent = -1;
  for (var i = 0; i < rows.length; i++) {
    if (!verdicts[i]) continue;
    var persists = true;
    for (var j = i + 1; j < rows.length; j++) {
      if (!verdicts[j]) { persists = false; break; }
    }
    if (persists) { firstPersistent = i; break; }
  }
  const transient = [];
  for (var t = 0; t < rows.length; t++) {
    if (verdicts[t] && (firstPersistent === -1 || t < firstPersistent)) {
      transient.push({ step: rows[t].step, requested_rps: rows[t].requested_rps, why: verdicts[t].why });
    }
  }

  const asClean = function (row) {
    return {
      step: row.step, requested_rps: row.requested_rps, from_rps: row.from_rps,
      achieved_rps: row.achieved_rps, p95: row.p95, failed_rate: row.failed_rate,
      sustained: Boolean(row.sustained),
      // A climbing step passed through its rate on the way up; only the hold held one. Quoting a swept
      // rate as a capacity figure is this tool's own averaging trap, one level up.
      caveat: row.sustained ? null
        : 'this rate was swept through on the way up, not sustained: only the --hold step holds a rate',
    };
  };

  // The clean rate is the highest rate the run stayed inside the SLO at, before the crossing it never
  // recovered from. A partial step is never the clean one: it is biased towards its worst part, since the
  // brake fires while latency is already climbing.
  var clean = null;
  const lastCleanIdx = firstPersistent === -1 ? rows.length : firstPersistent;
  for (var c = 0; c < lastCleanIdx; c++) {
    if (!rows[c].partial && !verdicts[c]) clean = asClean(rows[c]);
  }
  var crossed = null;
  if (firstPersistent !== -1) {
    const row = rows[firstPersistent];
    const bad = verdicts[firstPersistent];
    crossed = {
      step: row.step, requested_rps: row.requested_rps, from_rps: row.from_rps,
      achieved_rps: row.achieved_rps, p95: row.p95, failed_rate: row.failed_rate,
      partial: Boolean(row.partial), class: bad.class, why: bad.why,
    };
  }

  const out = { clean: clean, crossed: crossed, transient: transient };
  if (transient.length) {
    out.note = 'a step crossed the SLO and the system came back inside it at an equal or higher rate ('
      + transient.map(function (x) { return x.step + ' at ' + x.requested_rps + ' req/s'; }).join(', ')
      + '). That is a cold cache or noise, not a knee — use --warmup so the first step is not the one paying '
      + 'for an empty cache.';
  }
  if (!clean) {
    out.summary = 'no step stayed inside the SLO: the first one already crossed. The ramp starts above this '
      + 'system\'s capacity — lower --start.';
  } else if (!crossed) {
    out.summary = 'clean at every rate this run reached, up to ' + clean.requested_rps + ' req/s'
      + (clean.sustained ? ' (sustained)' : ' (swept, not sustained)')
      + '. The knee is above this peak: the run did not find it.';
  } else {
    out.summary = 'clean up to ' + clean.requested_rps + ' req/s'
      + (clean.sustained ? ' (sustained)' : ' (swept, not sustained)')
      + ', crossed at ' + crossed.requested_rps + ' req/s — ' + crossed.why + '.';
  }
  return out;
}
