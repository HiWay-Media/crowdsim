/*
 * certify.js — the hold that turns a swept knee into a sustained one.
 *
 * WHY THIS EXISTS — a ramp finds a knee while climbing, and that is a SWEPT knee: the rate was crossed on
 * the way up, and a rate the system touched for one step is not a rate it can hold. crowdsim already says
 * so. Certifying it means a second run with `--hold` at that rate, and on a six-run campaign one of the
 * six was exactly that — while the tool had everything it needed at the moment the sweep ended.
 *
 * What this must never do is merge the two. A swept number and a sustained number under one label is this
 * project's averaging trap one level up, so the hold is a separate run with its own id and its own
 * summary, and the report says which of the two it is holding. The more valuable answer is often
 * *swept at N, did not sustain it*, which a single run cannot give at all.
 *
 * And a hold is a LARGER authorisation than a sweep through the same rate: minutes at a rate rather than
 * one step. So the gates are re-evaluated by the run itself — this file only refuses to propose a rate
 * that is already past the ceiling.
 *
 * ES2019, no k6 imports: runs under `node --test` and from the driver.
 */

/** Long enough to be a steady state, short enough not to be a campaign. */
export const DEFAULT_CERTIFY_HOLD = '60s';

function no(reason) {
  return { certify: false, reason: reason };
}

/** opts: { knee, hold, safePeak, alreadyCertifying } */
export function certify(opts) {
  const o = opts || {};
  const knee = o.knee || {};

  if (o.alreadyCertifying) {
    return no('this run is already the certification of a sweep: one hold, not a chain of them.');
  }
  if (knee.refused) {
    return no('this run\'s knee was refused (' + knee.reason + '), so there is nothing to certify. '
      + 'Appending a hold would produce a clean sustained number for a rate this run never established.');
  }
  const clean = knee.clean;
  if (!clean || !isFinite(Number(clean.requested_rps)) || Number(clean.requested_rps) <= 0) {
    return no('this run stayed clean at no rate at all, so there is no rate to hold. Lower --start until '
      + 'the first step survives.');
  }
  if (clean.sustained) {
    return no('this knee was already held, not swept: the run\'s own --hold step sustained '
      + clean.requested_rps + ' req/s, so a second run would measure the same thing again.');
  }
  if (knee.transient && knee.transient.length) {
    return no('a step in this run crossed the SLO and came back at an equal or higher rate, which is a '
      + 'cold cache rather than a knee. Holding that rate would measure the cache filling — use --warmup '
      + 'and sweep again first.');
  }

  const rate = Number(clean.requested_rps);
  const safePeak = Number(o.safePeak);
  if (isFinite(safePeak) && safePeak > 0 && rate > safePeak) {
    return no('the swept knee is ' + rate + ' req/s and the safe peak is ' + safePeak + ' req/s: holding '
      + 'it for minutes is a larger authorisation than sweeping through it, and this tool will not '
      + 'propose it. Raise safety.safe_peak_rps deliberately, or certify a lower rate.');
  }

  return {
    certify: true,
    rate: rate,
    hold: o.hold || DEFAULT_CERTIFY_HOLD,
    why: 'this knee was swept through on the way up, not held. Certifying it is one run at ' + rate
      + ' req/s with a hold — a separate run, so a swept number and a sustained one never end up under '
      + 'one label.',
  };
}
