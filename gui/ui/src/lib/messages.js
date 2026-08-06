/*
 * The sentences that are not decoration.
 *
 * Most of the wording in this UI can be improved by anyone at any time. These cannot be softened without
 * changing what the page means, so they live here, where a test can assert them, instead of inside JSX where
 * the only reviewer is whoever reads the diff.
 *
 * Each one exists because the alternative is somebody acting on a misunderstanding:
 *  · the safe-peak block is the last thing between a click and 5xx served to real users;
 *  · the refusal is the entire answer when two runs are not comparable;
 *  · "unknown" and "MISS" describe two different worlds, one of which is a wrong header name in a profile.
 */

export const SAFE_PEAK = {
  /** Stated as a fact about what happens next, not as a question about whether you are sure. */
  consequence: (peak, safePeak, host) => `${peak} req/s is above this profile's safe ceiling of `
    + `${safePeak} req/s.`,
  explain: (host) => 'Past this point the run is expected to serve 5xx to real users of '
    + `${host || 'the target'}, and to degrade any co-tenant on the same nodes. Agree a window, tell whoever `
    + 'watches the uptime alerts, and be ready to stop. Then type the profile name to confirm.',
  /** Two deliberate acts, for this run only. Neither is ever remembered. */
  checkbox: 'I know this breaks production',
  confirmLabel: 'Profile name',
  /** Shown by the preview when the flag is armed: reading it must not be mistaken for arming it. */
  previewArmed: 'You are reading it armed; starting it still requires the profile name typed by hand, for '
    + 'this run only.',
  within: (safePeak) => `Within the profile's safe ceiling${safePeak !== null ? ` (${safePeak} req/s)` : ''}.`,
};

export const REFUSAL = {
  title: 'Refusing to compare these two runs.',
  why: 'A comparison that is not like-for-like is a confident number with nothing behind it.',
};

export const LAYER = {
  hit: 'HIT',
  miss: 'MISS',
  /** NOT "MISS", and not 0%: the header was never in the response at all. */
  unknown: 'unknown',
  absent: 'not present',
  absentExplained: (headers) => `${headers.length} declared header${headers.length > 1 ? 's' : ''} never `
    + `appeared (${headers.join(', ')}). That is usually the wrong header name in the profile rather than a `
    + 'cold cache. A layer that never speaks is reported as unknown and never as a miss, so it cannot '
    + 'quietly drag a hit ratio to zero — but it also means this run measures nothing about that layer.',
};

/** How a three-valued layer verdict is shown. null is not false. */
export function layerVerdict(hit) {
  if (hit === null || hit === undefined) return { text: LAYER.unknown, tone: 'warn' };
  return hit ? { text: LAYER.hit, tone: 'ok' } : { text: LAYER.miss, tone: 'note' };
}
