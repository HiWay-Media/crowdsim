/*
 * What the page knows about the live log, and what it must admit it does not. (#31)
 *
 * The old behaviour was one line: `es.onerror = () => es.close()`. The stream closed, nothing retried, and
 * nothing was said — so a server that had gone away looked exactly like a run that had gone quiet, while the
 * pill still read *running* and Stop was still offered.
 *
 * That is the one confusion this page cannot afford. It exists so somebody can watch load being generated
 * against a real system; "nothing is happening" and "I can no longer see what is happening" have to look
 * different, because the second may mean a generator is still running and nobody is watching it.
 *
 * Two states are tracked separately on purpose: the CONNECTION, and whether the RUN's state is still known.
 * After a drop the second is false, and the page stops asserting a status it cannot see.
 */

/** How many failed attempts before "reconnecting" stops being an honest description. */
const GIVING_UP_AFTER = 5;

export function streamState(s) {
  const phase = (s && s.phase) || 'open';        // open | retrying | ended
  const attempts = (s && s.attempts) || 0;
  if (phase === 'retrying') {
    return {
      phase,
      attempts,
      tone: attempts >= GIVING_UP_AFTER ? 'bad' : 'warn',
      runStateKnown: false,
    };
  }
  return { phase, attempts, tone: 'quiet', runStateKnown: true };
}

/** The sentence to show, or null when there is nothing worth saying. */
export function describeStream(state) {
  const s = state || {};
  if (s.phase !== 'retrying') return null;
  if (s.tone === 'bad') {
    return 'The server is not answering. This page lost the live log and cannot say whether the run is still '
      + 'going — the driver writes its own log and summary to out/, and that is where the truth is. '
      + 'Still reconnecting.';
  }
  return 'Lost the live log, reconnecting… Whether the run is still going is not known from here until it '
    + 'comes back.';
}
