/*
 * Starting the server, and the live stream's contract with a client that comes back. (#34, #31)
 *
 * The first is the first thing a new user can hit: `crowdsim serve` on a port something else already holds
 * printed an EADDRINUSE dump with a syscall object and a Node version banner, and exited 1. It was found by
 * accident during the audit — an old server was still listening, the new one's failure was invisible enough
 * that the page being served looked current when it was three releases old.
 *
 * The second is what a reconnecting client must receive: the whole log as one snapshot, not a replay of
 * individual lines that the client would append to what it already has.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../gui/server/lib/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const SERVER = path.join(root, 'gui/server/index.js');
const FAKE = path.join(here, 'fixtures/fake-crowdsim');

function tmpdirs() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-start-'));
  const profilesDir = path.join(tmp, 'profiles');
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(profilesDir);
  fs.mkdirSync(outDir);
  fs.copyFileSync(path.join(root, 'profiles/example.json'), path.join(profilesDir, 'example.json'));
  return { tmp, profilesDir, outDir };
}

/** Run gui/server/index.js to completion and collect what it said. */
function runServer(env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs || 4000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

test('a port already in use is one sentence, not a Node stack trace', async () => {
  const { profilesDir, outDir } = tmpdirs();
  // Hold a port with something that is not crowdsim, so the failure is genuinely "in use".
  const squatter = net.createServer(() => {});
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  const port = squatter.address().port;

  try {
    const r = await runServer({
      CROWDSIM_GUI_PORT: String(port),
      CROWDSIM_PROFILES: profilesDir,
      CROWDSIM_OUT: outDir,
    });
    const said = `${r.out}${r.err}`;
    assert.equal(r.code, 2, 'a usage problem, not an unhandled exception');
    assert.match(said, new RegExp(`port ${port}`), 'the port is named');
    assert.match(said, /already in use/i);
    assert.match(said, /crowdsim serve/, 'and the likely cause: another one of these');

    // What must be gone: the dump.
    assert.doesNotMatch(said, /EADDRINUSE/, 'the errno is not an explanation');
    assert.doesNotMatch(said, /at Server\.|node:internal|syscall/, 'no stack, no internals');
  } finally {
    await new Promise((r) => squatter.close(r));
  }
});

test('an address that cannot be bound is explained too, and not as a crash', async () => {
  const { profilesDir, outDir } = tmpdirs();
  const r = await runServer({
    CROWDSIM_GUI_BIND: '203.0.113.10',        // documentation address: not on this machine
    CROWDSIM_GUI_TOKEN: 'x',                  // off loopback needs one; that gate is not what is tested here
    CROWDSIM_GUI_PORT: '18999',
    CROWDSIM_PROFILES: profilesDir,
    CROWDSIM_OUT: outDir,
  });
  const said = `${r.out}${r.err}`;
  assert.equal(r.code, 2);
  assert.match(said, /203\.0\.113\.10/);
  assert.match(said, /cannot bind|not an address on this machine/i);
  assert.doesNotMatch(said, /node:internal/);
});

test('a profile directory that does not exist is named, before anything is served', async () => {
  const { outDir } = tmpdirs();
  const r = await runServer({
    CROWDSIM_GUI_PORT: '0',
    CROWDSIM_PROFILES: '/nope/not/here',
    CROWDSIM_OUT: outDir,
  });
  const said = `${r.out}${r.err}`;
  assert.equal(r.code, 2);
  assert.match(said, /\/nope\/not\/here/);
  assert.match(said, /profile directory/i);
});

// ── the stream's contract with a client that comes back (#31) ────────────────────────────────────────
test('a connecting client gets the log as one snapshot, not as a replay of lines', async () => {
  // A reconnecting page has lines already. If the server replays them as `line` events the page cannot tell
  // them from new output, and the log doubles on every reconnect.
  const { profilesDir, outDir } = tmpdirs();
  const app = createApp({ crowdsimBin: FAKE, profilesDir, outDir, env: { FAKE_SLEEP: '2' } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const started = await (await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'load', profile: 'example.json', peak: 10 }),
    })).json();

    // Let the fake driver print something first, then connect the way a reconnecting client would.
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`${base}/api/runs/${started.id}/stream`);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    await reader.cancel();

    assert.match(text, /^event: snapshot/m, 'the first event replaces, it does not append');
    const payload = JSON.parse(/^event: snapshot\ndata: (.*)$/m.exec(text)[1]);
    assert.ok(Array.isArray(payload.lines), 'the whole log, as one array');
    assert.ok(payload.lines.some((l) => l.includes('ARGV:')), payload.lines);

    await fetch(`${base}/api/runs/${started.id}/stop`, { method: 'POST' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
