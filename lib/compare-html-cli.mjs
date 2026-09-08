#!/usr/bin/env node
/*
 * The command-line face of lib/compare-html.mjs. `crowdsim compare a b --html` runs this.
 *
 *   node lib/compare-html-cli.mjs --out <file.html> [--version <v>]   < compare.json
 *
 * The comparison arrives on stdin as exactly what `compare --json` prints, so the refusals on the page
 * are the command's own: there is no second implementation of *are these two comparable* to fall out of
 * step with it.
 *
 * All the judgement is in compare-html.mjs, where it is tested. This file reads a stream and writes a
 * file.
 *
 * Exit: 0 wrote the page · 2 the comparison could not be read or parsed
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildCompare } from './compare-html.mjs';

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out' || a === '--version') opts[a] = argv[++i];
  else { console.error(`unknown option: ${a}`); process.exit(2); }
}

const dest = opts['--out'];
if (!dest) {
  console.error('usage: compare-html-cli.mjs --out <file.html> [--version <v>]  < compare.json');
  process.exit(2);
}

let cmp;
try {
  cmp = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (e) {
  console.error(`  ❌ cannot read the comparison: ${e.message}`);
  process.exit(2);
}

// `compare --json` reports a usage-level problem as { error }. That is not a page.
if (cmp && cmp.error) {
  console.error(`  ❌ ${cmp.error}`);
  process.exit(2);
}

const html = buildCompare(cmp, {
  generatedBy: opts['--version'] ? `crowdsim ${opts['--version']}` : 'crowdsim',
});

fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
fs.writeFileSync(dest, html);
console.log(`  ✅ wrote ${dest}`);
