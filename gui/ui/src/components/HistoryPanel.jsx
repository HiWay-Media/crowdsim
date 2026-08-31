import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import SummaryCard from './SummaryCard.jsx';
import CompareCard from './CompareCard.jsx';
import { orderPair } from '../lib/compare.js';
import { parseHash, formatHash } from '../lib/hash.js';
import { activatesOn } from '../lib/keys.js';
import { kneeText, stepCurve } from '../lib/runs.js';

/*
 * The archive, read from out/history.tsv and out/summary-*.json — the files the driver writes. Runs
 * launched from the command line appear here too, because there is only one source of truth.
 *
 * The chart is a knee plot: rate on x, p95 on y. Two things are drawn on those axes and they do not mean the
 * same thing — a dot is one run's requested peak against its p95 over the WHOLE ramp, i.e. an average across
 * every rate it passed through; the line is the selected run's own per-step shape, which is the real curve.
 * Runs the generator could not sustain are drawn hollow, and excluded from any conclusion.
 */
export default function HistoryPanel() {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  // Two runs picked for a comparison, oldest-first as A and B. Kept separate from `selected`, which is the
  // row whose full result is on screen: reading one run and comparing two are different questions.
  const [picked, setPicked] = useState([]);
  const [comparison, setComparison] = useState(null);

  // A comparison is a thing people quote to each other, so it has an address: #history=<a>,<b>. Parsing it
  // (and refusing anything that is not two run ids) is lib/hash.js, with its tests.
  useEffect(() => {
    const { pair: ids } = parseHash(window.location.hash);
    if (!ids) return;
    setPicked(ids);
    api.compare(ids[0], ids[1])
      .then(setComparison)
      .catch((e) => (e instanceof ApiError && e.body && e.body.refused
        ? setComparison(e.body)
        : setError(e.message)));
  }, []);

  const togglePick = (runId) => setPicked((p) => (
    p.indexOf(runId) !== -1 ? p.filter((x) => x !== runId) : p.concat([runId]).slice(-2)
  ));

  async function compareNow() {
    setError(null);
    const pair = orderPair(picked, rows);
    if (!pair) return;
    const [a, b] = pair;
    window.location.hash = formatHash('history', pair);
    try {
      setComparison(await api.compare(a, b));
    } catch (e) {
      // A refusal is not an error to hide in a banner: it IS the answer, and the card renders it.
      if (e instanceof ApiError && e.body && e.body.refused) setComparison(e.body);
      else setError(e.message);
    }
  }

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
        {rows.length ? (
          <KneePlot
            rows={rows}
            onPick={setSelected}
            selected={selected}
            curve={stepCurve(detail && detail.summary ? detail.summary.per_step : null)}
          />
        ) : null}

        {rows.length ? (
          <div className="actions">
            <button className="primary" disabled={picked.length !== 2} onClick={compareNow}>
              Compare the two ticked runs
            </button>
            <span className="note">
              {orderPair(picked, rows)
                ? `A ${orderPair(picked, rows)[0]} → B ${orderPair(picked, rows)[1]} (oldest first)`
                : `tick two runs (${picked.length}/2). The comparison, and every refusal, comes from crowdsim compare.`}
            </span>
            {picked.length ? <button onClick={() => { setPicked([]); setComparison(null); }}>clear</button> : null}
          </div>
        ) : null}

        <table className="data">
          <thead>
            <tr>
              <th>cmp</th>
              <th>run</th><th>profile</th><th>target</th><th>shape</th><th>peak</th><th>achieved</th>
              <th>p95</th><th>failed</th><th>504</th><th>knee</th><th>outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.run_id}
                className={`${selected === r.run_id ? 'sel' : ''} ${r.generator_ok === false ? 'invalid' : ''}`}
                onClick={() => setSelected(r.run_id)}
                // Reachable without a mouse: a row that only answers a click is a run somebody cannot open.
                tabIndex={0}
                role="button"
                aria-pressed={selected === r.run_id}
                aria-label={`open run ${r.run_id}`}
                onKeyDown={(e) => { if (activatesOn(e)) { e.preventDefault(); setSelected(r.run_id); } }}
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={picked.indexOf(r.run_id) !== -1}
                    onChange={() => togglePick(r.run_id)}
                    aria-label={`compare ${r.run_id}`}
                  />
                </td>
                <td className="mono">{r.run_id}</td>
                <td>{r.profile}</td>
                <td className="mono small">{r.base_url}</td>
                <td>{r.shape}</td>
                <td>{r.peak}</td>
                <td>{r.rps}</td>
                <td>{r.p95} ms</td>
                <td>{r.failed === null ? 'n/a' : `${(r.failed * 100).toFixed(2)}%`}</td>
                <td>{r.e504}</td>
                <td className={r.knee_crossed !== null && r.knee_crossed !== undefined ? 'warn' : ''}>
                  {r.knee_clean === null || r.knee_clean === undefined ? ''
                    : (r.knee_crossed === null || r.knee_crossed === undefined
                        ? `≥ ${r.knee_clean}` : `${r.knee_clean} → ${r.knee_crossed}`)}
                </td>
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

      {comparison ? <CompareCard result={comparison} onClose={() => setComparison(null)} /> : null}

      {detail && detail.summary
        ? <SummaryCard summary={detail.summary} compare={detail.comparable} />
        : null}
    </div>
  );
}

