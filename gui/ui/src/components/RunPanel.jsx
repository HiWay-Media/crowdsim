import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, streamRun } from '../api.js';
import MixBars from './MixBars.jsx';
import SummaryCard from './SummaryCard.jsx';
import CommandPreview from './CommandPreview.jsx';
import { ProbeTable, DiscoverTable } from './PreflightTables.jsx';
import HostPanel from './HostPanel.jsx';
import { runToShow, shouldClearResult } from '../lib/runs.js';
import { allowlistVerdict } from '../lib/allowlist.js';
import { SAFE_PEAK, WARMUP } from '../lib/messages.js';
import { warmupRate, pastSafeCeiling } from '../lib/warmup.js';
import { LineBuffer } from '../lib/logbuffer.js';
import { streamState, describeStream } from '../lib/stream.js';

/*
 * The run launcher. Everything expensive to get wrong is shown BEFORE the button: which host will be hit,
 * whether it is allowlisted, the safe ceiling, and what the requested peak means per class. The
 * production override is a separate block that has to be filled in by hand, per run.
 */

const DEFAULTS = {
  peak: 60, start: 15, steps: 4, stepDur: '60s', hold: '120s',
  shape: 'mix', rscMode: 'repeat', maxP95: '', max5xx: '', skipClasses: '',
  // Off by default, like the CLI: a warm-up doubles the load a run puts on a target, and that is a choice
  // to make rather than a default to discover afterwards.
  warmup: '', warmupPeak: '',
  touchAndGo: false, insecure: false, slack: false,
};

