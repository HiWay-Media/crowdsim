/*
 * history.js — reading the run archive that the driver writes.
 *
 * The archive is out/history.tsv (one line per run) plus out/summary-<run_id>.json. The GUI reads it, it
 * never writes it: the driver is the only author, so a run launched from the CLI and a run launched from
 * the GUI show up identically. Anything the GUI stored on the side would be a second version of the
 * truth, and the second version is always the wrong one.
 */

import fs from 'node:fs';
import path from 'node:path';

const RUN_ID = /^\d{8}T\d{6}Z$/;

const num = (v) => (v === '' || v === undefined || v === null ? null : (Number.isFinite(Number(v)) ? Number(v) : v));
const bool = (v) => (v === 'True' || v === 'true' ? true : (v === 'False' || v === 'false' ? false : null));

/** history.tsv, newest first. A row that does not parse is skipped rather than breaking the page. */
export function readHistory(outDir) {
  const file = path.join(outDir, 'history.tsv');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    if (cells.length < 3) continue;
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i];
    rows.push({
      run_id: row.run_id,
      profile: row.profile || null,
      base_url: row.base_url || null,
      shape: row.shape || null,
      peak: num(row.peak),
      aborted: bool(row.aborted),
      requests: num(row.reqs),
      rps: num(row.rps),
      failed: num(row.failed),
      p95: num(row.p95),
      e504: num(row.e504),
      generator_ok: bool(row.gen_ok),
    });
  }
  return rows.reverse();
}

export function summaryPath(outDir, runId) {
  if (!RUN_ID.test(String(runId || ''))) return null;
  return path.join(outDir, `summary-${runId}.json`);
}

export function readSummary(outDir, runId) {
  const file = summaryPath(outDir, runId);
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

export function readRunLog(outDir, runId, kind) {
  if (!RUN_ID.test(String(runId || ''))) return null;
  const prefix = kind === 'probe' ? 'probe' : 'load';
  try { return fs.readFileSync(path.join(outDir, `${prefix}-${runId}.log`), 'utf8'); } catch (e) { return null; }
}

/**
 * The two preflight artefacts, as the driver wrote them. `probe` records the cache verdict per declared
 * layer and the page weight; `discover` records what the sitemap offered and what was dropped.
 *
 * Read, never derived: the alternative is scraping the run log for numbers, which produces a table that
 * disagrees with the file the next run reads back — and then two answers to the same question.
 */
export function readProbe(outDir, runId) {
  return readArtifact(outDir, 'probe', runId);
}

export function readDiscover(outDir, runId) {
  return readArtifact(outDir, 'discover', runId);
}

function readArtifact(outDir, prefix, runId) {
  if (!RUN_ID.test(String(runId || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(outDir, `${prefix}-${runId}.json`), 'utf8')); } catch (e) { return null; }
}

/**
 * Runs that can honestly be compared: same profile, same base_url, same shape — and valid. Absolute
 * numbers from a synthetic pool are not comparable to real traffic, but the DELTA between two runs at an
 * identical pool is exactly what a change should be judged on.
 */
export function comparable(rows, row) {
  if (!row) return [];
  return rows.filter((r) => r.run_id !== row.run_id
    && r.profile === row.profile && r.base_url === row.base_url && r.shape === row.shape
    && r.generator_ok !== false);
}
