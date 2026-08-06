/*
 * The URL fragment: which tab, and which two runs are being compared.
 *
 * `#history=<run-a>,<run-b>` exists so a delta can be pasted into an incident document and reopened by
 * somebody else. That makes the fragment user input which ends up in a request the server turns into a
 * spawn argv — the server checks it again, and so does this, because the page should not be the first
 * place that stops caring.
 */

export const TAB_IDS = ['run', 'profiles', 'history'];

const RUN_ID = /^\d{8}T\d{6}Z$/;

/** { tab, pair } — pair is null unless the fragment carries exactly two well-formed run ids. */
export function parseHash(hash) {
  const raw = String(hash === null || hash === undefined ? '' : hash).replace(/^#/, '');
  const [head, rest] = raw.split('=');
  const tab = TAB_IDS.indexOf(head) === -1 ? 'run' : head;

  const parts = rest ? rest.split(',') : [];
  const pair = parts.length === 2 && parts.every((p) => RUN_ID.test(p)) ? parts : null;
  return { tab, pair };
}

/** The inverse, without the leading '#': assigning to location.hash adds it. */
export function formatHash(tab, pair) {
  const id = TAB_IDS.indexOf(tab) === -1 ? 'run' : tab;
  if (!pair || pair.length !== 2 || !pair.every((p) => RUN_ID.test(p))) return id;
  return `${id}=${pair[0]},${pair[1]}`;
}
