import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, streamRun } from '../api.js';
import MixBars from './MixBars.jsx';
import SummaryCard from './SummaryCard.jsx';

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
      setForce(false);
      setConfirm('');
      setSummary(null);
    }).catch((e) => setError(e.message));
    return () => { alive = false; };
  }, [profileName]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

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

  async function launch(kind, extra) {
    setError(null);
    setLog([]);
    setSummary(null);
    try {
      const body = {
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
      };
      const started = await api.startRun(body);
      setRun(started);
      onActiveRun(started);
      streamRun(started.id, (line) => setLog((l) => [...l, line]), async (ended) => {
        setRun(ended);
        onActiveRun(null);
        try {
          const full = await api.run(ended.id);
          setSummary(full.summary || null);
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
            <select value={profileName} onChange={(e) => setProfileName(e.target.value)}>
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
          {busy ? <button className="danger" onClick={() => api.stopRun(run.id)}>Stop</button> : null}
        </div>
        {error ? <div className="banner bad">{error}</div> : null}
      </section>

      {run ? (
        <section className="card wide">
          <h2>
            Run <span className="mono">{run.run_id || run.id}</span>
            <span className={`state ${run.status}`}>{run.status}{run.exit_code !== null && run.exit_code !== undefined ? ` · exit ${run.exit_code}` : ''}</span>
          </h2>
          {run.status === 'failed' && run.exit_code === 3
            ? <div className="banner bad">A safety gate refused this run. Nothing was generated.</div> : null}
          <pre className="log" ref={logRef}>{log.join('\n')}</pre>
        </section>
      ) : null}

      {summary ? <SummaryCard summary={summary} /> : null}
    </div>
  );
}
