/*
 * args.js — turning a form submission into a crowdsim command line.
 *
 * This is the security-critical file of the GUI. The gates live in bin/crowdsim and the GUI must not be
 * able to weaken them, so this module has exactly one job: produce an argv array of KNOWN flags with
 * VALIDATED values, and refuse everything else. Consequences of that design, all tested:
 *
 *  · allowlisting is not re-implemented here. The CLI decides, and its exit code 3 is surfaced as-is.
 *  · --i-know-this-breaks-production is never inferred. It requires force:true AND a confirmation string
 *    typed by the user, per run. It is never stored in a profile or a server setting — a remembered
 *    override is an outage waiting for someone to click Run again.
 *  · nothing is ever interpolated into a shell. The caller spawns with this array and no shell, so a
 *    profile called `x.json; rm -rf /` is just a filename that does not exist.
 */

import fs from 'node:fs';
import path from 'node:path';

export class InvalidRun extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'InvalidRun';
    this.field = field;
    this.status = 400;
  }
}

const DURATION = /^\d+(ms|s|m|h)?$/;
const CLASS_LIST = /^[A-Za-z0-9_,-]*$/;
// A metric name, not a sentence: this string is passed to the driver and then rendered on the page and
// in a report, so it stays in the shape of an identifier.
const METRIC_LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
// A relative path with no traversal and no absolute root. The series lives on the machine the server runs
// on, and the page is a form: `../../etc/passwd` must not become an argument. The driver resolves what is
// left against its own working directory, which is where a run's files already live.
const SAFE_REL_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_.\/-]{1,255}$/;
export const SHAPES = ['mix', 'journey'];
export const RSC_MODES = ['repeat', 'random'];

function int(v, field, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new InvalidRun(field, `${field} must be an integer between ${min} and ${max}`);
  }
  return String(n);
}

function ratio(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new InvalidRun(field, `${field} must be between 0 and 1`);
  return String(n);
}

function duration(v, field) {
  const s = String(v);
  if (!DURATION.test(s)) throw new InvalidRun(field, `${field} must look like 30s, 2m or 500ms`);
  return s;
}

function enumOf(v, field, allowed) {
  if (allowed.indexOf(v) === -1) throw new InvalidRun(field, `${field} must be one of ${allowed.join(', ')}`);
  return v;
}

/**
 * A base URL typed into the GUI. Only http/https, and no credentials — a URL with a userinfo part is
 * almost always a copy-paste accident, and it would end up in the log and in the history file.
 */
function baseUrl(v) {
  let u;
  try { u = new URL(String(v)); } catch (e) { throw new InvalidRun('baseUrl', 'baseUrl is not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new InvalidRun('baseUrl', 'baseUrl must be http or https');
  }
  if (u.username || u.password) throw new InvalidRun('baseUrl', 'baseUrl must not contain credentials');
  return u.origin;
}

function targetName(v) {
  // Must start with an alphanumeric: a value like "--peak" would otherwise be handed to the driver as a
  // target name and read as a flag by anything less careful than the current parser.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(v))) {
    throw new InvalidRun('target', 'target must be a name declared in the profile');
  }
  return String(v);
}

/**
 * Build the argv for `crowdsim load`.
 *   run          — the request body from the GUI
 *   profilePath  — an absolute path already resolved and checked by profiles.js
 *   profileName  — used as the confirmation phrase for the safe-peak override
 *   opts.preview — build the line WITHOUT demanding the typed confirmation, for display only
 *
 * `preview` exists so the operator can read the exact command before committing to it, including the
 * override flag while it is still being armed. It is safe precisely because it changes nothing else: the
 * only caller that may pass it is the endpoint that spawns no process, and the check it skips is re-run in
 * full when the run is actually started. It must never be reachable from POST /api/runs.
 */
