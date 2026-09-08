/*
 * summary-blocks.js — what the page shows of a summary, and what it deliberately does not.
 *
 * WHY THIS EXISTS — the GUI rendered `knee` and nothing else that had been added to the summary since
 * 1.21.0: `concurrency`, `think_time`, `allocation`, `failure_mode`, `delivery`, `server_side`. The
 * `failure_mode` one is the same wrong answer as #74, still live on the page — a run that completed
 * without crossing its thresholds while serving 32% 404s on one class read as a pass, in the place most
 * people look.
 *
 * Six blocks accumulated because nothing noticed. So the two lists below are exhaustive over what
 * `buildSummary` produces, and a test in tests/ui/ fails when a new block belongs to neither: a block
 * left out on purpose is a decision, a block left out because nobody looked is this bug again.
 *
 * The TEXT comes from the summary. The panel, the markdown report, the HTML page and this one all quote
 * the same sentence rather than each rebuilding it — four renderings of one verdict is four chances to
 * disagree while somebody is deciding something.
 */

// The band arithmetic is shared with the drawn report — see classOutcomes below.
import { outcomeBands } from '../../../../k6/lib/failure.js';

/** Blocks the result view shows. */
export const RENDERED = [
  'run_id', 'profile', 'base_url', 'shape', 'rsc_mode', 'peak_rps_user_target',
  'aborted', 'aborted_by', 'generator_ok', 'target_unreachable',
  'failure_mode',      // the headline: what broke, before what stopped the run
  'drop_diagnosis',    // WHY the rate was not held — the generator, or the target
  'delivery',          // requested → delivered, and the fan-out between them
  'knee',
  'requests', 'rps_avg', 'failed_rate', 'dur', 'guillotine_ms', 'over_guillotine_rate',
  'e504', 'e502', 'e5xx', 'e404', 'denied', 'authFail',
  'cache', 'per_class', 'per_step', 'mix_target', 'dropped_iterations',
  'warmup', 'is_warmup', 'slo',
];

/**
 * Blocks the page does NOT show, each with the reason. None of these is "not got round to yet": that is
 * what the list above is for.
 */
export const DELIBERATELY_NOT_RENDERED = [
  // Journey-shape only, and the page cannot launch a journey run: it would be a permanently empty panel.
  // The CLI and `report` show both methods side by side, which is where the figure is quoted from.
  'concurrency',
  'think_time',
  // A per-class rate table that duplicates `mix_target`, already rendered. Two tables of the same
  // arithmetic is the disagreement this file exists to prevent.
  'allocation',
  // Registration is a CLI operation: the manifest names real accounts on a real system and belongs in
  // out/, not on a page that can be left open in a browser.
  'signup',
  // Account counts and the sharing note. The page cannot express a credentials file, so a run launched
  // from it never signs in.
  'auth',
  // Written as its own artefact (out/server-side-<run>.json) by a CLI flag the page does not offer.
  // Listed here so that offering the flag and forgetting the panel cannot pass silently.
  'server_side',
];

/**
 * Outcomes per class, for the page. (#85)
 *
 * The band arithmetic comes from `k6/lib/failure.js` — the same function the drawn report uses — because
 * "cs_5xx counts the 502s and 504s too" in two places is two places to get it wrong, and this page and
 * that report end up side by side in the same conversation.
 *
 * A class that never ran has no row, and a run where nothing failed has no rows at all: six full-width
 * bars say nothing the p95 chart does not already say better.
 */
export function classOutcomes(perClass) {
  const names = Object.keys(perClass || {}).filter((c) => perClass[c] && Number(perClass[c].reqs) > 0);
  const rows = names.map((c) => {
    const bands = outcomeBands(perClass[c]);
    return {
      class: c,
      bands,
      failed: bands.filter((b) => b.key !== 'ok').reduce((n, b) => n + b.n, 0),
      total: bands.reduce((n, b) => n + b.n, 0),
    };
  });
  return rows.some((r) => r.failed > 0) ? rows : [];
}

/** The headline: which class, which code, what share. Null when nothing failed. */
export function failureModeText(fm) {
  if (!fm) return null;
  return {
    tone: 'warn',
    headline: `Failure mode: ${fm.code}`,
    detail: fm.line,
  };
}

/** Requested versus delivered, or the refusal in its place. */
export function deliveryText(d) {
  if (!d) return null;
  if (d.refused) {
    return { tone: 'warn', headline: 'Delivered rate not measured', detail: d.reason };
  }
  return {
    tone: 'info',
    headline: `${d.requested_rps} req/s requested → ${d.delivered_rps} req/s arrived at the target`,
    detail: d.note || '',
  };
}

/**
 * Why the rate was not held. The verdict decides the words: telling somebody to discard a run whose
 * target simply saturated throws away the finding they booked the window for.
 */
export function dropDiagnosisText(d) {
  if (!d) return null;
  if (d.verdict === 'target') {
    return {
      tone: 'warn',
      headline: 'The TARGET could not absorb the requested rate — a finding, not a wasted run',
      detail: `${d.reason} ${d.fix}`,
    };
  }
  if (d.verdict === 'generator') {
    return {
      tone: 'bad',
      headline: 'The GENERATOR was the bottleneck — DISCARD this run',
      detail: `${d.reason} ${d.fix}`,
    };
  }
  if (d.verdict === 'unreachable') {
    return { tone: 'bad', headline: 'The target never answered', detail: `${d.reason} ${d.fix}` };
  }
  return {
    tone: 'bad',
    headline: 'The rate was not held, and the cause could not be told — treat as a discard',
    detail: `${d.reason} ${d.fix}`,
  };
}
