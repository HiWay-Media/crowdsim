/*
 * compare-html.mjs — the delta between two runs, drawn.
 *
 * WHY THIS EXISTS — this tool measures deltas honestly and absolutes optimistically, and says so in its
 * own source: a synthetic pool of cold URLs is a harder test than real traffic, so *p95 was 240 ms*
 * travels badly and *p95 fell 38% after the cache change* is the claim worth making. That claim had no
 * picture. `report --html` refuses to draw two runs — *"--html reports one run. A delta between two runs
 * is `crowdsim compare`"* — and it is right for the reason it gives: two runs on one pair of axes without
 * compare's refusals is a picture of two different experiments. That is not an argument against drawing
 * them WITH those refusals.
 *
 * SO THE REFUSALS COME FROM `compare` ITSELF. This file consumes exactly what `compare --json` prints,
 * which means there is no second implementation of *are these two comparable* to fall out of step: if a
 * refusal is added to compare, this page stops drawing without being told.
 *
 * The delta is drawn AS A DELTA. Two absolute bars would leave the reader subtracting by eye, which is
 * the one number this whole tool is confident about.
 *
 * Same shell, stylesheet and geometry as the run report: one self-contained file, no scripts, nothing
 * fetched.
 */
import { esc, page, W, PAD } from './report-html.mjs';

const pct = (v) => `${(v * 100).toFixed(1)}%`;

/** A refusal as compare prints it: a [why, fix[]] pair, or an object. Both shapes are read. */
function refusalText(r) {
  if (Array.isArray(r)) return String(r[0]);
  if (r && typeof r === 'object') return String(r.why || r.reason || JSON.stringify(r));
  return String(r);
}

function runLine(label, run) {
  const r = run || {};
  return `<li><strong>${esc(label)}</strong> <code>${esc(r.run_id)}</code> — profile `
    + `${esc(r.profile)}, target ${esc(r.base_url)}, shape ${esc(r.shape)}, peak asked for `
    + `${esc(r.peak)} req/s${r.aborted ? ', the brake aborted it' : ''}`
    + `${r.generator_ok === false ? ', <em>the generator did not hold the rate</em>' : ''}</li>`;
}

/**
 * One horizontal bar per metric, drawn from the RELATIVE change and centred on zero: left is better,
 * right is worse, and the zero line is where nothing moved. A metric with no relative change (a zero
 * baseline, or an absent number) is drawn as a mark on that line and labelled, never as a bar of zero
 * width that reads as "no data".
 */
function deltaChart(metrics) {
  const rows = (metrics || []).filter((m) => m && m.label);
  if (!rows.length) return '';
  const rels = rows.map((m) => (m.relative === null || m.relative === undefined
    ? 0 : Math.abs(Number(m.relative)))).filter((v) => isFinite(v));
  const span = Math.max(0.1, ...rels);
  const rowH = 30;
  const height = PAD.top + rows.length * rowH + 30;
  const mid = (PAD.left + 90 + (W - PAD.right)) / 2;
  const half = (W - PAD.right - (PAD.left + 90)) / 2;

  const bars = rows.map((m, i) => {
    const y = PAD.top + i * rowH;
    const rel = m.relative === null || m.relative === undefined ? null : Number(m.relative);
    const label = `<text class="tick" x="${PAD.left + 84}" y="${y + 12}" text-anchor="end">`
      + `${esc(m.label)}</text>`;
    if (rel === null || !isFinite(rel) || rel === 0) {
      return label
        + `<circle class="delta same" cx="${mid.toFixed(1)}" cy="${y + 8}" r="4">`
        + `<title>${esc(m.label)}: ${esc(String(m.a))} to ${esc(String(m.b))} ${esc(m.unit || '')} — `
        + 'unchanged</title></circle>'
        + `<text class="bar-value" x="${(mid + 10).toFixed(1)}" y="${y + 12}">unchanged</text>`;
    }
    const w = Math.max(2, (Math.abs(rel) / span) * half);
    const x = rel < 0 ? mid - w : mid;
    const cls = m.verdict === 'better' ? 'better' : (m.verdict === 'worse' ? 'worse' : 'same');
    return label
      + `<rect class="delta ${cls}" x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="16">`
      + `<title>${esc(m.label)}: ${esc(String(m.a))} to ${esc(String(m.b))} ${esc(m.unit || '')} — `
      + `${esc(m.verdict || '')} by ${esc(pct(Math.abs(rel)))}</title></rect>`
      + `<text class="bar-value" x="${(rel < 0 ? x - 6 : x + w + 6).toFixed(1)}" y="${y + 12}" `
      + `text-anchor="${rel < 0 ? 'end' : 'start'}">${esc(pct(Math.abs(rel)))} ${esc(cls)}</text>`;
  }).join('');

  const desc = rows.map((m) => `${m.label}: ${m.a} to ${m.b} ${m.unit || ''} (${m.verdict})`).join('; ');
  return `<figure class="chart">\n<svg viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="cd-t cd-d">`
    + '<title id="cd-t">the change from the baseline run to the other, per metric</title>'
    + `<desc id="cd-d">${esc(desc)}</desc>`
    + `<line class="axis" x1="${mid.toFixed(1)}" y1="${PAD.top - 6}" x2="${mid.toFixed(1)}" `
    + `y2="${height - 30}"/>`
    + bars
    + `<text class="axis-label" x="${(mid - half).toFixed(1)}" y="${height - 6}">better</text>`
    + `<text class="axis-label" x="${(mid + half).toFixed(1)}" y="${height - 6}" text-anchor="end">`
    + 'worse</text>'
    + '</svg>\n</figure>';
}

