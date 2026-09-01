/*
 * weights.mjs — the class mix, measured on an access log instead of guessed.
 *
 * The mix is the one input this tool insists must be measured: every page of the documentation says the
 * weights have to come from your own edge log, and `crowdsim init` writes them as a TODO for exactly that
 * reason. Nothing in the tool read a log, so the most important number in a profile was left to somebody
 * counting lines in a terminal — which in practice means a guess with a decimal point.
 *
 * What this does NOT do is fetch the log. That would mean privileged access to a production edge, which
 * this project deliberately does not want: the log arrives on stdin, or as a file the operator hands over.
 *
 * Four decisions here are about honesty rather than parsing, and each one is tested:
 *
 *  · **A class is recognised by what the profile declares, not by a built-in list of URL shapes.** The rules
 *    are, in order: `log_match` globs, `path_prefix`, then membership of the class's own pool — plus the
 *    hard filter that an `rsc` class only ever matches a request carrying the navigation query parameter,
 *    and a `plain` class only ever matches one without it. A tool that guessed "this looks like a static
 *    asset" would be inventing a mix, which is the thing this command exists to stop.
 *  · **What did not match is the interesting part, and it is reported as a share.** A mix computed from 40%
 *    of the log is a mix of something else. Unclassified lines are counted, sampled by path so you can see
 *    what to declare, and never folded into a class.
 *  · **Non-GET and non-2xx/3xx are excluded, and said so.** This tool sends GETs and nothing else, so a
 *    write in the mix is a weight for load that will never be generated; and a 404 in the mix is a weight
 *    for requesting URLs that do not exist — the same reasoning `har.mjs` applies to a recording.
 *  · **A line that could not be parsed is never a line that was 0.** Unparsed lines are counted separately
 *    from unclassified ones: the first means the format is wrong, the second means the profile is
 *    incomplete, and the fix is different.
 *
 * Pure and dependency-free, so it is testable: no fs, no network, no process. It is fed lines by
 * lib/weights-cli.mjs, which is the only part that touches a file descriptor. ES modules, node >= 18.
 */

/** nginx/Apache combined: the request is one quoted token, the status the bare number after it. */
const REQUEST_LINE = /^([A-Z]{3,10})\s+(\S+)(?:\s+(HTTP\/[\d.]+))?$/;

/** [01/Sep/2026:12:00:00 +0000] — the only timestamp shape the combined format has. */
const CLF_TIME = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Field names `--format` understands. Anything else is a column this command will not pretend to read. */
export const KNOWN_FIELDS = ['request', 'path', 'method', 'status', 'time', '-'];

/**
 * Split a log line the way the combined format is built: whitespace-separated, except that `"…"` and
 * `[…]` are single tokens. Done by hand rather than with one big regex so that a line which does not fit
 * the format comes back as tokens to be rejected, instead of as a silent non-match.
 */
