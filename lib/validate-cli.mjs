#!/usr/bin/env node
/*
 * The command-line face of lib/validate.js — the same rules the GUI's editor applies, reachable from a
 * terminal. `crowdsim validate` runs this; `doctor` and `load` run it too, so validation cannot drift from
 * what a run actually requires.
 *
 * Why node and not a second implementation in python3: the rules exist, they are tested, and two rule sets
 * would drift — the day they do, the one that matters is whichever the operator did not run. The cost is
 * that full validation needs node, which the CLI otherwise does not. The driver handles that explicitly:
 * without node it says so and falls back to the structural checks it does itself while resolving a profile
 * (pool references, missing pool files, empty pools). See docs/profile.md.
 *
 *   node lib/validate-cli.mjs <profile.json> [--brief] [--json]
 *
 *   --brief   print nothing when there is nothing to report (for use inside another command)
 *   --json    machine-readable, for anything that wants the structure rather than the prose
 *
 * Exit: 0 = no errors (warnings are not errors) · 2 = errors, unreadable file, or unparseable JSON
 */

import fs from 'node:fs';
import path from 'node:path';
// .mjs, not .js: inside the container image there is no package.json above lib/, so a `.js` file with
// ESM syntax is read as CommonJS and the import fails. The extension states the module system itself.
import { validateProfile } from './validate.mjs';

const args = process.argv.slice(2);
const brief = args.includes('--brief');
const asJson = args.includes('--json');
const file = args.find((a) => !a.startsWith('-'));

if (!file) {
  console.error('usage: validate-cli.mjs <profile.json> [--brief] [--json]');
  process.exit(2);
}

let raw;
try {
  raw = fs.readFileSync(file, 'utf8');
} catch (e) {
  if (asJson) console.log(JSON.stringify({ ok: false, read_error: e.message }));
  else console.error(`❌ cannot read ${file}: ${e.message}`);
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  // A JSON syntax error is the most common profile problem and the least helpful message in the world, so
  // it is reported on its own rather than as one finding among many.
  if (asJson) console.log(JSON.stringify({ ok: false, parse_error: e.message }));
  else console.error(`❌ ${path.basename(file)} is not valid JSON: ${e.message}`);
  process.exit(2);
}

const result = validateProfile(parsed);

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

const width = Math.min(
  28,
  Math.max(0, ...result.errors.concat(result.warnings).map((f) => f.path.length)),
);
const line = (mark, f) => `  ${mark} ${f.path.padEnd(width)}  ${f.message}`;

// Everything at once, and errors first: a validator that stops at the first problem turns one fix into a
// sequence of round trips, each of which is another chance to give up and just run the thing.
for (const e of result.errors) console.log(line('❌', e));
for (const w of result.warnings) console.log(line('⚠️ ', w));

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// In brief mode the tally is only worth a line when something has to be fixed: `load` already prints the
// findings, and a "0 errors · 2 warnings" in the middle of a run's preamble is noise.
if (result.errors.length || (result.warnings.length && !brief)) {
  console.log(`  ${count(result.errors.length, 'error')} · ${count(result.warnings.length, 'warning')}` +
    (result.errors.length ? ' — errors must be fixed before a run means anything' : ''));
} else if (!brief && !result.warnings.length) {
  const s = result.summary;
  const classes = s.classes.map((c) => `${c.name} ${(c.share * 100).toFixed(1)}%`).join(' · ');
  console.log(`  ✅ ${path.basename(file)} is valid`);
  console.log(`     mix        ${classes}`);
  console.log(`     targets    ${s.targets.map((t) => t.name).join(' · ') || '— (runs need --base-url)'}` +
    (s.default_target ? `  (default: ${s.default_target})` : ''));
  console.log(`     safe peak  ${s.safe_peak_rps === null ? '150 (driver default)' : s.safe_peak_rps + ' req/s'}` +
    `   allowlist  ${(s.allow_hosts || []).join(', ') || '— (needs CROWDSIM_ALLOW_TARGETS)'}`);
}

process.exit(result.ok ? 0 : 2);
