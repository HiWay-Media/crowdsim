/*
 * runner.js — supervising crowdsim processes on behalf of the GUI.
 *
 * Design constraints that are not negotiable, and that the tests pin down:
 *
 *  · ONE run at a time. A GUI makes it trivial to click Run twice; two generators against the same
 *    target produce twice the load nobody agreed to, and a pair of results that are both invalid.
 *  · No shell. The command is an argv array built by args.js and spawned directly, so nothing typed in
 *    a form is ever interpreted.
 *  · Stop means SIGINT, not SIGKILL. k6 shuts a run down gracefully on SIGINT and still writes the
 *    summary — a killed run is a window burned for no data. SIGKILL only as a last resort.
 *  · The log is bounded. A long run at high rate produces a lot of lines, and the server must not grow
 *    without limit; it says so in the log itself instead of silently dropping the beginning.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_LOG_LINES = 4000;
const SIGKILL_AFTER_MS = 10000;

export class Busy extends Error {
  constructor(active) {
    super(`a run is already in progress (${active.kind} ${active.id}) — stop it first`);
    this.name = 'Busy';
    this.status = 409;
    this.active = active;
  }
}

export class Runner extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.bin = o.bin;
    this.outDir = o.outDir;
    this.env = o.env || {};
    this.spawnFn = o.spawnFn || spawn;
    this.runs = new Map();
    this.order = [];
    this.seq = 0;
  }

  active() {
    for (const id of this.order) {
      const r = this.runs.get(id);
      if (r && r.status === 'running') return r;
    }
    return null;
  }

  list() {
    return this.order.map((id) => this.public(this.runs.get(id))).reverse();
  }

  get(id) {
    const r = this.runs.get(id);
    return r ? this.public(r) : null;
  }

  logOf(id) {
    const r = this.runs.get(id);
    return r ? r.log : null;
  }

  public(r) {
    if (!r) return null;
    return {
      id: r.id, kind: r.kind, status: r.status, exit_code: r.exitCode,
      started_at: r.startedAt, ended_at: r.endedAt,
      run_id: r.runId, summary_path: r.summaryPath,
      argv: r.argv, request: r.request, lines: r.log.length,
    };
  }

  start(spec) {
    const busy = this.active();
    if (busy) throw new Busy(this.public(busy));

    const id = `r${++this.seq}-${Date.now().toString(36)}`;
    const run = {
      id,
      kind: spec.kind,
      argv: spec.argv,
      request: spec.request || null,
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      runId: null,
      summaryPath: null,
      log: [],
      child: null,
      stopping: false,
    };
    this.runs.set(id, run);
    this.order.push(id);

    const child = this.spawnFn(this.bin, spec.argv, {
      cwd: spec.cwd,
      env: Object.assign({}, process.env, this.env, { CROWDSIM_OUT: this.outDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.child = child;

    const onData = (chunk) => this.append(run, String(chunk));
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);

    child.on('error', (e) => {
      this.append(run, `\ncrowdsim could not be started: ${e.message}\n`);
      this.finish(run, null, 'failed');
    });
    child.on('close', (code, signal) => {
      // The brake tripping is an outcome, and the driver already exits 0 for it. A non-zero code here is
      // a refusal (a gate) or a real error, and the UI shows the exit code because it is meaningful:
      // 2 usage · 3 safety gate · 4 target unreachable · 5 k6 missing.
      const status = run.stopping ? 'stopped' : (code === 0 ? 'done' : 'failed');
      this.finish(run, code === null ? null : code, status, signal);
    });

    this.emit('start', this.public(run));
    return this.public(run);
  }

  append(run, text) {
    for (const line of text.split('\n')) {
      if (line === '' ) continue;
      if (run.log.length === MAX_LOG_LINES) {
        run.log.push('… log truncated: this run produced more output than the GUI keeps in memory. ' +
                     'The full log is in the run log file under the output directory.');
      }
      if (run.log.length > MAX_LOG_LINES) break;
      run.log.push(line);
      this.emit('line', { id: run.id, line });

      // The driver prints the run id and the summary path; the GUI needs both to show the result.
      if (!run.runId) {
        const m = /^\s*run\s+(\d{8}T\d{6}Z)\s*$/.exec(line);
        if (m) run.runId = m[1];
      }
      const s = /summary:\s+(\S+)/.exec(line);
      if (s) run.summaryPath = s[1];
    }
  }

  finish(run, code, status, signal) {
    if (run.status !== 'running') return;
    run.status = status;
    run.exitCode = code;
    run.signal = signal || null;
    run.endedAt = new Date().toISOString();
    run.child = null;
    this.emit('end', this.public(run));
  }

  /** Graceful stop: SIGINT so k6 still writes the summary, SIGKILL only if it refuses to go. */
  stop(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    if (run.status !== 'running' || !run.child) return this.public(run);
    run.stopping = true;
    this.append(run, 'stop requested: SIGINT sent, letting the generator wind down and write its summary');
    try { run.child.kill('SIGINT'); } catch (e) { /* already gone */ }
    const child = run.child;
    const timer = setTimeout(() => {
      if (run.status === 'running') {
        this.append(run, 'the generator did not stop within 10s: sending SIGKILL (the summary will be lost)');
        try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      }
    }, SIGKILL_AFTER_MS);
    if (timer.unref) timer.unref();
    return this.public(run);
  }
}
