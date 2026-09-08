#!/usr/bin/env node
/*
 * followup-cli.mjs — should the driver run something else after this run, and with what?
 *
 * Two decisions, both opt-in and both refusing far more often than they agree:
 *
 *   recalibrate  the ramp's first step did not survive, so the run measured nothing. Try lower. (#72)
 *   certify      the knee was swept through on the way up. Hold it and see. (#73)
 *
 * The policies live in k6/lib/recalibrate.js and k6/lib/certify.js, pure and unit tested, because they
 * decide whether this tool generates load nobody typed a command for. This file only reads a summary and
 * prints one line the driver can act on.
 *
 * Output, tab separated:
 *   GO    <argv fragment>   <why>       act on it
 *   STOP  <reason>                      do not
 *
 * Exit: 0 a decision was made (either kind) · 2 usage.
 */
import { readFileSync } from 'node:fs';
import { recalibrate } from '../k6/lib/recalibrate.js';
import { certify } from '../k6/lib/certify.js';

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : argv[i + 1];
}
function die(msg) {
  process.stderr.write('followup: ' + msg + '\n');
  process.exit(2);
}

const file = argv[0];
if (!file || file.startsWith('--')) die('usage: followup-cli.mjs <summary.json> --mode recalibrate|certify …');

let s;
try {
  s = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  die(`cannot read ${file}: ${e.message}`);
}

const mode = opt('mode');
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
const TAB = '\t';

if (mode === 'recalibrate') {
  const d = recalibrate({
    knee: s.knee,
    failureMode: s.failure_mode,
    dropDiagnosis: s.drop_diagnosis,
    start: num(opt('start')),
    peak: num(opt('peak')),
    attempt: num(opt('attempt')) || 1,
    floor: num(opt('floor')),
    safePeak: num(opt('safe-peak')),
  });
  if (d.retry) {
    process.stdout.write(['GO', `--start ${d.start} --peak ${d.peak}`, d.why].join(TAB) + '\n');
  } else {
    process.stdout.write(['STOP', d.reason].join(TAB) + '\n');
  }
  process.exit(0);
}

if (mode === 'certify') {
  const d = certify({
    knee: s.knee,
    hold: opt('hold'),
    safePeak: num(opt('safe-peak')),
    alreadyCertifying: opt('already') === '1',
  });
  if (d.certify) {
    // `--steps 1` and `--start` at the rate itself: a certification is a hold, not another ramp. The
    // sweep already found the knee; climbing to it again would spend the window twice.
    process.stdout.write(['GO',
      `--start ${d.rate} --peak ${d.rate} --steps 1 --hold ${d.hold}`, d.why].join(TAB) + '\n');
  } else {
    process.stdout.write(['STOP', d.reason].join(TAB) + '\n');
  }
  process.exit(0);
}

die('--mode must be recalibrate or certify');
