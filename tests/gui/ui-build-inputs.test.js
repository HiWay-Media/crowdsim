/*
 * Everything the UI imports must exist in the stage that builds the UI.
 *
 * WHY THIS EXISTS — `gui/ui/src/lib/summary-blocks.js` imports `outcomeBands` from `k6/lib/failure.js`,
 * so the page and the drawn report share one band arithmetic instead of two that can disagree. That is
 * the right call. But the Dockerfile's `ui` stage copies only `gui/ui/`, so inside the image the file is
 * not there, and `vite build` failed with:
 *
 *     Could not resolve "../../../../k6/lib/failure.js" from "src/lib/summary-blocks.js"
 *
 * Locally it resolves, because a checkout has the whole repository. `make lint`, `make test` and the UI
 * tests all passed; the only thing that could catch it was building the image, and the image build is not
 * part of `make test`. So CI went red on a release, twice, for a one-line omission in a COPY.
 *
 * This test is the cheap version of that build: it reads the imports and the Dockerfile and asserts they
 * agree. It cannot prove the image builds — `make image-smoke` does that — but it fails in one second on
 * the mistake that actually happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI = path.join(ROOT, 'gui', 'ui');

/** Every file under gui/ui/src. */
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(p));
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Relative imports that resolve OUTSIDE gui/ui, as repo-relative paths. */
function escapingImports() {
  const found = [];
  for (const file of sources(path.join(UI, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      if (!target.startsWith(UI + path.sep)) {
        found.push({ file: path.relative(ROOT, file), target: path.relative(ROOT, target) });
      }
    }
  }
  return found;
}

/** The paths the Dockerfile's `ui` stage copies into the build context. */
function uiStageCopies() {
  const df = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const lines = df.split('\n');
  const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+ui\s*$/.test(l.trim()));
  assert.ok(start >= 0, 'the Dockerfile no longer has a stage named `ui` — check this test');
  const copies = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^FROM\s/.test(lines[i].trim())) break;
    const m = /^COPY\s+(.+)$/.exec(lines[i].trim());
    if (!m) continue;
    const parts = m[1].split(/\s+/).filter((p) => !p.startsWith('--'));
    copies.push(...parts.slice(0, -1));   // everything but the destination
  }
  return copies;
}

test('every file the UI imports from outside gui/ui is copied into the ui build stage', () => {
  const escaping = escapingImports();
  const copies = uiStageCopies();
  const missing = [];
  for (const imp of escaping) {
    const covered = copies.some((c) => {
      const clean = c.replace(/\/$/, '').replace(/^\.\//, '');
      return imp.target === clean || imp.target.startsWith(clean + '/');
    });
    if (!covered) missing.push(imp);
  }
  assert.deepEqual(missing, [], missing.length
    ? `the ui stage does not copy: ${missing.map((m) => `${m.target} (imported by ${m.file})`).join(', ')}`
      + `\n  it copies: ${copies.join(' ')}`
      + '\n  vite build will fail inside the image with "Could not resolve".'
    : '');
});

test('the escaping imports are known, so adding one is a decision', () => {
  // Reaching out of the UI is allowed — sharing one arithmetic with the drawn report is better than two
  // copies — but it costs a line in the Dockerfile, so it should not happen by accident.
  const targets = escapingImports().map((i) => i.target).sort();
  assert.deepEqual([...new Set(targets)], ['k6/lib/failure.js'],
    'a new import reaches outside gui/ui: add it to the ui stage in the Dockerfile, then to this list');
});
