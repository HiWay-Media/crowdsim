/*
 * Which driver the GUI spawns.
 *
 * This is the file that exists because of a shipped bug: from 1.2.0 to 1.19.1 the published image ran a GUI
 * that could not launch a single run. The server derived the driver's path from its own location
 * (`/crowdsim/gui/server/../../bin/crowdsim`) while the image puts the driver in `/usr/local/bin`, and the
 * documentation said the default was `$CROWDSIM_ROOT/bin/crowdsim` — which is what anybody would assume, so
 * setting `CROWDSIM_ROOT` looked like it covered this and did not.
 *
 * Nothing failed loudly: the page started, said nothing, and every run died with `spawn ENOENT` after the
 * click. So these tests are about the order, and about the refusal — a server that cannot spawn the driver
 * has no job, and should say so at startup rather than accept every click and fail each one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBin, unresolvedMessage, executable } from '../../gui/server/lib/bin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

/** A set of paths that "exist and are executable", so no filesystem is needed. */
const only = (...paths) => (p) => paths.indexOf(p) !== -1;

test('CROWDSIM_BIN wins, and is reported as itself', () => {
  const r = resolveBin({
    env: { CROWDSIM_BIN: '/opt/crowdsim', CROWDSIM_ROOT: '/crowdsim', PATH: '/usr/local/bin' },
    serverRoot: '/checkout',
    isExecutable: only('/opt/crowdsim', '/crowdsim/bin/crowdsim', '/usr/local/bin/crowdsim'),
  });
  assert.equal(r.bin, '/opt/crowdsim');
  assert.equal(r.source, 'CROWDSIM_BIN');
});

test('a CROWDSIM_BIN that is not executable is an error, never a fallback', () => {
  // Falling through would hide a typo behind a driver from somewhere else, and the GUI would then spawn a
  // different tool from the one it was told to — which is worse than refusing.
  const r = resolveBin({
    env: { CROWDSIM_BIN: '/opt/typo', CROWDSIM_ROOT: '/crowdsim', PATH: '/usr/local/bin' },
    serverRoot: '/checkout',
    isExecutable: only('/crowdsim/bin/crowdsim', '/usr/local/bin/crowdsim'),
  });
  assert.equal(r.bin, null);
  assert.equal(r.source, 'CROWDSIM_BIN');
  assert.match(unresolvedMessage(r), /CROWDSIM_BIN is set to \/opt\/typo/);
});

test('CROWDSIM_ROOT is next, which is what the documentation always claimed', () => {
  const r = resolveBin({
    env: { CROWDSIM_ROOT: '/crowdsim', PATH: '/usr/local/bin' },
    serverRoot: '/checkout',
    isExecutable: only('/crowdsim/bin/crowdsim', '/checkout/bin/crowdsim', '/usr/local/bin/crowdsim'),
  });
  assert.equal(r.bin, '/crowdsim/bin/crowdsim');
  assert.equal(r.source, 'CROWDSIM_ROOT');
});

test('then the checkout the server is running from', () => {
  const r = resolveBin({
    env: { PATH: '/usr/local/bin' },
    serverRoot: '/checkout',
    isExecutable: only('/checkout/bin/crowdsim', '/usr/local/bin/crowdsim'),
  });
  assert.equal(r.bin, '/checkout/bin/crowdsim');
  assert.equal(r.source, 'this checkout');
});

test('then PATH — an installed driver, whatever the layout around it', () => {
  const r = resolveBin({
    env: { CROWDSIM_ROOT: '/crowdsim' },
    serverRoot: '/checkout',
    pathDirs: ['/sbin', '/usr/local/bin'],
    isExecutable: only('/usr/local/bin/crowdsim'),
  });
  assert.equal(r.bin, '/usr/local/bin/crowdsim');
  assert.equal(r.source, 'PATH');
});

