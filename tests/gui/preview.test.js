/*
 * The command preview, the run-state file, and the two preflight artefacts read as data.
 *
 * The property under test in the first group is not "the endpoint returns a string" — it is that the string
 * is the SAME argv the server would execute. A preview assembled anywhere else is a description of what the
 * server probably does, and the moment the two drift it becomes a wrong answer delivered at the one moment
 * that matters: just before somebody authorises real traffic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../gui/server/lib/app.js';
import { Runner } from '../../gui/server/lib/runner.js';
import { shellQuote, commandLine } from '../../gui/server/lib/command.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const FAKE = path.join(here, 'fixtures/fake-crowdsim');

async function withServer(opts, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-gui-'));
  const profilesDir = path.join(tmp, 'profiles');
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(profilesDir);
  fs.copyFileSync(path.join(root, 'profiles/example.json'), path.join(profilesDir, 'example.json'));

  const app = createApp(Object.assign({
    crowdsimBin: FAKE, profilesDir, outDir, version: 'test',
  }, opts || {}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json, text };
  };
  try {
    await fn({ api, app, tmp, profilesDir, outDir });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function settle(api, id) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = await api('GET', `/api/runs/${id}`);
    if (r.json && r.json.status !== 'running') return r.json;
    if (Date.now() > deadline) throw new Error(`run ${id} never finished`);
    await new Promise((s) => setTimeout(s, 25));
  }
}

// ── the preview (#22) ────────────────────────────────────────────────────────────────────────────────

test('the previewed argv is exactly the argv the server executes', async () => {
  await withServer({}, async ({ api }) => {
    const body = { kind: 'load', profile: 'example.json', target: 'edge', peak: 40, hold: '90s' };
    const preview = await api('POST', '/api/preview', body);
    assert.equal(preview.status, 200);

    const started = await api('POST', '/api/runs', body);
    assert.equal(started.status, 201);
    // Not "looks similar": the same array, element for element.
    assert.deepEqual(preview.json.argv, started.json.argv);
    await settle(api, started.json.id);
  });
});

test('the preview is a preview: it starts nothing', async () => {
  await withServer({}, async ({ api }) => {
    await api('POST', '/api/preview', { kind: 'load', profile: 'example.json', peak: 40 });
    await api('POST', '/api/preview', { kind: 'load', profile: 'example.json', peak: 90 });
    const runs = await api('GET', '/api/runs');
    assert.deepEqual(runs.json.runs, []);
    assert.equal(runs.json.active, null);
  });
});

test('the preview shows the override while it is being armed, and the launch still demands the phrase', async () => {
  await withServer({}, async ({ api }) => {
    const armed = { kind: 'load', profile: 'example.json', target: 'edge', peak: 5000, force: true };

    // Nobody should have to type the confirmation in order to READ what the flag will do.
    const preview = await api('POST', '/api/preview', armed);
    assert.equal(preview.status, 200);
    assert.ok(preview.json.argv.includes('--i-know-this-breaks-production'));
    assert.equal(preview.json.needs_confirmation, true);

    // …and reading it buys nothing on the path that spawns.
    const refused = await api('POST', '/api/runs', armed);
    assert.equal(refused.status, 400);
    assert.equal(refused.json.field, 'confirm');

    const wrongPhrase = await api('POST', '/api/runs', Object.assign({ confirm: 'example.json' }, armed));
    assert.equal(wrongPhrase.status, 400, 'the file name is not the profile name');
  });
});

test('the preview is pasteable: it carries the allowlist the CLI will demand', async () => {
  process.env.CROWDSIM_ALLOW_TARGETS = 'www.example.test';
  try {
    await withServer({}, async ({ api }) => {
      const r = await api('POST', '/api/preview', { kind: 'load', profile: 'example.json', peak: 40 });
      assert.match(r.json.command, /^CROWDSIM_ALLOW_TARGETS=www\.example\.test crowdsim load /);
      assert.equal(r.json.env.CROWDSIM_ALLOW_TARGETS, 'www.example.test');
    });
  } finally {
    delete process.env.CROWDSIM_ALLOW_TARGETS;
  }
});

test('the preview reports an invalid form as a field error, before anything runs', async () => {
  await withServer({}, async ({ api }) => {
    const r = await api('POST', '/api/preview', { kind: 'load', profile: 'example.json', peak: 'lots' });
    assert.equal(r.status, 400);
    assert.equal(r.json.field, 'peak');
  });
});

test('a rendered command survives a hostile filename without becoming two commands', () => {
  // Nothing here is ever executed — the argv is spawned directly — but a copy-pasteable line that a reader
  // then runs must not turn a profile name into a second command.
  assert.equal(shellQuote("x.json; rm -rf /"), "'x.json; rm -rf /'");
  assert.equal(shellQuote("it's.json"), "'it'\\''s.json'");
  assert.equal(shellQuote('/plain/path-1.json'), '/plain/path-1.json');
  assert.equal(shellQuote(''), "''");
  assert.equal(
    commandLine(['load', '--profile', '/tmp/a b.json'], { bin: 'crowdsim' }),
    "crowdsim load --profile '/tmp/a b.json'",
  );
});

// ── the run survives a restart (#23) ─────────────────────────────────────────────────────────────────

test('a live run is written to out/ so another server can find it', async () => {
  await withServer({ env: { FAKE_SLEEP: '2' } }, async ({ api, outDir }) => {
    const started = await api('POST', '/api/runs', { kind: 'load', profile: 'example.json', peak: 10 });
    const state = JSON.parse(fs.readFileSync(path.join(outDir, 'gui-run.json'), 'utf8'));
    assert.equal(state.id, started.json.id);
    assert.equal(state.status, 'running');
    assert.ok(state.pid > 0, 'the pid is the way back to the process after a restart');

    await api('POST', `/api/runs/${started.json.id}/stop`);
    await settle(api, started.json.id);
    // A finished run must not look in-flight to the next server that starts.
    assert.equal(fs.existsSync(path.join(outDir, 'gui-run.json')), false);
  });
});

test('a restart adopts the run that is still going, and refuses to start a second generator', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-adopt-'));
  const outDir = path.join(tmp, 'out');
  const profilesDir = path.join(tmp, 'profiles');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'profiles/example.json'), path.join(profilesDir, 'example.json'));

  // The state a previous server would have left behind, and the driver's own log file next to it.
  fs.writeFileSync(path.join(outDir, 'gui-run.json'), JSON.stringify({
    id: 'r1-abc', kind: 'load', pid: 4242, status: 'running',
    argv: ['load', '--profile', 'example.json', '--peak', '60'],
    started_at: '2026-08-05T10:11:12.000Z', run_id: '20260805T101112Z',
  }));
  fs.writeFileSync(path.join(outDir, 'load-20260805T101112Z.log'), 'step 1: 15 req/s\nstep 2: 30 req/s\n');

  const alive = new Set([4242]);
  const signalled = [];
  const runner = new Runner({
    bin: FAKE,
    outDir,
    aliveFn: (pid) => alive.has(pid),
    signalFn: (pid, sig) => signalled.push([pid, sig]),
  });
  const app = createApp({ crowdsimBin: FAKE, profilesDir, outDir, runner });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  try {
    const runs = await api('GET', '/api/runs');
    assert.equal(runs.json.runs.length, 1, 'the page must not look idle while a generator is running');
    assert.equal(runs.json.active.id, 'r1-abc');
    assert.equal(runs.json.active.adopted, true);
    assert.equal(runs.json.active.pid, 4242);

    // The log comes back from the driver's file, not from a copy the GUI kept.
    const detail = await api('GET', '/api/runs/r1-abc');
    assert.ok(detail.json.log.join('\n').includes('step 2: 30 req/s'));
    assert.ok(detail.json.log.join('\n').includes('reattached after a server restart'));
    assert.equal(detail.json.exit_code, null, 'an adopted run cannot honestly report an exit code');

    // The one-run-at-a-time rule is the whole reason this matters: a rebuild must not become two generators.
    const second = await api('POST', '/api/runs', { kind: 'load', profile: 'example.json', peak: 10 });
    assert.equal(second.status, 409);
    assert.equal(second.json.active.id, 'r1-abc');

    // Stop still works: by pid, since there is no child handle.
    await api('POST', '/api/runs/r1-abc/stop');
    assert.deepEqual(signalled, [[4242, 'SIGINT']]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a stop that cannot be delivered says so, and how to do it by hand', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-adopt-'));
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'gui-run.json'), JSON.stringify({
    id: 'r9-zzz', kind: 'load', pid: 5150, status: 'running', argv: ['load'],
  }));
  const runner = new Runner({
    bin: FAKE,
    outDir,
    aliveFn: () => true,
    signalFn: () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; },
  });
  runner.adopt();

  const stopped = runner.stop('r9-zzz');
  assert.equal(stopped.status, 'running', 'reporting it as stopped would be a lie');
  assert.match(stopped.stop_error, /kill -INT 5150/);
});

test('a run interrupted by the server dying is reported as ended: not as live, and not as nothing', async () => {
  // This is the COMMON case, and it was measured rather than assumed: the driver's stdout is a pipe to the
  // server, so killing the server takes the driver and k6 with it inside about two seconds. The page must
  // say that happened — claiming a live run would be false, and showing an empty list loses a run that
  // really did happen and really did leave an archive.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-adopt-'));
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const statePath = path.join(outDir, 'gui-run.json');
  fs.writeFileSync(statePath, JSON.stringify({
    id: 'r0-old', kind: 'load', pid: 777, status: 'running', run_id: '20260805T101112Z',
  }));

  const runner = new Runner({ bin: FAKE, outDir, aliveFn: () => false });
  const adopted = runner.adopt();
  assert.equal(adopted.status, 'ended');
  assert.equal(adopted.interrupted, true);
  assert.equal(adopted.exit_code, null, 'this server was not there when it ended');
  assert.equal(runner.list().length, 1, 'the run stays visible');
  assert.equal(runner.active(), null, 'and does not block the next one');
  assert.equal(fs.existsSync(statePath), false, 'the file must not keep claiming a run that ended');
});

// ── probe and discover as data (#24) ─────────────────────────────────────────────────────────────────

test('the run id is picked up from both shapes the driver prints it in', () => {
  // `load` prints it on a line of its own; `probe` prints it inline with the base url. Reading only the
  // first shape is why a probe run had no run id, and so no route to the file holding its result.
  const runner = new Runner({ bin: FAKE, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-id-')) });

  const load = { id: 'a', kind: 'load', log: [], runId: null, status: 'running' };
  runner.append(load, '  run       20260805T101112Z\n');
  assert.equal(load.runId, '20260805T101112Z');

  const probe = { id: 'b', kind: 'probe', log: [], runId: null, status: 'running' };
  runner.append(probe, 'run: 20260805T101112Z  base: http://127.0.0.1:8099  path: /\n');
  assert.equal(probe.runId, '20260805T101112Z');

  // And not from prose that merely contains the word.
  const other = { id: 'c', kind: 'load', log: [], runId: null, status: 'running' };
  runner.append(other, 'this run will not tell you 20260805T101112Z\n');
  assert.equal(other.runId, null);
});

test('a probe run exposes the per-layer verdict, including the header that never appeared', async () => {
  await withServer({}, async ({ api, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'probe-20260805T101112Z.json'), JSON.stringify({
      run_id: '20260805T101112Z', base_url: 'https://www.example.test', path: '/', status: 200,
      ttfb_s: 0.18, bytes: 46231,
      headers: { 'cache-control': 'public, max-age=60', 'x-proxy-cache': 'HIT' },
      layers: [
        { label: 'proxy', header: 'X-Proxy-Cache', hit_pattern: 'HIT', value: 'HIT', hit: true },
        { label: 'cdn', header: 'X-Cache', hit_pattern: 'Hit', value: null, hit: null },
      ],
    }));
    const started = await api('POST', '/api/runs', { kind: 'probe', profile: 'example.json' });
    const done = await settle(api, started.json.id);
    assert.equal(done.artifacts.probe.bytes, 46231);
    assert.equal(done.artifacts.probe.layers[0].hit, true);
    assert.equal(done.artifacts.probe.layers[1].hit, null,
      'null is not a miss: the header was never in the response');
    assert.equal(done.artifacts.discover, null);
  });
});

test('a discover run exposes the pool it would write, with what was dropped and why', async () => {
  await withServer({}, async ({ api, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'discover-20260805T101112Z.json'), JSON.stringify({
      run_id: '20260805T101112Z', base_url: 'https://www.example.test',
      sitemap: 'https://www.example.test/sitemap.xml', pool_path: '/out/pool-20260805T101112Z.json',
      loc_entries: 5, distinct: 5, verified: true, kept: 3,
      dropped: [{ path: '/gone', reason: 'status', status: 404 },
        { path: '/old', reason: 'redirect', status: 307 }],
    }));
    const started = await api('POST', '/api/runs', { kind: 'discover', profile: 'example.json', limit: 5 });
    const done = await settle(api, started.json.id);
    assert.equal(done.artifacts.discover.kept, 3);
    assert.equal(done.artifacts.discover.dropped.length, 2);
    assert.equal(done.artifacts.discover.dropped[0].status, 404);
    assert.equal(done.artifacts.probe, null);
  });
});