function metricTable(title, rows) {
  if (!rows || !rows.length) return '';
  const head = ['metric', 'baseline', 'other', 'change', ''];
  const body = rows.map((m) => [
    m.label, String(m.a), String(m.b),
    m.relative === null || m.relative === undefined ? '—' : pct(Number(m.relative)),
    m.verdict || '',
  ]);
  return `<h3>${esc(title)}</h3><table><thead><tr>`
    + head.map((h) => `<th>${esc(h)}</th>`).join('') + '</tr></thead><tbody>'
    + body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
    + '</tbody></table>';
}

function footer(o) {
  return `<footer>Written by <strong>${esc(o.generatedBy || 'crowdsim')}</strong> from `
    + '<code>crowdsim compare --json</code>, so the refusals on this page are the command\'s own. '
    + 'Self-contained: no scripts, no fonts, nothing fetched.</footer>';
}

/** The page. `cmp` is exactly what `crowdsim compare a b --json` prints. */
export function buildCompare(cmp, opts) {
  const o = opts || {};
  const parts = ['<h1>crowdsim: the delta between two runs</h1>'];

  if (!cmp || !cmp.a || !cmp.b) {
    parts.push('<div class="banner bad"><strong>Nothing to compare.</strong> This page is drawn from '
      + '<code>crowdsim compare --json</code>, and that produced no pair of runs.</div>');
    return page('crowdsim: nothing to compare', parts, footer(o));
  }

  parts.push('<ul class="caveats">' + runLine('baseline', cmp.a) + runLine('other', cmp.b) + '</ul>');

  const refused = cmp.refused || [];
  if (refused.length) {
    // The whole reason `report --html` would not draw two runs. Nothing is drawn here either: a picture
    // of two different experiments is worse than no picture, because it looks like an answer.
    parts.push('<div class="banner bad"><strong>These runs are not comparable, so nothing is drawn.</strong> '
      + 'A delta between two different experiments looks exactly like a delta between two systems, which '
      + 'is why this is a refusal and not a footnote.</div>');
    parts.push('<ul class="caveats">'
      + refused.map((r) => `<li>${esc(refusalText(r))}</li>`).join('')
      + '</ul>');
    return page('crowdsim: not comparable', parts, footer(o));
  }

  if ((cmp.warnings || []).length) {
    parts.push('<div class="banner warn"><strong>Read these first.</strong> They do not stop the '
      + 'comparison, and they change what it is worth.</div>');
    parts.push('<ul class="caveats">'
      + cmp.warnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>');
  }

  parts.push('<h2>Overall</h2>');
  parts.push('<p class="note">Each bar is the <strong>change</strong>, not the two absolute numbers: the '
    + 'delta is the honest part here, and two absolute bars would leave it to be worked out by eye.</p>');
  parts.push(deltaChart(cmp.overall));
  parts.push(metricTable('the same numbers', cmp.overall));

  if ((cmp.per_class || []).length) {
    parts.push('<h2>Per class</h2>');
    parts.push(deltaChart(cmp.per_class));
    parts.push(metricTable('the same numbers', cmp.per_class));
  }
  if ((cmp.layers || []).length) {
    parts.push('<h2>Cache, per layer</h2>');
    parts.push(metricTable('hit ratio', cmp.layers));
  }
  if ((cmp.notes || []).length) {
    parts.push('<ul class="caveats">' + cmp.notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>');
  }

  parts.push('<ul class="caveats">'
    + '<li>This is a delta at the <strong>same pool</strong>, which is the only condition under which two '
    + 'runs are comparable at all — and it is checked, not assumed.</li>'
    + '<li>The absolutes on both sides come from a <strong>synthetic pool of cold URLs</strong>, which is '
    + 'a harder test than the traffic real visitors produce. The delta travels; the absolutes do not.</li>'
    + '<li>The baseline is the first run named on the command line. Swapping them changes every sign on '
    + 'this page and nothing else.</li>'
    + '</ul>');

  return page('crowdsim: the delta between two runs', parts, footer(o));
}
