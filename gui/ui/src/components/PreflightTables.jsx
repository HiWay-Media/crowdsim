import React from 'react';

/*
 * probe and discover, read as data.
 *
 * These two commands answer the question that decides whether a load run is worth starting: did the layer
 * you think you are measuring actually answer, and are the URLs you are about to fire real. Both used to be
 * shown as terminal output, which meant re-reading curl headers to find out.
 *
 * Everything below comes from out/probe-<run>.json and out/discover-<run>.json, written by the driver. The
 * page computes no verdicts of its own — a table that disagreed with the file the next run reads back would
 * be two answers to one question.
 */

export function ProbeTable({ probe }) {
  if (!probe) return null;
  const layers = probe.layers || [];
  const absent = layers.filter((l) => l.hit === null);
  const kb = probe.bytes ? (probe.bytes / 1024).toFixed(1) : '0';

  return (
    <section className="card wide">
      <h2>Preflight <span className="note">from probe-{probe.run_id}.json</span></h2>

      <table className="kv">
        <tbody>
          <tr><th>base url</th><td className="mono">{probe.base_url}</td></tr>
          <tr><th>path</th><td className="mono">{probe.path}</td></tr>
          <tr>
            <th>status</th>
            <td className={probe.status >= 400 || !probe.status ? 'bad' : 'ok'}>
              {probe.status || 'no answer'}
            </td>
          </tr>
          <tr><th>ttfb</th><td>{probe.ttfb_s}s</td></tr>
          <tr>
            <th>page weight</th>
            <td>
              {kb} KB
              <span className="note"> — this is what a peak is multiplied by to estimate the bandwidth a run needs</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h3>The layers this profile declares</h3>
      {layers.length ? (
        <table className="data">
          <thead>
            <tr><th>layer</th><th>header</th><th>what it said</th><th>counts as</th></tr>
          </thead>
          <tbody>
            {layers.map((l) => (
              <tr key={l.label}>
                <td>{l.label}</td>
                <td className="mono">{l.header}</td>
                <td className="mono">{l.value === null ? <span className="note">not present</span> : l.value}</td>
                <td>
                  {l.hit === null
                    ? <span className="warn">unknown</span>
                    : l.hit
                      ? <span className="ok">HIT</span>
                      : <span className="note">MISS</span>}
                  <span className="note"> /{l.hit_pattern}/i</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="note">This profile declares no <code>cache_headers</code>, so no layer can be reported.</p>
      )}

      {absent.length ? (
        <div className="banner warn">
          <strong>{absent.length} declared header{absent.length > 1 ? 's' : ''} never appeared
            ({absent.map((l) => l.header).join(', ')}).</strong>
          <p>
            That is usually the wrong header <em>name</em> in the profile rather than a cold cache. A layer
            that never speaks is reported as unknown and never as a miss, so it cannot quietly drag a hit
            ratio to zero — but it also means this run measures nothing about that layer.
          </p>
        </div>
      ) : null}
    </section>
  );
}

export function DiscoverTable({ discover }) {
  if (!discover) return null;
  const dropped = discover.dropped || [];
  const kept = discover.kept === null || discover.kept === undefined ? discover.distinct : discover.kept;

  return (
    <section className="card wide">
      <h2>The pool this would write <span className="note">from discover-{discover.run_id}.json</span></h2>

      <table className="kv">
        <tbody>
          <tr><th>sitemap</th><td className="mono">{discover.sitemap}</td></tr>
          <tr><th>pool file</th><td className="mono">{discover.pool_path}</td></tr>
          <tr>
            <th>found</th>
            <td>{discover.loc_entries} sitemap entries → {discover.distinct} distinct paths
              {discover.limit ? <span className="note"> (limit {discover.limit})</span> : null}</td>
          </tr>
          <tr>
            <th>verified</th>
            <td>
              {discover.verified
                ? <span className="ok">yes — {kept} of {discover.distinct} render</span>
                : <span className="warn">no. Nobody has asked these paths whether they render: run discover
                  again with verification before a load run uses them.</span>}
            </td>
          </tr>
        </tbody>
      </table>

      {dropped.length ? (
        <>
          <h3>Dropped, and why</h3>
          <p className="note">
            A 404 is cheap for the app tier — or is itself rendered — and a 3xx measures a redirect. Either
            one in a pool produces a flattering number for load that never reached the renderer.
          </p>
          <table className="data">
            <thead><tr><th>path</th><th>reason</th><th>status</th></tr></thead>
            <tbody>
              {dropped.map((d) => (
                <tr key={d.path}>
                  <td className="mono">{d.path}</td>
                  <td>{d.reason}</td>
                  <td className="mono">{d.status === null || d.status === undefined ? '—' : d.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : discover.verified ? (
        <div className="banner ok">Every discovered path renders. Nothing was dropped.</div>
      ) : null}

      <p className="note">
        Regenerate after every deploy: a static-asset pool contains build hashes, and a stale pool measures
        404s at full speed.
      </p>
    </section>
  );
}
