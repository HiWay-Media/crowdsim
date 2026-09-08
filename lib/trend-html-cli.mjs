#!/usr/bin/env node
/*
 * The command-line face of lib/trend-html.mjs. `crowdsim history --html` runs this.
 *
 *   node lib/trend-html-cli.mjs --out <file.html> [--version <v>]   < records.json
 *
 * The records arrive on stdin as the same JSON `crowdsim history --json` prints, so the page and the
 * table can never disagree about what a run was: there is one reader of history.tsv, in the driver.
 *
 * All the judgement is in trend-html.mjs, where it is tested. This file reads a stream and writes a file.
 *
 * Exit: 0 wrote the page · 2 the records could not be read or parsed
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildTrend } from './trend-html.mjs';

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out' || a === '--version') opts[a] = argv[++i];
  else { console.error(`unknown option: ${a}`); process.exit(2); }
}

const dest = opts['--out'];
if (!dest) {
  console.error('usage: trend-html-cli.mjs --out <file.html> [--version <v>]  < records.json');
  process.exit(2);
}

let rows;
try {
  const raw = fs.readFileSync(0, 'utf8');
  rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('expected a JSON array of history records');
} catch (e) {
  console.error(`  ❌ cannot read the run records: ${e.message}`);
  process.exit(2);
}

const html = buildTrend(rows, {
  generatedBy: opts['--version'] ? `crowdsim ${opts['--version']}` : 'crowdsim',
});

fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
fs.writeFileSync(dest, html);
console.log(`  ✅ wrote ${dest}`);