export function buildLoadArgs(run, profilePath, profileName, opts) {
  const r = run || {};
  const preview = Boolean(opts && opts.preview);
  const args = ['load', '--profile', profilePath];

  if (r.baseUrl) args.push('--base-url', baseUrl(r.baseUrl));
  else if (r.target) args.push('--target', targetName(r.target));

  args.push('--peak', int(r.peak === undefined ? 60 : r.peak, 'peak', 1, 100000));
  if (r.start !== undefined && r.start !== '') args.push('--start', int(r.start, 'start', 1, 100000));
  if (r.steps !== undefined && r.steps !== '') args.push('--steps', int(r.steps, 'steps', 1, 50));
  if (r.stepDur) args.push('--step-dur', duration(r.stepDur, 'stepDur'));
  if (r.hold !== undefined && r.hold !== '') args.push('--hold', duration(r.hold, 'hold'));
  if (r.shape) args.push('--shape', enumOf(r.shape, 'shape', SHAPES));
  if (r.rscMode) args.push('--rsc-mode', enumOf(r.rscMode, 'rscMode', RSC_MODES));
  if (r.maxP95 !== undefined && r.maxP95 !== '') args.push('--max-p95', int(r.maxP95, 'maxP95', 1, 600000));
  if (r.max5xx !== undefined && r.max5xx !== '') args.push('--max-5xx', ratio(r.max5xx, 'max5xx'));
  if (r.safePeak !== undefined && r.safePeak !== '') args.push('--safe-peak', int(r.safePeak, 'safePeak', 1, 100000));
  if (r.skipClasses) {
    if (!CLASS_LIST.test(String(r.skipClasses))) throw new InvalidRun('skipClasses', 'skipClasses must be a comma-separated list of class names');
    args.push('--skip-classes', String(r.skipClasses));
  }
  // A warm-up is load. It is passed through like any other flag and gated by the driver exactly like the
  // peak — including the safe ceiling, which `bin/crowdsim` re-checks with the warm-up rate in place of the
  // peak. Priming a cache is not a way around a ceiling, and this file is not where that would be decided.
  if (r.warmup !== undefined && r.warmup !== '') args.push('--warmup', duration(r.warmup, 'warmup'));
  if (r.warmupPeak !== undefined && r.warmupPeak !== '') {
    if (r.warmup === undefined || r.warmup === '') {
      throw new InvalidRun('warmup', 'a warm-up rate without a warm-up duration would do nothing: set both');
    }
    args.push('--warmup-peak', int(r.warmupPeak, 'warmupPeak', 1, 100000));
  }
  // ── the two follow-up runs (1.30.0) ────────────────────────────────────────────────────────────────
  // These are not ordinary form fields: either one can start a FURTHER run. The driver keeps both gates
  // on every attempt and does not inherit the safe-peak override, so nothing about safety is decided
  // here — what is decided here is that the page cannot ask for a combination that will not happen.
  if (r.recalibrate && r.certify) {
    throw new InvalidRun('recalibrate',
      'recalibrate and certify are two different follow-up runs and the driver takes the first: choose '
      + 'one. Recalibrate retries a ramp that started too high; certify holds a knee that was swept.');
  }
  if (r.recalibrate) args.push('--recalibrate');
  if (r.recalibrateFloor !== undefined && r.recalibrateFloor !== '') {
    if (!r.recalibrate) {
      throw new InvalidRun('recalibrateFloor',
        'a recalibration floor without --recalibrate would do nothing: set both, or neither');
    }
    args.push('--recalibrate-floor', int(r.recalibrateFloor, 'recalibrateFloor', 1, 100000));
  }
  if (r.certify) args.push('--certify');
  if (r.certifyHold !== undefined && r.certifyHold !== '') {
    if (!r.certify) {
      throw new InvalidRun('certifyHold',
        'a certification hold without --certify would do nothing: set both, or neither');
    }
    args.push('--certify-hold', duration(r.certifyHold, 'certifyHold'));
  }

  // ── a server-side series (1.31.0) ──────────────────────────────────────────────────────────────────
  // The DECISION, written down because the issue asked for one: the page may name a file, and the file
  // must be a relative path under the server's working directory. crowdsim never fetches a series (see
  // INTENT.md), so there is no URL to accept here, and a form field that could name any absolute path on
  // the server is a file-read primitive with a text box in front of it.
  if (r.serverMetrics !== undefined && r.serverMetrics !== '') {
    // The label first, deliberately: it is the cheaper mistake and the simpler fix, and reporting the
    // path when the label is what is missing sends somebody to look at their filesystem.
    if (!r.serverMetricsLabel) {
      throw new InvalidRun('serverMetricsLabel',
        'a series needs a label: an unnamed column of numbers cannot be read against anything');
    }
    if (!METRIC_LABEL.test(String(r.serverMetricsLabel))) {
      throw new InvalidRun('serverMetricsLabel',
        'the label must look like a metric name (letters, digits, _ . : -), because it is rendered');
    }
    const resolved = seriesPath(r.serverMetrics, opts && opts.seriesDir);
    // Resolved, so the driver reads the file that was CHECKED. Handing over the name instead would let
    // it be re-resolved against whatever directory the driver runs in.
    args.push('--server-metrics', resolved);
    args.push('--server-metrics-label', String(r.serverMetricsLabel));
  } else if (r.serverMetricsLabel) {
    throw new InvalidRun('serverMetrics',
      'a label with no series file would do nothing: set both, or neither');
  }

  if (r.touchAndGo) args.push('--touch-and-go');
  if (r.insecure) args.push('--insecure');
  if (r.slack) args.push('--slack');
  if (r.dryRun) args.push('--dry-run');

  if (r.force) {
    // Deliberate friction. The CLI already demands the flag on the command line every time; the GUI is a
    // button, so it demands the profile name typed by hand for this specific run. Anything less and the
    // override becomes a checkbox someone leaves ticked.
    if (!preview && String(r.confirm || '') !== String(profileName)) {
      throw new InvalidRun('confirm',
        `going past the safe peak requires typing the profile name (“${profileName}”) as confirmation`);
    }
    args.push('--i-know-this-breaks-production');
  }
  return args;
}

