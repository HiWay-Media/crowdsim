import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRuns, exportAsJSON, exportAsCSV } from '../../gui/ui/src/lib/export.js';

const testRuns = [
  {
    run_id: '20260908T100000Z',
    profile: 'example',
    base_url: 'http://localhost:3000',
    shape: 'mix',
    peak: '60',
    rps: '58.5',
    p95: '105',
    failed: 0.01,
    e504: '2',
    knee_clean: '45',
    knee_crossed: null,
    generator_ok: true,
    aborted: false,
  },
  {
    run_id: '20260908T101000Z',
    profile: 'example',
    base_url: 'http://localhost:3000',
    shape: 'mix',
    peak: '100',
    rps: '52.0',
    p95: '250',
    failed: 0.15,
    e504: '150',
    knee_clean: '60',
    knee_crossed: '75',
    generator_ok: true,
    aborted: true,
  },
  {
    run_id: '20260908T102000Z',
    profile: 'broken',
    base_url: 'http://localhost:3000',
    shape: 'mix',
    peak: '80',
    rps: '0',
    p95: null,
    failed: null,
    e504: '0',
    knee_clean: null,
    knee_crossed: null,
    generator_ok: false,
    aborted: false,
  },
];

test('filterRuns: filter by status', () => {
  const cleanRuns = filterRuns(testRuns, { status: 'clean', peakMin: '', peakMax: '' });
  assert.equal(cleanRuns.length, 1);
  assert.equal(cleanRuns[0].run_id, '20260908T100000Z');

  const kneeRuns = filterRuns(testRuns, { status: 'knee', peakMin: '', peakMax: '' });
  assert.equal(kneeRuns.length, 1);
  assert.equal(kneeRuns[0].run_id, '20260908T101000Z');

  const invalidRuns = filterRuns(testRuns, { status: 'invalid', peakMin: '', peakMax: '' });
  assert.equal(invalidRuns.length, 1);
  assert.equal(invalidRuns[0].run_id, '20260908T102000Z');

  const allRuns = filterRuns(testRuns, { status: 'all', peakMin: '', peakMax: '' });
  assert.equal(allRuns.length, 3);
});

test('filterRuns: filter by peak rate range', () => {
  const filtered = filterRuns(testRuns, { status: 'all', peakMin: '70', peakMax: '90' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].run_id, '20260908T102000Z');
});

test('exportAsJSON: produces valid JSON with metadata', () => {
  const result = exportAsJSON(testRuns.slice(0, 1));
  assert.equal(result.count, 1);
  assert(result.exported_at);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].run_id, '20260908T100000Z');
  assert.equal(result.runs[0].peak_rps, 60);
});

test('exportAsCSV: produces valid CSV with headers', () => {
  const csv = exportAsCSV(testRuns.slice(0, 1));
  const lines = csv.split('\n');
  assert(lines[0].includes('run_id'));
  assert(lines[0].includes('profile'));
  assert.equal(lines.length, 2); // header + 1 data row
  assert(lines[1].includes('20260908T100000Z'));
});

test('exportAsCSV: escapes comma and quote in fields', () => {
  const runs = [
    {
      ...testRuns[0],
      profile: 'test,with,comma',
      base_url: 'http://example.com"quoted"',
    },
  ];
  const csv = exportAsCSV(runs);
  assert(csv.includes('"test,with,comma"'));
  assert(csv.includes('"http://example.com""quoted"""'));
});
