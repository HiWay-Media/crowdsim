#!/usr/bin/env node
/*
 * The command-line face of lib/report-html.mjs. `crowdsim report <run-id> --html` runs this.
 *
 *   node lib/report-html-cli.mjs <summary.json> --out <file.html> [--version <v>]
 *
 * All the judgement is in report-html.mjs, where it is tested. This file reads one file and writes another,
 * which is the part that cannot be unit-tested and therefore should hold no decisions.
 *
 * Exit: 0 wrote the page · 2 the summary could not be read or parsed
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildReport } from './report-html.mjs';

const argv = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out' || a === '--version') opts[a] = argv[++i];
  else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); process.exit(2); }
  else positional.push(a);
}

const src = positional[0];
const dest = opts['--out'];
if (!src || !dest || positional.length > 1) {
  console.error('usage: report-html-cli.mjs <summary.json> --out <file.html> [--version <v>]');
  process.exit(2);
}

let summary;
try {
  summary = JSON.parse(fs.readFileSync(src, 'utf8'));
} catch (e) {
  console.error(`  ❌ cannot read ${src} as a run summary: ${e.message}`);
  process.exit(2);
}

// A server-side series, if this run was handed one. Read from beside the summary rather than passed as a
// flag: the driver already wrote it there, and a report should not need to be told what its own run
// produced. Absent is the normal case and not an error. (#86)
let serverSide = null;
try {
  const beside = path.join(path.dirname(path.resolve(src)), `server-side-${summary.run_id}.json`);
  serverSide = JSON.parse(fs.readFileSync(beside, 'utf8'));
} catch (e) { /* no series for this run */ }

const html = buildReport(summary, {
  generatedBy: opts['--version'] ? `crowdsim ${opts['--version']}` : 'crowdsim',
  serverSide,
});

fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
fs.writeFileSync(dest, html);
console.log(`  ✅ wrote ${dest}`);
