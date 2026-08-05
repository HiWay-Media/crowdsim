import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken, setToken } from './api.js';
import RunPanel from './components/RunPanel.jsx';
import ProfilePanel from './components/ProfilePanel.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';

const TABS = [
  { id: 'run', label: 'New run', hint: 'pick a target and a rate, watch it climb' },
  { id: 'profiles', label: 'Profiles', hint: 'the mix, the pools, the SLO, the allowlist' },
  { id: 'history', label: 'History', hint: 'does the knee move?' },
];

const TAB_IDS = TABS.map((t) => t.id);

export default function App() {
  // The tab lives in the URL fragment, so a reload keeps you where you were and a link can point at
  // "#history" — which is also how the documentation screenshots are taken.
  // `#history=<a>,<b>` selects the History tab AND the comparison in it, so a delta can be sent to
  // somebody as a link. The tab id is the part before the '='.
  const tabOf = (hash) => String(hash || '').replace('#', '').split('=')[0];
  const [tab, setTab] = useState(() => {
    const fromHash = tabOf(window.location.hash);
    return TAB_IDS.indexOf(fromHash) === -1 ? 'run' : fromHash;
  });

  useEffect(() => {
    if (tabOf(window.location.hash) !== tab) window.location.hash = tab;
  }, [tab]);

  useEffect(() => {
    const onHash = () => {
      const id = tabOf(window.location.hash);
      if (TAB_IDS.indexOf(id) !== -1) setTab(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const [env, setEnv] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [error, setError] = useState(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [activeRun, setActiveRun] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [e, p] = await Promise.all([api.env(), api.profiles()]);
      setEnv(e);
      setProfiles(p.profiles);
      setNeedsToken(false);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsToken(true);
      else setError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (needsToken) return <TokenGate onSaved={refresh} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">crowdsim</span>
          <span className="brand-sub">live-event load simulator</span>
        </div>
        <div className="chips">
          <Chip label="k6" value={env ? (env.k6 || 'not installed') : '…'} bad={env && !env.k6} />
          <Chip
            label="allowlist"
            value={env ? (env.allow_targets || 'from profile') : '…'}
            title="CROWDSIM_ALLOW_TARGETS. Without it, every run relies on the profile's safety.allow_hosts."
          />
          <Chip label="output" value={env ? env.out_dir : '…'} />
          {env && env.slack_configured ? <Chip label="slack" value="configured" /> : null}
        </div>
      </header>

      {error ? <div className="banner bad">{error}</div> : null}

      <div className="body">
        <nav className="sidenav">
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? 'navitem active' : 'navitem'} onClick={() => setTab(t.id)}>
              <span className="navitem-label">{t.label}</span>
              <span className="navitem-hint">{t.hint}</span>
            </button>
          ))}
          {activeRun ? (
            <div className="running-badge">
              <span className="dot" /> run in progress
              <div className="mono small">{activeRun.kind} · {activeRun.id}</div>
            </div>
          ) : null}
          <div className="sidenav-foot">
            <p>
              This page starts real load generators. The safety gates live in the CLI: an unlisted host or
              a rate above the profile's safe peak is refused here exactly as it is on the command line.
            </p>
          </div>
        </nav>

        <main className="content">
          {tab === 'run' && (
            <RunPanel env={env} profiles={profiles} onActiveRun={setActiveRun} onProfilesChanged={refresh} />
          )}
          {tab === 'profiles' && <ProfilePanel profiles={profiles} onChanged={refresh} />}
          {tab === 'history' && <HistoryPanel />}
        </main>
      </div>
    </div>
  );
}

function Chip({ label, value, bad, title }) {
  return (
    <span className={bad ? 'chip bad' : 'chip'} title={title || ''}>
      <span className="chip-label">{label}</span>
      <span className="chip-value mono">{value}</span>
    </span>
  );
}

function TokenGate({ onSaved }) {
  const [value, setValue] = useState(getToken());
  return (
    <div className="tokengate">
      <h1>crowdsim</h1>
      <p>
        This server was started off loopback, so it requires the token from <code>CROWDSIM_GUI_TOKEN</code>.
      </p>
      <input
        className="mono"
        type="password"
        value={value}
        placeholder="CROWDSIM_GUI_TOKEN"
        onChange={(e) => setValue(e.target.value)}
      />
      <button className="primary" onClick={() => { setToken(value.trim()); onSaved(); }}>Continue</button>
    </div>
  );
}
