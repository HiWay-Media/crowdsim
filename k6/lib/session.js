/*
 * session.js — what a visitor session is, and how many of them are in flight.
 *
 * WHY THIS EXISTS — a capacity requirement arrives as *"7,000 concurrent users"* and every number this tool
 * produced was a rate. Somebody then converted one into the other in their head, with an assumption they
 * did not write down. The StreamWay+ campaign of 2026-09-04 did it properly and that is the method copied
 * here: Little's law (sessions/s x mean session duration), cross-checked against a count of sessions in
 * flight, with the two printed side by side. They agreed, and the agreement is what made the number
 * defensible — not the number.
 *
 * The other half is think time. Concurrency is sessions/s x session duration, and session duration IS the
 * reading pauses plus the fan-out. It was hard-coded here as `1 + Math.random() * 4` seconds, in one place,
 * with nothing in a profile able to change it — so a concurrency figure derived from a crowdsim run would
 * describe visitors who all read at the same tool-chosen pace.
 *
 * Pure: no k6 imports, randomness injected. ES2019 (no optional chaining, no ??) — this runs in k6's
 * runtime as well as in node.
 */

/** Today's behaviour, kept exactly: a profile that declares nothing generates the traffic it always did. */
export const DEFAULT_THINK_MS = { min: 1000, max: 5000 };

/**
 * The think-time configuration a profile declares, normalised, with WHERE it came from.
 *
 * Three shapes, in decreasing order of how much they are worth:
 *   { samples: [1200, 3400, ...] }  — pauses somebody measured. Picked from, not fitted: a real
 *                                     distribution beats a uniform range drawn to look like one.
 *   { min_ms, max_ms }              — a declared range.
 *   nothing                         — the default above, and the summary says `default` so a concurrency
 *                                     figure is never read as if the pace had been measured.
 */
export function thinkTime(cfg) {
  const c = cfg || {};
  // Strictly positive: `Number(null)` is 0 and `Number('')` is 0, so a junk list — `['x', null]` — became
  // a "declared" think time of 0 ms and silently removed every pause in the run. A deliberate zero is
  // spelled `{ min_ms: 0, max_ms: 0 }`, which goes through the range branch below where it is explicit.
  const samples = (c.samples || []).map(Number).filter(function (v) { return isFinite(v) && v > 0; });
  if (samples.length) {
    var lo = samples[0];
    var hi = samples[0];
    var total = 0;
    for (var i = 0; i < samples.length; i++) {
      if (samples[i] < lo) lo = samples[i];
      if (samples[i] > hi) hi = samples[i];
      total += samples[i];
    }
    return {
      source: c.measured ? 'measured' : 'declared',
      min_ms: lo,
      max_ms: hi,
      mean_ms: Math.round(total / samples.length),
      samples: samples,
    };
  }
  const min = Number(c.min_ms);
  const max = Number(c.max_ms);
  if (isFinite(min) && isFinite(max) && min >= 0 && max >= min) {
    return { source: 'declared', min_ms: min, max_ms: max, mean_ms: Math.round((min + max) / 2), samples: [] };
  }
  return {
    source: 'default',
    min_ms: DEFAULT_THINK_MS.min,
    max_ms: DEFAULT_THINK_MS.max,
    mean_ms: Math.round((DEFAULT_THINK_MS.min + DEFAULT_THINK_MS.max) / 2),
    samples: [],
  };
}

/**
 * One pause, in SECONDS because that is what k6's sleep() takes.
 * `rand` is injected so the branch is testable instead of merely plausible — same reason as `rscQuery`.
 */
export function thinkSeconds(tt, rand) {
  const r = rand || Math.random;
  if (tt.samples && tt.samples.length) {
    return tt.samples[Math.floor(r() * tt.samples.length) % tt.samples.length] / 1000;
  }
  return (tt.min_ms + r() * (tt.max_ms - tt.min_ms)) / 1000;
}

/**
 * Little's law: the number in the system is the arrival rate times the time each one stays.
 * Sessions per second x mean session duration in seconds = sessions in the system.
 */
export function derivedConcurrency(sessionsPerSec, meanSessionSeconds) {
  const r = Number(sessionsPerSec);
  const s = Number(meanSessionSeconds);
  if (!isFinite(r) || !isFinite(s) || r <= 0 || s <= 0) return null;
  return Math.round(r * s);
}

/** Default agreement margin between the two methods. 25% is loose on purpose: see `concurrency`. */
export const AGREEMENT_MARGIN = 0.25;

