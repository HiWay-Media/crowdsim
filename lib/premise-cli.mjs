#!/usr/bin/env node
/*
 * premise-cli.mjs — the two halves of the authed-premise check, split so that the driver makes the
 * requests (curl, with the same TLS and Host flags as the rest of `probe`) and this file decides nothing
 * about how they are made.
 *
 *   plan   <profile>            → the lines `probe` should request, one per authed class, and the classes
 *                                 that cannot be requested at all.
 *   render                      → reads those lines back from stdin with a status attached, prints the
 *                                 section, and exits 4 when a class cannot measure what it claims.
 *
 * Line format, tab separated:
 *   T <class> <path>            a target to request without a token   (plan → driver)
 *   T <class> <path> <status>   the same, with what it answered       (driver → render)
 *   S <class> <reason>          a class that could not be checked
 *
 * Exit codes: 0 checked (verified, or unknown and said so) · 2 usage · 4 at least one authed class cannot
 * measure an authenticated read. 4 is `probe`'s existing "this profile and this target do not go
 * together" code, which is what a public authed endpoint is.
 */
import { readFileSync } from 'node:fs';
import { authedTargets, renderPremise } from './premise.mjs';

const argv = process.argv.slice(2);
const mode = argv[0];
const TAB = '\t';

function die(msg, code) {
  process.stderr.write(`premise: ${msg}\n`);
  process.exit(code);
}

if (mode === 'plan') {
  if (!argv[1]) die('usage: premise-cli.mjs plan <profile.json>', 2);
  let profile;
  try {
    profile = JSON.parse(readFileSync(argv[1], 'utf8'));
  } catch (e) {
    die(`cannot read ${argv[1]}: ${e.message}`, 2);
  }
  const { targets, skipped } = authedTargets(profile);
  for (const t of targets) process.stdout.write(['T', t.class, t.path].join(TAB) + '\n');
  for (const s of skipped) process.stdout.write(['S', s.class, s.reason].join(TAB) + '\n');
  process.exit(0);
}

if (mode === 'render') {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch { /* nothing on stdin: nothing to render */ }
  const observations = [];
  const skipped = [];
  for (const line of input.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split(TAB);
    if (f[0] === 'T') observations.push({ class: f[1], path: f[2], status: Number(f[3]) || 0 });
    else if (f[0] === 'S') skipped.push({ class: f[1], reason: f[2] });
  }
  const out = renderPremise(observations, skipped);
  if (!out) process.exit(0);
  process.stdout.write(out.text + '\n');
  process.exit(out.refused ? 4 : 0);
}

die('usage: premise-cli.mjs plan <profile.json> | premise-cli.mjs render < lines', 2);
