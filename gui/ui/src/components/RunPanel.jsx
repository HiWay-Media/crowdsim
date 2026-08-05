import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, streamRun } from '../api.js';
import MixBars from './MixBars.jsx';
import SummaryCard from './SummaryCard.jsx';
import CommandPreview from './CommandPreview.jsx';
import { ProbeTable, DiscoverTable } from './PreflightTables.jsx';

/*
 * The run launcher. Everything expensive to get wrong is shown BEFORE the button: which host will be hit,
 * whether it is allowlisted, the safe ceiling, and what the requested peak means per class. The
 * production override is a separate block that has to be filled in by hand, per run.
 */

const DEFAULTS = {
  peak: 60, start: 15, steps: 4, stepDur: '60s', hold: '120s',
  shape: 'mix', rscMode: 'repeat', maxP95: '', max5xx: '', skipClasses: '',
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
      const last = r.active || (r.runs && r.runs[0]) || null;
      if (!alive || !last) return;
      setRun(last);
      try {
        const full = await api.run(last.id);
        if (!alive) return;
        setLog(full.log || []);
        setSummary(full.summary || null);
        setArtifacts(full.artifacts || null);
      } catch (e) { /* the run record is enough */ }
      if (!r.active) return;
      onActiveRun(r.active);
      streamRun(r.active.id, (line) => setLog((l) => [...l, line]), async (ended) => {
        setRun(ended);
        onActiveRun(null);
        try {
          const full = await api.run(ended.id);
          setSummary(full.summary || null);
          setArtifacts(full.artifacts || null);
        } catch (e) { /* the run record is enough */ }
      });
    }).catch(() => { /* an empty run list is the normal case */ });
    return () => { alive = false; };
  }, []);

  const sum = profile && profile.validation ? profile.validation.summary : null;
  const chosen = sum ? sum.targets.find((t) => t.name === target) : null;
  const safePeak = sum ? sum.safe_peak_rps : null;
  const pastSafe = safePeak !== null && Number(form.peak) > safePeak;

  const host = useMemo(() => {
    if (!chosen || !chosen.base_url) return null;
    try { return new URL(chosen.base_url).hostname; } catch (e) { return null; }
  }, [chosen]);

  const allowed = useMemo(() => {
    if (!host) return null;
    const patterns = (env && env.allow_targets ? env.allow_targets.split(',') : (sum ? sum.allow_hosts : []))
      .map((s) => String(s).trim()).filter(Boolean);
    if (!patterns.length) return false;
    return patterns.some((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(host));
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

  async function launch(kind, extra) {
    setError(null);
    setLog([]);
    setSummary(null);
    setArtifacts(null);
    try {
      const body = buildBody(kind, extra);
      const started = await api.startRun(body);
      setRun(started);
      onActiveRun(started);
      streamRun(started.id, (line) => setLog((l) => [...l, line]), async (ended) => {
        setRun(ended);
        onActiveRun(null);
        try {
          const full = await api.run(ended.id);
          setSummary(full.summary || null);
          setArtifacts(full.artifacts || null);
        } catch (e) { /* the run record is enough */ }
      });
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
                setProfileName(e.target.value);
                setSummary(null);
                setArtifacts(null);
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
                  {allowed === null ? '—' : allowed
                    ? <span className="ok">{host} is authorised</span>
                    : <span className="bad">{host} is NOT in the allowlist — the run will be refused (exit 3)</span>}
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
              <strong>{form.peak} req/s is above this profile's safe ceiling of {safePeak} req/s.</strong>
              <p>
                Past this point the run is expected to serve 5xx to real users of {host || 'the target'}, and to
                degrade any co-tenant on the same nodes. Agree a window, tell whoever watches the uptime
                alerts, and be ready to stop. Then type the profile name to confirm.
              </p>
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> I know this breaks production
                </label>
                <label>
                  Profile name
                  <input className="mono" value={confirm} placeholder={sum.name || ''} onChange={(e) => setConfirm(e.target.value)} />
                </label>
              </div>
            </>
          ) : (
            <span>Within the profile's safe ceiling{safePeak !== null ? ` (${safePeak} req/s)` : ''}.</span>
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

      {run ? (
        <section className="card wide">
          <h2>
            Run <span className="mono">{run.run_id || run.id}</span>
            <span className={`state ${run.status}`}>{run.status}{run.exit_code !== null && run.exit_code !== undefined ? ` · exit ${run.exit_code}` : ''}</span>
          </h2>
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
