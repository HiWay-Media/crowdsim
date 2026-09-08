#!/usr/bin/env node
/*
 * server-metrics-cli.mjs — read a server-side series that was HANDED to a run, and line it up with the
 * run's own steps.
 *
 * The scope decision is in INTENT.md and is the same one as the access log: crowdsim does not go and get
 * this. It reads a file you point it at, writes one artefact next to the run, and fetches nothing.
 *
 * Accepts either a JSON array (`[{"t": 1757325600000, "v": 0}, …]`, or `[[t, v], …]`) or a two-column
 * CSV/TSV of `timestamp,value`. Timestamps in seconds are accepted and converted: a ten-digit epoch is
 * seconds, a thirteen-digit one is milliseconds, and guessing between them would silently align a series
 * to the wrong century.
 *
 * Writes out/server-side-<run_id>.json. Exits 0 when the series was aligned, 2 on usage, 4 when nothing
 * in the series describes this run — that is the same "nothing usable came out of it" as everywhere else.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { correlate } from '../k6/lib/correlate.js';

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : argv[i + 1];
}
function die(msg, code) {
  process.stderr.write('server-metrics: ' + msg + '\n');
  process.exit(code);
}

const summaryPath = argv[0];
const seriesPath = opt('series');
const label = opt('label');
const outDir = opt('out-dir', '.');
if (!summaryPath || !seriesPath) {
  die('usage: server-metrics-cli.mjs <summary.json> --series <file> --label <name> [--out-dir <dir>]', 2);
}

let summary;
try {
  summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
} catch (e) {
  die(`cannot read ${summaryPath}: ${e.message}`, 2);
}

let raw;
try {
  raw = readFileSync(seriesPath, 'utf8');
} catch (e) {
  die(`cannot read ${seriesPath}: ${e.message}`, 2);
}

/** Seconds or milliseconds — decided by magnitude, never guessed silently. */
function toMs(n) {
  const v = Number(n);
  if (!isFinite(v)) return NaN;
  return v < 1e11 ? v * 1000 : v;
}

function parseSeries(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      die(`${seriesPath} starts like JSON and does not parse: ${e.message}`, 2);
    }
    return arr.map((row) => (Array.isArray(row)
      ? { t: toMs(row[0]), v: Number(row[1]) }
      : { t: toMs(row.t !== undefined ? row.t : row.timestamp), v: Number(row.v !== undefined ? row.v : row.value) }));
  }
  const out = [];
  for (const line of trimmed.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const cells = s.split(/[,\t;]/).map((c) => c.trim());
    if (cells.length < 2) continue;
    const t = toMs(cells[0]);
    const v = Number(cells[1]);
    if (!isFinite(t) || !isFinite(v)) continue;   // a header row lands here, which is the point
    out.push({ t: t, v: v });
  }
  return out;
}

const series = parseSeries(raw);
const result = correlate(summary.per_step, series, { runId: summary.run_id, label: label });

if (result.refused) {
  process.stderr.write('  ⚠️  the series was not correlated: ' + result.reason + '\n');
  if (result.fix) process.stderr.write('     ' + result.fix + '\n');
  process.exit(4);
}

const dest = path.join(outDir, `server-side-${summary.run_id}.json`);
writeFileSync(dest, JSON.stringify({
  run_id: summary.run_id,
  source: path.basename(seriesPath),
  label: result.label,
  samples: series.length,
  steps: result.steps,
  caveat: result.caveat,
}, null, 1) + '\n');

const w = Math.max(4, ...result.steps.map((s) => String(s.step).length));
process.stdout.write(`  ── ${result.label}, per step (handed to this run, not collected) ──\n`);
process.stdout.write(`     ${'step'.padEnd(w)}  requested  samples  mean      max\n`);
for (const s of result.steps) {
  process.stdout.write(`     ${String(s.step).padEnd(w)}  ${String(s.requested_rps).padStart(9)}  `
    + `${String(s.samples).padStart(7)}  ${String(s.mean).padStart(8)}  ${String(s.max).padStart(7)}`
    + `${s.partial ? '   (partial step)' : ''}\n`);
}
process.stdout.write('     ' + result.caveat.replace(/(.{1,88})(\s|$)/g, '$1\n     ').trimEnd() + '\n');
process.stdout.write(`  ✅ server-side: ${dest}\n`);
