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
  /**
   * A warm-up is load. Naming which of the two rates is over the ceiling matters: told that a 60 req/s run
   * is refused, nobody looks at the warm-up field — and the driver's exit 3 does not name it either.
   */
  warmupOver: (rate, safePeak) => `The warm-up alone runs at ${rate} req/s, above this profile's safe `
    + `ceiling of ${safePeak} req/s. A warm-up generates real load and passes the same gate as the peak.`,
};

export const WARMUP = {
  /** Not "faster results": the point is that the number means something else without it. */
  why: 'The first seconds of a run measure an empty cache, a cold pool and an unJITted app, and they sit '
    + 'inside the p95 you are about to quote. A warm-up runs the generator first and throws those numbers '
    + "away — they go to the run's own warmup- summary file, which has no brake and is not a result.",
  /** A blank rate is not "no rate": it is --start, which is what the driver does with it. */
  rateDefault: (start) => `Blank means the ramp's own starting rate (${start} req/s).`,
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
/**
 * The brake tripped — but for whom, and against which number. A class may declare its own max_p95_ms, so the
 * knee is no longer necessarily at the profile's SLO nor in the profile's brake class, and "you found the
 * knee" alone leaves the reader with nowhere to go. Returns null when the run does not know: every summary
 * archived before per-class SLOs has no attribution, and deriving one from the profile would name a class
 * that may not be the one that crossed.
 */
export function abortDetail(by) {
  if (!by || !by.threshold) return null;
  const where = by.class ? `class ${by.class}` : by.metric;
  const at = (by.value === null || by.value === undefined) ? '' : `, reached ${Math.round(by.value * 100) / 100}`;
  return `Stopped by ${where} — ${by.threshold}${at}.`;
}

export function layerVerdict(hit) {
  if (hit === null || hit === undefined) return { text: LAYER.unknown, tone: 'warn' };
  return hit ? { text: LAYER.hit, tone: 'ok' } : { text: LAYER.miss, tone: 'note' };
}