/** Inline SVG: no chart dependency for one scatter plot with 20 points. */
function KneePlot({ rows, onPick, selected, curve }) {
  const pts = rows.filter((r) => r.peak && r.p95 !== null);
  const line = curve || [];
  if (pts.length < 2 && line.length < 2) return null;
  const W = 640; const H = 200; const pad = 34;
  // The curve shares the axes with the dots, so it has to share their scale too — otherwise the same
  // coordinate would mean two rates.
  const maxX = Math.max(...pts.map((p) => p.peak), ...line.map((p) => p.rate), 1);
  const maxY = Math.max(...pts.map((p) => p.p95), ...line.map((p) => p.p95), 1);
  const x = (v) => pad + (v / maxX) * (W - pad * 2);
  const y = (v) => H - pad - (v / maxY) * (H - pad * 2);
  return (
    <svg className="knee" viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label="p95 against rate: one dot per run, and the selected run's per-step curve">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="axis" />
      <line x1={pad} y1={pad} x2={pad} y2={H - pad} className="axis" />
      <text x={W - pad} y={H - 10} className="axis-label" textAnchor="end">rate (req/s)</text>
      <text x={6} y={pad - 12} className="axis-label">p95 (ms)</text>
      {line.length > 1 ? (
        <polyline
          className="step-curve"
          fill="none"
          points={line.map((p) => `${x(p.rate)},${y(p.p95)}`).join(' ')}
        />
      ) : null}
      {line.map((p) => (
        <circle key={`step-${p.step}`} cx={x(p.rate)} cy={y(p.p95)} r={p.partial ? 2 : 3}
                className={`step-pt ${p.partial ? 'partial' : ''}`}>
          <title>{`step ${p.step} · ${p.rate} req/s · p95 ${Math.round(p.p95)} ms`
            + (p.partial ? ' · PARTIAL: the run ended inside this step' : '')}</title>
        </circle>
      ))}
      {pts.map((p) => (
        <circle
          key={p.run_id}
          cx={x(p.peak)}
          cy={y(p.p95)}
          r={selected === p.run_id ? 6 : 4}
          className={`pt ${p.generator_ok === false ? 'invalid' : (p.aborted ? 'knee' : 'clean')}`}
          onClick={() => onPick(p.run_id)}
          tabIndex={0}
          role="button"
          aria-label={`run ${p.run_id}: peak ${p.peak} req/s, p95 ${p.p95} ms`}
          onKeyDown={(e) => { if (activatesOn(e)) { e.preventDefault(); onPick(p.run_id); } }}
        >
          <title>{`${p.run_id} · peak ${p.peak} · p95 ${p.p95} ms${p.generator_ok === false ? ' · INVALID' : ''}`}</title>
        </circle>
      ))}
    </svg>
  );
}
