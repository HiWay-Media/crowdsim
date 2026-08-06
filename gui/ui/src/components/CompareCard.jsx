import React from 'react';
import { valueCell, deltaCell, mayRenderNumbers } from '../lib/compare.js';

/*
 * Two runs, compared.
 *
 * Every number and every verdict here comes from `crowdsim compare --json`, run by the server as a child
 * process. Nothing on this screen is decided by the page: not which runs may be compared, not what counts as
 * an improvement, not what is "n/a". A second copy of those rules would be the one on screen the day the two
 * disagree — and a delta between two runs that were not the same experiment looks exactly like an answer.
 *
 * Which is why the refusal is rendered as prominently as a result would have been.
 */
export default function CompareCard({ result, onClose }) {
  if (!result) return null;
  const refused = result.refused || [];
  const withNumbers = mayRenderNumbers(result);

  return (
    <section className="card wide">
      <h2>
        Comparison
        <span className="note">from crowdsim compare — same verdict as the command line, because it is it</span>
        {onClose ? <button className="linkish" onClick={onClose}>close</button> : null}
      </h2>

      <table className="kv">
        <tbody>
          <tr><th>A</th><td><RunHead h={result.a} /></td></tr>
          <tr><th>B</th><td><RunHead h={result.b} /></td></tr>
        </tbody>
      </table>

      {refused.length ? (
        <div className="banner bad">
          <strong>Refusing to compare these two runs.</strong>
          <ul>
            {refused.map((r) => (
              <li key={r.reason}>
                {r.reason}
                {(r.detail || []).map((d) => <div key={d} className="note">{d}</div>)}
              </li>
            ))}
          </ul>
          <p>A comparison that is not like-for-like is a confident number with nothing behind it.</p>
        </div>
      ) : null}

      {(result.warnings || []).map((w) => <div key={w} className="banner warn">{w}</div>)}
      {(result.notes || []).map((n) => <div key={n} className="banner warn">{n}</div>)}

      {withNumbers ? (
        <>
          <h3>Overall</h3>
          <DeltaTable rows={result.overall} />

          {result.layers && result.layers.length ? (
            <>
              <h3>Cache hit ratio per layer</h3>
              <DeltaTable rows={result.layers} naNote="header never appeared in either run" />
            </>
          ) : null}

          {result.per_class && result.per_class.length ? (
            <>
              <h3>Per class</h3>
              <table className="data">
                <thead>
                  <tr><th>class</th><th>p95 A</th><th>p95 B</th><th>change</th><th>failed A</th><th>failed B</th></tr>
                </thead>
                <tbody>
                  {result.per_class.map((c) => (c.only_in ? (
                    <tr key={c.class}>
                      <td>{c.class}</td>
                      <td colSpan="5" className="note">
                        present only in run {c.only_in.toUpperCase()} — a class was skipped, or the profile changed
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.class}>
                      <td>{c.class}</td>
                      <td>{fmt(c.p95.a, 'ms')}</td>
                      <td>{fmt(c.p95.b, 'ms')}</td>
                      <td><Change row={c.p95} /></td>
                      <td>{fmt(c.failed.a, 'ratio')}</td>
                      <td>{fmt(c.failed.b, 'ratio')}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </>
          ) : null}

          <p className="note">
            Deltas are the honest part. The absolutes describe this pool, which is colder than real traffic —
            quote the change, not the number.
          </p>
        </>
      ) : null}
    </section>
  );
}

function RunHead({ h }) {
  if (!h) return null;
  return (
    <span>
      <span className="mono">{h.run_id}</span>{' '}
      <span className="note">
        profile {h.profile} · {h.base_url} · shape {h.shape} · peak {h.peak}
        {h.aborted ? ' · aborted by the brake' : ''}
      </span>
    </span>
  );
}

function DeltaTable({ rows, naNote }) {
  return (
    <table className="data">
      <thead><tr><th>{''}</th><th>A</th><th>B</th><th>change</th></tr></thead>
      <tbody>
        {(rows || []).map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td>{fmt(r.a, r.unit)}</td>
            <td>{fmt(r.b, r.unit)}</td>
            <td>
              {r.a === null && r.b === null
                ? <span className="note">{naNote || '—'}</span>
                : <Change row={r} />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The verdict is the server's and the wording is lib/compare.js's; this only paints it. */
function Change({ row }) {
  const cell = deltaCell(row);
  return <span className={cell.tone}>{cell.text}</span>;
}

function fmt(v, unit) {
  const text = valueCell(v, unit);
  return text === 'n/a' ? <span className="note">n/a</span> : text;
}
