/*
 * The allowlist verdict the page shows before a run starts.
 *
 * This is a PREVIEW. The gate is `gate_allowlist` in bin/crowdsim, it runs in the child process, and it is
 * the only thing that decides — the page showing green does not authorise anything, and the page showing red
 * does not prevent anything. What this must never do is disagree in the reassuring direction: saying
 * "authorised" about a host the CLI will refuse teaches people to ignore the line.
 *
 * So the matching mirrors the driver's exactly: a comma-separated list of shell-style globs, matched against
 * the host with `*` and `?` and nothing else. A missing allowlist is not a permissive one.
 */

/** Same semantics as `case "$host" in $pat)` in the driver: * and ? are wildcards, everything else literal. */
export function hostAllowed(host, patterns) {
  if (!host) return false;
  const list = (patterns || []).map((p) => String(p).trim()).filter(Boolean);
  if (!list.length) return false;                 // no allowlist is not an allowlist
  return list.some((pattern) => {
    const rx = new RegExp(`^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`);
    return rx.test(host);
  });
}

/**
 * { state, text } — 'authorised' | 'refused' | 'unknown'.
 * 'unknown' is for when there is no host to judge yet, and says so instead of showing a reassuring dash.
 */
export function allowlistVerdict(host, patterns) {
  if (!host) {
    return { state: 'unknown', text: 'no target chosen yet' };
  }
  if (hostAllowed(host, patterns)) {
    return { state: 'authorised', text: `${host} is authorised` };
  }
  return {
    state: 'refused',
    text: `${host} is NOT in the allowlist — the run will be refused (exit 3)`,
  };
}