test('THE SHIPPED BUG: root at /crowdsim, driver on PATH, and nothing under either bin/', () => {
  // Exactly the published image before this fix: CROWDSIM_ROOT=/crowdsim, the driver at
  // /usr/local/bin/crowdsim, and no /crowdsim/bin/crowdsim at all. The old code returned the path that did
  // not exist and the GUI failed at the first click.
  const r = resolveBin({
    env: { CROWDSIM_ROOT: '/crowdsim', PATH: '/usr/local/sbin:/usr/local/bin:/usr/bin' },
    serverRoot: '/crowdsim',
    isExecutable: only('/usr/local/bin/crowdsim'),
  });
  assert.equal(r.bin, '/usr/local/bin/crowdsim');
  assert.ok(r.tried.includes('/crowdsim/bin/crowdsim'), 'the path that used to be returned was tried');
});

test('nothing found is null, and the message names the variable and where it looked', () => {
  const r = resolveBin({
    env: { CROWDSIM_ROOT: '/crowdsim', PATH: '/usr/bin' },
    serverRoot: '/checkout',
    isExecutable: () => false,
  });
  assert.equal(r.bin, null);
  const msg = unresolvedMessage(r);
  assert.match(msg, /CROWDSIM_BIN/);
  assert.match(msg, /\/usr\/local\/bin\/crowdsim/, 'it names where the image puts it');
  assert.match(msg, /\/crowdsim\/bin\/crowdsim/, 'and lists what it tried');
  assert.match(msg, /refuses to start/);
});

test('an empty environment does not throw: no PATH is not a crash', () => {
  const r = resolveBin({ env: {}, serverRoot: '/checkout', isExecutable: () => false });
  assert.equal(r.bin, null);
  assert.ok(Array.isArray(r.tried));
});

test('executable() is about a file that can actually be run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-bin-'));
  const script = path.join(dir, 'crowdsim');
  fs.writeFileSync(script, '#!/bin/sh\nexit 0\n');
  assert.equal(executable(script), false, 'not executable yet');
  fs.chmodSync(script, 0o755);
  assert.equal(executable(script), true);
  assert.equal(executable(dir), false, 'a directory is not a driver');
  assert.equal(executable(path.join(dir, 'nope')), false);
  assert.equal(executable(root + '/bin/crowdsim'), true, "this repo's own driver");
});

// ── and the server refuses to start ─────────────────────────────────────────────────────────────────

test('the server exits 2 rather than serving a page that cannot spawn anything', () => {
  // Through CROWDSIM_BIN, because that is the branch that can be isolated: the real index.js lives inside
  // a checkout that HAS bin/crowdsim, so the "nothing anywhere" case cannot be staged against it without
  // copying the server somewhere else — the resolver's own test above covers that branch. What is asserted
  // here is the wiring: a driver that is not there stops startup instead of being discovered at the first
  // click, which is how the image shipped broken.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-nobin-'));
  fs.mkdirSync(path.join(dir, 'profiles'));
  const r = spawnSync(process.execPath, [path.join(root, 'gui/server/index.js')], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      PATH: '', HOME: dir,
      CROWDSIM_BIN: path.join(dir, 'not-a-driver'),
      CROWDSIM_PROFILES: path.join(dir, 'profiles'),
      CROWDSIM_OUT: path.join(dir, 'out'),
      CROWDSIM_GUI_PORT: '18998',
    },
  });
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /CROWDSIM_BIN is set to/);
  assert.match(r.stderr, /not an executable file/);
  assert.ok(!/GUI  http/.test(r.stdout), 'it must not have started serving');
});

test('the server names the driver it will spawn, so a log can answer the question', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-bin-ok-'));
  fs.mkdirSync(path.join(dir, 'profiles'));
  const fake = path.join(dir, 'crowdsim');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fake, 0o755);
  // A server that starts would keep running, so it is asked to fail immediately afterwards: an
  // unbindable address. What matters is that the driver line was printed before that.
  const r = spawnSync(process.execPath, [path.join(root, 'gui/server/index.js')], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      PATH: '', HOME: dir,
      CROWDSIM_BIN: fake,
      CROWDSIM_PROFILES: path.join(dir, 'profiles'),
      CROWDSIM_OUT: path.join(dir, 'out'),
      CROWDSIM_GUI_BIND: '203.0.113.10',
      CROWDSIM_GUI_TOKEN: 't',
      CROWDSIM_GUI_PORT: '18999',
    },
  });
  // It got past the driver check (that is the point) and died on the address instead.
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot bind 203\.0\.113\.10/);
  assert.ok(!/cannot find the crowdsim driver/.test(r.stderr));
});
