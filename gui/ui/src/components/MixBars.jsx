import React from 'react';

/*
 * The mix, as it will actually be generated: share of the peak per class, in req/s. This is the number
 * people get wrong when they reason about a load test — "60 req/s" is not 60 page loads, it is 60 user
 * requests split by weights measured on an edge log.
 */
export default function MixBars({ classes, peak }) {
  if (!classes || !classes.length) return null;
  const max = Math.max(...classes.map((c) => c.share));
  return (
    <div className="mix">
      <div className="mix-head">
        Mix at {peak} req/s
        <span className="note">weights come from your own edge log — a class with an empty pool is dropped and the rest renormalised</span>
      </div>
      {classes.map((c) => (
        <div className="mix-row" key={c.name}>
          <span className="mix-name mono">{c.name}</span>
          <span className="mix-bar">
            <span className={c.kind === 'rsc' ? 'fill rsc' : 'fill'} style={{ width: `${(c.share / max) * 100}%` }} />
          </span>
          <span className="mix-val mono">{(c.share * peak).toFixed(1)} req/s</span>
          <span className="mix-pct mono">{(c.share * 100).toFixed(1)}%</span>
          <span className="mix-pool note">
            {c.pool}{c.pool_size === null ? ' (@file)' : ` (${c.pool_size} urls)`}
            {c.pool_size === 0 ? ' — empty: class will be dropped' : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
