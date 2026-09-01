/*
 * The HTTP API, exercised over a real socket against a fake crowdsim binary.
 *
 * The recurring question in these tests: can the GUI be talked into doing something the CLI would have
 * refused? Path traversal out of the profile directory, two generators at once, the production override
 * without confirmation, a gate refusal presented as success. Each of those is a way for a convenience
 * layer to quietly become the weakest link.
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
const FAKE = path.join(here, 'fixtures/fake-crowdsim');

/** Boot the API on an ephemeral port with a throwaway profile dir and out dir. */
async function withServer(opts, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-gui-'));
  const profilesDir = path.join(tmp, 'profiles');
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(profilesDir);
  fs.copyFileSync(path.join(root, 'profiles/example.json'), path.join(profilesDir, 'example.json'));
  fs.copyFileSync(path.join(root, 'profiles/example.json'), path.join(profilesDir, 'site.json'));

  const app = createApp(Object.assign({
    crowdsimBin: FAKE, profilesDir, outDir, version: 'test',
  }, opts || {}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body, headers) => {
    const res = await fetch(base + url, {
      method,
      headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, headers || {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json: keep the text */ }
    return { status: res.status, json, text };
  };
  try {
    await fn({ api, base, app, tmp, profilesDir, outDir });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Wait for a run to leave the running state. */
async function settle(api, id, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  for (;;) {
    const r = await api('GET', `/api/runs/${id}`);
    if (r.json && r.json.status !== 'running') return r.json;
    if (Date.now() > deadline) throw new Error(`run ${id} never finished: ${JSON.stringify(r.json)}`);
    await new Promise((s) => setTimeout(s, 25));
  }
}

test('GET /api/env reports the environment without leaking the Slack webhook', async () => {
  process.env.CROWDSIM_SLACK_WEBHOOK = 'https://hooks.example.test/T/B/XYZSECRET';
  try {
    await withServer({}, async ({ api }) => {
      const r = await api('GET', '/api/env');
      assert.equal(r.status, 200);
      assert.equal(r.json.slack_configured, true);
      assert.ok(!r.text.includes('XYZSECRET'), 'the webhook is a secret: only its presence is reported');
      assert.deepEqual(r.json.shapes, ['mix', 'journey']);
    });
  } finally {
    delete process.env.CROWDSIM_SLACK_WEBHOOK;
  }
});

test('GET /api/profiles lists profiles with their validation state', async () => {
  await withServer({}, async ({ api }) => {
    const r = await api('GET', '/api/profiles');
    const names = r.json.profiles.map((p) => p.name);
    assert.deepEqual(names, ['example.json', 'site.json']);
    const site = r.json.profiles.find((p) => p.name === 'site.json');
    assert.equal(site.ok, true);
    assert.equal(site.default_target, 'edge');
    assert.equal(site.safe_peak_rps, 150);
  });
});

test('a profile name cannot escape the profile directory', async () => {
  await withServer({}, async ({ api, tmp }) => {
    fs.writeFileSync(path.join(tmp, 'secret.json'), '{"name":"not yours"}');
    for (const name of ['../secret.json', '..%2Fsecret.json', '%2e%2e%2fsecret.json',
      '/etc/passwd', 'sub/../../secret.json']) {
      const r = await api('GET', `/api/profiles/${name}`);
      assert.ok(r.status === 400 || r.status === 404, `${name} answered ${r.status}`);
      assert.ok(!r.text.includes('not yours'), `${name} leaked a file outside the directory`);
    }
  });
});

test('PUT writes a profile, refuses invalid JSON, and refuses one with errors', async () => {
  await withServer({}, async ({ api, profilesDir }) => {
    const good = JSON.parse(fs.readFileSync(path.join(profilesDir, 'example.json'), 'utf8'));
    good.name = 'written-by-the-gui';
    let r = await api('PUT', '/api/profiles/new.json', { raw: JSON.stringify(good) });
    assert.equal(r.status, 200);
    assert.match(fs.readFileSync(path.join(profilesDir, 'new.json'), 'utf8'), /written-by-the-gui/);

    r = await api('PUT', '/api/profiles/new.json', { raw: '{ not json' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not valid JSON/);

    const broken = Object.assign({}, good, { classes: [] });
    r = await api('PUT', '/api/profiles/new.json', { raw: JSON.stringify(broken) });
    assert.equal(r.status, 422);
    assert.ok(r.json.validation.errors.length > 0);

    // force is available: a half-built profile is a legitimate thing to save
    r = await api('PUT', '/api/profiles/new.json', { raw: JSON.stringify(broken), force: true });
    assert.equal(r.status, 200);
  });
});

test('a read-only profile directory is explained, not reported as a server error', {
  // Root ignores the permission bits this test relies on, so the scenario cannot exist as root: the write
  // succeeds and the test fails for a reason that has nothing to do with the code. That is how it behaved
  // in every container — including the clean-checkout run this suite is supposed to be safe for. Skipping
  // with a reason beats a red run that means "you are root".
  skip: typeof process.getuid === 'function' && process.getuid() === 0
    ? 'running as root: a 0500 directory is still writable, so this scenario cannot be reproduced'
    : false,
}, async () => {
  // This is what `-v ./profiles:/profiles:ro` gives you, and it is a reasonable way to mount a map of
  // your infrastructure. A 500 would tell the operator the server is broken when it is doing as asked.
  await withServer({}, async ({ api, profilesDir }) => {
    fs.chmodSync(profilesDir, 0o500);
    try {
      const r = await api('PUT', '/api/profiles/new.json', { raw: '{"name":"x"}', force: true });
      assert.equal(r.status, 409);
      assert.match(r.json.error, /not writable/);
      assert.match(r.json.error, /read and run profiles but not save/);
      // reading and listing keep working: a read-only mount is usable, just not editable
      assert.equal((await api('GET', '/api/profiles')).status, 200);
      assert.equal((await api('GET', '/api/profiles/site.json')).status, 200);
    } finally {
      fs.chmodSync(profilesDir, 0o700);
    }
  });
});

test('example.json is read-only: it is the shipped documentation', async () => {
  await withServer({}, async ({ api }) => {
    const r = await api('PUT', '/api/profiles/example.json', { raw: '{"name":"x"}' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /shipped documentation/);
    const d = await api('DELETE', '/api/profiles/example.json');
    assert.equal(d.status, 400);
  });
});

test('POST /api/validate reports errors and warnings without touching disk', async () => {
  await withServer({}, async ({ api, profilesDir }) => {
    const r = await api('POST', '/api/validate', { raw: '{"classes":[]}' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.ok(r.json.errors.length > 0);
    const bad = await api('POST', '/api/validate', { raw: 'nope' });
    assert.ok(bad.json.parse_error);
    assert.deepEqual(fs.readdirSync(profilesDir).sort(), ['example.json', 'site.json']);
  });
});

test('POST /api/runs launches the CLI with the arguments the form asked for', async () => {
  await withServer({}, async ({ api }) => {
    const r = await api('POST', '/api/runs', { profile: 'site.json', target: 'edge', peak: 40, dryRun: true });
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'running');
    const done = await settle(api, r.json.id);
    assert.equal(done.status, 'done');
    assert.equal(done.exit_code, 0);
    const argv = done.argv.join(' ');
    assert.match(argv, /^load --profile .*site\.json --target edge --peak 40 --dry-run$/);
    assert.ok(done.log.some((l) => l.includes('ARGV:')));
    assert.equal(done.run_id, '20260805T101112Z', 'the driver-generated run id is picked up from the log');
  });
});

test('a run against a profile with errors is refused before anything is spawned', async () => {
  await withServer({}, async ({ api, profilesDir }) => {
    fs.writeFileSync(path.join(profilesDir, 'broken.json'), JSON.stringify({ classes: [] }));
    const r = await api('POST', '/api/runs', { profile: 'broken.json', peak: 10 });
    assert.equal(r.status, 422);
    assert.ok(r.json.validation.errors.length > 0);
    const runs = await api('GET', '/api/runs');
    assert.equal(runs.json.runs.length, 0);
  });
});

test('a run against a profile that does not exist is a 404, not a 500', async () => {
  await withServer({}, async ({ api }) => {
    const r = await api('POST', '/api/runs', { profile: 'ghost.json', peak: 10 });
    assert.equal(r.status, 404);
  });
});

test('the safe-peak override needs the profile name typed back, and the field is named', async () => {
  await withServer({}, async ({ api }) => {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'profiles/example.json'), 'utf8')).name;
    let r = await api('POST', '/api/runs', { profile: 'site.json', peak: 9000, force: true });
    assert.equal(r.status, 400);
    assert.equal(r.json.field, 'confirm');

    r = await api('POST', '/api/runs', { profile: 'site.json', peak: 9000, force: true, confirm: name, dryRun: true });
    assert.equal(r.status, 201);
    assert.ok(r.json.argv.includes('--i-know-this-breaks-production'));
    // the confirmation phrase is not kept in the run record
    assert.ok(!JSON.stringify(r.json.request).includes('confirm'));
    await settle(api, r.json.id);
  });
});

test('only one run at a time: the second attempt is a 409 naming the active run', async () => {
  // A GUI makes double-clicking Run trivial. Two generators at once produce twice the load nobody
  // agreed to, and two results that are each invalid.
  await withServer({ env: { FAKE_SLEEP: '3' } }, async ({ api }) => {
    const first = await api('POST', '/api/runs', { profile: 'site.json', peak: 10 });
    assert.equal(first.status, 201);
    const second = await api('POST', '/api/runs', { profile: 'site.json', peak: 10 });
    assert.equal(second.status, 409);
    assert.equal(second.json.active.id, first.json.id);

    const stopped = await api('POST', `/api/runs/${first.json.id}/stop`);
    assert.equal(stopped.status, 200);
    const done = await settle(api, first.json.id);
    assert.equal(done.status, 'stopped');
    assert.ok(done.log.some((l) => /SIGINT/.test(l)), 'stop is a graceful SIGINT, not a kill');

    // and once it is over, a new run is accepted again
    const third = await api('POST', '/api/runs', { profile: 'site.json', peak: 10, dryRun: true });
    assert.equal(third.status, 201);
    await settle(api, third.json.id);
  });
});

test('a refusal from the CLI is surfaced with its exit code, not as a success', async () => {
  // Exit 3 is a safety gate. If the GUI swallowed it, the operator would be told the run "finished".
  await withServer({ env: { FAKE_EXIT: '3' } }, async ({ api }) => {
    const r = await api('POST', '/api/runs', { profile: 'site.json', peak: 10 });
    const done = await settle(api, r.json.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.exit_code, 3);
  });
});

test('a missing crowdsim binary is reported as a failed run, not a crashed server', async () => {
  await withServer({ crowdsimBin: '/nonexistent/crowdsim' }, async ({ api }) => {
    const r = await api('POST', '/api/runs', { profile: 'site.json', peak: 10 });
    const done = await settle(api, r.json.id);
    assert.equal(done.status, 'failed');
    assert.ok(done.log.some((l) => /could not be started/.test(l)));
  });
});

test('the summary written by the driver is attached to the finished run', async () => {
  const summary = path.join(root, 'tests/cli/fixtures/summary-invalid.json');
  await withServer({ env: { FAKE_SUMMARY_SRC: summary } }, async ({ api }) => {
    const r = await api('POST', '/api/runs', { profile: 'site.json', peak: 40 });
    const done = await settle(api, r.json.id);
    assert.equal(done.summary.generator_ok, false, 'an invalid run must arrive at the UI marked invalid');
    assert.equal(done.summary.run_id, '20260805T101112Z');
  });
});

test('the live log stream replays what happened as a snapshot, then closes on end', async () => {
  // The replay is ONE snapshot event, not a series of `line` events: a client that reconnects already holds
  // lines, and a replay it cannot tell from new output doubles the log every time. See tests/gui/startup.
  await withServer({}, async ({ api, base }) => {
    const r = await api('POST', '/api/runs', { profile: 'site.json', peak: 10, dryRun: true });
    await settle(api, r.json.id);
    const res = await fetch(`${base}/api/runs/${r.json.id}/stream`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const body = await res.text();                       // a finished run closes the stream immediately
    assert.match(body, /event: snapshot/);
    const lines = JSON.parse(/event: snapshot\ndata: (.*)/.exec(body)[1]).lines;
    assert.ok(lines.some((l) => l.includes('ARGV:')), lines);
    assert.match(body, /event: end/);
  });
});

test('history is read from the files the driver writes, not from GUI state', async () => {
  await withServer({}, async ({ api, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'history.tsv'),
      'run_id\tprofile\tbase_url\tshape\tpeak\taborted\treqs\trps\tfailed\tp95\te504\tgen_ok\n' +
      '20260805T090000Z\tsite\thttp://127.0.0.1:8099\tmix\t40\tFalse\t12000\t39.6\t0.0012\t780\t0\tTrue\n' +
      '20260805T100000Z\tsite\thttp://127.0.0.1:8099\tmix\t80\tTrue\t20000\t70.1\t0.07\t6900\t812\tTrue\n');
    fs.copyFileSync(path.join(root, 'tests/cli/fixtures/summary-aborted.json'),
      path.join(outDir, 'summary-20260805T100000Z.json'));

    const h = await api('GET', '/api/history');
    assert.equal(h.json.runs.length, 2);
    assert.equal(h.json.runs[0].run_id, '20260805T100000Z', 'newest first');
    assert.equal(h.json.runs[0].aborted, true);
    assert.equal(h.json.runs[0].generator_ok, true);

    const one = await api('GET', '/api/history/20260805T100000Z');
    assert.equal(one.status, 200);
    assert.equal(one.json.summary.e504, 812);
    assert.equal(one.json.comparable.length, 1, 'the other run at the same profile/target/shape');

    assert.equal((await api('GET', '/api/history/nope')).status, 404);
    assert.equal((await api('GET', '/api/history/../../etc/passwd')).status, 404);
  });
});

test('with a token configured, every API route requires it', async () => {
  await withServer({ token: 'sekret' }, async ({ api }) => {
    assert.equal((await api('GET', '/api/env')).status, 401);
    assert.equal((await api('GET', '/api/profiles')).status, 401);
    assert.equal((await api('POST', '/api/runs', { profile: 'site.json', peak: 10 })).status, 401);
    const ok = await api('GET', '/api/env', null, { Authorization: 'Bearer sekret' });
    assert.equal(ok.status, 200);
  });
});

test('an unknown API path is a JSON 404', async () => {
  await withServer({}, async ({ api }) => {
    const r = await api('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no such endpoint/);
  });
});

test('without a built UI the root page says how to build it instead of 404ing', async () => {
  await withServer({ uiDir: '/nonexistent/dist' }, async ({ api }) => {
    const r = await api('GET', '/');
    assert.equal(r.status, 503);
    assert.match(r.text, /gui:build/);
  });
});

// ── the knee travels with the history (#51) ─────────────────────────────────────────────────────────
// history.tsv is what the page plots. Without the knee in it, every row is "peak asked" against "p95 over
// the whole ramp" — two numbers that describe rates the system was never held at. With it, a row states a
// rate that was measured surviving.

test('history carries the knee, and a row from before it existed is not invented', async () => {
  await withServer({}, async ({ api, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'history.tsv'),
      // an old row: the two columns simply are not there
      'run_id\tprofile\tbase_url\tshape\tpeak\taborted\treqs\trps\tfailed\tp95\te504\tgen_ok\n' +
      '20260805T090000Z\tsite\thttp://127.0.0.1:8099\tmix\t40\tFalse\t12000\t39.6\t0.0012\t780\t0\tTrue\n');
    const old = await api('GET', '/api/history');
    assert.equal(old.json.runs[0].knee_clean, null, 'a knee was invented for a run that never measured one');
    assert.equal(old.json.runs[0].knee_crossed, null);

    fs.writeFileSync(path.join(outDir, 'history.tsv'),
      'run_id\tprofile\tbase_url\tshape\tpeak\taborted\treqs\trps\tfailed\tp95\te504\tgen_ok\tknee_clean\tknee_crossed\n' +
      '20260805T090000Z\tsite\thttp://127.0.0.1:8099\tmix\t40\tFalse\t12000\t39.6\t0.0012\t780\t0\tTrue\t30\t40\n' +
      // a run whose knee was refused: the columns are empty, which is not the same as zero
      '20260805T100000Z\tsite\thttp://127.0.0.1:8099\tmix\t80\tTrue\t20000\t70.1\t0.07\t6900\t812\tTrue\t\t\n');
    const h = await api('GET', '/api/history');
    const [newest, older] = h.json.runs;
    assert.equal(older.knee_clean, 30);
    assert.equal(older.knee_crossed, 40);
    assert.equal(newest.knee_clean, null, 'a refused knee must not become 0 req/s');
    assert.equal(newest.knee_crossed, null);
  });
});

// ── the report, produced by the CLI and handed over (#53) ────────────────────────────────────────────
// The GUI had no way to produce the one artefact somebody reading a finished run wants next, so the
// caveats — the whole point of that document — were what got left behind on the way out of the page.

test('a finished run can be handed over as markdown, written by crowdsim report', async () => {
  await withServer({}, async ({ api, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(path.join(root, 'tests/cli/fixtures/summary-good.json'),
      path.join(outDir, 'summary-20260805T100000Z.json'));

    const r = await api('GET', '/api/history/20260805T100000Z/report');
    assert.equal(r.status, 200);
    assert.match(r.text, /FAKE REPORT BODY/);
    // The server hands over the CLI's file rather than rendering its own: the artefact is on disk where
    // `crowdsim report` puts it, which is also where the CLI's users already look for it.
    assert.ok(fs.existsSync(path.join(outDir, 'report-20260805T100000Z.md')));
  });
});

test('a run id with no summary is a 404, and a path is not a run id', async () => {
  await withServer({}, async ({ api }) => {
    assert.equal((await api('GET', '/api/history/20260805T100000Z/report')).status, 404);
    assert.equal((await api('GET', '/api/history/nope/report')).status, 400);
    assert.equal((await api('GET', '/api/history/..%2F..%2Fetc%2Fpasswd/report')).status, 400);
  });
});

test('when crowdsim report fails, the failure is reported and not an empty file', async () => {
  await withServer({ env: { FAKE_EXIT: '2' } }, async ({ api, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(path.join(root, 'tests/cli/fixtures/summary-good.json'),
      path.join(outDir, 'summary-20260805T100000Z.json'));
    const r = await api('GET', '/api/history/20260805T100000Z/report');
    assert.equal(r.status, 500);
    assert.match(r.json.error, /exited 2/);
  });
});

test('the same run can be handed over as a page with charts', async () => {
  await withServer({}, async ({ api, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(path.join(root, 'tests/cli/fixtures/summary-good.json'),
      path.join(outDir, 'summary-20260805T100000Z.json'));

    const r = await api('GET', '/api/history/20260805T100000Z/report?format=html');
    assert.equal(r.status, 200);
    assert.match(r.text, /FAKE HTML REPORT BODY/);
    assert.ok(fs.existsSync(path.join(outDir, 'report-20260805T100000Z.html')));

    // and the markdown one is still the default: a caller that asks for nothing gets what it always got
    const md = await api('GET', '/api/history/20260805T100000Z/report');
    assert.match(md.text, /FAKE REPORT BODY/);
    assert.ok(!/FAKE HTML/.test(md.text));
  });
});

test('a format the server does not produce is a 400, not a guess', async () => {
  await withServer({}, async ({ api, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(path.join(root, 'tests/cli/fixtures/summary-good.json'),
      path.join(outDir, 'summary-20260805T100000Z.json'));
    const r = await api('GET', '/api/history/20260805T100000Z/report?format=pdf');
    assert.equal(r.status, 400);
    assert.equal(r.json.field, 'format');
  });
});
