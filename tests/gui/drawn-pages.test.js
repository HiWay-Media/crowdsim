/*
 * Every page the CLI can draw, the page can hand over — or says why not.
 *
 * WHY THIS EXISTS — the GUI offered `report --html` and nothing else. `history --html` (the knee over
 * time) and `compare a b --html` (the delta) shipped in 1.38.0 and the page could hand over neither,
 * although it already plots the archive and already knows which runs are comparable.
 *
 * That is the fourth time this shape has come up: #53 was two flags, #78 was six summary blocks, #79 was
 * six flags, and this was two subcommands. Every one of them was the page tracking the CLI by hand. The
 * two that stopped recurring are the two that got a test: the summary blocks in 1.34.0 and the UI's build
 * inputs in 1.38.1.
 *
 * So the set of drawn pages is declared once, exhaustively, and this asks `bin/crowdsim` itself: a
 * subcommand that grows a `--html` flag and is listed in neither table fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRAWN_PAGES, DELIBERATELY_NOT_OFFERED } from '../../gui/server/lib/drawn-pages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRIVER = path.join(root, 'bin', 'crowdsim');

/** Subcommands whose own help block declares `--html`: the pages the CLI can draw. */
function drawnByTheCli() {
  const src = fs.readFileSync(DRIVER, 'utf8').split('\n');
  const names = [];
  let current = null;
  for (const line of src) {
    const head = /^#@ ([a-z-]+)$/.exec(line);
    if (head) { current = head[1]; continue; }
    if (/^#@/.test(line)) { current = null; continue; }
    if (!current) continue;
    if (!/^#/.test(line)) { current = null; continue; }
    const body = line.replace(/^# ?/, '');
    if (/^--html\b/.test(body.trim()) && !names.includes(current)) names.push(current);
  }
  return names.sort();
}

test('the CLI draws the pages we think it draws', () => {
  // If this list changes, the two tables below have to be revisited — which is the point.
  assert.deepEqual(drawnByTheCli(), ['compare', 'history', 'report']);
});

test('every drawn page is either offered by the page or deliberately not', () => {
  const cli = drawnByTheCli();
  const declared = DRAWN_PAGES.map((p) => p.subcommand).concat(DELIBERATELY_NOT_OFFERED.map((p) => p.subcommand));
  const missing = cli.filter((c) => !declared.includes(c));
  assert.deepEqual(missing, [], missing.length
    ? `the CLI can draw ${missing.join(', ')} and gui/server/lib/drawn-pages.js lists neither: `
      + 'offer it, or say why not'
    : '');
});

test('nothing is declared that the CLI cannot draw', () => {
  // The other direction: a route for a page that no longer exists is a 500 waiting for somebody to click.
  const cli = drawnByTheCli();
  for (const p of DRAWN_PAGES.concat(DELIBERATELY_NOT_OFFERED)) {
    assert.ok(cli.includes(p.subcommand), `${p.subcommand} is declared and the CLI does not draw it`);
  }
});

test('a page that is not offered says why, in a sentence', () => {
  for (const p of DELIBERATELY_NOT_OFFERED) {
    assert.ok(p.why && p.why.length > 30, `${p.subcommand} is not offered and gives no reason`);
  }
});

test('every offered page names a route, and the server has it', () => {
  const app = fs.readFileSync(path.join(root, 'gui/server/lib/app.js'), 'utf8');
  for (const p of DRAWN_PAGES) {
    assert.ok(p.route, `${p.subcommand} declares no route`);
    assert.ok(app.includes(p.route),
      `${p.subcommand} claims the route ${p.route} and app.js does not serve it`);
  }
});

test('the three pages are told apart by what they draw, not by name alone', () => {
  // A reader picking one needs to know it is one run, the archive, or a delta — the same distinction the
  // docs index has to make. Keeping it here means the page and the docs quote one source.
  const kinds = DRAWN_PAGES.map((p) => p.draws).sort();
  assert.deepEqual(kinds, ['a delta between two runs', 'one run', 'the archive over time']);
});
