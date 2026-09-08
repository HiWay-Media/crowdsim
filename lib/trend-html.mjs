/*
 * trend-html.mjs — the knee over time, as a page somebody can be handed.
 *
 * WHY THIS EXISTS — `crowdsim history` exists to answer one question, *does the knee move*, and answered
 * it as a table. The GUI plots it; the CLI had nothing to hand over, and `report --html` draws exactly one
 * run. So the trend — the only claim in this tool that survives its own caveat about absolutes being
 * optimistic, because a delta at an identical pool is what a change should be judged on — was the one
 * thing that could not be attached to a ticket.
 *
 * THE REFUSALS ARE THE POINT, as everywhere else here. Runs at a different profile, target, shape or
 * fan-out are not points on one line: they are different experiments, and a line through them is a
 * picture of nothing. The fan-out rule comes from k6/lib/delivery.js rather than a second copy, because
 * one of them changing must not leave this page behind.
 *
 * Same shell, stylesheet and geometry as the run report (lib/report-html.mjs): one self-contained file,
 * no scripts, nothing fetched.
 */
import { comparableFanOut } from '../k6/lib/delivery.js';
import { esc, page, niceCeil, linear, W, H, PAD } from './report-html.mjs';

const num = (v) => (v === null || v === undefined || !isFinite(Number(v)) ? null : Number(v));

/** Runs at the same profile, target and shape belong to one experiment. */
function groupKey(r) {
  return [r.profile || '', r.base_url || '', r.shape || ''].join(' ');
}

/**
 * Split the runs into series that can honestly share a line, and say what was left out and why.
 *
 * A discard never joins a line: `generator_ok: false` means no step measured the rate it claims, so its
 * knee — if it even has one — is not a point about the system.
 */
export function comparableRuns(rows) {
  const runs = (rows || []).filter(Boolean);
  const refused = [];
  const groups = new Map();

  for (const r of runs) {
    if (r.generator_ok === false) {
      refused.push({
        run_id: r.run_id,
        why: 'the generator did not hold the requested rate, so no step measured the rate it claims: '
          + 'this run is a discard, not a point.',
      });
      continue;
    }
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const series = [];
  for (const [, list] of groups) {
    const sorted = list.slice().sort((a, b) => String(a.run_id).localeCompare(String(b.run_id)));
    const kept = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      // Against the FIRST kept run, not the previous one: a series is only comparable end to end, and
      // comparing each to its neighbour would let a fan-out drift across the whole line one step at a
      // time.
      const verdict = comparableFanOut(kept[0].fan_out, sorted[i].fan_out);
      if (verdict.comparable === true) kept.push(sorted[i]);
      else refused.push({ run_id: sorted[i].run_id, why: verdict.reason });
    }
    series.push({
      profile: sorted[0].profile,
      base_url: sorted[0].base_url,
      shape: sorted[0].shape,
      fan_out: num(sorted[0].fan_out),
      runs: kept,
    });
  }
  return { series, refused };
}

/**
 * One point per run: both rates, because a knee is two numbers — what the ramp asked for and what
 * arrived. A refused or absent knee is `null`, never 0: a knee of zero req/s is a claim about the system,
 * and *this run could not support one* is a different statement.
 */
export function trendSeries(runs) {
  return (runs || []).map((r) => ({
    run_id: r.run_id,
    clean: num(r.knee_clean),
    clean_delivered: num(r.knee_clean_delivered),
    crossed: num(r.knee_crossed),
    crossed_delivered: num(r.knee_crossed_delivered),
    peak: num(r.peak),
    aborted: r.aborted === true,
  }));
}