export function buildProbeArgs(run, profilePath) {
  const r = run || {};
  const args = ['probe', '--profile', profilePath];
  if (r.target) args.push('--target', targetName(r.target));
  if (r.insecure) args.push('--insecure');
  return args;
}

export function buildDiscoverArgs(run, profilePath) {
  const r = run || {};
  const args = ['discover', '--profile', profilePath];
  if (r.target) args.push('--target', targetName(r.target));
  if (r.limit !== undefined && r.limit !== '') args.push('--limit', int(r.limit, 'limit', 1, 100000));
  return args;
}

/**
 * A server-side series the page named, resolved and contained. (#91)
 *
 * WHY THIS IS NOT A PATTERN — `gui/server/lib/profiles.js` has resolved and contained a browser-supplied
 * name since the beginning: `realpathSync` the base, `resolve` the name against it, refuse if it landed
 * elsewhere. This field, added later, matched a regex instead. The regex refuses an absolute path and any
 * `..` segment, which is the traversal that matters most — and it cannot see a **symlink**: a name with
 * no `..` in it that resolves outside anyway. The driver then read whatever it pointed at and rendered
 * numbers out of it into a page. The weaker of two checks guarding the same kind of thing, in the newer
 * code, which is the direction this repository is usually careful about.
 *
 * A DEDICATED DIRECTORY rather than the server's working directory: easier to reason about, and easier to
 * mount read-only in the container. Nothing configured means the field is refused — falling back to the
 * cwd is what made this weak in the first place.
 *
 * Nesting is allowed (a series directory is naturally organised by date), unlike a profile name, which is
 * flat. Containment is what matters, not depth.
 */
