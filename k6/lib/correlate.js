/*
 * correlate.js — a server-side series, lined up with the run's own steps.
 *
 * WHY THIS EXISTS — every number crowdsim produces is measured from outside: latency, failed rate, cache
 * hit ratio, the knee. That is the right place to measure what users experience and the wrong place to
 * answer the question that follows immediately, which is *why*. A run ends with a defensible knee and no
 * way to tell a saturated app tier from a CPU quota being throttled — and those have different fixes: one
 * is a rewrite, the other is one line of configuration.
 *
 * THE SCOPE DECISION, made in INTENT.md before this file existed: a series can be HANDED to a run, the
 * same way `weights` is handed an access log. crowdsim does not go and get one. Collecting would mean a
 * load generator holding credentials for a metrics backend or a cluster, which is a different tool with a
 * different risk profile.
 *
 * WHAT IT MUST NEVER DO is say the series explains the latency. A counter that rose during the same
 * minutes is a correlation; promoting it to a cause is the same mistake as quoting a knee as an absolute,
 * and this project's whole discipline is not making it. The caveat is part of the output, and a test
 * asserts the wording does not contain the words that would turn it into a claim.
 *
 * Alignment works because a run id IS the run's start time in UTC, and the per-step rows carry their own
 * offsets from it.
 *
 * ES2019, no k6 imports: runs under `node --test` and from the driver.
 */

/** The run's start, in epoch ms, from its id — `20260908T100000Z`. null when that is not what it is. */
export function runStartMs(runId) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(runId || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                  Number(m[4]), Number(m[5]), Number(m[6]));
}

function refuse(reason, fix) {
  return { refused: true, reason: reason, fix: fix };
}

/**
 * `steps` are the per-step rows (they carry `start_ms`/`end_ms`), `series` is `[{ t, v }]` with `t` in
 * epoch ms. `opts`: { runId, label }.
 */
export function correlate(steps, series, opts) {
  const o = opts || {};
  if (!o.label) {
    return refuse('this series has no label, and an unnamed column of numbers cannot be read against '
      + 'anything.', 'Name it with --server-metrics-label, e.g. cpu_throttled_periods.');
  }
  if (!steps || !steps.length) {
    return refuse('this run has no per-step numbers, so there are no windows to align a series to.',
      'A series is read against the ramp: use --shape mix with --steps.');
  }
  const t0 = runStartMs(o.runId);
  if (t0 === null) {
    return refuse('this run id is not a timestamp, so a series cannot be anchored to when the run '
      + 'happened.', 'Run ids look like 20260908T100000Z. An edited summary cannot be correlated.');
  }

  const points = [];
  for (var i = 0; i < (series || []).length; i++) {
    const p = series[i] || {};
    const t = Number(p.t);
    const v = Number(p.v);
    if (isFinite(t) && isFinite(v)) points.push({ t: t, v: v });
  }
  if (!points.length) {
    return refuse('this series has no usable samples: every row is missing a timestamp or a value.',
      'Each row needs a time and a number.');
  }

  const out = [];
  for (var s = 0; s < steps.length; s++) {
    const row = steps[s];
    const from = t0 + (Number(row.start_ms) || 0);
    const to = t0 + (Number(row.end_ms) || 0);
    var n = 0;
    var sum = 0;
    var max = null;
    var min = null;
    for (var j = 0; j < points.length; j++) {
      if (points[j].t < from || points[j].t > to) continue;
      n += 1;
      sum += points[j].v;
      if (max === null || points[j].v > max) max = points[j].v;
      if (min === null || points[j].v < min) min = points[j].v;
    }
    // A step nobody recorded anything in is ABSENT, not zero. Zero is a measurement; "no samples here"
    // is a different statement, and plotting one as the other is the failure this project keeps refusing.
    if (!n) continue;
    out.push({
      step: row.step,
      requested_rps: row.requested_rps,
      partial: Boolean(row.partial),
      samples: n,
      mean: Math.round((sum / n) * 100) / 100,
      max: max,
      min: min,
    });
  }

  if (!out.length) {
    return refuse('every sample in this series falls outside this run\'s window, so none of it describes '
      + 'what happened during it.',
      'Check the clock and the time zone: the timestamps must be UTC epoch milliseconds or seconds.');
  }

  return {
    label: o.label,
    steps: out,
    // Said as what it is. The forbidden words are asserted absent by a test, because the whole value of
    // this feature is that it does not overclaim.
    caveat: 'This is a correlation and not a cause: the series moved during the same windows, which is a '
      + 'reason to look and not a finding on its own. crowdsim measures from outside the system and was '
      + 'handed this series — it did not collect it and knows nothing about how it was recorded.',
  };
}
