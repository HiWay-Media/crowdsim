/*
 * validity.js — why the generator did not hold the rate, which is not always the generator.
 *
 * WHY THIS EXISTS — `generatorHeldRate()` is one line: `dropped_iterations > 2% of requests`. k6 drops an
 * iteration when the arrival-rate executor has no free VU to start it in, and that happens for two
 * OPPOSITE reasons:
 *
 *   · the generator is starved — CPU, network, a container inside a VM. The run is garbage.
 *   · every VU is blocked waiting on a target that stopped keeping up. The target saturated, which is the
 *     finding somebody booked the window for.
 *
 * The tool reported both as *THE GENERATOR DID NOT HOLD THE RATE — discard this run*, and told the
 * operator to move the generator closer to the target. Measured: a run at 12 req/s against a
 * single-worker origin with a 300 ms delay — a target that cannot serve 12 req/s by construction — said
 * exactly that on a completely healthy generator. The advice was wrong and the run was the answer.
 *
 * This is the most consequential verdict in the tool: it is the first line of reading a result, and it
 * voids the knee, the concurrency figure, the delivered rate and `compare`. A verdict that decides
 * whether a window was wasted must not be ambiguous about which of two opposite things happened.
 *
 * WHAT DOES NOT CHANGE is `generator_ok`. It means "the generator did not deliver the requested rate",
 * which is true in both cases, and `history.tsv`, the GUI and `compare` all read it. What this adds is
 * WHICH of the two, from evidence the run already records — and `unknown` when it cannot tell, because
 * guessing there is the whole bug again.
 *
 * ES2019, no k6 imports: runs under `node --test` and inside the generator.
 */

/** The share of dropped iterations at which a run is generator-bound at all. Matches generatorHeldRate. */
export const DROP_SHARE = 0.02;

/** VUs this close to the ceiling count as pinned — same rule as the concurrency figure's `vu_bound`. */
const CEILING_MARGIN = 0.95;

/**
 * opts: { dropped, requests, p95, maxP95, guillotineMs, vusMax, vuCeiling, targetUnreachable,
 *         virtualisedGenerator }
 *
 * Returns null when the drops are not material, otherwise a verdict.
 */
export function dropDiagnosis(opts) {
  const o = opts || {};
  const dropped = Number(o.dropped) || 0;
  const requests = Number(o.requests) || 0;
  if (dropped <= DROP_SHARE * Math.max(1, requests)) return null;

  if (o.targetUnreachable === true) {
    return {
      verdict: 'unreachable',
      generator_bound: false,
      discard: true,
      retry_lower: false,
      reason: 'the target never really answered, so the dropped iterations say nothing about capacity: '
        + 'that is connectivity, not a rate that is too high.',
      fix: 'Run `crowdsim probe` against the same target and fix the path before generating load.',
    };
  }

  const p95 = Number(o.p95);
  // `Number(null)` is 0 and `isFinite(0)` is true, so testing the conversion alone reports "the target
  // answered in 0 ms" for a summary that recorded no latency at all — and then diagnoses a starved
  // generator from a measurement that does not exist. This project has been caught by that conversion
  // once already (see thinkTime in k6/lib/session.js), which is why the check is on the input.
  const havep95 = o.p95 !== null && o.p95 !== undefined && isFinite(p95);
  const maxP95 = Number(o.maxP95);
  const guillotine = Number(o.guillotineMs);
  const ceiling = Number(o.vuCeiling) || 0;
  const vus = Number(o.vusMax) || 0;

  // Two independent signals that the TARGET is what the VUs were waiting for. Either is enough: a queue
  // is a queue whether or not it has crossed a threshold somebody wrote down.
  const latencyClimbing = havep95 && (
    (isFinite(maxP95) && maxP95 > 0 && p95 > maxP95)
    || (isFinite(guillotine) && guillotine > 0 && p95 > guillotine * 0.5));
  const vuBound = ceiling > 0 && vus >= ceiling * CEILING_MARGIN;

  if (latencyClimbing || vuBound) {
    return {
      verdict: 'target',
      generator_bound: false,
      // NOT a discard. The generator started every session it could and they were all waiting on the
      // target: that is the system refusing to be driven this fast, which is what the run was for.
      discard: false,
      retry_lower: true,
      reason: 'the target could not absorb the requested rate: '
        + (vuBound ? 'every virtual user was in flight (' + vus + ' of ' + ceiling + ') ' : '')
        + (latencyClimbing ? (vuBound ? 'and ' : '') + 'latency was climbing (p95 ' + Math.round(p95)
          + ' ms) ' : '')
        + 'while iterations were being dropped. The generator started every session it could — they were '
        + 'waiting on the target, which is a finding about the target and not a wasted window.',
      fix: 'Read this as the system refusing to be driven this fast, then measure it properly below that '
        + 'rate: lower --start and --peak, or let --recalibrate do it.',
    };
  }

  // The target was answering promptly and there were VUs to spare, so whatever could not keep the
  // schedule was on this side of the wire.
  if (havep95) {
    var fix = 'Move the generator closer to the target, or onto a bigger host, and repeat. Nothing in '
      + 'this run is measurable.';
    if (o.virtualisedGenerator === true) {
      fix = 'This generator is in a container inside a VM, where the network layer saturates before the '
        + 'target does — measured, repeatedly. Run k6 natively, or put the container on a Linux host near '
        + 'the target. Nothing in this run is measurable.';
    }
    return {
      verdict: 'generator',
      generator_bound: true,
      discard: true,
      retry_lower: false,
      reason: 'the generator did not keep the schedule while the target was still answering promptly '
        + '(p95 ' + Math.round(p95) + ' ms) with virtual users to spare, so the bottleneck was on this '
        + 'side of the wire.',
      fix: fix,
    };
  }

  // No latency recorded at all: an older summary, or a run that produced nothing. The conservative
  // verdict is the one that throws the run away.
  return {
    verdict: 'unknown',
    generator_bound: true,
    discard: true,
    retry_lower: false,
    reason: 'iterations were dropped and it cannot be told whether the generator was starved or the '
      + 'target stopped keeping up: this run does not record the latency and virtual-user counts that '
      + 'separate the two.',
    fix: 'Treat it as a discard, which is the safe direction, and repeat with a generator you can '
      + 'account for.',
  };
}
