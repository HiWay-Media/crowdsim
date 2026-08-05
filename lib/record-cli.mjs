#!/usr/bin/env node
/*
 * The command-line face of lib/har.mjs. `crowdsim record <file.har>` runs this.
 *
 *   node lib/record-cli.mjs <file.har> --out <journey.json> [--origin <https://host>] [--rsc-query _rsc]
 *                                      [--profiles-dir <dir>] [--force]
 *
 * Two guards that are not about parsing:
 *
 *  · it refuses to write into the profile directory. A journey is data ABOUT a site — the same category as a
 *    URL pool: it names real routes, so it belongs next to the run output (gitignored) and in a private repo,
 *    never in the public one by accident.
 *  · it refuses to overwrite an existing file without --force. A recording takes a browser session to make.
 *
 * Exit: 0 wrote a journey · 2 usage, unreadable/unparseable HAR, refused destination · 4 nothing usable in
 * the recording (no document on any origin, or no page survived the filters)
 */

import fs from 'node:fs';
import path from 'node:path';
import { harToJourney } from './har.mjs';

const argv = process.argv.slice(2);
const VALUE_FLAGS = ['--out', '--origin', '--rsc-query', '--profiles-dir'];
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.indexOf(a) !== -1) {
    opts[a] = argv[++i];
  } else if (a === '--force') {
    opts[a] = true;
  } else if (a.startsWith('-')) {
    console.error(`unknown option: ${a}`);
    process.exit(2);
  } else {
    positional.push(a);
  }
}
const flag = (name) => (opts[name] === undefined ? null : opts[name]);
const has = (name) => Boolean(opts[name]);

const file = positional[0];
const dest = flag('--out');

if (!file || !dest || positional.length > 1) {
  console.error('usage: record-cli.mjs <file.har> --out <journey.json> [--origin <url>] [--rsc-query <p>]');
  process.exit(2);
}

let har;
try {
  har = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`  ❌ cannot read ${file} as a HAR: ${e.message}`);
  console.error('     Export it from the browser: DevTools → Network → the ⬇ "Export HAR" button.');
  process.exit(2);
}

// A journey names real routes on a real site. Writing one into profiles/ is how it ends up in a commit.
const profilesDir = flag('--profiles-dir');
if (profilesDir) {
  const resolvedDest = path.resolve(dest);
  const resolvedProfiles = path.resolve(profilesDir);
  if (resolvedDest === resolvedProfiles || resolvedDest.startsWith(resolvedProfiles + path.sep)) {
    console.error(`  ❌ refusing to write a journey into the profile directory (${resolvedProfiles}).`);
    console.error('     A journey is data about your site, like a URL pool: it names real routes. Keep it');
    console.error('     with the run output, or in your own private repo — not where profiles get committed.');
    process.exit(2);
  }
}

if (fs.existsSync(dest) && !has('--force')) {
  console.error(`  ❌ ${dest} already exists. Pass --force to replace it.`);
  console.error('     A recording costs a browser session; overwriting one silently is not a favour.');
  process.exit(2);
}

const { journey, report } = harToJourney(har, {
  origin: flag('--origin') || undefined,
  rscQuery: flag('--rsc-query') || undefined,
});

if (!journey.pages.length) {
  console.error('  ❌ nothing usable in that recording: no page survived.');
  if (!journey.origin) {
    console.error('     No HTML document was recorded on any origin. Record a page LOAD, not just the XHRs');
    console.error('     after it — and check "Preserve log" was on and the filter was off.');
  } else {
    console.error(`     Documents were found on ${journey.origin}, but every request was dropped as`);
    console.error('     third-party, non-GET or failed. Use --origin if the site under test is not that one.');
  }
  process.exit(4);
}

fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
fs.writeFileSync(dest, `${JSON.stringify(journey, null, 1)}\n`);

const totalRsc = journey.pages.reduce((n, p) => n + p.rsc.length, 0);
const totalStatic = journey.pages.reduce((n, p) => n + p.static.length, 0);

console.log(`  ✅ ${journey.pages.length} pages · ${totalRsc} navigation requests · ${totalStatic} assets`);
console.log(`     origin ${journey.origin}  →  ${dest}`);
console.log(`     from ${report.entries} recorded requests`);
if (report.dropped.third_party) {
  const hosts = report.dropped.third_party_hosts;
  const shown = hosts.slice(0, 4).join(', ') + (hosts.length > 4 ? `, +${hosts.length - 4} more` : '');
  console.log(`     dropped ${report.dropped.third_party} third-party (${shown}) — not your capacity problem,`);
  console.log('             and not yours to generate load against');
}
if (report.dropped.failed) console.log(`     dropped ${report.dropped.failed} that did not answer 2xx/3xx`);
if (report.dropped.not_get) console.log(`     dropped ${report.dropped.not_get} non-GET (this tool does not send writes)`);
if (report.stripped_params.length) {
  console.log(`     stripped per-request query params: ${report.stripped_params.join(', ')}`);
  console.log('             they vary between requests to the same path, so keeping them would make the');
  console.log('             recording a pool of unique cold URLs — the pool that makes any cache look useless');
}
console.log('');
console.log('  Point the profile at it and run the journey shape:');
console.log(`     "journey": { "file": "${path.basename(dest)}" }`);
console.log(`     crowdsim load --profile <p.json> --shape journey --peak <n>`);
console.log('  ⚠️  Re-record after a redesign or a deploy that changes the fan-out: a journey is a snapshot');
console.log('      of what one build made the browser fetch.');