export function tokenize(line) {
  const out = [];
  let i = 0;
  const s = String(line);
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let close = null;
    if (s[i] === '"') close = '"';
    else if (s[i] === '[') close = ']';
    if (close) {
      const end = s.indexOf(close, i + 1);
      if (end === -1) { out.push(s.slice(i + 1)); break; }
      out.push(s.slice(i + 1, end));
      i = end + 1;
    } else {
      let j = i;
      while (j < s.length && !/\s/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** The `[01/Sep/2026:12:00:00 +0000]` token as an ISO-ish string, or null. Used only for the window. */
export function clfTime(token) {
  const m = CLF_TIME.exec(String(token || ''));
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2]);
  if (mon === -1) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`;
}

/**
 * One log line → {method, path, query, status, time} or null when nothing in it looks like a request.
 * With no `format`, the request is found by shape (the token that reads `GET /x HTTP/1.1`) rather than by
 * position: the combined format has variants, and a positional guess is how a column gets misread.
 */
export function parseLine(line, format) {
  const tokens = tokenize(line);
  if (!tokens.length) return null;
  const rec = { method: null, path: null, query: '', status: null, time: null };

  if (format && format.length) {
    for (let i = 0; i < format.length && i < tokens.length; i++) {
      const name = format[i];
      const tok = tokens[i];
      if (name === '-' ) continue;
      if (name === 'request') {
        const m = REQUEST_LINE.exec(tok.trim());
        if (!m) return null;
        rec.method = m[1];
        splitPath(rec, m[2]);
      } else if (name === 'path') {
        splitPath(rec, tok);
      } else if (name === 'method') {
        rec.method = tok.toUpperCase();
      } else if (name === 'status') {
        rec.status = /^\d{3}$/.test(tok) ? Number(tok) : null;
      } else if (name === 'time') {
        rec.time = clfTime(tok);
      }
    }
    if (!rec.path) return null;
    if (!rec.method) rec.method = 'GET';
    return rec;
  }

  for (let i = 0; i < tokens.length; i++) {
    const m = REQUEST_LINE.exec(tokens[i].trim());
    if (!m) {
      if (!rec.time) rec.time = clfTime(tokens[i]);
      continue;
    }
    rec.method = m[1];
    splitPath(rec, m[2]);
    const next = tokens[i + 1];
    if (next && /^\d{3}$/.test(next)) rec.status = Number(next);
    return rec;
  }
  return null;
}

function splitPath(rec, raw) {
  let v = String(raw || '');
  // An absolute-form request target is legal and proxies log it: keep the path, drop the origin.
  const scheme = /^https?:\/\/[^/]+/i.exec(v);
  if (scheme) v = v.slice(scheme[0].length) || '/';
  const q = v.indexOf('?');
  if (q === -1) { rec.path = v; rec.query = ''; return; }
  rec.path = v.slice(0, q);
  rec.query = v.slice(q + 1);
}

/** `/_next/static/*` → anchored regex. `*` spans `/` on purpose: a path glob that stops at a segment
 *  boundary would need `**`, and nobody remembers which one a given tool wants. */
export function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Does the query string carry the navigation parameter? `_rsc` and `_rsc=abc` both count. */
export function hasParam(query, param) {
  if (!query) return false;
  const p = String(param);
  for (const pair of String(query).split('&')) {
    const name = pair.indexOf('=') === -1 ? pair : pair.slice(0, pair.indexOf('='));
    if (name === p) return true;
  }
  return false;
}

/** The query with the navigation parameter removed, so a pool entry that has its own query still matches. */
function queryWithout(query, param) {
  if (!query) return '';
  return String(query).split('&').filter((pair) => {
    const name = pair.indexOf('=') === -1 ? pair : pair.slice(0, pair.indexOf('='));
    return name !== String(param);
  }).join('&');
}

/**
 * Turn a profile into matchers, one per class, in profile order.
 *
 * `pools` is the resolved pool map — the driver has already turned `"@pool-pages.json"` into a list by the
 * time this runs. A pool that could not be resolved is simply absent, and the class then matches on its
 * declared rules only; it is not an error, because a class can be recognised by `log_match` alone.
 */
export function compileRules(profile, opts) {
  const o = opts || {};
  const rscParam = (profile && profile.rsc && (profile.rsc.param || profile.rsc.query)) || o.rscParam || '_rsc';
  const pools = (profile && profile.pools) || {};
  const classes = ((profile && profile.classes) || []).filter((c) => c && c.name);

  return {
    rscParam,
    classes: classes.map((c) => {
      const poolRaw = Array.isArray(pools[c.pool]) ? pools[c.pool] : [];
      const pool = new Set();
      const poolPaths = new Set();
      for (const entry of poolRaw) {
        if (typeof entry !== 'string' || !entry) continue;
        const withPrefix = c.path_prefix ? c.path_prefix + (entry === '/' ? '/' : entry) : entry;
        pool.add(withPrefix);
        const q = withPrefix.indexOf('?');
        poolPaths.add(q === -1 ? withPrefix : withPrefix.slice(0, q));
      }
      return {
        name: c.name,
        label: c.label || c.name,
        kind: c.kind === 'rsc' ? 'rsc' : 'plain',
        prefix: c.path_prefix || null,
        globs: (Array.isArray(c.log_match) ? c.log_match : []).filter((g) => typeof g === 'string' && g)
          .map((g) => ({ glob: g, re: globToRegExp(g) })),
        pool,
        poolPaths,
        declared: Boolean(
          (Array.isArray(c.log_match) && c.log_match.length) || c.path_prefix || poolRaw.length,
        ),
      };
    }),
  };
}

/**
 * Which class does this request belong to? Returns the class name, or null.
 *
 * The rule order is the contract, and it is the profile's own vocabulary in decreasing explicitness:
 *   0. kind — an `rsc` class only matches a request carrying the navigation parameter, and a `plain` class
 *      only one without it. This is a filter, not a score: a navigation request is a different class of
 *      work from the document at the same path, which is the entire reason the two are separate classes.
 *   1. `log_match` — what the operator declared this class looks like in a log.
 *   2. `path_prefix` — already declared, already unambiguous.
 *   3. the class's own pool — the paths the tool would actually request for it.
 * First match in profile order wins, so a specific class declared before a broad one keeps its traffic.
 */
export function classifyRequest(rec, rules) {
  const isRsc = hasParam(rec.query, rules.rscParam);
  const bare = queryWithout(rec.query, rules.rscParam);
  const withQuery = bare ? `${rec.path}?${bare}` : rec.path;

  for (const c of rules.classes) {
    if ((c.kind === 'rsc') !== isRsc) continue;
    let hit = false;
    for (const g of c.globs) {
      if (g.re.test(rec.path) || g.re.test(withQuery)) { hit = true; break; }
    }
    if (!hit && c.prefix && rec.path.indexOf(c.prefix) === 0) hit = true;
    if (!hit && (c.pool.has(withQuery) || c.poolPaths.has(rec.path))) hit = true;
    if (hit) return c.name;
  }
  return null;
}

/**
 * The accumulator. Kept separate from any I/O so a 4 GB log can be streamed through it line by line, and
 * so the whole thing is testable with an array of strings.
 *
 * `maxDistinct` caps the unclassified sample: a log with a million distinct URLs must not turn this into a
 * memory problem, and when the cap is reached that fact is reported rather than silently truncating.
 */
export function newTally(profile, opts) {
  const o = opts || {};
  return {
    rules: compileRules(profile, o),
    maxDistinct: o.maxDistinct || 5000,
    lines: 0,
    unparsed: 0,
    unparsedSamples: [],
    skipped: { method: 0, status: 0 },
    counted: 0,
    perClass: new Map(),
    unclassified: 0,
    unclassifiedPaths: new Map(),
    unclassifiedCapped: false,
    firstTime: null,
    lastTime: null,
  };
}

export function feed(tally, line, format) {
  if (!String(line).trim()) return tally;
  tally.lines++;
  const rec = parseLine(line, format);
  if (!rec) {
    tally.unparsed++;
    if (tally.unparsedSamples.length < 3) tally.unparsedSamples.push(String(line).slice(0, 160));
    return tally;
  }
  if (rec.time) {
    if (!tally.firstTime || rec.time < tally.firstTime) tally.firstTime = rec.time;
    if (!tally.lastTime || rec.time > tally.lastTime) tally.lastTime = rec.time;
  }
  if (rec.method !== 'GET') { tally.skipped.method++; return tally; }
  if (rec.status !== null && (rec.status < 200 || rec.status >= 400)) { tally.skipped.status++; return tally; }

  tally.counted++;
  const name = classifyRequest(rec, tally.rules);
  if (name === null) {
    tally.unclassified++;
    const key = rec.path;
    if (tally.unclassifiedPaths.has(key)) {
      tally.unclassifiedPaths.set(key, tally.unclassifiedPaths.get(key) + 1);
    } else if (tally.unclassifiedPaths.size < tally.maxDistinct) {
      tally.unclassifiedPaths.set(key, 1);
    } else {
      tally.unclassifiedCapped = true;
    }
    return tally;
  }
  tally.perClass.set(name, (tally.perClass.get(name) || 0) + 1);
  return tally;
}

/**
 * The result. Weights are the share of the CLASSIFIED requests, renormalised to 100 — which is the same
 * arithmetic `shares()` does at run time, so a pasted weight means what it looks like.
 *
 * `unclassified.share` is over the counted requests, NOT over the classified ones. Those two denominators
 * are the whole point: a 9% unclassified share means the printed mix describes 91% of the traffic, and
 * hiding that behind a percentage of the part that did match would make the number look complete.
 */
export function result(tally, opts) {
  const o = opts || {};
  const top = o.top || 10;
  const classified = Array.from(tally.perClass.values()).reduce((a, b) => a + b, 0);
  const classes = tally.rules.classes.map((c) => {
    const count = tally.perClass.get(c.name) || 0;
    return {
      name: c.name,
      kind: c.kind,
      count,
      share: classified > 0 ? count / classified : 0,
      weight: classified > 0 ? Math.round((count / classified) * 1000) / 10 : 0,
      declared: c.declared,
    };
  });
  const unclassifiedTop = Array.from(tally.unclassifiedPaths.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, top)
    .map(([path, count]) => ({ path, count }));

  return {
    lines: tally.lines,
    unparsed: tally.unparsed,
    unparsed_samples: tally.unparsedSamples.slice(),
    unparsed_share: tally.lines > 0 ? tally.unparsed / tally.lines : 0,
    skipped: { method: tally.skipped.method, status: tally.skipped.status },
    counted: tally.counted,
    classified,
    classes,
    unclassified: {
      count: tally.unclassified,
      share: tally.counted > 0 ? tally.unclassified / tally.counted : 0,
      top: unclassifiedTop,
      capped: tally.unclassifiedCapped,
    },
    window: { from: tally.firstTime, to: tally.lastTime },
  };
}

/** Convenience for the tests and for `init`: an array of lines straight to a result. */
export function weightsFromLog(lines, profile, opts) {
  const o = opts || {};
  const tally = newTally(profile, o);
  for (const line of lines) feed(tally, line, o.format);
  return result(tally, o);
}

/**
 * Suggested `log_match` patterns for what did not match, collapsed to the deepest common directory. Not
 * written anywhere by this tool — it is printed so the operator can decide which class the traffic belongs
 * to, which is a judgement about their own site and not one to be inferred from a frequency count.
 */
export function suggestPatterns(unclassifiedTop, limit) {
  const dirs = new Map();
  for (const { path, count } of unclassifiedTop) {
    const cut = path.lastIndexOf('/');
    const dir = cut <= 0 ? '/' : path.slice(0, cut);
    dirs.set(dir, (dirs.get(dir) || 0) + count);
  }
  return Array.from(dirs.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit || 5)
    .map(([dir]) => (dir === '/' ? '/*' : `${dir}/*`));
}
