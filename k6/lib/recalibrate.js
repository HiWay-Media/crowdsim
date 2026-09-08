/*
 * recalibrate.js — when the ramp's first step was already past capacity, what to try next.
 *
 * WHY THIS EXISTS — on a six-run campaign, two runs were thrown away because `--start` was above what the
 * system could serve. crowdsim diagnoses that correctly and says so — *lower --start until the first step
 * survives* — AFTER the window has been spent, and then somebody edits the command and runs it again. A
 * ramp that never completed a step measured nothing, so the whole output of those two runs was a sentence
 * telling the operator to do arithmetic the tool had already done.
 *
 * WHAT THIS IS NOT. Recalibration is a way to spend fewer runs. It is never:
 *
 *  · a way to reach a rate a gate refuses. Every attempt re-enters the driver through the front door, so
 *    the allowlist and the safe peak are re-checked by construction rather than by remembering to; and
 *    every step this file proposes is DOWNWARDS, which is asserted in the tests because a sign error here
 *    would turn a brake into an accelerator.
 *  · a way to retry a failure that is not about capacity. A generator-bound run, an unreachable target,
 *    or a class failing on 404s all produce the same refused knee — and retrying at half the rate
 *    produces the same failure at half the rate, which is a second wasted run.
 *  · a way to lose the evidence. The attempt that failed is a run of its own, and the fact that its
 *    `--start` was too high is itself a capacity finding.
 *
 * ES2019, no k6 imports: runs under `node --test` and from the driver.
 */

/** Each attempt halves the rate. Coarse on purpose: the point is to get under the knee, not to find it. */
export const RECALIBRATE_FACTOR = 0.5;

/** Attempts, including the first. Bounded so an unattended run cannot become a campaign. */
export const MAX_ATTEMPTS = 3;

/** Below this rate a ramp is not a ramp. Overridable per run. */
const DEFAULT_FLOOR = 1;

/** The refusal reasons that mean "the first step did not survive" — the one case worth retrying lower. */
const FIRST_STEP = /no step ran to completion/;

/** Refusals that are emphatically not about capacity, and would produce the same failure again. */
const NOT_CAPACITY = [
  { re: /generator did not hold/, why: 'the generator did not hold the requested rate, so the bottleneck '
    + 'was the generator and not the target. A lower rate would measure the same generator.' },
  { re: /never really answered|connectivity/, why: 'the target never really answered: that is '
    + 'connectivity, not capacity, and no rate is low enough to fix an address.' },
  { re: /brake is not evaluated/, why: 'the steps are shorter than --abort-delay, so the brake was never '
    + 'evaluated in them. That is a shape problem in the ramp, not a rate that is too high.' },
];

/**
 * Codes whose failure is not about how fast we are going. A 404 at half the rate is the same 404: the
 * pool names paths this target does not serve, and that is the finding.
 */
const NOT_CAPACITY_CODES = ['404', '401/403'];

function no(reason) {
  return { retry: false, reason: reason };
}

/**
 * opts: { knee, start, peak, attempt, floor, safePeak, failureMode }
 * Returns { retry: true, start, peak, why } or { retry: false, reason }.
 */
export function recalibrate(opts) {
  const o = opts || {};
  const knee = o.knee || {};
  const attempt = Number(o.attempt) || 1;
  const floor = o.floor === undefined ? DEFAULT_FLOOR : Number(o.floor);
  const start = Number(o.start);
  const peak = Number(o.peak);

  if (!knee.refused) {
    return no('this run has a knee, or a curve to read one from: there is nothing to recalibrate.');
  }
  if (!FIRST_STEP.test(String(knee.reason || ''))) {
    for (var i = 0; i < NOT_CAPACITY.length; i++) {
      if (NOT_CAPACITY[i].re.test(String(knee.reason))) return no(NOT_CAPACITY[i].why);
    }
    return no('the knee was refused for a reason a lower rate does not address: ' + knee.reason);
  }

  // A failure that is not about rate produces the same failure at half the rate.
  const fm = o.failureMode;
  if (fm && NOT_CAPACITY_CODES.indexOf(fm.code) !== -1) {
    return no('the failures in this run are ' + fm.code + 's, not saturation: the pool names paths this '
      + 'target does not serve, so the same run at a lower rate produces the same result. Fix the pool '
      + '(`crowdsim probe`, `crowdsim discover --verify`) instead.');
  }

  if (attempt >= MAX_ATTEMPTS) {
    return no('this was attempt ' + attempt + ' of ' + MAX_ATTEMPTS + ': recalibration stops here rather '
      + 'than generating load unattended. Every attempt is archived — read them, then choose a --start.');
  }

  if (!isFinite(start) || !isFinite(peak) || start <= 0 || peak <= 0) {
    return no('this run does not record the rates it used, so there is nothing to halve.');
  }

  const nextStart = Math.round(start * RECALIBRATE_FACTOR);
  // Rounding can land on the rate that just failed — halving 1 gives 0.5, which rounds back to 1. That is
  // a loop, not a recalibration.
  if (nextStart >= start) {
    return no('halving ' + start + ' req/s rounds back to ' + start + ', which is the rate that just '
      + 'failed. This system is at its floor: measure it with a --hold at 1 req/s instead of a ramp.');
  }
  if (nextStart < floor) {
    return no('the next attempt would start at ' + nextStart + ' req/s, below the floor of ' + floor
      + ' req/s (--recalibrate-floor). A ramp below that is not a ramp; if the system cannot serve the '
      + 'floor, that is the finding.');
  }

  // The ramp keeps its SHAPE: peak comes down with start. Lowering only --start would leave a ramp that
  // still climbs to the same peak in the same number of steps, so the second step would be past capacity
  // instead of the first — which is not progress.
  var nextPeak = Math.max(nextStart, Math.round(peak * (nextStart / start)));
  if (isFinite(Number(o.safePeak)) && Number(o.safePeak) > 0) {
    nextPeak = Math.min(nextPeak, Number(o.safePeak));
  }

  return {
    retry: true,
    start: nextStart,
    peak: nextPeak,
    why: 'the first step did not survive, so this ramp starts at or above this system\'s capacity. '
      + 'Attempt ' + (attempt + 1) + ' of ' + MAX_ATTEMPTS + ': --start ' + nextStart + ' --peak '
      + nextPeak + ', which keeps the same shape at half the rate.',
  };
}
