import React from 'react';

/*
 * A run result, in the order in which it has to be read:
 *   1. is this run valid at all (generator_ok, target_unreachable)?
 *   2. did the brake trip (did we find the knee)?
 *   3. only then: the numbers, per class, with the share past the read timeout — not the average.
 * Presenting the numbers first is how a generator-bound run becomes a capacity claim.
 */
import { abortDetail } from '../lib/messages.js';
import { kneeText } from '../lib/runs.js';

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(2)}%`);
const ms = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x)} ms`);

export default function SummaryCard({ summary, compare }) {
  const s = summary;
  const classes = Object.keys(s.per_class || {}).filter((c) => s.per_class[c].reqs);
  return (
    <section className="card wide">
      <h2>Result <span className="mono">{s.run_id}</span></h2>

      {!s.generator_ok ? (
        <div className="banner bad">
          <strong>Discard this run.</strong> The generator dropped {s.dropped_iterations} iterations, so it
          never delivered the requested rate: this looks exactly like a healthy system under load and means
          nothing. Move the generator closer to the target, or onto a bigger host, and repeat.
        </div>
      ) : null}

      {s.target_unreachable ? (
        <div className="banner bad">
          <strong>The target never answered.</strong> {pct(s.failed_rate)} failed at ~0 ms. A saturated system
          is slow before it errors, so this is a connectivity problem — address, port, TLS or network path —
          and not a capacity number. Run a probe against the same target.
        </div>
      ) : s.aborted ? (
        <div className="banner warn">
          <strong>Aborted by the brake: you found the knee.</strong> That is the intended outcome, not a failure.
          {abortDetail(s.aborted_by) ? <> {abortDetail(s.aborted_by)}</> : null}
        </div>
      ) : (
        <div className="banner ok">Completed without crossing the thresholds.</div>
      )}

      {/* The knee: the only rate in this card that was measured rather than requested. A refusal is shown
          with the same weight as a claim would have been — a quiet absence is read as "no knee found", and
          then somebody quotes the requested peak. */}
      {s.knee ? (
        <div className={`banner ${s.knee.refused ? 'warn' : 'info'}`}>
          {s.knee.refused ? (
            <><strong>No knee from this run.</strong> {s.knee.reason} {s.knee.fix}</>
          ) : (
            <>
              <strong>{`${s.knee.summary[0].toUpperCase()}${s.knee.summary.slice(1)}`}</strong>{' '}
              {s.knee.clean && s.knee.clean.caveat
                ? `${s.knee.clean.caveat[0].toUpperCase()}${s.knee.clean.caveat.slice(1)}. ` : ''}
              {s.knee.note ? `${s.knee.note} ` : ''}
              This is a knee at this URL pool, which is colder than real traffic.
            </>
          )}
        </div>
      ) : null}

      <div className="stats">
        <Stat label="requests" value={s.requests} />
        <Stat label="achieved" value={`${(s.rps_avg || 0).toFixed(1)} req/s`} sub={`asked ${s.peak_rps_user_target}`} />
        <Stat label="failed" value={pct(s.failed_rate)} />
        <Stat label="p95" value={ms(s.dur && s.dur.p95)} sub={`p99 ${ms(s.dur && s.dur.p99)}`} />
        <Stat label={`over ${s.guillotine_ms} ms`} value={pct(s.over_guillotine_rate)} sub="where 504s come from" />
        <Stat label="504 / 502" value={`${s.e504} / ${s.e502}`} />
      </div>

      <div className="cache-line">
        cache:{' '}
        {Object.keys(s.cache || {}).length
          ? Object.keys(s.cache).map((k) => (
            <span key={k} className="mono cache-chip">{k} {pct(s.cache[k])}</span>
          ))
          : <span className="note">no cache_headers declared in the profile</span>}
        {Object.keys(s.cache || {}).length && Object.values(s.cache).every((v) => v === null)
          ? <span className="note"> n/a everywhere: no declared cache header was ever seen in a response</span>
          : null}
      </div>

      <table className="data">
        <thead>
          <tr>
            <th>class</th><th>target req/s</th><th>requests</th><th>p50</th><th>p95</th><th>p99</th>
            <th>&gt; {s.guillotine_ms} ms</th><th>failed</th>
          </tr>
        </thead>
        <tbody>
          {classes.map((c) => {
            const k = s.per_class[c];
            return (
              <tr key={c}>
                <td className="mono">{c}</td>
                <td>{k.rps_target === null ? '—' : k.rps_target}</td>
                <td>{k.reqs}</td>
                <td>{ms(k.med)}</td>
                <td>{ms(k.p95)}</td>
                <td>{ms(k.p99)}</td>
                <td className={k.over_guillotine > 0.01 ? 'bad' : ''}>{pct(k.over_guillotine)}</td>
                <td className={k.failed > 0.01 ? 'bad' : ''}>{pct(k.failed)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {compare && compare.length ? (
        <div className="compare">
          <h3>Against comparable runs <span className="note">same profile, target and shape — deltas are the honest part, absolutes are not</span></h3>
          <table className="data">
            <thead><tr><th>run</th><th>peak</th><th>p95</th><th>Δ p95</th><th>failed</th><th>aborted</th></tr></thead>
            <tbody>
              {compare.map((r) => (
                <tr key={r.run_id}>
                  <td className="mono">{r.run_id}</td>
                  <td>{r.peak}</td>
                  <td>{ms(r.p95)}</td>
                  <td className={(s.dur.p95 || 0) - (r.p95 || 0) > 0 ? 'bad' : 'ok'}>
                    {r.p95 === null ? 'n/a' : `${Math.round((s.dur.p95 || 0) - r.p95)} ms`}
                  </td>
                  <td>{pct(r.failed)}</td>
                  <td>{String(r.aborted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value mono">{value}</div>
      {sub ? <div className="stat-sub note">{sub}</div> : null}
    </div>
  );
}
