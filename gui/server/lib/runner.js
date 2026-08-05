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
 *  · A run outlives this process. The server can be restarted, rebuilt or crash while k6 keeps generating
 *    traffic; the page must then say "a generator is running" rather than show an empty list. One line of
 *    state goes to out/gui-run.json and is adopted on startup — enough to find the process, stop it, and
 *    follow the driver's own log file. Still no results of the GUI's own: those stay in out/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_LOG_LINES = 4000;
const SIGKILL_AFTER_MS = 10000;
const ADOPT_POLL_MS = 1000;
const STATE_FILE = 'gui-run.json';

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
    this.aliveFn = o.aliveFn || defaultAlive;
    this.signalFn = o.signalFn || defaultSignal;
    this.statePath = o.statePath || (this.outDir ? path.join(this.outDir, STATE_FILE) : null);
    this.runs = new Map();
    this.order = [];
    this.seq = 0;
    this.pollTimers = new Map();
  }

  /**
   * Pick up a run this process did not start. Called once at startup.
   *
   * Measured behaviour, because the answer is not what it looks like: kill this server and the generator
   * normally dies with it, within about two seconds. The driver's stdout is a pipe to this process, so when
   * the read end goes away the next write fails and `set -eo pipefail` takes the run down. That is a
   * fail-safe worth keeping — a load generator whose supervisor is gone is exactly the thing nobody can see
   * and nobody can stop — so the child is deliberately NOT detached.
   *
   * Two outcomes, then, and both are better than the empty page this used to show:
   *  · the pid is alive (it can happen: a supervisor that restarts only this process, a wrapper that
   *    re-parents the child) → adopt it, so it is visible, stoppable, and still counts for
   *    one-run-at-a-time;
   *  · the pid is gone → the run is over, and the page says so and points at the archive, instead of
   *    silently dropping a run that was interrupted mid-flight.
   *
   * Deliberately conservative about the pid: a pid can be reused by an unrelated process, so an adopted run
   * is labelled as adopted everywhere and its exit code is reported as unknown rather than invented.
   */
  adopt() {
    const state = this.readState();
    if (!state || !state.pid || state.status !== 'running') return null;
    if (!this.aliveFn(state.pid)) return this.adoptEnded(state);
    const run = {
      id: state.id,
      kind: state.kind,
      argv: state.argv || [],
      request: state.request || null,
      status: 'running',
      exitCode: null,
      startedAt: state.started_at || null,
      endedAt: null,
      runId: state.run_id || null,
      summaryPath: state.summary_path || null,
      log: [],
      child: null,
      pid: state.pid,
      adopted: true,
      stopping: false,
    };
    this.runs.set(run.id, run);
    this.order.push(run.id);
    this.append(run,
      `reattached after a server restart: pid ${state.pid} is still running. This server did not start it, ` +
      'so the live stream below is the driver\'s own run log file and the exit code will not be known here.');
    this.watch(run);
    this.emit('start', this.public(run));
    return this.public(run);
  }

  /**
   * The run recorded in the state file is over — this server was not here when it ended. Show it as ended
   * and interrupted rather than deleting the evidence: "the previous server died during this run, and the
   * generator went with it" is the sentence the operator needs, and out/ has the log and any summary.
   */
  adoptEnded(state) {
    const run = {
      id: state.id,
      kind: state.kind,
      argv: state.argv || [],
      request: state.request || null,
      status: 'ended',
      exitCode: null,
      startedAt: state.started_at || null,
      endedAt: null,
      runId: state.run_id || null,
      summaryPath: state.summary_path || null,
      log: [],
      child: null,
      pid: state.pid,
      adopted: true,
      interrupted: true,
      stopping: false,
    };
    this.runs.set(run.id, run);
    this.order.push(run.id);
    this.append(run,
      `this run was started by an earlier life of this server, which stopped while it was in flight. ` +
      `pid ${state.pid} is gone, so the generator stopped too — that is by design: the driver's output is a ` +
      'pipe to the server, and a generator nobody supervises is one nobody can stop. What was written before ' +
      'the interruption is in the output directory; the exit code is not knowable from here.');
    this.clearState();
    return this.public(run);
  }

  /** Poll an adopted run, since there is no child handle to emit 'close'. */
  watch(run) {
    const timer = setInterval(() => {
      if (run.status !== 'running') return;
      if (this.aliveFn(run.pid)) return;
      this.append(run, `pid ${run.pid} is gone: the run ended. Read the summary in the output directory — ` +
                       'an adopted run cannot report its exit code.');
      this.finish(run, null, 'ended');
    }, ADOPT_POLL_MS);
    if (timer.unref) timer.unref();
    this.pollTimers.set(run.id, timer);
  }

  /** Everything needed to find the run again, and nothing else. */
  writeState(run) {
    if (!this.statePath) return;
    const state = {
      id: run.id, kind: run.kind, pid: run.pid || null, status: run.status,
      argv: run.argv, request: run.request, started_at: run.startedAt,
      run_id: run.runId, summary_path: run.summaryPath,
    };
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 1));
    } catch (e) { /* the archive in out/ is the record; losing this file costs adoption, not data */ }
  }

  readState() {
    if (!this.statePath) return null;
    try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch (e) { return null; }
  }

  clearState() {
    if (!this.statePath) return;
    try { fs.rmSync(this.statePath, { force: true }); } catch (e) { /* nothing to clear */ }
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

  /**
   * The lines this server captured. For an adopted run there are none — the output went to the process this
   * server is not the parent of — so the driver's own run log file is read instead. That file is the same
   * one the CLI writes, which is the point: the GUI never keeps a second copy of a result.
   */
  logOf(id) {
    const r = this.runs.get(id);
    if (!r) return null;
    if (!r.adopted || !r.runId || !this.outDir) return r.log;
    const prefix = r.kind === 'probe' ? 'probe' : 'load';
    let file;
    try {
      file = fs.readFileSync(path.join(this.outDir, `${prefix}-${r.runId}.log`), 'utf8');
    } catch (e) {
      return r.log.concat([`the driver's log file for ${r.runId} is not readable from here yet`]);
    }
    return r.log.concat(file.split('\n').filter((l) => l !== ''));
  }

  public(r) {
    if (!r) return null;
    return {
      id: r.id, kind: r.kind, status: r.status, exit_code: r.exitCode,
      started_at: r.startedAt, ended_at: r.endedAt,
      run_id: r.runId, summary_path: r.summaryPath,
      argv: r.argv, request: r.request, lines: r.log.length,
      pid: r.pid || null, adopted: Boolean(r.adopted), interrupted: Boolean(r.interrupted),
      stop_error: r.stopError || null,
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
      pid: null,
      adopted: false,
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
    run.pid = child && child.pid ? child.pid : null;
    this.writeState(run);

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

      // The driver prints the run id and the summary path; the GUI needs both to show the result. They are
      // also written to the state file as soon as they are known: after a restart the run id is the only way
      // back to the driver's log and summary for a process this server did not start.
      if (!run.runId) {
        // Two shapes, because two subcommands announce it differently: `load` prints it alone on a line
        // ("  run       20260805T101112Z") and `probe` prints it inline ("run: 20260805T101112Z  base: …").
        // Matching only the first meant a probe run had no run id here, and therefore no way back to
        // out/probe-<run_id>.json — the file with the actual answer in it.
        const m = /\brun[:\s]\s*(\d{8}T\d{6}Z)\b/.exec(line);
        if (m) { run.runId = m[1]; this.writeState(run); }
      }
      const s = /summary:\s+(\S+)/.exec(line);
      if (s && s[1] !== run.summaryPath) { run.summaryPath = s[1]; this.writeState(run); }
    }
  }

  finish(run, code, status, signal) {
    if (run.status !== 'running') return;
    run.status = status;
    run.exitCode = code;
    run.signal = signal || null;
    run.endedAt = new Date().toISOString();
    run.child = null;
    const timer = this.pollTimers.get(run.id);
    if (timer) { clearInterval(timer); this.pollTimers.delete(run.id); }
    // Nothing is in flight any more, so a later restart must not claim there is.
    const state = this.readState();
    if (!state || state.id === run.id) this.clearState();
    this.emit('end', this.public(run));
  }

  /** Graceful stop: SIGINT so k6 still writes the summary, SIGKILL only if it refuses to go. */
  stop(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    if (run.status !== 'running') return this.public(run);

    // An adopted run has no child handle — this process is not its parent. Signalling by pid still works,
    // and when it does not (a pid that now belongs to someone else, a run started by another user) the
    // honest answer is to say so and give the command, not to report a stop that did not happen.
    if (!run.child) {
      if (!run.pid) {
        run.stopError = 'this run was adopted after a restart and its pid is unknown: stop it from the host';
        this.append(run, run.stopError);
        return this.public(run);
      }
      run.stopping = true;
      this.append(run, `stop requested on adopted pid ${run.pid}: SIGINT sent`);
      try {
        this.signalFn(run.pid, 'SIGINT');
      } catch (e) {
        run.stopping = false;
        run.stopError = `could not signal pid ${run.pid} (${e.code || e.message}). Stop it by hand: ` +
                        `kill -INT ${run.pid}`;
        this.append(run, run.stopError);
      }
      return this.public(run);
    }

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

/** Signal 0 asks "does this pid exist and may I signal it", without delivering anything. */
function defaultAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to somebody else — still running, still worth reporting.
    return e.code === 'EPERM';
  }
}

function defaultSignal(pid, signal) {
  process.kill(pid, signal);
}
