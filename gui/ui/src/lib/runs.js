/*
 * Which run the page shows, and when a result stops belonging to what is on the form.
 *
 * Both of these lived inside effects in RunPanel, and both were wrong at some point. The second one shipped:
 * the effect that loads a profile also cleared the last result, and it runs on first load too — so the run
 * just restored from the server was wiped and the page looked like nothing had ever happened. It was found
 * by dumping the DOM, because there was nowhere to put a test.
 *
 * Plain ES module, no React: this is a decision, not a component.
 */

/**
 * What to display when the page opens.
 *   active — the run the server says is in flight, if any
 *   runs   — every run the server knows about, newest first
 *
 * Returns { run, follow }: which run to show, and whether to attach to its live stream. A finished run is
 * shown and not followed — that is what makes a reload keep the result instead of discarding it.
 */
export function runToShow(state) {
  const s = state || {};
  if (s.active) return { run: s.active, follow: true };
  const runs = s.runs || [];
  return { run: runs.length ? runs[0] : null, follow: false };
}

/**
 * Should the displayed result be cleared?
 *
 * `profile-loaded` is the profile arriving from the server, which also happens on first load — clearing
 * there is the bug. `profile-selected` is somebody actually choosing a different profile, and a result
 * belongs to the profile it came from: keeping it on screen next to another profile's form is how last
 * week's number gets read as today's.
 */
export function shouldClearResult(event) {
  const e = event || {};
  if (e.reason === 'run-started') return true;
  if (e.reason === 'profile-selected') return Boolean(e.from) && e.from !== e.to;
  return false;
}

/**
 * The knee, as one cell of the history table. (#51)
 *
 * Three states that must not be collapsed into each other:
 *  · measured — a band: clean up to X, crossed at Y;
 *  · not found — the run stayed clean at every rate it reached, so the knee is ABOVE its peak. Printing the
 *    peak on its own would read as a measured knee, which is the mistake this whole feature exists to stop;
 *  · refused / absent — a dash or nothing, never a number. A refused knee is a run that cannot answer the
 *    question; an absent one is a run archived before the question could be asked.
 */
export function kneeText(knee) {
  if (!knee) return { text: '', tone: null, title: 'this run has no per-step numbers' };
  if (knee.refused) {
    return { text: '—', tone: 'warn', title: `no knee from this run: ${knee.reason} ${knee.fix || ''}`.trim() };
  }
  const clean = knee.clean || {};
  if (!knee.crossed) {
    return {
      text: `≥ ${clean.requested_rps}`,
      tone: 'ok',
      title: 'clean at every rate this run reached: the knee is above this peak, the run did not find it',
    };
  }
  return {
    text: `${clean.requested_rps} → ${knee.crossed.requested_rps}`,
    tone: 'warn',
    title: knee.summary || '',
  };
}

/**
 * One run's own shape: rate against p95, one point per ramp step. A single run is a curve now — the dots in
 * the plot are a whole-ramp p95 against a requested peak, which is an average over every rate the run passed
 * through, and the two must not be drawn as if they meant the same thing.
 *
 * A step with no p95 emitted nothing: left out, rather than drawn at zero, which would bend the curve towards
 * a rate that was never measured.
 */
export function stepCurve(perStep) {
  if (!perStep || !perStep.length) return [];
  return perStep
    .filter((r) => r && r.p95 !== null && r.p95 !== undefined && r.requested_rps)
    .map((r) => ({ step: r.step, rate: r.requested_rps, p95: r.p95, partial: Boolean(r.partial) }));
}