function seriesPath(v, seriesDir) {
  if (!seriesDir) {
    throw new InvalidRun('serverMetrics', 'this server has no series directory configured, so it will '
      + 'not read one: set CROWDSIM_SERIES_DIR to a directory holding the series files (mount it '
      + 'read-only in the container).');
  }
  const name = String(v);
  if (!SAFE_REL_PATH.test(name)) {
    throw new InvalidRun('serverMetrics', 'the series must be a relative path with no ".." in it, made '
      + 'of letters, digits, dots, dashes, underscores and slashes');
  }
  let base;
  try {
    base = fs.realpathSync(seriesDir);
  } catch (e) {
    throw new InvalidRun('serverMetrics', `the series directory ${seriesDir} is not there: `
      + 'create it, or point CROWDSIM_SERIES_DIR somewhere that exists.');
  }
  const candidate = path.resolve(base, name);
  let full;
  try {
    // realpath, not existsSync: resolving the symlinks is the whole point, and a file that is not there
    // cannot be read anyway. The two refusals are kept apart because they send you to different places.
    full = fs.realpathSync(candidate);
  } catch (e) {
    throw new InvalidRun('serverMetrics', `the series ${name} is not there under ${base}`);
  }
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new InvalidRun('serverMetrics', `the series ${name} resolves outside the series directory `
      + `(${base}) — a symlink or a mount can leave it without a ".." anywhere in the name.`);
  }
  return full;
}

/**
 * A filter value that reaches an argv. `--target` is matched by the driver as a substring of the base_url
 * host, and `--profile` against the profile name in history.tsv: both are opaque strings to us, so the
 * charset is the check. A leading dash is refused explicitly — a value that starts with one becomes a
 * flag rather than an argument, which is the oldest way to smuggle one in.
 */
const FILTER_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;

function filterValue(v, field) {
  const s = String(v);
  if (!FILTER_VALUE.test(s) || s.startsWith('-')) {
    throw new InvalidRun(field, `${field} must look like a host or a profile name (letters, digits, `
      + '. : _ -) and may not start with a dash');
  }
  return s;
}

/**
 * `crowdsim history --html`: the knee over time, drawn. (#90)
 *
 * `--out` is required rather than optional: without it the driver names the file after the invocation
 * (`trend-<run id>.html`), and the server would have to guess which of them it just wrote.
 *
 * The filters are the ones `history` itself accepts, so the page and the table cannot be two answers to
 * one question — a trend drawn from every run while the table shows five is exactly that.
 */
export function buildTrendArgs(query, outFile) {
  const q = query || {};
  if (!outFile) throw new InvalidRun('out', 'the trend needs an --out path: the driver names the file '
    + 'after the invocation, not after a run');
  const args = ['history', '--html', '--out', String(outFile)];
  if (q.last !== undefined && q.last !== '') {
    args.push('--last', String(int(q.last, 'last', 1, 100000)));
  }
  if (q.target !== undefined && q.target !== '') args.push('--target', filterValue(q.target, 'target'));
  if (q.profile !== undefined && q.profile !== '') args.push('--profile', filterValue(q.profile, 'profile'));
  return args;
}

/**
 * `crowdsim compare <a> <b> --html`: the delta, drawn. (#90)
 *
 * Exact run ids only. `latest` and `previous` are the CLI resolving an id for somebody typing at a
 * terminal; the page is showing the archive and already knows which two runs it means, so accepting a
 * selector here would let the page and the file it hands over name different runs.
 *
 * Every refusal stays the CLI's: this builds an argv and decides nothing about whether the two runs are
 * comparable. `compare` exits 2 with its reasons and the endpoint passes them through.
 */
export function buildComparePageArgs(a, b) {
  const RUN_ID = /^\d{8}T\d{6}Z$/;
  for (const [v, field] of [[a, 'run a'], [b, 'run b']]) {
    if (!RUN_ID.test(String(v || ''))) {
      throw new InvalidRun('run', `${field} must be a run id, as printed by crowdsim history`);
    }
  }
  return ['compare', String(a), String(b), '--html'];
}
