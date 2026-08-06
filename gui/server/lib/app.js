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
import { validateProfile } from '../../../lib/validate.mjs';
import { buildLoadArgs, buildProbeArgs, buildDiscoverArgs, InvalidRun, SHAPES, RSC_MODES } from './args.js';
import { commandLine } from './command.js';
import { readHistory, readSummary, readRunLog, comparable, readProbe, readDiscover } from './history.js';
import { Runner, Busy } from './runner.js';

export function createApp(opts) {
  const o = opts || {};
  const profilesDir = o.profilesDir;
  const outDir = o.outDir;
  const uiDir = o.uiDir || null;
  const token = o.token || null;
  const runner = o.runner || new Runner({ bin: o.crowdsimBin, outDir, env: o.env });

  fs.mkdirSync(outDir, { recursive: true });

  // Before serving anything: is a generator from a previous life of this server still running? If so it is
  // adopted, which also means the one-run-at-a-time rule survives a restart — otherwise the first click
  // after a rebuild would start a second generator against a target already under load.
  if (o.adopt !== false) runner.adopt();

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
  //
  // One function resolves a request into an argv, and both the preview and the launch go through it. If the
  // preview were assembled separately — in the UI, or by a second builder here — it would be a description
  // of what the server probably does, and the first time the two drifted the preview would be a lie told at
  // exactly the wrong moment.
  const resolveArgv = (body, opts) => {
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
    const argv = kind === 'load' ? buildLoadArgs(body, full, name, opts)
      : kind === 'probe' ? buildProbeArgs(body, full)
        : buildDiscoverArgs(body, full);
    return { kind, argv, profileName: name };
  };

  app.post('/api/runs', wrap((req, res) => {
    const body = req.body || {};
    // No preview option here: the typed confirmation is enforced on the path that actually spawns.
    const { kind, argv } = resolveArgv(body);
    res.status(201).json(runner.start({ kind, argv, request: redact(body) }));
  }));

  // The command the operator is about to authorise. Spawns nothing, writes nothing, and is allowed to
  // render the override flag while it is still being armed — reading it is the point.
  app.post('/api/preview', wrap((req, res) => {
    const body = req.body || {};
    const { kind, argv } = resolveArgv(body, { preview: true });
    const env = {};
    if (process.env.CROWDSIM_ALLOW_TARGETS) env.CROWDSIM_ALLOW_TARGETS = process.env.CROWDSIM_ALLOW_TARGETS;
    res.json({
      kind,
      argv,
      command: commandLine(argv, { bin: 'crowdsim', env }),
      env,
      // Stated rather than implied: the preview shows the flag as armed, the launch still asks for the
      // profile name to be typed.
      needs_confirmation: Boolean(body.force),
    });
  }));

  app.get('/api/runs', wrap((req, res) => res.json({ runs: runner.list(), active: runner.active() ? runner.get(runner.active().id) : null })));

  app.get('/api/runs/:id', wrap((req, res) => {
    const run = runner.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'no such run' });
    const summary = run.run_id ? readSummary(outDir, run.run_id) : null;
    // The preflight artefacts, when the driver wrote them. `probe` and `discover` answer questions that
    // decide whether a load run is worth doing at all, and they are data on disk — not something the page
    // should be reconstructing out of terminal output.
    const artifacts = run.run_id ? {
      probe: run.kind === 'probe' ? readProbe(outDir, run.run_id) : null,
      discover: run.kind === 'discover' ? readDiscover(outDir, run.run_id) : null,
    } : { probe: null, discover: null };
    res.json(Object.assign({}, run, { log: runner.logOf(req.params.id), summary, artifacts }));
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

    // Everything this server has for the run, as ONE snapshot event. A client that reconnects already has
    // lines: replaying them as individual `line` events gives it no way to tell a replay from new output,
    // and the log doubles on every reconnect. A snapshot replaces.
    const existing = runner.logOf(id) || [];
    send('snapshot', { lines: existing });
    let sent = existing.length;
    const onLine = (e) => { if (e.id === id) { send('line', { line: e.line }); sent++; } };
    const onEnd = (e) => { if (e.id === id) { send('end', e); res.end(); } };
    runner.on('line', onLine);
    runner.on('end', onEnd);

    // An adopted run produces no 'line' events here: this server is not the parent of that process, so its
    // output never passes through. Follow the driver's log file instead — same lines, one hop later.
    let follow = null;
    if (run.adopted && run.status === 'running') {
      follow = setInterval(() => {
        const lines = runner.logOf(id) || [];
        for (let i = sent; i < lines.length; i++) send('line', { line: lines[i] });
        if (lines.length > sent) sent = lines.length;
      }, 1000);
      if (follow.unref) follow.unref();
    }

    if (run.status !== 'running') { send('end', run); res.end(); }
    req.on('close', () => {
      runner.off('line', onLine);
      runner.off('end', onEnd);
      if (follow) clearInterval(follow);
    });
  });

  // ── history (written by the driver, read-only here) ────────────────────────────────────────────────
  app.get('/api/history', wrap((req, res) => res.json({ runs: readHistory(outDir) })));

  // Two runs compared, by asking the CLI rather than by re-deciding here.
  //
  // `crowdsim compare --json` computes the verdict and the refusals once, and this endpoint hands the
  // result through. The alternative — a second copy of "are these two runs comparable" living in the
  // server — would be the one on screen the day the two disagree, and it would be wrong exactly when it
  // matters: a delta between two different experiments looks like an answer.
  //
  // A refusal keeps the CLI's exit code meaning: 422, with the reasons, not an empty 200.
  app.get('/api/compare', wrap((req, res) => {
    const RUN_ID = /^\d{8}T\d{6}Z$/;
    const a = String(req.query.a || '');
    const b = String(req.query.b || '');
    if (!RUN_ID.test(a) || !RUN_ID.test(b)) {
      throw new InvalidRun('run', 'a and b must both be run ids, as printed by crowdsim history');
    }
    const r = spawnSync(o.crowdsimBin, ['compare', a, b, '--json'], {
      encoding: 'utf8',
      timeout: 15000,
      env: Object.assign({}, process.env, o.env || {}, { CROWDSIM_OUT: outDir }),
    });
    if (r.error) throw Object.assign(new Error(`could not run the comparison: ${r.error.message}`), { status: 500 });
    let body;
    try {
      body = JSON.parse(r.stdout);
    } catch (e) {
      throw Object.assign(new Error(`the comparison produced no usable output: ${(r.stderr || '').trim() || r.stdout}`),
        { status: 500 });
    }
    if (body.error) return res.status(404).json(body);
    // Exit 2 with a `refused` list is the CLI saying these two runs are not the same experiment.
    return res.status(body.refused && body.refused.length ? 422 : 200).json(body);
  }));

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
