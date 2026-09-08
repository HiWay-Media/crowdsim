/*
 * failure.js — WHAT broke, which goes before WHAT stopped the run.
 *
 * WHY THIS EXISTS — a report opened with *ABORTED by the brake — stopped by class html p95*, and the news
 * was **6.31% 404s, concentrated on the frontend classes alone**. Both sentences are true: a class
 * answering 404 at volume drags a p95 with it, so the brake really did fire on latency. But the headline
 * sends a reader looking for a slow renderer, and the renderer was fine — the pool named paths that tier
 * does not serve. The information was all in the summary already; nothing assembled it into the one
 * sentence somebody needs first.
 *
 * So: the failure mode comes first, the brake's own reason still comes after it, and neither replaces the
 * other. `aborted_by` answers "what stopped this run". This answers "what is wrong with the system".
 *
 * Derived from the summary and nothing else — no re-reading of the log, no estimate. A failure mode the
 * archive cannot support is absent rather than guessed.
 *
 * ES2019, no k6 imports: runs under `node --test` and inside the generator.
 */

/**
 * Below this share of the run, a failure is not the headline. Any banner that is always there stops being
 * read, and three 404s in ten thousand requests is noise. It is a SHARE and not a count on purpose: three
 * in thirty is the story.
 *
 * An aborted run is exempt — whatever failed there is material by definition, because it is what the
 * abort was about.
 */
export const HEADLINE_SHARE = 0.005;

/**
 * The codes, most specific first. Order matters and is not by count: `cs_5xx` counts the 504s and 502s
 * too, so picking the largest raw counter would report "5xx" for a run whose finding is a read timeout.
 * `denied` (401/403) is last of the coded ones because it is the narrowest claim — an authenticated class
 * being refused — and must not shadow a 5xx that happened alongside it.
 */
const CODES = [
  { key: 'e504', code: '504', what: 'read timeouts at the proxy' },
  { key: 'e502', code: '502', what: 'bad gateway from upstream' },
  { key: 'e5xx', code: '5xx', what: 'server errors' },
  { key: 'e404', code: '404', what: 'paths this target does not serve' },
  { key: 'denied', code: '401/403', what: 'requests refused' },
];

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/** How many of `key` a class recorded. */
function classCount(cls, key) {
  const errs = (cls && cls.errors) || {};
  return num(errs[key]);
}

/**
 * The failure mode of a run, or null when there is nothing to say.
 *
 * `s` is the summary (or the object being built into one): { requests, failed_rate, aborted, per_class,
 * e504, e502, e5xx, e404, denied }.
 */
export function failureMode(s) {
  if (!s) return null;
  const total = num(s.requests);
  if (!total) return null;
  const perClass = s.per_class || {};
  const names = Object.keys(perClass).filter(function (n) { return num(perClass[n].reqs) > 0; });

  // Pick the code first, then decide whether it is worth a headline: a 504 at 1% and a 404 at 1% are the
  // same share and different findings, and the choice must not depend on which one crossed a threshold.
  //
  // ⚠️ Specificity decides between codes that are BOTH THERE — never between a code that is there and one
  // that is a rounding error. Ordering by specificity alone put *0.01% answered 502* in a headline over
  // **474 × 404** in the same run: two requests out of 21,299 outranked the finding, which is the exact
  // failure this line exists to prevent, arrived at from the other side. So: among the codes that clear
  // the headline floor, the most specific wins; if none clears it, the largest does. Magnitude gates the
  // choice, specificity orders it.
  var present = [];
  for (var i = 0; i < CODES.length; i++) {
    var n = num(s[CODES[i].key]);
    if (n > 0) present.push({ def: CODES[i], count: n, share: n / total });
  }
  var material = present.filter(function (c) { return c.share >= HEADLINE_SHARE; });
  var chosen = null;
  if (material.length) {
    chosen = material[0].def;                       // CODES order = specificity, already applied
  } else if (present.length) {
    var biggest = present[0];
    for (var j = 1; j < present.length; j++) if (present[j].count > biggest.count) biggest = present[j];
    chosen = biggest.def;
  }

  var count;
  var code;
  var what;
  if (chosen) {
    count = num(s[chosen.key]);
    code = chosen.code;
    what = chosen.what;
  } else {
    // http_req_failed can be non-zero with every counter at zero: a connection that never got a status
    // at all. Reporting nothing here would leave the most severe case silent.
    var failed = 0;
    for (var f = 0; f < names.length; f++) failed += num(perClass[names[f]].failed);
    if (!failed) failed = Math.round(num(s.failed_rate) * total);
    if (!failed) return null;
    count = failed;
    code = 'no status';
    what = 'requests that never returned a status at all';
  }

  const share = count / total;
  if (share < HEADLINE_SHARE && s.aborted !== true) return null;

  // Which classes carry it. A code on some classes and not others is a different finding from the same
  // code spread evenly: the first points at a pool or a route, the second at the system.
  const carrying = [];
  if (chosen) {
    for (var c = 0; c < names.length; c++) {
      if (classCount(perClass[names[c]], chosen.key) > 0) carrying.push(names[c]);
    }
  } else {
    for (var d = 0; d < names.length; d++) {
      if (num(perClass[names[d]].failed) > 0) carrying.push(names[d]);
    }
  }

  const concentrated = carrying.length > 0 && names.length > 1 && carrying.length < names.length;
  const pct = (share * 100).toFixed(2) + '%';

  var line;
  if (concentrated) {
    line = pct + ' of requests answered ' + code + ' (' + what + '), concentrated on '
      + carrying.length + ' of ' + names.length + ' classes: ' + carrying.join(', ')
      + '. The other classes did not see it, so this is about what those classes request — '
      + 'not about the system as a whole.';
  } else if (carrying.length && names.length > 1) {
    line = pct + ' of requests answered ' + code + ' (' + what + '), on every class that ran. '
      + 'Spread evenly rather than concentrated, so it is not one route or one pool.';
  } else {
    line = pct + ' of requests answered ' + code + ' (' + what + ').';
  }

  return {
    code: code,
    count: count,
    share: share,
    classes: carrying,
    class_count: names.length,
    concentrated: concentrated,
    line: line,
  };
}
