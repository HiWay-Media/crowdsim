import React from 'react';
import { hostHealth, benchLine } from '../lib/health.js';

/*
 * The machine the runs come from. (#49)
 *
 * Its limits are the most common reason a run is invalid, and this is the page that starts runs — yet all
 * of it lived in a terminal until now, including crowdsim's own version, which /api/env had been returning
 * and nothing displayed. A page served by a stale server looks exactly like a current one.
 *
 * Every value comes from the server; the wording and the tone come from lib/health.js, where they are
 * tested. Nothing here measures anything, and nothing here starts a benchmark: that generates load, and a
 * report that starts generating traffic on its own is not a report.
 */
export default function HostPanel({ env }) {
  if (!env) return null;
  const bench = benchLine(env.bench);

  return (
    <section className="card wide">
      <h2>This machine <span className="note">where the load comes from — crowdsim doctor, in the page</span></h2>

      <table className="kv">
        <tbody>
          {hostHealth(env).map((row) => (
            <tr key={row.label}>
              <th>{row.label}</th>
              <td>
                <span className={row.tone === 'ok' ? 'ok' : row.tone === 'bad' ? 'bad' : row.tone === 'warn' ? 'warn' : 'mono'}>
                  {row.value}
                </span>
                {row.note ? <div className="note">{row.note}</div> : null}
              </td>
            </tr>
          ))}
          <tr>
            <th>generator</th>
            <td>
              <span className={bench.tone === 'ok' ? 'ok' : bench.tone === 'warn' ? 'warn' : 'note'}>
                {bench.text}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
