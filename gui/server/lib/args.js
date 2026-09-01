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