function chart(points) {
  const withKnee = points.filter((p) => p.clean !== null || p.crossed !== null);
  if (withKnee.length < 2) return '';
  const vals = [];
  for (const p of withKnee) {
    for (const v of [p.clean, p.crossed, p.clean_delivered, p.crossed_delivered]) {
      if (v !== null) vals.push(v);
    }
  }
  const yMax = niceCeil(Math.max(...vals) * 1.1) || 1;
  const x = linear([0, Math.max(1, points.length - 1)], [PAD.left, W - PAD.right]);
  const y = linear([0, yMax], [H - PAD.bottom, PAD.top]);

  // Segments, so a run whose knee was refused breaks the line instead of being spanned. Interpolating
  // across it would draw a knee for a run that had none.
  const segments = [];
  let current = [];
  points.forEach((p, i) => {
    if (p.clean === null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push(`${x(i).toFixed(1)},${y(p.clean).toFixed(1)}`);
  });
  if (current.length) segments.push(current);

  const lines = segments.filter((s) => s.length > 1)
    .map((s) => `<polyline class="series-line" fill="none" points="${s.join(' ')}"/>`).join('');
  const dots = points.map((p, i) => {
    if (p.clean === null) {
      return `<text class="tick" x="${x(i).toFixed(1)}" y="${H - PAD.bottom - 6}" text-anchor="middle">`
        + `—<title>${esc(p.run_id)}: no knee from this run</title></text>`;
    }
    const delivered = p.clean_delivered === null ? '' : ` to ${p.clean_delivered} delivered`;
    return `<circle class="series-pt" cx="${x(i).toFixed(1)}" cy="${y(p.clean).toFixed(1)}" r="3">`
      + `<title>${esc(p.run_id)}: clean up to ${p.clean} req/s requested${delivered}`
      + `${p.crossed === null ? ', never crossed' : `, crossed at ${p.crossed}`}</title></circle>`;
  }).join('');
  const labels = points.map((p, i) => `<text class="tick" x="${x(i).toFixed(1)}" `
    + `y="${H - PAD.bottom + 14}" text-anchor="middle">${esc(String(p.run_id).slice(0, 8))}</text>`)
    .join('');

  const desc = points.map((p) => `${p.run_id}: `
    + (p.clean === null ? 'no knee' : `clean ${p.clean}`)).join('; ');
  return `<figure class="chart">\n<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="tr-t tr-d">`
    + '<title id="tr-t">the highest rate each run stayed inside its SLO at</title>'
    + `<desc id="tr-d">${esc(desc)}</desc>`
    + `<line class="axis" x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" `
    + `y2="${H - PAD.bottom}"/>`
    + labels + lines + dots
    + `<text class="axis-label" x="${PAD.left}" y="${PAD.top - 10}">requested req/s the run stayed clean `
    + `up to (0-${yMax}) - hover a point for what arrived</text>`
    + '</svg>\n</figure>';
}

function table(rows) {
  const head = ['run', 'clean (requested to delivered)', 'crossed', 'peak asked for'];
  const body = rows.map((p) => [
    p.run_id,
    p.clean === null ? '—'
      : `${p.clean}${p.clean_delivered === null ? '' : ` to ${p.clean_delivered}`}`,
    p.crossed === null ? '—'
      : `${p.crossed}${p.crossed_delivered === null ? '' : ` to ${p.crossed_delivered}`}`,
    p.peak === null ? '—' : String(p.peak),
  ]);
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>`
    + body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
    + '</tbody></table>';
}

function footer(o, n) {
  return `<footer>Written by <strong>${esc(o.generatedBy || 'crowdsim')}</strong> from `
    + `<code>history.tsv</code> (${n} run${n === 1 ? '' : 's'}). Self-contained: no scripts, no fonts, `
    + 'nothing fetched, so it renders the same offline in a year.</footer>';
}

/** The page. `rows` are history records — the same shape `crowdsim history --json` returns. */
export function buildTrend(rows, opts) {
  const o = opts || {};
  const parts = ['<h1>crowdsim: does the knee move?</h1>'];

  if (!rows || !rows.length) {
    parts.push('<div class="banner warn"><strong>No runs to draw.</strong> This archive holds nothing '
      + 'that can be put on a line yet. <code>crowdsim history</code> lists what it does hold.</div>');
    return page('crowdsim: no runs', parts, footer(o, 0));
  }

  const { series, refused } = comparableRuns(rows);
  parts.push('<p class="sub">One line per experiment. Runs at a different profile, target, shape or '
    + 'fan-out are not points on one line: they are different experiments, and this page separates them '
    + 'rather than averaging them.</p>');

  for (const s of series) {
    const points = trendSeries(s.runs);
    parts.push(`<h2>${esc(s.profile || 'unnamed')}: ${esc(s.base_url || 'no target')} `
      + `<span class="note">shape ${esc(s.shape || '?')}`
      + `${s.fan_out === null ? '' : `, fan-out ${s.fan_out}x`}</span></h2>`);
    if (points.length < 2) {
      parts.push('<div class="banner info"><strong>One run is not a trend.</strong> A line through a '
        + 'single point is a straight line through one measurement, which is the same mistake this tool '
        + 'refuses when it will not read a knee off one step. At least two comparable runs are needed.'
        + '</div>');
    } else {
      parts.push(chart(points));
    }
    parts.push(table(points));
  }

  if (refused.length) {
    parts.push('<h2>Left out, and why</h2>');
    parts.push('<p class="note">Each of these is a run this archive holds and this page will not draw '
      + 'on a line with the others.</p>');
    parts.push('<ul class="caveats">'
      + refused.map((r) => `<li><code>${esc(r.run_id)}</code>: ${esc(r.why)}</li>`).join('')
      + '</ul>');
  }

  parts.push('<ul class="caveats">'
    + '<li>The rates are what the ramp <strong>asked for</strong>; the second number in each cell is what '
    + 'arrived at the target. A knee quoted as the first when the system fell over at the second is wrong '
    + 'in the direction that gets capacity bought.</li>'
    + '<li>A run with no knee is a <strong>gap</strong>, not a zero. A knee of 0 req/s would be a claim '
    + 'about the system; <em>this run could not support one</em> is a different statement.</li>'
    + '<li>These are knees <strong>at their own URL pools</strong>. The trend is the honest part; the '
    + 'absolutes are optimistic, because a synthetic pool of cold URLs is a harder test than real '
    + 'traffic.</li>'
    + '</ul>');

  return page('crowdsim: does the knee move?', parts, footer(o, rows.length));
}
