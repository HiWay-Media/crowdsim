/*
 * GET /api/compare — two runs, compared by asking the CLI.
 *
 * The property these tests defend is not the arithmetic. It is that the page cannot show a comparison the
 * command line would have refused: the same two runs, through two interfaces, must produce the same verdict.
 * A second copy of "are these comparable" living in the server would be the one on screen the day the two
 * disagree — and a delta between two different experiments looks exactly like an answer.
 *
 * So these run the real bin/crowdsim (no traffic: two summary files on disk are the whole input) rather than
 * the fake driver, because the point is precisely that the server is not deciding anything itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../gui/server/lib/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const REAL = path.join(root, 'bin/crowdsim');

const A = '20260805T090000Z';
const B = '20260805T093000Z';

/** A summary as the driver writes one. */
function writeRun(outDir, runId, opts) {
  const o = opts || {};
  const p95 = o.p95 === undefined ? 200 : o.p95;
  const summary = {
    run_id: runId,
    profile: o.profile || 'live-event',
    shape: o.shape || 'mix',
    base_url: o.baseUrl || 'https://www.example.test',
    rsc_mode: 'repeat',
    peak_rps_user_target: o.peak || 60,
    aborted: Boolean(o.aborted),
    requests: 4000,
    rps_avg: 59.4,
    failed_rate: o.failed === undefined ? 0 : o.failed,
    dur: { p50: p95 / 2, p95, p99: p95 * 1.4, max: p95 * 3 },
    guillotine_ms: 5000,
    over_guillotine_rate: 0,
    dropped_iterations: 0,
    e504: 0, e502: 0, e5xx: 0, e404: 0,
    cache: { proxy: o.hit === undefined ? 0.61 : o.hit, cdn: null },
    per_class: {
      html: {
        p95, p99: p95 * 1.3, med: p95 / 2, failed: 0, over_guillotine: 0,
        cache: { proxy: 0.61, cdn: null }, reqs: 4000, rps_target: 60,
      },
    },
    mix_target: { html: 60 },
    generator_ok: o.generatorOk === undefined ? true : o.generatorOk,
    target_unreachable: Boolean(o.unreachable),
  };
  fs.writeFileSync(path.join(outDir, `summary-${runId}.json`), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(outDir, `profile-${runId}.json`), JSON.stringify({
    name: 'live-event', pools: { pages: o.pool || ['/', '/news'] },
  }, null, 1));
}

async function withServer(fn, seed) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-cmp-'));
  const profilesDir = path.join(tmp, 'profiles');
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(profilesDir);
  fs.mkdirSync(outDir);
  fs.copyFileSync(path.join(root, 'profiles/example.json'), path.join(profilesDir, 'example.json'));
  (seed || (() => {}))(outDir);

  const app = createApp({ crowdsimBin: REAL, profilesDir, outDir, version: 'test' });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (url) => {
    const res = await fetch(base + url);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn({ get, outDir });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('two comparable runs come back as the same structure the CLI computes', async () => {
  await withServer(async ({ get }) => {
    const r = await get(`/api/compare?a=${A}&b=${B}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.refused, []);
    assert.equal(r.json.a.run_id, A);
    assert.equal(r.json.b.run_id, B);

    const p95 = r.json.overall.find((x) => x.label === 'p95');
    assert.equal(p95.a, 200);
    assert.equal(p95.b, 140);
    assert.equal(p95.verdict, 'better', '140 ms after 200 ms is an improvement');

    const proxy = r.json.layers.find((x) => x.label === 'proxy');
    assert.equal(proxy.verdict, 'better', 'a higher hit ratio is better, unlike latency');

    const cdn = r.json.layers.find((x) => x.label === 'cdn');
    assert.equal(cdn.a, null);
    assert.equal(cdn.verdict, 'unknown', 'a header that never appeared is not 0%');
  }, (outDir) => {
    writeRun(outDir, A, { p95: 200, hit: 0.61 });
    writeRun(outDir, B, { p95: 140, hit: 0.94 });
  });
});

test('a run the generator could not deliver is refused here exactly as on the command line', async () => {
  await withServer(async ({ get }) => {
    const r = await get(`/api/compare?a=${A}&b=${B}`);
    assert.equal(r.status, 422, 'not a 200 with an empty table: the page must not render a delta');
    assert.equal(r.json.refused.length, 1);
    assert.match(r.json.refused[0].reason, /generator_ok: false/);
    assert.equal(r.json.overall, undefined, 'no numbers are computed for a run that has none');
  }, (outDir) => {
    writeRun(outDir, A, {});
    writeRun(outDir, B, { generatorOk: false });
  });
});

test('two different URL pools are refused, with the reason the CLI gives', async () => {
  await withServer(async ({ get }) => {
    const r = await get(`/api/compare?a=${A}&b=${B}`);
    assert.equal(r.status, 422);
    assert.match(r.json.refused[0].reason, /pool "pages" is not the same list of URLs/);
    assert.match(r.json.refused[0].detail.join(' '), /colder pool is a harder test/);
  }, (outDir) => {
    writeRun(outDir, A, { pool: ['/', '/news'] });
    writeRun(outDir, B, { pool: ['/', '/news', '/news/latest'] });
  });
});

test('a different target is allowed and labelled, not refused', async () => {
  await withServer(async ({ get }) => {
    const r = await get(`/api/compare?a=${A}&b=${B}`);
    assert.equal(r.status, 200);
    assert.ok(r.json.notes.some((n) => n.includes('BETWEEN TWO TARGETS')), r.json.notes);
  }, (outDir) => {
    writeRun(outDir, A, {});
    writeRun(outDir, B, { baseUrl: 'https://cdn.example.test' });
  });
});

test('the server and the CLI agree, run for run', async () => {
  // The actual guarantee: whatever the endpoint answers is what `crowdsim compare --json` answered.
  const { spawnSync } = await import('node:child_process');
  await withServer(async ({ get, outDir }) => {
    const viaHttp = await get(`/api/compare?a=${A}&b=${B}`);
    const viaCli = spawnSync(REAL, ['compare', A, B, '--json'], {
      encoding: 'utf8', env: Object.assign({}, process.env, { CROWDSIM_OUT: outDir }),
    });
    assert.deepEqual(viaHttp.json, JSON.parse(viaCli.stdout));
  }, (outDir) => {
    writeRun(outDir, A, { p95: 200 });
    writeRun(outDir, B, { p95: 140, aborted: true });
  });
});

test('a run id that does not exist is a 404 naming it, not a 500', async () => {
  await withServer(async ({ get }) => {
    const r = await get(`/api/compare?a=${A}&b=20260101T000000Z`);
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no summary for 20260101T000000Z/);
  }, (outDir) => {
    writeRun(outDir, A, {});
  });
});

test('anything that is not a run id is rejected before a process is started', async () => {
  // The two values reach a spawn argv. They are matched against the run-id shape first — the same reason
  // profile names are checked before they become a path.
  await withServer(async ({ get }) => {
    for (const bad of ['--help', '../../etc/passwd', 'x; rm -rf /', '']) {
      const r = await get(`/api/compare?a=${encodeURIComponent(bad)}&b=${B}`);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal(r.json.field, 'run');
    }
  }, (outDir) => {
    writeRun(outDir, A, {});
    writeRun(outDir, B, {});
  });
});
