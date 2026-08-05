import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import MixBars from './MixBars.jsx';

/*
 * The profile editor. A raw JSON textarea plus live validation, on purpose: a profile is a small,
 * heavily commented document that people diff in git, and a generated form would strip the `_comment`
 * keys that make it readable. The value the GUI adds is telling you what is wrong while you type.
 */
export default function ProfilePanel({ profiles, onChanged }) {
  const [name, setName] = useState('');
  const [raw, setRaw] = useState('');
  const [validation, setValidation] = useState(null);
  const [status, setStatus] = useState(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!name && profiles.length) setName(profiles[0].name);
  }, [profiles, name]);

  useEffect(() => {
    if (!name) return;
    api.profile(name).then((p) => {
      setRaw(p.raw);
      setValidation(p.validation);
      setDirty(false);
      setStatus(null);
    }).catch((e) => setStatus({ bad: true, text: e.message }));
  }, [name]);

  // Debounced: validation is cheap but typing is bursty.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      api.validate(raw).then(setValidation).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [raw, dirty]);

  async function save(force) {
    try {
      await api.saveProfile(name, raw, force);
      setStatus({ text: `saved ${name}` });
      setDirty(false);
      onChanged();
    } catch (e) {
      setStatus({ bad: true, text: e.message });
      if (e.validation) setValidation(e.validation);
    }
  }

  async function saveAs() {
    const target = window.prompt('Save as (e.g. my-site.json)', name.replace(/\.json$/, '-copy.json'));
    if (!target) return;
    try {
      await api.saveProfile(target, raw, false);
      setStatus({ text: `saved ${target}` });
      onChanged();
      setName(target);
    } catch (e) {
      setStatus({ bad: true, text: e.message });
    }
  }

  const current = profiles.find((p) => p.name === name);
  const sum = validation ? validation.summary : null;

  return (
    <div className="grid">
      <section className="card">
        <h2>Profiles</h2>
        <ul className="profile-list">
          {profiles.map((p) => (
            <li key={p.name} className={p.name === name ? 'active' : ''} onClick={() => setName(p.name)}>
              <span className="mono">{p.name}</span>
              <span className="note">{p.title || '—'}</span>
              <span className={p.ok ? 'pill ok' : 'pill bad'}>{p.ok ? `${p.warnings} warn` : `${p.errors} err`}</span>
            </li>
          ))}
        </ul>
        <p className="note">
          A profile holds hostnames, URL pools and a map of how your site is built. Keep yours in your own
          private repo — <span className="mono">example.json</span> is the shipped documentation and is read-only.
        </p>
      </section>

      <section className="card wide">
        <h2>
          <span className="mono">{name}</span>
          {dirty ? <span className="pill warn">unsaved</span> : null}
        </h2>
        <textarea
          className="editor mono"
          spellCheck={false}
          value={raw}
          onChange={(e) => { setRaw(e.target.value); setDirty(true); }}
        />
        <div className="actions">
          <button className="primary" disabled={current && current.example} onClick={() => save(false)}>Save</button>
          <button onClick={saveAs}>Save as…</button>
          <button
            className="danger"
            disabled={!current || current.example}
            onClick={async () => {
              if (!window.confirm(`Delete ${name}?`)) return;
              await api.deleteProfile(name);
              setName('');
              onChanged();
            }}
          >Delete</button>
        </div>
        {status ? <div className={status.bad ? 'banner bad' : 'banner ok'}>{status.text}</div> : null}

        {validation ? (
          <div className="validation">
            {validation.parse_error ? <div className="banner bad">JSON: {validation.parse_error}</div> : null}
            {(validation.errors || []).map((e, i) => (
              <div className="issue err" key={i}><span className="mono">{e.path}</span> {e.message}</div>
            ))}
            {(validation.warnings || []).map((w, i) => (
              <div className="issue warn" key={i}><span className="mono">{w.path}</span> {w.message}</div>
            ))}
            {validation.ok && !(validation.warnings || []).length ? <div className="banner ok">No errors, no warnings.</div> : null}
          </div>
        ) : null}

        {sum ? (
          <>
            <MixBars classes={sum.classes} peak={100} />
            <table className="kv">
              <tbody>
                <tr><th>targets</th><td className="mono">{sum.targets.map((t) => t.name).join(' · ') || '—'}</td></tr>
                <tr><th>default</th><td className="mono">{sum.default_target || '—'}</td></tr>
                <tr><th>safe peak</th><td className="mono">{sum.safe_peak_rps === null ? '150 (driver default)' : `${sum.safe_peak_rps} req/s`}</td></tr>
                <tr><th>allowlist</th><td className="mono">{(sum.allow_hosts || []).join(', ') || '— (needs CROWDSIM_ALLOW_TARGETS)'}</td></tr>
                <tr><th>brake</th><td className="mono">{sum.slo.brake_class || 'first class'} · p95 {sum.slo.max_p95_ms} ms · failed {sum.slo.max_failed_rate}</td></tr>
                <tr><th>read timeout</th><td className="mono">{sum.slo.guillotine_ms} ms<span className="note"> requests past this become 504s for real visitors</span></td></tr>
                <tr><th>cache layers</th><td className="mono">{(sum.cache_layers || []).join(' · ') || '—'}</td></tr>
              </tbody>
            </table>
          </>
        ) : null}
      </section>
    </div>
  );
}
