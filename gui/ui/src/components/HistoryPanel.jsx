import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import SummaryCard from './SummaryCard.jsx';

/*
 * The archive, read from out/history.tsv and out/summary-*.json — the files the driver writes. Runs
 * launched from the command line appear here too, because there is only one source of truth.
 *
 * The chart is a knee plot: requested peak on x, p95 on y, one point per run of the selected profile.
 * Runs the generator could not sustain are drawn hollow, and excluded from any conclusion.
 */
export default function HistoryPanel() {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.history().then((h) => setRows(h.runs)).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.historyRun(selected).then(setDetail).catch((e) => setError(e.message));
  }, [selected]);

  return (
    <div className="grid">
      <section className="card wide">
        <h2>Runs</h2>
        {error ? <div className="banner bad">{error}</div> : null}
        {!rows.length ? <p className="note">No runs recorded yet. The archive is written by the driver, in the output directory.</p> : null}
        {rows.length ? <KneePlot rows={rows} onPick={setSelected} selected={selected} /> : null}
        <table className="data">
          <thead>
            <tr>
              <th>run</th><th>profile</th><th>target</th><th>shape</th><th>peak</th><th>achieved</th>
              <th>p95</th><th>failed</th><th>504</th><th>outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.run_id}
                className={`${selected === r.run_id ? 'sel' : ''} ${r.generator_ok === false ? 'invalid' : ''}`}
                onClick={() => setSelected(r.run_id)}
              >
                <td className="mono">{r.run_id}</td>
                <td>{r.profile}</td>
                <td className="mono small">{r.base_url}</td>
                <td>{r.shape}</td>
                <td>{r.peak}</td>
                <td>{r.rps}</td>
                <td>{r.p95} ms</td>
                <td>{r.failed === null ? 'n/a' : `${(r.failed * 100).toFixed(2)}%`}</td>
                <td>{r.e504}</td>
                <td>
                  {r.generator_ok === false
                    ? <span className="pill bad">invalid</span>
                    : r.aborted ? <span className="pill warn">knee</span> : <span className="pill ok">clean</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {detail && detail.summary
        ? <SummaryCard summary={detail.summary} compare={detail.comparable} />
        : null}
    </div>
  );
}

/** Inline SVG: no chart dependency for one scatter plot with 20 points. */
function KneePlot({ rows, onPick, selected }) {
  const pts = rows.filter((r) => r.peak && r.p95 !== null);
  if (pts.length < 2) return null;
  const W = 640; const H = 200; const pad = 34;
  const maxX = Math.max(...pts.map((p) => p.peak));
  const maxY = Math.max(...pts.map((p) => p.p95));
  const x = (v) => pad + (v / maxX) * (W - pad * 2);
  const y = (v) => H - pad - (v / maxY) * (H - pad * 2);
  return (
    <svg className="knee" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="p95 against requested peak">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="axis" />
      <line x1={pad} y1={pad} x2={pad} y2={H - pad} className="axis" />
      <text x={W - pad} y={H - 10} className="axis-label" textAnchor="end">requested peak (req/s)</text>
      <text x={6} y={pad - 12} className="axis-label">p95 (ms)</text>
      {pts.map((p) => (
        <circle
          key={p.run_id}
          cx={x(p.peak)}
          cy={y(p.p95)}
          r={selected === p.run_id ? 6 : 4}
          className={`pt ${p.generator_ok === false ? 'invalid' : (p.aborted ? 'knee' : 'clean')}`}
          onClick={() => onPick(p.run_id)}
        >
          <title>{`${p.run_id} · peak ${p.peak} · p95 ${p.p95} ms${p.generator_ok === false ? ' · INVALID' : ''}`}</title>
        </circle>
      ))}
    </svg>
  );
}
