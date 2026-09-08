/*
 * delivery.js — the rate the ramp asked for, and the rate that arrived.
 *
 * WHY THIS EXISTS — `--peak` is deliberately the total USER requests per second, and one user request in
 * the mix fans out into several HTTP requests. So the number the target has to survive is a different,
 * larger one: on one campaign 60 requested arrived as roughly 76 delivered — a factor of about 1.25,
 * consistently enough that every report was translated by hand before it could be quoted.
 *
 * Both numbers are true and they answer different questions: *what did we drive* and *what did it take*.
 * Reporting one and calling it the knee makes the other somebody's mental arithmetic, done under time
 * pressure, in a document that outlives the run. A knee quoted as 60 when the system fell over at 76 is
 * not conservative — it is wrong in the direction that gets capacity bought.
 *
 * The fan-out is a property of the MIX, not of the run, which has two consequences this file exists to
 * enforce:
 *
 *  · it is REFUSED for a run that could not hold its rate. There, delivered/requested measures the
 *    generator's shortfall, and publishing it as the profile's fan-out teaches somebody a wrong constant.
 *  · two runs whose fan-out differs are not the same experiment, the same way two different URL pools are
 *    not — see `comparableFanOut`.
 *
 * The delivered rate is MEASURED (`achieved_rps`, http_reqs over that step's own window). It is never
 * `requested × fan_out`: deriving it would make the fan-out an assumption dressed as a measurement.
 *
 * ES2019, no k6 imports: runs under `node --test` and inside the generator.
 */

/** Beyond this relative gap, two fan-outs describe two different mixes. */
export const FAN_OUT_TOLERANCE = 0.1;

function refuse(reason, fix) {
  return { refused: true, reason: reason, fix: fix };
}

/**
 * The two rates for a run, and the fan-out between them.
 *
 * `rows` are the per-step rows (k6/lib/steps.js). `opts`: { generatorOk, targetUnreachable }.
 */
export function delivery(rows, opts) {
  const o = opts || {};
  if (o.generatorOk === false) {
    // Same two causes, same rule as the knee: refuse either way, but never blame the generator for a
    // target that saturated. (#76)
    if (o.dropDiagnosis && o.dropDiagnosis.verdict === 'target') {
      return refuse('the target could not absorb the requested rate, so what arrived is what the target '
        + 'would serve and not what this mix asks for.',
        'Measure the fan-out below that rate, where the target keeps up.');
    }
    return refuse('the generator did not hold the requested rate, so what arrived measures the generator '
      + 'and not the mix.',
      'Move the generator closer to the target, or onto a bigger host, and repeat.');
  }
  if (o.targetUnreachable === true) {
    return refuse('the target never really answered, so nothing was delivered to put beside what was '
      + 'requested.',
      'Run `crowdsim probe` against the same target and fix the path before generating load.');
  }
  if (!rows || !rows.length) {
    return refuse('this run has no per-step numbers, so there is no delivered rate to measure.',
      'A knee and a delivered rate both need --shape mix with --steps.');
  }

  // A partial step is a fraction of a step, biased towards its worst part — the brake fires while latency
  // is already climbing. It is never the row a rate is quoted from.
  const complete = rows.filter(function (r) { return !r.partial; });
  if (!complete.length) {
    return refuse('no step ran to completion, so no step delivered the rate it was asked for.',
      'Lower --start until the first step survives, then ramp from there.');
  }

  // The top of the ramp that actually completed, and what arrived during it.
  //
  // `>=` on purpose, so that when a ramp holds its peak the LAST row at that rate wins: a hold and the
  // climbing step that passed through it are both complete rows at the same requested rate, and the hold
  // is the one that actually held it. Picking the climbing step made the panel say "12 requested → 11
  // arrived" while the knee, which reads the hold, said "12 requested, 12 delivered" — two numbers for
  // one thing in one output. Found by running it.
  var top = complete[0];
  for (var i = 1; i < complete.length; i++) {
    if (Number(complete[i].requested_rps) >= Number(top.requested_rps)) top = complete[i];
  }

  // The ratio is measured on the SAME rows the quoted pair comes from, or the printed sentence
  // contradicts itself: reading the pair off the hold (12 → 12) while aggregating the ratio over every
  // complete step, climbing ones included, produced "12 requested → 12 arrived (fewer arrived than asked
  // for)" in one line. A hold is where a rate is actually held, so when the ramp has one, that is what
  // the ratio describes; with no hold it is the aggregate over the steps that completed.
  //
  // An AGGREGATE, never the mean of the per-step ratios: averaging ratios weights a 2 req/s step the same
  // as a 200 req/s one.
  const sustained = complete.filter(function (r) { return r.sustained; });
  const basis = sustained.length ? sustained : complete;
  var reqSum = 0;
  var delSum = 0;
  for (var j = 0; j < basis.length; j++) {
    reqSum += Number(basis[j].requested_rps) || 0;
    delSum += Number(basis[j].achieved_rps) || 0;
  }
  const ratio = reqSum > 0 ? Math.round((delSum / reqSum) * 100) / 100 : null;

  // A FAN-OUT CANNOT BE LESS THAN ONE. It is HTTP requests *per* user request, so a ratio under one does
  // not describe the mix at all — it means fewer requests completed than were asked for, which is the
  // target (or the network) throttling us. Found by running it: a slow-origin run reported "fan-out
  // 0.77x", and the generator was perfectly healthy. Both rates below are still facts and still
  // reported; only the interpretation is withheld.
  const shortfall = ratio !== null && ratio < 1;

  const out = {
    requested_rps: Number(top.requested_rps),
    delivered_rps: Number(top.achieved_rps),
    step: top.step,
    fan_out: shortfall ? null : ratio,
    note: null,
  };
  if (shortfall) {
    out.shortfall = true;
    out.ratio = ratio;
    out.note = 'fewer HTTP requests arrived than user requests were asked for, so the target did not keep '
      + 'up with the requested rate. That ratio is not this mix\'s fan-out — a fan-out is HTTP requests '
      + 'per user request and cannot be under one — it is the system refusing to be driven this fast, '
      + 'which is a finding about the target and usually the same finding as the knee.';
  } else if (ratio !== null) {
    out.note = 'a fan-out of ' + ratio + ' HTTP requests per user request, measured over '
      + (sustained.length ? 'the step this rate was held at' : 'the steps that completed')
      + '. It is a property of this mix: a profile whose fan-out changed is a profile whose runs are not '
      + 'comparable.';
  }
  return out;
}

/**
 * Can these two runs be compared? A fan-out that moved means the mix moved, and then a delta between
 * their knees is a delta between two experiments.
 *
 * `null` rather than `false` when either side does not record one: a run archived before this existed
 * has no fan-out, and calling that "the same" would silently compare two experiments while calling it
 * "different" would refuse every older run.
 */
export function comparableFanOut(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!isFinite(x) || !isFinite(y) || x <= 0 || y <= 0) {
    return {
      comparable: null,
      reason: 'one of these runs does not record a fan-out, so comparability of the mix cannot be checked '
        + '(runs archived before 1.29.0 do not have one).',
    };
  }
  const span = Math.max(x, y);
  if (Math.abs(x - y) > span * FAN_OUT_TOLERANCE) {
    return {
      comparable: false,
      reason: 'the fan-out differs between these runs (' + x + ' against ' + y + '): one user request '
        + 'became a different number of HTTP requests, so the mix is not the same and the delta would be '
        + 'between two experiments rather than between two systems.',
    };
  }
  return { comparable: true, reason: null };
}