/**
 * The two answers, side by side, and what their disagreement means.
 *
 * `derived`  — Little's law over the session ARRIVAL rate and the session duration the run measured
 *              (k6's `iteration_duration`). One session is one iteration in the journey shape.
 *
 *              The arrival rate is the rate the run drove, not `iterations.rate`: that counter is
 *              COMPLETED iterations, so a run that was cut mid-ramp reported 0.1 sessions/s against 50
 *              sessions in flight and called it a disagreement — a real run showed exactly that, and the
 *              derived number was garbage by construction rather than evidence of anything.
 * `observed` — the peak number of sessions in flight, which is the peak VU count for the same reason.
 *
 * They are NEVER averaged into one figure. A disagreement past the margin IS the finding: it means the
 * session duration and the arrival rate describe different things — usually because the generator could
 * not start sessions fast enough, or because the run was still ramping when it ended.
 *
 * And a refusal that matters more than either number: if the peak VU count is against the ceiling the run
 * provisioned, then `observed` is the provisioning and not a measurement. Reporting it as concurrency
 * would be reporting our own configuration back as a property of the system.
 *
 * opts: { sessionsPerSec, meanSessionSeconds, observedPeak, vuCeiling, margin }
 */
export function concurrency(opts) {
  const o = opts || {};
  const derived = derivedConcurrency(o.sessionsPerSec, o.meanSessionSeconds);
  const observed = isFinite(Number(o.observedPeak)) && Number(o.observedPeak) > 0
    ? Math.round(Number(o.observedPeak)) : null;
  const ceiling = Number(o.vuCeiling) || 0;
  const margin = o.margin === undefined ? AGREEMENT_MARGIN : Number(o.margin);

  // The same refusals the knee has, for the same reason: these are the conditions under which the numbers
  // in this run describe the generator or the network rather than the system. A concurrency figure gets
  // quoted in rooms this tool is not in, so it is refused rather than qualified.
  if (o.generatorOk === false) {
    return {
      refused: true,
      reason: 'the generator did not hold the requested rate, so the sessions it started are not the '
        + 'sessions this figure would claim.',
      fix: 'Move the generator closer to the target, or onto a bigger host, and repeat.',
    };
  }
  if (o.targetUnreachable === true) {
    return {
      refused: true,
      reason: 'the target never really answered: sessions that fail instantly are not visitors.',
      fix: 'Run `crowdsim probe` against the same target and fix the path first.',
    };
  }
  if (o.aborted === true) {
    return {
      refused: true,
      reason: 'the brake stopped this run, so it never held a steady state — and concurrency is a '
        + 'property of one: the arrival rate and the session duration come from different parts of a ramp '
        + 'that was still climbing when it was cut.',
      fix: 'Read the knee instead, then measure concurrency in a --hold at a rate below it.',
    };
  }
  if (derived === null && observed === null) {
    return {
      refused: true,
      reason: 'this run measured neither a session rate nor a session duration, so there is nothing to '
        + 'convert into concurrent users.',
      fix: 'Concurrency is a property of sessions: use --shape journey, where one iteration is one visitor.',
    };
  }

  const out = {
    derived: derived,
    observed: observed,
    sessions_per_sec: isFinite(Number(o.sessionsPerSec)) ? Number(o.sessionsPerSec) : null,
    mean_session_seconds: isFinite(Number(o.meanSessionSeconds)) ? Number(o.meanSessionSeconds) : null,
    agree: null,
    note: null,
  };

  // The provisioning check comes first: it can void `observed` entirely.
  if (observed !== null && ceiling > 0 && observed >= ceiling * 0.95) {
    out.vu_bound = true;
    out.note = 'the sessions in flight reached the VU ceiling this run provisioned (' + ceiling + '), so '
      + 'that number is the provisioning and not a measurement — the real concurrency was at least this '
      + 'and the generator could not hold more. Raise the peak, or the pool, and repeat.';
    return out;
  }

  if (derived !== null && observed !== null) {
    const span = Math.max(derived, observed);
    out.agree = Math.abs(derived - observed) <= span * margin;
    if (!out.agree) {
      out.note = 'the two methods disagree by more than ' + Math.round(margin * 100) + '%: '
        + derived + ' from the rate and the session duration, ' + observed + ' counted in flight. That '
        + 'gap is the finding — the arrival rate and the session duration are describing different parts '
        + 'of the run, which happens when it was still ramping at the end or when sessions could not be '
        + 'started fast enough. Neither number should be quoted until they agree.';
    }
  }
  return out;
}

/**
 * The sentence that goes with the number, wherever it is printed. A concurrency figure from this tool is
 * what THIS mix implies at THIS pace — not a headcount of real visitors — and the pace is the part people
 * forget, which is why the think-time source is in the sentence.
 */
export function concurrencyCaveat(conc, think) {
  if (!conc || conc.refused) return null;
  const t = think || {};
  const pace = t.source === 'measured'
    ? 'reading pauses you measured (' + t.min_ms + '-' + t.max_ms + ' ms)'
    : (t.source === 'declared'
      ? 'the reading pauses this profile declares (' + t.min_ms + '-' + t.max_ms + ' ms)'
      : 'the tool\'s default reading pause (' + t.min_ms + '-' + t.max_ms + ' ms, which nobody measured)');
  return 'This is the concurrency this mix implies at ' + pace + ', on a synthetic URL pool. Change the '
    + 'pace and the same traffic becomes a different number of users: it is a conversion of a rate, not a '
    + 'headcount.';
}
