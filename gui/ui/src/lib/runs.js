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
