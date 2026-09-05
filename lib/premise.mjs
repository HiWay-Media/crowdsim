/*
 * premise.mjs — does an `authed` class actually measure an authenticated read?
 *
 * WHY THIS EXISTS — the first authenticated smoke against a real target was green and measured nothing.
 * The `authed` class was pointed at `/api/auth/whoami`, which answers 200 with the same body whether or
 * not an `Authorization` header is present. So the class sent an anonymous GET wearing a bearer token and
 * reported p50 63 ms as an authenticated read. The login itself was proven — a real token, `no token: 0`
 * over 29 iterations — but the read was not, and nothing in the summary could tell the two apart.
 *
 * That is the failure shape this tool exists to avoid: a run that completed, clean, and answered a
 * question nobody asked. `cs_denied` counts 401/403 DURING a run, which is the opposite case (a class
 * being refused under load); it cannot help here, because the anonymous request succeeds.
 *
 * The check is one request per `authed` class, sent WITHOUT the token, before any load:
 *   401/403 → the premise holds. Stated out loud, because "no warning" is not evidence.
 *   2xx     → refused: this endpoint does not require the token.
 *   404/410 → refused: the pool names a path that does not exist (the older, already-known trap).
 *   3xx/5xx → unknown, and named as unknown. A redirect to a login page and a redirect to a public
 *             canonical URL look identical from here, and guessing between them would be exactly the
 *             confident-and-wrong answer the refusals above are for.
 *
 * Pure: no I/O, no network. The requests are made by the driver (curl), the verdicts are decided here so
 * that they are testable rather than merely plausible.
 */

/** Anything with a body that a bearer token is supposed to unlock. */
const AUTHED_KIND = 'authed';

/**
 * One path per `authed` class — the first entry of its pool, the same one `probe` already uses for the
 * cache check — plus the classes that cannot be probed at all, which are a finding rather than a skip:
 * a class with no URLs sends nothing and then vanishes from every table in the summary.
 */
export function authedTargets(profile) {
  const p = profile || {};
  const pools = p.pools || {};
  const targets = [];
  const skipped = [];
  for (const c of p.classes || []) {
    if (!c || c.kind !== AUTHED_KIND) continue;
    const name = c.name || '(unnamed)';
    if (!c.pool) {
      skipped.push({ class: name, reason: 'names no pool, so it has no URL to check — and no URL to run' });
      continue;
    }
    const pool = pools[c.pool];
    if (!Array.isArray(pool) || !pool.length) {
      skipped.push({
        class: name,
        reason: `names the pool "${c.pool}", which is ${Array.isArray(pool) ? 'empty' : 'not in this profile'}`,
      });
      continue;
    }
    targets.push({ class: name, pool: c.pool, path: String(pool[0]) });
  }
  return { targets, skipped };
}

/**
 * The verdict on one request sent without a token.
 * `o`: { status, error } — `error` is set when the request never landed at all.
 */
export function premiseVerdict(o) {
  const obs = o || {};
  const status = Number(obs.status) || 0;

  if (obs.error || !status) {
    return {
      verdict: 'unknown', usable: false, refuse: false,
      headline: 'the request never landed',
      why: `nothing answered${obs.error ? ` (${obs.error})` : ''}, so the premise could not be verified — `
        + 'this says nothing about the class, only that the check did not run.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      verdict: 'verified', usable: true, refuse: false,
      headline: `the endpoint refused the request without a token (${status})`,
      why: 'so what this class measures is an authenticated read, not a public one.',
    };
  }
  if (status >= 200 && status < 300) {
    return {
      verdict: 'public', usable: false, refuse: true,
      headline: `this endpoint does not require the token (${status} without one)`,
      why: 'this class would send an anonymous GET wearing a bearer token, and report the result as an '
        + 'authenticated read. Point it at a path that answers 401 without a token, or drop the class: '
        + 'the numbers it produces describe the public path.',
    };
  }
  if (status === 404 || status === 410) {
    return {
      verdict: 'missing', usable: false, refuse: true,
      headline: `the path does not exist on this target (${status})`,
      why: 'the pool this class draws from names URLs the target does not serve, so the class would be '
        + '100% failed and the brake would stop the run at a few req/s.',
    };
  }
  if (status >= 300 && status < 400) {
    return {
      verdict: 'unknown', usable: false, refuse: false,
      headline: `the endpoint answered with a redirect (${status})`,
      why: 'a redirect is not a refusal: it may be a login wall, or it may be a canonical URL that is '
        + 'then served publicly. Follow it by hand and check which one it is.',
    };
  }
  return {
    verdict: 'unknown', usable: false, refuse: false,
    headline: `the endpoint answered ${status}`,
    why: 'that is neither a refusal nor a successful read, so the premise could not be verified.',
  };
}

/**
 * The section `probe` prints. Returns null when there is nothing to say at all — a profile with no
 * `authed` class gets no empty heading.
 *
 * `refused` is true when at least one class cannot measure what it claims. It is deliberately not a
 * count: one unusable authenticated class is enough to make the authenticated half of a run meaningless,
 * and the tool must not present it as usable.
 */
/** Wrap a why-line onto a terminal, indented under the class it belongs to. */
function wrap(text, indent, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) { out.push(indent + line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(indent + line);
  return out;
}

export function renderPremise(observations, skipped) {
  const obs = observations || [];
  const skip = skipped || [];
  if (!obs.length && !skip.length) return null;

  const lines = ['── the premise of every authed class (one request, sent without the token) ──'];
  let refused = false;
  let verified = 0;

  const width = Math.max(0, ...obs.map((o) => String(o.class || '').length),
    ...skip.map((s) => String(s.class || '').length));

  for (const o of obs) {
    const v = premiseVerdict(o);
    if (v.verdict === 'verified') verified += 1;
    if (v.refuse) refused = true;
    const mark = v.verdict === 'verified' ? '✅' : (v.refuse ? '⛔' : '⚠️ ');
    lines.push(`  ${mark} ${String(o.class).padEnd(width)}  ${o.path}`);
    lines.push(`     ${v.headline}`);
    for (const l of wrap(v.why, '     ', 92)) lines.push(l);
  }
  for (const s of skip) {
    refused = true;
    lines.push(`  ⛔ ${String(s.class).padEnd(width)}  (not checked)`);
    for (const l of wrap(s.reason + '.', '     ', 92)) lines.push(l);
  }

  if (!refused && verified && verified === obs.length) {
    lines.push('  Every authed class is pointed at an endpoint that requires the token.');
  } else if (!refused) {
    for (const l of wrap('At least one premise could not be verified: read the line above before quoting '
      + 'any latency from that class.', '  ', 92)) lines.push(l);
  }
  return { text: lines.join('\n'), refused, verified };
}