export default function RunPanel({ env, profiles, onActiveRun }) {
  const [profileName, setProfileName] = useState('');
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState(DEFAULTS);
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState('');
  const [force, setForce] = useState(false);
  const [run, setRun] = useState(null);
  const [log, setLog] = useState([]);
  // Lines accumulate in a buffer and are published on a timer. Joining the log on every appended line cost
  // 760 MB of strings and 215 ms over the 4000 the server keeps — spent on the machine generating the load.
  const bufRef = useRef(new LineBuffer());
  const [stream, setStream] = useState(streamState({ phase: 'ended', attempts: 0 }));
  const [error, setError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [artifacts, setArtifacts] = useState(null);
  const logRef = useRef(null);

  const usable = profiles.filter((p) => p.ok);
  useEffect(() => {
    if (!profileName && usable.length) setProfileName(usable[0].name);
  }, [usable, profileName]);

  useEffect(() => {
    if (!profileName) return;
    let alive = true;
    api.profile(profileName).then((p) => {
      if (!alive) return;
      setProfile(p);
      const s = p.validation ? p.validation.summary : null;
      setTarget((s && s.default_target) || (s && s.targets[0] && s.targets[0].name) || '');
      // Switching profile must disarm the override — it is granted for one run against one profile. The
      // last result is NOT cleared here: this effect also runs on first load, where it would wipe the run
      // just restored from the server and leave the page looking like nothing had ever happened.
      setForce(false);
      setConfirm('');
    }).catch((e) => setError(e.message));
    return () => { alive = false; };
  }, [profileName]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // One render per tick, not one per line. The tick is short enough to read as live and long enough that a
  // few hundred req/s of output does not become the busiest thing on this machine.
  useEffect(() => {
    const t = setInterval(() => {
      const lines = bufRef.current.flush();
      if (lines.length) setLog(lines.slice());
    }, 200);
    return () => clearInterval(t);
  }, []);

  // What this page shows on load is what the server says is going on — not an empty form.
  //
  // Two cases, and neither used to be handled. A generator may still be RUNNING that this page did not
  // start: the server keeps one line of state in out/ and adopts it after a restart, so a rebuilt server
  // must not show an idle form while a target is under load (the operator's next click would come back as
  // a 409 they cannot explain). And a run may have FINISHED: reloading the tab used to throw away the log,
  // the summary and the preflight tables, which are all still on the server.
  useEffect(() => {
    let alive = true;
    api.runs().then(async (r) => {
      const { run: last, follow } = runToShow(r);
      if (!alive || !last) return;
      setRun(last);
      try {
        const full = await api.run(last.id);
        if (!alive) return;
        setLog(full.log || []);
        setSummary(full.summary || null);
        setArtifacts(full.artifacts || null);
      } catch (e) { /* the run record is enough */ }
      if (!follow) return;
      onActiveRun(r.active);
      follow_(r.active.id);
    }).catch(() => { /* an empty run list is the normal case */ });
    return () => { alive = false; };
  }, []);

  const sum = profile && profile.validation ? profile.validation.summary : null;
  const chosen = sum ? sum.targets.find((t) => t.name === target) : null;
  const safePeak = sum ? sum.safe_peak_rps : null;
  // A warm-up is load, so the ceiling applies to it too: the driver re-runs the same gate with the warm-up
  // rate in place of the peak, and a page that only looked at the peak would show "within the ceiling" and
  // then hand back an exit 3 nobody could explain.
  const ceiling = pastSafeCeiling(form, safePeak);
  const pastSafe = ceiling.past;
  const warmRate = warmupRate(form);

  const host = useMemo(() => {
    if (!chosen || !chosen.base_url) return null;
    try { return new URL(chosen.base_url).hostname; } catch (e) { return null; }
  }, [chosen]);

  // CROWDSIM_ALLOW_TARGETS overrides the profile's list, exactly as it does in the driver.
  const verdict = useMemo(() => {
    const patterns = env && env.allow_targets
      ? env.allow_targets.split(',')
      : ((sum && sum.allow_hosts) || []);
    return allowlistVerdict(host, patterns);
  }, [host, env, sum]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  // One body, two destinations: the preview endpoint and the launch endpoint. Building it twice is how a
  // preview starts describing a different run from the one that happens.
  const buildBody = (kind, extra) => ({
    kind,
    profile: profileName,
    target: target || undefined,
    ...(kind === 'load' ? {
      peak: Number(form.peak),
      start: form.start === '' ? undefined : Number(form.start),
      steps: form.steps === '' ? undefined : Number(form.steps),
      stepDur: form.stepDur || undefined,
      hold: form.hold === '' ? undefined : form.hold,
      shape: form.shape,
      rscMode: form.rscMode,
      maxP95: form.maxP95 === '' ? undefined : Number(form.maxP95),
      max5xx: form.max5xx === '' ? undefined : Number(form.max5xx),
      skipClasses: form.skipClasses || undefined,
      warmup: form.warmup === '' ? undefined : form.warmup,
      warmupPeak: form.warmupPeak === '' ? undefined : Number(form.warmupPeak),
      touchAndGo: form.touchAndGo,
      insecure: form.insecure,
      slack: form.slack,
      force,
      confirm: force ? confirm : undefined,
    } : {}),
    ...(extra || {}),
  });

  // The preview never carries the typed phrase: it is not needed to read the line, and echoing it back on
  // every keystroke would put it in a request log for no reason.
  const previewBody = useMemo(() => {
    const b = buildBody('load');
    delete b.confirm;
    return b;
  }, [profileName, target, form, force]);

  // Attaching to a run's live log. A reconnect arrives as a snapshot and REPLACES what is on screen: the
  // server sends everything it has, and appending that would show every line twice.
  function follow_(id) {
    bufRef.current = new LineBuffer();
    setLog([]);
    streamRun(id, {
      onSnapshot: (lines) => { bufRef.current.snapshot(lines); setLog(bufRef.current.flush().slice()); },
      onLine: (line) => bufRef.current.push(line),
      onState: (st) => setStream(streamState(st)),
      onEnd: async (ended) => {
        setLog(bufRef.current.flush().slice());
        setRun(ended);
        onActiveRun(null);
        try {
          const full = await api.run(ended.id);
          setSummary(full.summary || null);
          setArtifacts(full.artifacts || null);
        } catch (e) { /* the run record is enough */ }
      },
    });
  }

  async function launch(kind, extra) {
    setError(null);
    setLog([]);
    if (shouldClearResult({ reason: 'run-started' })) {
      setSummary(null);
      setArtifacts(null);
    }
    try {
      const body = buildBody(kind, extra);
      const started = await api.startRun(body);
      setRun(started);
      onActiveRun(started);
      follow_(started.id);
    } catch (e) {
      onActiveRun(null);
      if (e instanceof ApiError && e.active) setError(`${e.message}`);
      else setError(e.field ? `${e.field}: ${e.message}` : e.message);
    }
  }

  const busy = run && run.status === 'running';

  return (
    <div className="grid">
      <section className="card">
        <h2>Target</h2>
        <div className="row">
          <label>
            Profile
            <select
              value={profileName}
              onChange={(e) => {
                // A result belongs to the profile it came from: keeping it on screen next to a different
                // profile's form is how somebody reads last week's number as today's.
                if (shouldClearResult({ reason: 'profile-selected', from: profileName, to: e.target.value })) {
                  setSummary(null);
                  setArtifacts(null);
                }
                setProfileName(e.target.value);
              }}
            >
              {usable.map((p) => <option key={p.name} value={p.name}>{p.name}{p.title ? ` — ${p.title}` : ''}</option>)}
            </select>
          </label>
          <label>
            Target
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {(sum ? sum.targets : []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </label>
        </div>

        {chosen ? (
          <table className="kv">
            <tbody>
              <tr><th>base url</th><td className="mono">{chosen.base_url}</td></tr>
              {chosen.host_header ? <tr><th>Host header</th><td className="mono">{chosen.host_header}</td></tr> : null}
              {chosen.bypass ? <tr><th>bypass</th><td className="mono">{chosen.bypass}<span className="note"> CDN skipped, SNI and Host kept</span></td></tr> : null}
              {chosen.skip_classes ? <tr><th>skips</th><td className="mono">{chosen.skip_classes}</td></tr> : null}
              <tr>
                <th>allowlist</th>
                <td>
                  <span className={verdict.state === 'authorised' ? 'ok' : verdict.state === 'refused' ? 'bad' : 'note'}>
                    {verdict.text}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        ) : null}
      </section>

      <section className="card">
        <h2>Rate</h2>
        <div className="row">
          <label>Peak (total user req/s)<input type="number" min="1" value={form.peak} onChange={set('peak')} /></label>
          <label>Start<input type="number" min="1" value={form.start} onChange={set('start')} /></label>
          <label>Steps<input type="number" min="1" max="50" value={form.steps} onChange={set('steps')} /></label>
          <label>Step duration<input value={form.stepDur} onChange={set('stepDur')} /></label>
          <label>Hold<input value={form.hold} onChange={set('hold')} /></label>
        </div>
        <div className="row">
          <label>Shape
            <select value={form.shape} onChange={set('shape')}>
              {(env ? env.shapes : ['mix']).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>RSC mode
            <select value={form.rscMode} onChange={set('rscMode')}>
              {(env ? env.rsc_modes : ['repeat']).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>Abort over p95 (ms)<input type="number" value={form.maxP95} placeholder={sum && sum.slo.max_p95_ms} onChange={set('maxP95')} /></label>
          <label>Abort over failed rate<input type="number" step="0.01" value={form.max5xx} placeholder={sum && sum.slo.max_failed_rate} onChange={set('max5xx')} /></label>
          <label>Skip classes<input value={form.skipClasses} onChange={set('skipClasses')} placeholder="proxy_only,static" /></label>
        </div>
        <div className="row">
          <label>Warm-up<input value={form.warmup} onChange={set('warmup')} placeholder="off — e.g. 30s" /></label>
          <label>Warm-up rate (req/s)
            <input type="number" min="1" value={form.warmupPeak} onChange={set('warmupPeak')}
                   placeholder={form.start === '' ? 'start' : String(form.start)} disabled={!form.warmup} />
          </label>
          <span className="note grow">
            {WARMUP.why}
            {form.warmup ? <> {WARMUP.rateDefault(warmRate === null ? form.start : warmRate)}</> : null}
          </span>
        </div>
        <div className="row checks">
          <label className="check"><input type="checkbox" checked={form.touchAndGo} onChange={set('touchAndGo')} /> touch and go
            <span className="note">steep ramp, no hold, faster brake — still expect 20–40s of errors</span></label>
          <label className="check"><input type="checkbox" checked={form.insecure} onChange={set('insecure')} /> skip TLS verification</label>
          <label className="check"><input type="checkbox" checked={form.slack} onChange={set('slack')} disabled={!(env && env.slack_configured)} /> Slack recap</label>
        </div>

        {sum ? <MixBars classes={sum.classes} peak={Number(form.peak) || 0} /> : null}

        <div className={pastSafe ? 'gate danger' : 'gate'}>
          {pastSafe ? (
            <>
              <strong>
                {ceiling.by === 'warmup'
                  ? SAFE_PEAK.warmupOver(ceiling.rate, safePeak)
                  : SAFE_PEAK.consequence(form.peak, safePeak, host)}
              </strong>
              {ceiling.by === 'both'
                ? <p>{SAFE_PEAK.warmupOver(warmRate, safePeak)}</p>
                : null}
              <p>{SAFE_PEAK.explain(host)}</p>
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {SAFE_PEAK.checkbox}
                </label>
                <label>
                  {SAFE_PEAK.confirmLabel}
                  <input className="mono" value={confirm} placeholder={sum.name || ''} onChange={(e) => setConfirm(e.target.value)} />
                </label>
              </div>
            </>
          ) : (
            <span>{SAFE_PEAK.within(safePeak)}</span>
          )}
        </div>

        <div className="actions">
          <button className="primary" disabled={busy || !profileName} onClick={() => launch('load')}>Run</button>
          <button disabled={busy || !profileName} onClick={() => launch('load', { dryRun: true })}>Dry run</button>
          <button disabled={busy || !profileName} onClick={() => launch('probe')}>Probe</button>
          <button disabled={busy || !profileName} onClick={() => launch('discover', { limit: 400 })}>Discover URLs</button>
          {busy ? (
            <button
              className="danger"
              onClick={() => api.stopRun(run.id).then(setRun).catch((e) => setError(e.message))}
            >
              Stop
            </button>
          ) : null}
        </div>
        {error ? <div className="banner bad">{error}</div> : null}
      </section>

      <CommandPreview body={previewBody} disabled={!profileName} />

      <HostPanel env={env} />

      {run ? (
        <section className="card wide">
          <h2>
            Run <span className="mono">{run.run_id || run.id}</span>
            {stream.runStateKnown
              ? (
                <span className={`state ${run.status}`}>
                  {run.status}{run.exit_code !== null && run.exit_code !== undefined ? ` · exit ${run.exit_code}` : ''}
                </span>
              )
              : <span className="state unknown" title="the live log was lost: this page cannot see the run">not known</span>}
          </h2>
          {describeStream(stream) ? (
            <div className={stream.tone === 'bad' ? 'banner bad' : 'banner warn'}>{describeStream(stream)}</div>
          ) : null}
          {bufRef.current.note() ? <div className="note">{bufRef.current.note()}</div> : null}
          {run.adopted && run.interrupted ? (
            <div className="banner warn">
              <strong>This run was interrupted: the server it was started from stopped while it was in
              flight</strong> (pid {run.pid} is gone). The generator stopped with it — by design, because the
              driver writes to a pipe held by this server, and a load generator nobody supervises is one
              nobody can stop. Whatever was written before the interruption is in the output directory; the
              exit code cannot be known from here.
            </div>
          ) : run.adopted ? (
            <div className="banner warn">
              <strong>This run was started by an earlier life of this server</strong> (pid {run.pid}) and is
              still going, so it was picked up again. The log below is the driver's own run log file, and the
              exit code will not be reported here — read the summary. Stop still works.
            </div>
          ) : null}
          {run.stop_error ? <div className="banner bad">{run.stop_error}</div> : null}
          {run.status === 'failed' && run.exit_code === 3
            ? <div className="banner bad">A safety gate refused this run. Nothing was generated.</div> : null}
          <pre className="log" ref={logRef}>{log.join('\n')}</pre>
        </section>
      ) : null}

      {artifacts && artifacts.probe ? <ProbeTable probe={artifacts.probe} /> : null}
      {artifacts && artifacts.discover ? <DiscoverTable discover={artifacts.discover} /> : null}
      {summary ? <SummaryCard summary={summary} /> : null}
    </div>
  );
}
