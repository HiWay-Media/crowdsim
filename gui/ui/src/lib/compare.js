/*
 * Painting a comparison — and refusing to paint one.
 *
 * The verdicts themselves ('better', 'worse', 'same', 'unknown') come from `crowdsim compare --json`: the
 * page does not decide whether a change is an improvement, because two copies of that judgement would
 * eventually disagree and the wrong one would be the one on screen. What lives here is how the answer is
 * presented, which is still a place to be wrong in a way that matters — a null hit ratio drawn as 0% is a
 * lie with a colour on it.
 */

/**
 * Which of two ticked runs is A. The older one, so a before/after reads in one direction whatever order
 * somebody happened to tick them in. `rows` is the archive, newest first.
 * Returns null unless both runs are in the archive.
 */
export function orderPair(picked, rows) {
  const list = picked || [];
  if (list.length !== 2) return null;
  const at = (id) => (rows || []).findIndex((r) => r.run_id === id);
  if (list.some((id) => at(id) === -1)) return null;
  return list.slice().sort((x, y) => at(y) - at(x));
}

/** A measured value, or the honest absence of one. */
export function valueCell(v, unit) {
  if (v === null || v === undefined) return 'n/a';
  if (unit === 'ms') {
    // A tenth of a millisecond matters on a loopback target and is noise on a real one.
    return Math.abs(v) < 10 ? `${v.toFixed(2)} ms` : `${v.toFixed(0)} ms`;
  }
  if (unit === 'ratio') return `${(v * 100).toFixed(2)}%`;
  return String(v);
}

/** { text, tone } for a change. The tone follows the server's verdict, never a comparison made here. */
export function deltaCell(row) {
  const r = row || {};
  if (r.change === null || r.change === undefined) return { text: '—', tone: 'note' };

  const sign = r.change >= 0 ? '+' : '';
  let text;
  if (r.unit === 'ms') {
    text = `${sign}${Math.abs(r.change) < 10 ? r.change.toFixed(2) : r.change.toFixed(0)} ms`;
  } else if (r.unit === 'ratio') {
    text = `${sign}${(r.change * 100).toFixed(2)} pp`;
  } else {
    text = `${sign}${r.change.toFixed(0)}`;
  }
  if (r.relative) {
    const rel = r.relative >= 0 ? '+' : '';
    text += ` (${rel}${(r.relative * 100).toFixed(0)}%)`;
  }
  const tone = r.verdict === 'better' ? 'ok' : r.verdict === 'worse' ? 'bad' : 'note';
  return { text, tone };
}

/**
 * May this result be rendered as numbers at all?
 *
 * A refusal is the whole answer: a delta between two runs that were not the same experiment looks exactly
 * like an answer, so the page must not be able to show one beside the reason it was refused.
 */
export function mayRenderNumbers(result) {
  if (!result) return false;
  return !(result.refused && result.refused.length);
}
