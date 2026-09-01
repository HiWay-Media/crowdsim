/*
 * The URL fragment: which tab, which two runs are being compared, and which single run is open.
 *
 * `#history=<run-a>,<run-b>` exists so a delta can be pasted into an incident document and reopened by
 * somebody else. `#history=<run-id>` is the same argument applied to one run: a result is the thing people
 * paste at each other most often, and until it had an address the only way to show somebody a run was to
 * tell them which row to click. It is also what makes the run's report reachable by link.
 *
 * That makes the fragment user input which ends up in a request the server turns into a spawn argv — the
 * server checks it again, and so does this, because the page should not be the first place that stops
 * caring.
 */

export const TAB_IDS = ['run', 'profiles', 'history'];

const RUN_ID = /^\d{8}T\d{6}Z$/;

/**
 * { tab, pair, one }
 *   pair — null unless the fragment carries exactly two well-formed run ids;
 *   one  — null unless it carries exactly one. Never both: two ids are a comparison, one is a result, and
 *          a fragment that meant either would be a page that opens differently depending on who reads it.
 */
export function parseHash(hash) {
  const raw = String(hash === null || hash === undefined ? '' : hash).replace(/^#/, '');
  const [head, rest] = raw.split('=');
  const tab = TAB_IDS.indexOf(head) === -1 ? 'run' : head;

  const parts = rest ? rest.split(',') : [];
  const pair = parts.length === 2 && parts.every((p) => RUN_ID.test(p)) ? parts : null;
  const one = parts.length === 1 && RUN_ID.test(parts[0]) ? parts[0] : null;
  return { tab, pair, one };
}

/**
 * The inverse, without the leading '#': assigning to location.hash adds it. Accepts a pair, a one-element
 * array, or a bare run id — anything else is just the tab, because a malformed address is better than one
 * that reopens as a different run.
 */
export function formatHash(tab, runs) {
  const id = TAB_IDS.indexOf(tab) === -1 ? 'run' : tab;
  const list = typeof runs === 'string' ? [runs] : runs;
  if (!list || !list.length || list.length > 2 || !list.every((p) => RUN_ID.test(p))) return id;
  return `${id}=${list.join(',')}`;
}
