/*
 * The warm-up, as a decision rather than as a form field.
 *
 * `--warmup` runs the generator once before the measured run and throws those numbers away: the first thirty
 * seconds of any run measure an empty cache, a cold pool and an unJITted app, and they sit inside the p95
 * somebody is about to quote. The CLI has had it since 1.15.0; the page did not, which meant every run
 * launched from the GUI folded its own cold start into the result — and the page is where the people least
 * likely to know that are launching runs.
 *
 * Two things are decided here rather than in the component, because both are about safety and both are easy
 * to get subtly wrong in JSX:
 *
 *  · **the rate the warm-up will actually run at.** It defaults to `--start`, not to `--peak`, and not to
 *    zero. A blank field in the form is not "no warm-up rate", it is "the same rate the ramp begins at".
 *  · **whether this run is past the safe ceiling.** A warm-up is load, so the ceiling applies to it too. A
 *    run whose peak is inside the ceiling and whose warm-up is above it still needs the override, and the
 *    driver will refuse it with exit 3 — the page must say so BEFORE the click, not translate a refusal
 *    afterwards.
 *
 * Plain ES module, no React: this is arithmetic and a rule, not a component.
 */

/**
 * The rate the warm-up will run at, as the driver will compute it: `--warmup-peak` when given, otherwise
 * `--start`. Returns null when there is no warm-up at all, which is not the same as 0.
 */
export function warmupRate(form) {
  const f = form || {};
  if (f.warmup === undefined || f.warmup === null || String(f.warmup).trim() === '') return null;
  const explicit = Number(f.warmupPeak);
  if (f.warmupPeak !== undefined && f.warmupPeak !== null && String(f.warmupPeak).trim() !== ''
      && Number.isFinite(explicit)) {
    return explicit;
  }
  const start = Number(f.start);
  return Number.isFinite(start) ? start : null;
}

/**
 * Is this run past the profile's safe ceiling — counting the warm-up?
 *
 * Returns { past, rate, by }, where `by` is 'peak', 'warmup' or 'both'. `rate` is the highest rate the run
 * will ask for, which is the number the operator has to be shown: telling somebody their 60 req/s run is
 * refused, when it is the 200 req/s warm-up that is refused, is worse than saying nothing.
 */
export function pastSafeCeiling(form, safePeak) {
  const f = form || {};
  if (safePeak === null || safePeak === undefined || !Number.isFinite(Number(safePeak))) {
    return { past: false, rate: null, by: null };
  }
  const ceiling = Number(safePeak);
  const peak = Number(f.peak);
  const warm = warmupRate(f);
  const peakPast = Number.isFinite(peak) && peak > ceiling;
  const warmPast = warm !== null && Number.isFinite(warm) && warm > ceiling;
  if (!peakPast && !warmPast) return { past: false, rate: null, by: null };
  return {
    past: true,
    rate: Math.max(peakPast ? peak : 0, warmPast ? warm : 0),
    by: peakPast && warmPast ? 'both' : (peakPast ? 'peak' : 'warmup'),
  };
}
