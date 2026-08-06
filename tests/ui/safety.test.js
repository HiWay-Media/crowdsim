/*
 * The three parts of the page that are not conveniences.
 *
 * Most of this UI is there to save typing. These three stand between a click and an incident, or between a
 * reader and a number that is not true — and until now nothing asserted them. They are named as safety tests
 * so that nobody deletes one to make a refactor green.
 *
 * What this layer can prove: the wording exists, says the thing, and the three-valued verdict stays
 * three-valued. What it cannot: that the component renders it. That is the browser pass in tests/e2e, and
 * this file deliberately checks the components' source for the imports rather than pretending otherwise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SAFE_PEAK, REFUSAL, LAYER, layerVerdict } from '../../gui/ui/src/lib/messages.js';
import { mayRenderNumbers } from '../../gui/ui/src/lib/compare.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.resolve(here, '../../gui/ui/src', rel), 'utf8');

// ── 1. the safe-peak block ───────────────────────────────────────────────────────────────────────────
test('the safe-peak block states what happens, in a sentence that cannot be read as optional', () => {
  const text = SAFE_PEAK.consequence(500, 150, 'www.example.test') + ' ' + SAFE_PEAK.explain('www.example.test');
  assert.match(text, /above this profile's safe ceiling of 150 req\/s/);
  assert.match(text, /expected to serve 5xx to real users of www\.example\.test/);
  assert.match(text, /degrade any co-tenant/);
  assert.match(text, /be ready to stop/);
  // Not "are you sure?": the page names the consequence, because the operator is the one who knows the
  // window and nobody else can weigh it for them.
  assert.doesNotMatch(text, /are you sure/i);
});

test('the override asks for two deliberate acts, and the profile NAME is one of them', () => {
  assert.equal(SAFE_PEAK.checkbox, 'I know this breaks production');
  assert.equal(SAFE_PEAK.confirmLabel, 'Profile name');
  // The API refuses without both (tests/gui/preview.test.js). This is the other half: the page still asks.
  const panel = src('components/RunPanel.jsx');
  assert.match(panel, /SAFE_PEAK\.checkbox/);
  assert.match(panel, /SAFE_PEAK\.confirmLabel/);
  assert.match(panel, /setForce\(false\)/, 'switching profile disarms the override');
  assert.doesNotMatch(panel, /localStorage|sessionStorage/, 'nothing about the override is remembered');
});

test('reading the armed command is not arming it', () => {
  assert.match(SAFE_PEAK.previewArmed, /still requires the profile name typed by hand/);
  assert.match(SAFE_PEAK.previewArmed, /this run only/);
  assert.match(src('components/CommandPreview.jsx'), /SAFE_PEAK\.previewArmed/);
});

// ── 2. the refusal card ──────────────────────────────────────────────────────────────────────────────
test('a refused comparison shows the reason and no numbers', () => {
  const refused = { refused: [{ reason: 'run X has generator_ok: false', detail: ['…'] }] };
  assert.equal(mayRenderNumbers(refused), false);
  assert.match(REFUSAL.title, /Refusing to compare/);
  assert.match(REFUSAL.why, /confident number with nothing behind it/);

  // The component must gate its tables on that answer, not on its own reading of the payload.
  const card = src('components/CompareCard.jsx');
  assert.match(card, /mayRenderNumbers\(result\)/);
  assert.match(card, /withNumbers \?/, 'the numbers are rendered only when they may be');
});

test('an empty refusal list is not a refusal', () => {
  assert.equal(mayRenderNumbers({ refused: [], overall: [] }), true);
});

// ── 3. unknown is not MISS ───────────────────────────────────────────────────────────────────────────
test('a cache header that never appeared is unknown, never a miss and never 0%', () => {
  assert.deepEqual(layerVerdict(null), { text: 'unknown', tone: 'warn' });
  assert.deepEqual(layerVerdict(undefined), { text: 'unknown', tone: 'warn' });
  assert.deepEqual(layerVerdict(false), { text: 'MISS', tone: 'note' });
  assert.deepEqual(layerVerdict(true), { text: 'HIT', tone: 'ok' });
  assert.notEqual(LAYER.unknown, LAYER.miss);
});

test('the explanation names the likely cause: a wrong header name, not a cold cache', () => {
  const text = LAYER.absentExplained(['X-Cache']);
  assert.match(text, /1 declared header never appeared \(X-Cache\)/);
  assert.match(text, /wrong header name in the profile rather than a cold cache/);
  assert.match(text, /never as a miss/);
  assert.match(text, /measures nothing about that layer/);
  assert.match(LAYER.absentExplained(['X-Cache', 'Cache-Status']), /2 declared headers never appeared/);
});

test('the preflight table paints the verdict through layerVerdict, not with its own conditional', () => {
  const tables = src('components/PreflightTables.jsx');
  assert.match(tables, /layerVerdict/);
  assert.match(tables, /LAYER\.absentExplained/);
});
