/*
 * app.js — the HTTP API behind the GUI.
 *
 * What this server is: a form over `bin/crowdsim`. Every run is a child process of the same CLI, with the
 * same gates, writing the same out/ directory. What it is NOT: a second implementation of the safety
 * rules, a scheduler, or a store of results.
 *
 * Two consequences worth stating, because they are what makes a load-generating web UI defensible:
 *  · the CLI's exit codes are passed through, not translated — a refusal (3) looks like a refusal;
 *  · binding anywhere other than loopback requires a token (enforced in index.js), because a page that
 *    can generate 500 req/s against your production is not a page to leave open on a shared network.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listProfiles, readProfile, writeProfile, deleteProfile, profilePath, BadProfile } from './profiles.js';
import { validateProfile } from './validate.js';
import { buildLoadArgs, buildProbeArgs, buildDiscoverArgs, InvalidRun, SHAPES, RSC_MODES } from './args.js';
import { readHistory, readSummary, readRunLog, comparable } from './history.js';
import { Runner, Busy } from './runner.js';

export function createApp(opts) {
  const o = opts || {};
  const profilesDir = o.profilesDir;
  const outDir = o.outDir;
  const uiDir = o.uiDir || null;
  const token = o.token || null;
  const runner = o.runner || new Runner({ bin: o.crowdsimBin, outDir, env: o.env });

  fs.mkdirSync(outDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // A token is only required when the server was told to listen off-loopback. When it is required it
  // applies to every API route, including the read-only ones: the profile list is a map of your estate.
  app.use('/api', (req, res, next) => {
    if (!token) return next();
    const auth = String(req.headers.authorization || '');
    if (auth === `Bearer ${token}`) return next();
    // EventSource cannot set headers, so the live-log stream — and only it — also accepts the token as a
    // query parameter. It is read-only: nothing can be started or changed through this path.
    if (req.path.endsWith('/stream') && req.method === 'GET' && String(req.query.token || '') === token) return next();
    return res.status(401).json({ error: 'unauthorized' });
  });

  const wrap = (fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      const body = { error: e.message, name: e.name };
      if (e.field) body.field = e.field;
      if (e.validation) body.validation = e.validation;
      if (e.active) body.active = e.active;
      res.status(status).json(body);
    }
  };

  // ── environment ───────────────────────────────────────────────────────────────────────────────────
  app.get('/api/env', wrap((req, res) => {
    let k6 = null;
    try {
      const r = spawnSync('k6', ['version'], { encoding: 'utf8', timeout: 5000 });
      if (!r.error && r.status === 0) k6 = String(r.stdout || '').trim().split('\n')[0];
    } catch (e) { /* k6 absent: reported as null, the CLI will exit 5 and say what to install */ }
    res.json({
      version: o.version || null,
      k6,
      profiles_dir: profilesDir,
      out_dir: outDir,
      // The allowlist is configuration, not a secret — showing it is how you notice it is wrong.
      allow_targets: process.env.CROWDSIM_ALLOW_TARGETS || null,
      // The webhook IS a secret: only ever report whether one is configured.
      slack_configured: Boolean(process.env.CROWDSIM_SLACK_WEBHOOK),
      shapes: SHAPES,
      rsc_modes: RSC_MODES,
      ui: Boolean(uiDir),
    });
  }));

  // ── profiles ──────────────────────────────────────────────────────────────────────────────────────
  app.get('/api/profiles', wrap((req, res) => res.json({ profiles: listProfiles(profilesDir) })));

  app.get('/api/profiles/:name', wrap((req, res) => res.json(readProfile(profilesDir, req.params.name))));

  app.put('/api/profiles/:name', wrap((req, res) => {
    const raw = typeof req.body.raw === 'string' ? req.body.raw : JSON.stringify(req.body.profile, null, 2);
    res.json(writeProfile(profilesDir, req.params.name, raw, { force: Boolean(req.body.force) }));
  }));

  app.delete('/api/profiles/:name', wrap((req, res) => res.json(deleteProfile(profilesDir, req.params.name))));

  // Live validation for the editor: no write, no side effect.
  app.post('/api/validate', wrap((req, res) => {
    const raw = typeof req.body.raw === 'string' ? req.body.raw : JSON.stringify(req.body.profile || {});
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      return res.json({ ok: false, parse_error: e.message, errors: [], warnings: [], summary: null });
    }
    res.json(validateProfile(parsed));
  }));

  // ── runs ──────────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/runs', wrap((req, res) => {
    const body = req.body || {};
    const kind = body.kind || 'load';
    if (['load', 'probe', 'discover'].indexOf(kind) === -1) {
      throw new InvalidRun('kind', 'kind must be load, probe or discover');
    }
    const full = profilePath(profilesDir, body.profile);
    if (!fs.existsSync(full)) throw new BadProfile(`no such profile: ${body.profile}`, 404);
    const read = readProfile(profilesDir, body.profile);
    if (read.parse_error) throw new BadProfile(`profile does not parse: ${read.parse_error}`);
    if (!read.validation.ok) {
      const e = new BadProfile('profile has errors: fix them before running', 422);
      e.validation = read.validation;
      throw e;
    }
    const name = (read.parsed && read.parsed.name) || body.profile;
    const argv = kind === 'load' ? buildLoadArgs(body, full, name)
      : kind === 'probe' ? buildProbeArgs(body, full)
        : buildDiscoverArgs(body, full);
    res.status(201).json(runner.start({ kind, argv, request: redact(body) }));
  }));

  app.get('/api/runs', wrap((req, res) => res.json({ runs: runner.list(), active: runner.active() ? runner.get(runner.active().id) : null })));

  app.get('/api/runs/:id', wrap((req, res) => {
    const run = runner.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'no such run' });
    const summary = run.run_id ? readSummary(outDir, run.run_id) : null;
    res.json(Object.assign({}, run, { log: runner.logOf(req.params.id), summary }));
  }));

  app.post('/api/runs/:id/stop', wrap((req, res) => {
    const run = runner.stop(req.params.id);
    if (!run) return res.status(404).json({ error: 'no such run' });
    res.json(run);
  }));

  // Live log. SSE and not WebSocket on purpose: one direction, one message type, no extra dependency,
  // and it survives a reverse proxy that only knows about HTTP.
  app.get('/api/runs/:id/stream', (req, res) => {
    const id = req.params.id;
    const run = runner.get(id);
    if (!run) return res.status(404).json({ error: 'no such run' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const line of runner.logOf(id) || []) send('line', { line });
    const onLine = (e) => { if (e.id === id) send('line', { line: e.line }); };
    const onEnd = (e) => { if (e.id === id) { send('end', e); res.end(); } };
    runner.on('line', onLine);
    runner.on('end', onEnd);
    if (run.status !== 'running') { send('end', run); res.end(); }
    req.on('close', () => { runner.off('line', onLine); runner.off('end', onEnd); });
  });

  // ── history (written by the driver, read-only here) ────────────────────────────────────────────────
  app.get('/api/history', wrap((req, res) => res.json({ runs: readHistory(outDir) })));

  app.get('/api/history/:runId', wrap((req, res) => {
    const summary = readSummary(outDir, req.params.runId);
    if (!summary) return res.status(404).json({ error: 'no summary for that run id' });
    const rows = readHistory(outDir);
    const row = rows.find((r) => r.run_id === req.params.runId) || null;
    res.json({ summary, row, comparable: comparable(rows, row), log: readRunLog(outDir, req.params.runId) });
  }));

  // ── UI ────────────────────────────────────────────────────────────────────────────────────────────
  if (uiDir && fs.existsSync(uiDir)) {
    app.use(express.static(uiDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(uiDir, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => res.status(503).type('text/plain').send(
      'The UI has not been built yet. Run: npm run gui:build (or make gui)\n' +
      'The API is up: try /api/env\n'));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: `no such endpoint: ${req.path}` }));

  app.runner = runner;
  return app;
}

/** Never echo the confirmation phrase back into a stored request record. */
function redact(body) {
  const out = Object.assign({}, body);
  delete out.confirm;
  return out;
}
