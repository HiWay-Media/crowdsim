#!/usr/bin/env node
/*
 * The command-line face of lib/weights.mjs. `crowdsim weights <access.log>` runs this.
 *
 *   node lib/weights-cli.mjs [<access.log>] --profile <p.json> [--format "a b c"] [--top 10] [--json]
 *
 * With no file it reads stdin, which is the form that matters: an access log is usually somewhere it
 * cannot be copied from, and `ssh edge 'zcat access.log.gz' | crowdsim weights - --profile p.json` keeps
 * it that way. Streamed line by line, so the size of the log is not a limit.
 *
 * Two things it does not do, both deliberate:
 *
 *  · it never writes. Not the profile, not an artefact in out/, not a temporary copy. An access log holds
 *    URLs, addresses and user agents; this tool's output directory is somewhere people copy from, and a
 *    repository is somewhere they commit from. The mix goes to stdout and stops there.
 *  · it never fills a class in. What did not match is printed with the patterns that would catch it, and
 *    deciding which class that traffic belongs to is a judgement about somebody's own site.
 *
 * Exit: 0 printed a mix · 2 usage, unreadable profile, or a log this command could not parse · 4 the log
 * parsed but nothing in it could be classified (the profile does not describe this traffic at all)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { newTally, feed, result, suggestPatterns } from './weights.mjs';

const argv = process.argv.slice(2);
const VALUE_FLAGS = ['--profile', '--format', '--top'];
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.indexOf(a) !== -1) opts[a] = argv[++i];
  else if (a === '--json') opts[a] = true;
  else if (a === '-') positional.push('-');
  else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); process.exit(2); }
  else positional.push(a);
}
const asJson = Boolean(opts['--json']);
const profileArg = opts['--profile'];
const file = positional[0] && positional[0] !== '-' ? positional[0] : null;

if (!profileArg || positional.length > 1) {
  console.error('usage: weights-cli.mjs [<access.log>] --profile <p.json> [--format "…"] [--top N] [--json]');
  process.exit(2);
}

// ── the profile ──────────────────────────────────────────────────────────────────────────────────────
// Resolved here rather than through the driver's resolver, because that one DROPS a class whose pool is
// empty — correct for a run, wrong here: a class recognised by log_match alone has no pool and still has
// traffic, and dropping it would report that traffic as unclassified.
let profile;
try {
  profile = JSON.parse(fs.readFileSync(profileArg, 'utf8'));
} catch (e) {
  console.error(`  ❌ cannot read ${profileArg} as a profile: ${e.message}`);
  process.exit(2);
}
const base = path.dirname(path.resolve(profileArg));
for (const [key, value] of Object.entries(profile.pools || {})) {
  if (typeof value === 'string' && value.startsWith('@')) {
    const ref = path.join(base, value.slice(1));
    try {
      profile.pools[key] = JSON.parse(fs.readFileSync(ref, 'utf8'));
    } catch (e) {
      // Not fatal: a pool file that is missing costs matching accuracy, and the unclassified share is
      // where that shows up. Refusing the whole command would be worse for a log that log_match covers.
      console.error(`  ⚠️  pool "${key}" points at ${ref}, which could not be read — paths that would have`);
      console.error('      matched through it will be reported as unclassified');
      profile.pools[key] = [];
    }
  }
}

const format = opts['--format']
  ? String(opts['--format']).trim().split(/[\s,]+/).filter(Boolean)
  : null;
const top = Number(opts['--top']) > 0 ? Number(opts['--top']) : 10;

if (format) {
  const KNOWN = ['request', 'path', 'method', 'status', 'time', '-'];
  const unknown = format.filter((f) => KNOWN.indexOf(f) === -1);
  if (unknown.length) {
    console.error(`  ❌ --format: this command does not know the field(s) ${unknown.join(', ')}.`);
    console.error(`     Known fields: ${KNOWN.join(', ')} — use "-" for a column to skip.`);
    console.error('     Example, for a log of "<time> <method> <path> <status>":');
    console.error('       --format "time method path status"');
    process.exit(2);
  }
  if (format.indexOf('request') === -1 && format.indexOf('path') === -1) {
    console.error('  ❌ --format names no "request" and no "path": there would be nothing to classify.');
    process.exit(2);
  }
}

// ── the log ──────────────────────────────────────────────────────────────────────────────────────────
if (file && !fs.existsSync(file)) {
  console.error(`  ❌ no such file: ${file}`);
  process.exit(2);
}
const input = file ? fs.createReadStream(file) : process.stdin;
if (!file && process.stdin.isTTY) {
  console.error('  ❌ no log file given and stdin is a terminal. Either:');
  console.error('       crowdsim weights /var/log/nginx/access.log --profile <p.json>');
  console.error("       ssh edge 'zcat /var/log/nginx/access.log.*.gz' | crowdsim weights - --profile <p.json>");
  process.exit(2);
}

const tally = newTally(profile, { maxDistinct: 5000 });
const rl = readline.createInterface({ input, crlfDelay: Infinity });
rl.on('line', (l) => feed(tally, l, format));
await new Promise((resolve, reject) => {
  rl.on('close', resolve);
  input.on('error', reject);
}).catch((e) => {
  console.error(`  ❌ cannot read the log: ${e.message}`);
  process.exit(2);
});

const r = result(tally, { top });

// ── the refusals ─────────────────────────────────────────────────────────────────────────────────────
// A format that does not fit is the most likely thing to go wrong here, and the failure mode to avoid is a
// confident mix computed from the 3% of lines that happened to parse.
if (r.lines === 0) {
  console.error('  ❌ the log is empty: no lines to classify.');
  process.exit(2);
}
if (r.unparsed_share > 0.5) {
  console.error(`  ❌ ${pct(r.unparsed_share)} of ${n(r.lines)} lines did not parse, so any mix computed from`);
  console.error('     the rest would be a mix of whatever happened to fit. This does not look like the');
  console.error('     combined format. Lines that failed, as they were read:');
  for (const s of r.unparsed_samples) console.error(`       ${s}`);
  console.error('     Describe the columns instead, e.g. --format "time method path status"');
  process.exit(2);
}
if (r.classified === 0) {
  console.error(`  ❌ ${n(r.counted)} GET requests parsed and none of them matched a class in ${profileArg}.`);
  console.error('     The profile does not describe this traffic at all. Either it is the wrong profile for');
  console.error('     this log, or no class declares how it is recognised — see the paths below and give');
  console.error('     the classes they belong to a `log_match`:');
  for (const u of r.unclassified.top) console.error(`       ${n(u.count).padStart(9)}  ${u.path}`);
  for (const p of suggestPatterns(r.unclassified.top, 5)) console.error(`         "log_match": ["${p}"]`);
  process.exit(4);
}

// ── the output ───────────────────────────────────────────────────────────────────────────────────────
function n(v) { return Number(v).toLocaleString('en-US'); }
function pct(v) { return `${(v * 100).toFixed(1)}%`; }

if (asJson) {
  // Deliberately WITHOUT the unclassified sample: those are paths out of somebody's access log, and this
  // is the form `init` consumes into a file under out/. Aggregates travel; URLs do not.
  process.stdout.write(`${JSON.stringify({
    counted: r.counted,
    classified: r.classified,
    lines: r.lines,
    unparsed: r.unparsed,
    skipped: r.skipped,
    unclassified: { count: r.unclassified.count, share: r.unclassified.share },
    window: r.window,
    uncountable: r.uncountable,
    classes: r.classes.map((c) => ({
      name: c.name, kind: c.kind, count: c.count, share: c.share, weight: c.weight,
      // Carried so a consumer cannot mistake "no GET log can count this" for "the window did not have it".
      countable: c.countable, declared_kind: c.declared_kind,
    })),
  }, null, 1)}\n`);
  process.exit(0);
}

console.log(`▶ ${n(r.lines)} lines · ${n(r.counted)} GET requests counted · ${n(r.classified)} classified`);
if (r.unparsed) {
  console.log(`  ⚠️  ${n(r.unparsed)} lines (${pct(r.unparsed_share)}) did not parse and are in no number below`);
}
if (r.skipped.method) console.log(`     ${n(r.skipped.method)} non-GET excluded: this tool sends GETs only`);
if (r.skipped.status) console.log(`     ${n(r.skipped.status)} non-2xx/3xx excluded: a 404 in the mix is a weight for URLs that do not exist`);
console.log('');

const width = Math.max('unclassified'.length, ...r.classes.map((c) => c.name.length));
console.log(`  ${'class'.padEnd(width)}  kind   ${'requests'.padStart(11)}  ${'share'.padStart(7)}  ${'weight'.padStart(7)}`);
for (const c of r.classes) {
  if (!c.countable) {
    // Reported, not counted, and never as a zero: a `login` or `signup` class is a POST and this command
    // counts GETs only, so no access log can produce a number for it. Treating it as an ordinary class is
    // what let it match every document GET in the log.
    console.log(`  ${c.name.padEnd(width)}  ${c.declared_kind.padEnd(5)}  ${'—'.padStart(11)}  `
      + `${'—'.padStart(7)}  ${'—'.padStart(7)}   ← a ${c.declared_kind} is a POST: not countable here`);
    continue;
  }
  console.log(`  ${c.name.padEnd(width)}  ${c.kind.padEnd(5)}  ${n(c.count).padStart(11)}  `
    + `${pct(c.share).padStart(7)}  ${c.weight.toFixed(1).padStart(7)}`
    + (c.declared ? '' : '   ← no log_match, no path_prefix, no pool: nothing can match it'));
}
console.log('');
console.log(`  ${'unclassified'.padEnd(width)}  ${''.padEnd(5)}  ${n(r.unclassified.count).padStart(11)}  `
  + `${pct(r.unclassified.share).padStart(7)}          of the counted requests`);

if (r.unclassified.count) {
  console.log('');
  console.log('  What nothing matched — the interesting part, because the mix above describes');
  console.log(`  ${pct(1 - r.unclassified.share)} of the traffic and not all of it:`);
  for (const u of r.unclassified.top) console.log(`     ${n(u.count).padStart(11)}  ${u.path}`);
  if (r.unclassified.capped) {
    console.log(`     … more distinct paths than this command samples (${n(5000)}); the counts above are`);
    console.log('       still exact for the paths shown');
  }
  console.log('');
  console.log('  Decide which class each of those belongs to, then declare it — crowdsim will not guess:');
  for (const p of suggestPatterns(r.unclassified.top, 5)) {
    console.log(`     { "name": "…", "log_match": ["${p}"], … }`);
  }
  if (r.unclassified.share > 0.1) {
    console.log('');
    console.log(`  ⚠️  ${pct(r.unclassified.share)} unclassified is enough to change the answer. A mix measured over`);
    console.log('      part of the log is a mix of something else — close that gap before pasting.');
  }
}

if (r.uncountable.length) {
  console.log('');
  console.log(`  Not countable from an access log: ${r.uncountable.join(', ')}. Those classes POST, and this`);
  console.log('  command counts GETs only — the same reason a write is excluded from the mix above. Their');
  console.log('  weight has to come from the rate you measured yourself: logins per second during the window');
  console.log('  you care about, from your identity provider or your application logs.');
}

console.log('');
console.log('  Paste into the profile (weights are relative; the generator renormalises them):');
console.log('  "classes": [');
const rows = r.classes.map((c, i) => {
  const comma = i === r.classes.length - 1 ? '' : ',';
  const kind = c.kind === 'rsc' ? ', "kind": "rsc"' : '';
  // weight 0 is refused by `validate`, on purpose: a class that generates nothing is a class to remove.
  // Printing the row anyway, with the reason, beats printing a block that cannot be pasted.
  if (!c.countable) {
    return `    { "name": "${c.name}", "weight": <your measured ${c.declared_kind} rate>${kind}, … }${comma}`
      + `   ← not from this log`;
  }
  const zero = c.count === 0
    ? (c.declared ? '   ← not once in this log: remove the class, or measure a window that has it'
                  : '   ← nothing can match it: give it a log_match, or remove it')
    : '';
  return `    { "name": "${c.name}", "weight": ${c.weight}${kind}, … }${comma}${zero}`;
});
for (const row of rows) console.log(row);
console.log('  ]');
if (r.classes.some((c) => c.countable && c.count === 0)) {
  console.log('  A weight of 0 is refused by `crowdsim validate`: a class that generates nothing belongs');
  console.log('  in a profile only as a mistake. Remove those rows or explain them to yourself first.');
}

console.log('');
if (r.window.from && r.window.to) {
  console.log(`  ⚠️  This is your traffic between ${r.window.from} and ${r.window.to}, by the log's own`);
  console.log('      timestamps. A mix measured in a quiet hour does not reproduce a spike: the classes that');
  console.log('      grow under load are exactly the ones a quiet window under-weights.');
} else {
  console.log('  ⚠️  This is your traffic during whatever window that log covers — no timestamp in it was in a');
  console.log('      format this command recognised, so it cannot tell you which window. A mix measured in a');
  console.log('      quiet hour does not reproduce a spike.');
}
console.log('  Nothing was written: no profile touched, no artefact in out/. An access log is not this');
console.log('  tool\'s data to keep.');
