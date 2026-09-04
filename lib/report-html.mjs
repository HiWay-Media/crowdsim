/*
 * report-html.mjs — one run as a page with charts, and the refusals that stop a chart from lying.
 *
 * `crowdsim report` writes markdown, which is where a result belongs when it is going into a ticket. What it
 * cannot do is show the SHAPE of a ramp, and the shape is the whole point of this tool: the numbers that
 * matter are a curve — rate against latency, per step — and a table of eight rows asks the reader to draw it
 * in their head. The GUI has drawn it since 1.17.0, and only the GUI: the moment a result leaves the page it
 * went back to being a table.
 *
 * Everything here is PURE — summary object in, HTML string out. No fs, no network, no dates, no randomness.
 * That is what makes the chart geometry testable, and geometry is exactly the part that fails silently: an
 * axis whose scale is wrong produces a beautiful, confident, wrong picture.
 *
 * Five rules, each one a way a chart could mislead, and each one tested:
 *
 *  1. **An invalid run gets no performance charts.** `generator_ok: false` means no step measured the rate it
 *     claims, so a latency curve drawn from it is the most persuasive wrong answer this tool could produce.
 *     What such a run DOES get is the one chart that shows why it is invalid: requested rate against achieved
 *     rate. Same for a target that never answered — a p95 of ~0 ms is not a fast system.
 *  2. **A threshold line is drawn only when the run recorded the threshold.** `summary.slo` exists from
 *     1.19.0; a run archived before that has no SLO line and the page says so. A line at a guessed limit
 *     moves the knee for the reader.
 *  3. **A partial step is drawn as a partial step.** The brake fires while latency is climbing, so the step
 *     it fired in is a fraction of one, biased towards its worst part. Hollow marker, dashed segment, and a
 *     note — not an ordinary point on the curve.
 *  4. **`unknown` is not a miss and not 0%.** A cache layer whose header never appeared has no hit ratio at
 *     all; a zero bar would read as a cache that answered and missed every time, which is usually a wrong
 *     header name in the profile.
 *  5. **Nothing is fetched.** No script, no stylesheet, no font, no image: a report that needs the network to
 *     render is not an attachment. Asserted by a test that greps the output.
 *
 * ES modules, node >= 18. Not loaded by k6, so ES2020+ is fine here — unlike k6/lib/*.
 */

// ── text ─────────────────────────────────────────────────────────────────────────────────────────────

export function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ms = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v)} ms`);
const pct = (v) => (v === null || v === undefined ? 'unknown' : `${(v * 100).toFixed(2)}%`);
const num = (v) => (v === null || v === undefined ? 'n/a' : String(v));

/** The label a step carries on an axis: a climbing step swept a range, only the hold held a rate. */
export function stepLabel(row) {
  if (!row) return '';
  if (row.is_hold || row.sustained) return `${row.requested_rps} held`;
  if (row.from_rps !== undefined && row.from_rps !== null && row.from_rps !== row.requested_rps) {
    return `${row.from_rps}→${row.requested_rps}`;
  }
  return String(row.requested_rps);
}

// ── scales ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A round upper bound at or above `v`, so an axis ends on a number somebody would say out loud. Returns 1
 * for a non-positive domain: an axis from 0 to 0 has no height and every point lands on the baseline.
 */
export function niceCeil(v) {
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(x));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (x <= step * mag) return step * mag;
  }
  return 10 * mag;
}

/** `count` evenly spaced values from 0 to max, trimmed of floating-point noise. */
export function ticks(max, count) {
  const n = Math.max(2, count || 5);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(Math.round((max * i) / n * 1000) / 1000);
  return out;
}

/** A linear map from a numeric domain to a pixel range. */
export function linear(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (v) => (span === 0 ? r0 : r0 + ((Number(v) - d0) / span) * (r1 - r0));
}

// ── chart plumbing ───────────────────────────────────────────────────────────────────────────────────

const W = 760;
const H = 300;
const PAD = { top: 24, right: 96, bottom: 52, left: 62 };
const PLOT = { x0: PAD.left, x1: W - PAD.right, y0: PAD.top, y1: H - PAD.bottom };

/**
 * The frame every chart shares: a y axis with ticks and gridlines, an x axis with categorical labels, and
 * an accessible title and description. `desc` is not decoration — it is what a screen reader gets, and what
 * a reader gets when the SVG does not render at all.
 */
function frame(opts) {
  const o = opts;
  const yScale = linear([0, o.yMax], [PLOT.y1, PLOT.y0]);
  const grid = ticks(o.yMax, o.yTicks || 4).map((t) => {
    const y = yScale(t).toFixed(1);
    return `<line class="grid" x1="${PLOT.x0}" x2="${PLOT.x1}" y1="${y}" y2="${y}"/>`
      + `<text class="tick" x="${PLOT.x0 - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">`
      + `${esc(o.yFormat ? o.yFormat(t) : t)}</text>`;
  }).join('');
  const xLabels = o.xLabels.map((label, i) => {
    const x = o.xAt(i).toFixed(1);
    return `<text class="tick" x="${x}" y="${PLOT.y1 + 18}" text-anchor="middle">${esc(label)}</text>`;
  }).join('');
  return {
    yScale,
    open: `<figure class="chart">\n<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${o.id}-t ${o.id}-d">`
      + `<title id="${o.id}-t">${esc(o.title)}</title><desc id="${o.id}-d">${esc(o.desc)}</desc>`
      + grid
      + `<line class="axis" x1="${PLOT.x0}" x2="${PLOT.x1}" y1="${PLOT.y1}" y2="${PLOT.y1}"/>`
      + `<line class="axis" x1="${PLOT.x0}" x2="${PLOT.x0}" y1="${PLOT.y0}" y2="${PLOT.y1}"/>`
      + xLabels
      + `<text class="axis-label" x="${PLOT.x0}" y="${PLOT.y0 - 10}">${esc(o.yLabel)}</text>`
      + `<text class="axis-label" x="${PLOT.x1}" y="${H - 8}" text-anchor="end">${esc(o.xLabel)}</text>`,
    close: '</svg>\n</figure>',
  };
}

/** A dashed horizontal rule at a threshold, with its name at the right-hand margin. */
function threshold(yScale, value, yMax, label, cls) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  if (Number(value) > yMax) return '';       // off the top: drawing it at the edge would be a lie of scale
  const y = yScale(value);
  // The label sits just ABOVE its line rather than centred on it: a point at that same latency lands on the
  // right-hand edge, and a centred label collided with it — visible in the first screenshot taken for the
  // documentation, which is why the screenshot is taken.
  return `<line class="${cls}" x1="${PLOT.x0}" x2="${PLOT.x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`
    + `<text class="${cls}-label" x="${PLOT.x1 + 8}" y="${(y - 4).toFixed(1)}">${esc(label)}</text>`;
}

// ── 1. the ramp: where the knee is ───────────────────────────────────────────────────────────────────

/**
 * The y domain of the ramp chart, and which thresholds do not fit on it.
 *
 * The SLO is always part of the domain: a chart scaled to the data alone hides how far above the limit the
 * run went, and can put the limit line off the top and drop it. The read timeout is different — it is
 * routinely ten times the p95, and forcing it into the domain would squash the whole curve into the bottom
 * of the picture to make room for a line nothing came near. So it joins the domain only when it is close,
 * and otherwise it is reported as **hidden**: `buildReport` says so under the chart, because a threshold
 * that silently is not drawn is a threshold the reader assumes was never crossed.
 */
export function rampDomain(rows, opts) {
  const o = opts || {};
  const peak = Math.max(...rows.map((r) => r.p95));
  const values = [peak];
  if (o.maxP95) values.push(Number(o.maxP95));
  const guillotine = o.guillotineMs ? Number(o.guillotineMs) : null;
  if (guillotine !== null && guillotine <= peak * 1.35) values.push(guillotine);
  const yMax = niceCeil(Math.max(...values) * 1.1);
  const hidden = [];
  if (guillotine !== null && guillotine > yMax) {
    hidden.push({ name: 'read timeout', value: guillotine });
  }
  if (o.maxP95 && Number(o.maxP95) > yMax) hidden.push({ name: 'SLO', value: Number(o.maxP95) });
  return { yMax, hidden };
}


/**
 * p95 per step, with the SLO, the read timeout and the knee band. This is the chart the tool is named
 * after: one run, one curve, and the rate at which the curve left the SLO.
 *
 * opts: { maxP95, guillotineMs, knee }
 */
export function rampChart(perStep, opts) {
  const rows = (perStep || []).filter((r) => r && r.p95 !== null && r.p95 !== undefined);
  if (rows.length < 1) return '';
  const o = opts || {};
  const { yMax } = rampDomain(rows, o);
  const xAt = (i) => (rows.length === 1
    ? (PLOT.x0 + PLOT.x1) / 2
    : PLOT.x0 + ((PLOT.x1 - PLOT.x0) * i) / (rows.length - 1));

  const knee = o.knee && !o.knee.refused ? o.knee : null;
  const idxOf = (step) => rows.findIndex((r) => r.step === step);
  const cleanIdx = knee && knee.clean ? idxOf(knee.clean.step) : -1;
  const crossedIdx = knee && knee.crossed ? idxOf(knee.crossed.step) : -1;

  const f = frame({
    id: 'ramp',
    title: 'p95 latency per ramp step',
    desc: rows.map((r) => `${stepLabel(r)} req/s: p95 ${Math.round(r.p95)} ms`
      + (r.partial ? ' (partial step)' : '')).join('; '),
    yMax,
    yLabel: 'p95 (ms)',
    xLabel: 'requested rate (req/s)',
    xLabels: rows.map(stepLabel),
    xAt,
  });

  let band = '';
  if (cleanIdx !== -1 && crossedIdx !== -1) {
    const x = xAt(cleanIdx);
    const w = xAt(crossedIdx) - x;
    band = `<rect class="knee-band" x="${x.toFixed(1)}" y="${PLOT.y0}" width="${w.toFixed(1)}" `
      + `height="${PLOT.y1 - PLOT.y0}"/>`
      + `<text class="knee-label" x="${(x + w / 2).toFixed(1)}" y="${PLOT.y0 + 12}" text-anchor="middle">`
      + 'the knee is in here</text>';
  }

  // Segments, not one polyline: the segment leading into a partial step is dashed, because its endpoint is
  // a fraction of a step rather than a measurement of its rate.
  let segments = '';
  for (let i = 1; i < rows.length; i++) {
    const cls = rows[i].partial || rows[i - 1].partial ? 'line partial' : 'line';
    segments += `<line class="${cls}" x1="${xAt(i - 1).toFixed(1)}" y1="${f.yScale(rows[i - 1].p95).toFixed(1)}"`
      + ` x2="${xAt(i).toFixed(1)}" y2="${f.yScale(rows[i].p95).toFixed(1)}"/>`;
  }
  const points = rows.map((r, i) => {
    const x = xAt(i).toFixed(1);
    const y = f.yScale(r.p95).toFixed(1);
    const cls = r.partial ? 'pt partial' : (i === crossedIdx ? 'pt crossed' : 'pt');
    return `<circle class="${cls}" cx="${x}" cy="${y}" r="5"><title>${esc(stepLabel(r))} req/s — p95 `
      + `${Math.round(r.p95)} ms, achieved ${num(r.achieved_rps)} req/s`
      + `${r.partial ? ', PARTIAL step' : ''}</title></circle>`;
  }).join('');

  return f.open + band + segments + points
    + threshold(f.yScale, o.maxP95, yMax, `SLO ${o.maxP95} ms`, 'slo')
    + threshold(f.yScale, o.guillotineMs, yMax, `504 at ${o.guillotineMs} ms`, 'guillotine')
    + f.close;
}

// ── 2. requested against achieved: the generator's own ceiling ───────────────────────────────────────

/**
 * The chart an invalid run gets, and the only one. A generator that could not deliver the rate produces a
 * latency curve that is a picture of the generator, not of the target — and it looks exactly like a healthy
 * system absorbing load.
 */
export function rateChart(perStep) {
  const rows = (perStep || []).filter((r) => r && r.requested_rps);
  if (!rows.length) return '';
  const yMax = niceCeil(Math.max(...rows.map((r) => Math.max(r.requested_rps, r.achieved_rps || 0))) * 1.1);
  const slot = (PLOT.x1 - PLOT.x0) / rows.length;
  const xAt = (i) => PLOT.x0 + slot * (i + 0.5);
  const f = frame({
    id: 'rate',
    title: 'requested rate against the rate the generator delivered',
    desc: rows.map((r) => `${stepLabel(r)}: asked ${r.requested_rps}, delivered ${num(r.achieved_rps)}`)
      .join('; '),
    yMax,
    yLabel: 'req/s',
    xLabel: 'step',
    xLabels: rows.map(stepLabel),
    xAt,
  });
  const bars = rows.map((r, i) => {
    const bw = Math.max(6, slot * 0.28);
    const asked = `<rect class="bar asked" x="${(xAt(i) - bw).toFixed(1)}" y="${f.yScale(r.requested_rps).toFixed(1)}"`
      + ` width="${bw.toFixed(1)}" height="${(PLOT.y1 - f.yScale(r.requested_rps)).toFixed(1)}">`
      + `<title>${esc(stepLabel(r))}: asked ${r.requested_rps} req/s</title></rect>`;
    const got = r.achieved_rps === null || r.achieved_rps === undefined ? '' :
      `<rect class="bar got" x="${xAt(i).toFixed(1)}" y="${f.yScale(r.achieved_rps).toFixed(1)}"`
      + ` width="${bw.toFixed(1)}" height="${(PLOT.y1 - f.yScale(r.achieved_rps)).toFixed(1)}">`
      + `<title>${esc(stepLabel(r))}: delivered ${r.achieved_rps} req/s</title></rect>`;
    return asked + got;
  }).join('');
  const legend = `<g class="legend"><rect class="bar asked" x="${PLOT.x1 + 8}" y="${PLOT.y0}" width="10" height="10"/>`
    + `<text class="tick" x="${PLOT.x1 + 22}" y="${PLOT.y0 + 9}">asked</text>`
    + `<rect class="bar got" x="${PLOT.x1 + 8}" y="${PLOT.y0 + 18}" width="10" height="10"/>`
    + `<text class="tick" x="${PLOT.x1 + 22}" y="${PLOT.y0 + 27}">got</text></g>`;
  return f.open + bars + legend + f.close;
}

// ── 3. per class, against each class's own limit ─────────────────────────────────────────────────────

/**
 * p95 per class, with the limit each class is actually held to. One SLO for every class was one too few —
 * a document at 2.5 s is unpleasant, a navigation request at 2.5 s means the app is already queueing — so a
 * single limit line across every bar would be the wrong line for most of them.
 *
 * opts: { maxP95, classSlo }
 */
export function classChart(perClass, opts) {
  const o = opts || {};
  const names = Object.keys(perClass || {}).filter((c) => perClass[c] && perClass[c].reqs);
  if (!names.length) return '';
  const classSlo = o.classSlo || {};
  const limitOf = (name) => {
    const own = classSlo[name] && (classSlo[name].maxP95 !== undefined ? classSlo[name].maxP95 : null);
    return own !== null && own !== undefined ? Number(own) : (o.maxP95 ? Number(o.maxP95) : null);
  };
  const values = names.map((n) => perClass[n].p95 || 0)
    .concat(names.map(limitOf).filter((v) => v !== null));
  const xMax = niceCeil(Math.max(...values) * 1.1);
  const rowH = 34;
  const height = PAD.top + names.length * rowH + 34;
  const x = linear([0, xMax], [PAD.left + 40, W - PAD.right]);
  const bars = names.map((name, i) => {
    const c = perClass[name];
    const y = PAD.top + i * rowH;
    const limit = limitOf(name);
    const own = Boolean(classSlo[name] && classSlo[name].maxP95 !== undefined);
    const over = limit !== null && c.p95 > limit;
    const bar = `<rect class="hbar${over ? ' over' : ''}" x="${x(0).toFixed(1)}" y="${y}" `
      + `width="${Math.max(1, x(c.p95 || 0) - x(0)).toFixed(1)}" height="16">`
      + `<title>${esc(name)}: p95 ${ms(c.p95)}${limit !== null ? `, limit ${limit} ms` : ''}</title></rect>`;
    const mark = limit === null ? '' :
      `<line class="limit" x1="${x(limit).toFixed(1)}" x2="${x(limit).toFixed(1)}" y1="${y - 4}" y2="${y + 20}"/>`
      + `<text class="limit-label" x="${x(limit).toFixed(1)}" y="${y + 32}" text-anchor="middle">`
      + `${limit} ms${own ? ' (own)' : ''}</text>`;
    return `<text class="tick" x="${PAD.left + 34}" y="${y + 12}" text-anchor="end">${esc(name)}</text>`
      + bar + mark
      + `<text class="bar-value" x="${(x(c.p95 || 0) + 6).toFixed(1)}" y="${y + 12}">${esc(ms(c.p95))}</text>`;
  }).join('');
  return `<figure class="chart">\n<svg viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="cls-t cls-d">`
    + '<title id="cls-t">p95 per request class, against the limit each one is held to</title>'
    + `<desc id="cls-d">${esc(names.map((n) => `${n}: p95 ${ms(perClass[n].p95)}`
      + `${limitOf(n) !== null ? `, limit ${limitOf(n)} ms` : ''}`).join('; '))}</desc>`
    + bars
    + `<text class="axis-label" x="${PAD.left + 40}" y="${height - 6}">p95 (ms) — the mark is that class's `
    + 'own limit where it declares one</text>'
    + '</svg>\n</figure>';
}

// ── 4. the cache, with unknown as its own state ──────────────────────────────────────────────────────

/**
 * Hit ratio per declared layer. A layer whose header never appeared in any response has NO ratio: it is
 * drawn as `unknown`, hatched and labelled, never as a 0% bar. A zero bar reads as a cache that answered
 * and missed every time, and the usual cause is a wrong header name in the profile — a different bug with a
 * different fix.
 */
export function cacheChart(cache) {
  const labels = Object.keys(cache || {});
  if (!labels.length) return '';
  const rowH = 30;
  const height = PAD.top + labels.length * rowH + 24;
  const x = linear([0, 1], [PAD.left + 46, W - PAD.right]);
  const rows = labels.map((label, i) => {
    const v = cache[label];
    const y = PAD.top + i * rowH;
    const name = `<text class="tick" x="${PAD.left + 40}" y="${y + 12}" text-anchor="end">${esc(label)}</text>`;
    const track = `<rect class="track" x="${x(0).toFixed(1)}" y="${y}" width="${(x(1) - x(0)).toFixed(1)}" height="16"/>`;
    if (v === null || v === undefined) {
      return name + track
        + `<rect class="unknown" x="${x(0).toFixed(1)}" y="${y}" width="${(x(1) - x(0)).toFixed(1)}" height="16">`
        + `<title>${esc(label)}: the header never appeared — no hit ratio at all, which is not a miss</title>`
        + '</rect>'
        + `<text class="bar-value" x="${(x(1) + 6).toFixed(1)}" y="${y + 12}">unknown</text>`;
    }
    return name + track
      + `<rect class="hbar cache" x="${x(0).toFixed(1)}" y="${y}" width="${Math.max(1, x(v) - x(0)).toFixed(1)}" height="16">`
      + `<title>${esc(label)}: ${pct(v)} hit</title></rect>`
      + `<text class="bar-value" x="${(x(1) + 6).toFixed(1)}" y="${y + 12}">${esc(pct(v))}</text>`;
  }).join('');
  return `<figure class="chart">\n<svg viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="cache-t cache-d">`
    + '<title id="cache-t">cache hit ratio per declared layer</title>'
    + `<desc id="cache-d">${esc(labels.map((l) => `${l}: ${cache[l] === null || cache[l] === undefined
      ? 'unknown, the header never appeared' : pct(cache[l])}`).join('; '))}</desc>`
    + rows
    + `<text class="axis-label" x="${PAD.left + 46}" y="${height - 6}">hit ratio — an absent header is `
    + '`unknown`, never a miss</text>'
    + '</svg>\n</figure>';
}

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────

const CSS = `
:root { color-scheme: light dark;
  --bg:#ffffff; --panel:#f6f7f9; --line:#d8dce3; --text:#14181f; --dim:#5c6675;
  --ok:#1a7f4b; --warn:#8a5a00; --bad:#a32020; --accent:#1f4fd8; --grid:#e6e9ee; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#0f1319; --panel:#161c25; --line:#2a3441; --text:#e6eaf0; --dim:#93a0b1;
  --ok:#4fd08a; --warn:#e0b154; --bad:#ff8484; --accent:#7aa2ff; --grid:#1f2733; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 -apple-system,BlinkMacSystemFont,
  "Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 28px 20px 60px; }
h1 { font-size: 21px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 30px 0 8px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }
.sub { color: var(--dim); margin: 0 0 20px; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 12.5px; }
.banner { border:1px solid var(--line); border-left-width:4px; border-radius:6px; padding:11px 14px; margin:12px 0; background:var(--panel); }
.banner.bad { border-left-color: var(--bad); }
.banner.warn { border-left-color: var(--warn); }
.banner.ok { border-left-color: var(--ok); }
.banner.info { border-left-color: var(--accent); }
.stats { display:flex; flex-wrap:wrap; gap:10px; margin:14px 0; }
.stat { border:1px solid var(--line); border-radius:6px; padding:8px 12px; background:var(--panel); min-width:118px; }
.stat b { display:block; font-size:17px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:600; }
.stat span { color:var(--dim); font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; }
table { border-collapse:collapse; width:100%; font-size:12.5px; margin:8px 0 4px; }
th,td { border-bottom:1px solid var(--line); padding:5px 8px; text-align:right; white-space:nowrap; }
th:first-child,td:first-child { text-align:left; }
th { color:var(--dim); font-weight:600; }
td.mono,th.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.wrap { overflow-x:auto; }
figure.chart { margin:6px 0 2px; }
figure.chart svg { width:100%; height:auto; }
details { margin:0 0 6px; }
summary { cursor:pointer; color:var(--dim); font-size:12.5px; }
p.note { color:var(--dim); font-size:12.5px; }
ul.caveats { padding-left:20px; }
ul.caveats li { margin:6px 0; }
footer { margin-top:34px; padding-top:12px; border-top:1px solid var(--line); color:var(--dim); font-size:12px; }
/* charts */
.grid { stroke:var(--grid); stroke-width:1; }
.axis { stroke:var(--line); stroke-width:1; }
.tick { fill:var(--dim); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.axis-label { fill:var(--dim); font-size:11px; }
.line { stroke:var(--accent); stroke-width:2.5; fill:none; }
.line.partial { stroke-dasharray:5 4; }
.pt { fill:var(--accent); stroke:var(--bg); stroke-width:1.5; }
.pt.partial { fill:var(--bg); stroke:var(--accent); stroke-width:2.5; }
.pt.crossed { fill:var(--bad); stroke:var(--bg); }
.slo { stroke:var(--warn); stroke-width:1.5; stroke-dasharray:6 4; }
.slo-label { fill:var(--warn); font-size:11px; }
.guillotine { stroke:var(--bad); stroke-width:1.5; stroke-dasharray:2 3; }
.guillotine-label { fill:var(--bad); font-size:11px; }
.knee-band { fill:var(--warn); opacity:.10; }
.knee-label { fill:var(--warn); font-size:11px; }
.bar.asked { fill:var(--dim); opacity:.45; }
.bar.got { fill:var(--accent); }
.hbar { fill:var(--accent); }
.hbar.over { fill:var(--bad); }
.hbar.cache { fill:var(--ok); }
.track { fill:var(--grid); }
.unknown { fill:none; stroke:var(--dim); stroke-width:1; stroke-dasharray:3 3; }
.limit { stroke:var(--warn); stroke-width:2; }
.limit-label { fill:var(--warn); font-size:10.5px; }
.bar-value { fill:var(--text); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.legend text { font-size:11px; }
@media print {
  :root { --bg:#fff; --panel:#fff; --text:#000; --dim:#444; --grid:#ddd; --line:#bbb; }
  body { font-size:11pt; }
  details { display:block; }
  details > summary { display:none; }
  main { max-width:none; padding:0; }
}
`;

function stat(label, value, sub) {
  return `<div class="stat"><span>${esc(label)}</span><b>${esc(value)}</b>`
    + `${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
}

/** A chart's own numbers, under it. A chart nobody can quote from is a chart somebody retypes by eye. */
function table(caption, head, rows) {
  if (!rows.length) return '';
  return `<details><summary>${esc(caption)}</summary><div class="wrap"><table><thead><tr>`
    + head.map((h) => `<th>${esc(h)}</th>`).join('')
    + '</tr></thead><tbody>'
    + rows.map((r) => `<tr>${r.map((c) => `<td class="mono">${esc(c)}</td>`).join('')}</tr>`).join('')
    + '</tbody></table></div></details>';
}

/**
 * The whole page.
 *
 * @param {object} summary  a parsed out/summary-<run>.json
 * @param {object} [opts]   { generatedBy: 'crowdsim 1.19.0' } — no clock is read in here, by design: a pure
 *                          function that stamps the time cannot be tested twice with the same expectation.
 * @returns {string} a complete, self-contained HTML document
 */
export function buildReport(summary, opts) {
  const s = summary || {};
  const o = opts || {};
  const slo = s.slo || {};
  const invalid = s.generator_ok === false;
  const unreachable = s.target_unreachable === true;
  // The one condition under which no performance chart is drawn at all. Stated here once, and used below,
  // so the rule is visible rather than repeated as four `if`s.
  const noPerf = invalid || unreachable;
  const perStep = Array.isArray(s.per_step) ? s.per_step : null;

  const parts = [];
  parts.push(`<h1>crowdsim run <span class="mono">${esc(s.run_id)}</span></h1>`);
  parts.push(`<p class="sub">profile ${esc(s.profile)} · target ${esc(s.base_url)} · shape ${esc(s.shape)}`
    + ` · requested peak ${esc(s.peak_rps_user_target)} user req/s`
    + `${s.warmup ? ` · warm-up: ${esc(s.warmup)}` : ''}</p>`);

  // ── 1. is this run valid at all ──────────────────────────────────────────────────────────────────
  parts.push('<h2>Is this run valid?</h2>');
  if (invalid) {
    parts.push('<div class="banner bad"><strong>DISCARD THIS RUN.</strong> The generator dropped '
      + `${esc(s.dropped_iterations)} iterations of ${esc(s.requests)} requests, so no step measured the rate `
      + 'it claims. A generator-bound run looks exactly like a healthy system absorbing load — which is why '
      + 'there are no latency charts on this page. Move the generator closer to the target, or onto a bigger '
      + 'host, and repeat.</div>');
  } else if (unreachable) {
    parts.push('<div class="banner bad"><strong>The target never answered.</strong> '
      + `${esc(pct(s.failed_rate))} failed at around 0 ms. A saturated system is slow before it errors, so `
      + 'this is a connectivity problem — address, port, TLS or network path — and not a capacity number. '
      + 'No latency charts: a p95 of nearly zero is not a fast system.</div>');
  } else {
    parts.push('<div class="banner ok"><strong>Yes.</strong> The generator held the requested rate ('
      + `${esc(s.dropped_iterations)} dropped iterations of ${esc(s.requests)} requests), and the target `
      + 'answered.</div>');
  }

  // ── 2. the knee ─────────────────────────────────────────────────────────────────────────────────
  if (s.knee) {
    parts.push('<h2>The knee</h2>');
    if (noPerf && !s.knee.refused) {
      // A summary can carry both: `knee()` refuses on an invalid run, but a run archived by an older
      // version, or a file somebody edited, can hold a knee next to a verdict that voids it. The verdict
      // wins, always — a knee is the number that gets quoted in rooms this tool is not in.
      parts.push('<div class="banner bad"><strong>This run recorded a knee, and it does not count.</strong> '
        + `It says “${esc(s.knee.summary)}”, and the verdict above says the run measured nothing it can `
        + 'claim. A knee from a run whose generator did not hold the rate, or whose target never answered, '
        + 'is a number about the generator or the network. It is shown here only so nobody finds it in the '
        + 'JSON and quotes it.</div>');
    } else if (s.knee.refused) {
      parts.push(`<div class="banner warn"><strong>No knee from this run.</strong> ${esc(s.knee.reason)} `
        + `${esc(s.knee.fix || '')}</div>`);
    } else {
      const k = s.knee;
      parts.push(`<div class="banner info"><strong>${esc(k.summary)}</strong>`
        + `${k.clean && k.clean.caveat ? ` ${esc(k.clean.caveat)}.` : ''}`
        + `${k.note ? ` ${esc(k.note)}` : ''}`
        + ' A knee measured at this URL pool is harsher than one at real traffic: a synthetic pool of cold '
        + 'URLs is a harder test than the mix your visitors produce.</div>');
    }
  }

  // ── 3. what happened ────────────────────────────────────────────────────────────────────────────
  parts.push('<h2>What happened</h2>');
  if (s.aborted) {
    const by = s.aborted_by;
    parts.push('<div class="banner warn"><strong>Aborted by the brake.</strong> That is the intended '
      + 'outcome, not a failure: the run stopped as soon as it crossed a threshold.'
      + `${by && by.threshold ? ` Stopped by ${esc(by.class ? `class ${by.class}` : by.metric)} — `
        + `${esc(by.threshold)}${by.value === null || by.value === undefined ? ''
          : `, reached ${esc(Math.round(by.value * 100) / 100)}`}.` : ''}</div>`);
  } else {
    parts.push('<div class="banner ok"><strong>Completed without crossing its thresholds.</strong> The brake '
      + 'did not trip at this peak.</div>');
  }
  parts.push('<div class="stats">'
    + stat('requests', num(s.requests))
    + stat('achieved', `${(s.rps_avg || 0).toFixed(1)} req/s`, `asked ${num(s.peak_rps_user_target)}`)
    + stat('failed', pct(s.failed_rate))
    + (noPerf ? '' : stat('p95 (whole ramp)', ms(s.dur && s.dur.p95), `p99 ${ms(s.dur && s.dur.p99)}`))
    + (noPerf ? '' : stat(`past ${num(s.guillotine_ms)} ms`, pct(s.over_guillotine_rate), 'where 504s come from'))
    + stat('504 / 502', `${num(s.e504)} / ${num(s.e502)}`)
    + '</div>');

  // ── 4. the charts ───────────────────────────────────────────────────────────────────────────────
  if (invalid && perStep) {
    parts.push('<h2>Why this run is invalid</h2>');
    parts.push('<p class="note">The only chart an invalid run gets: what each step asked for, against what '
      + 'the generator actually delivered. The gap is the finding — everything else on this page would be a '
      + 'measurement of the generator.</p>');
    parts.push(rateChart(perStep));
    parts.push(table('the same numbers', ['step', 'asked req/s', 'delivered req/s', 'requests'],
      perStep.map((r) => [stepLabel(r), num(r.requested_rps), num(r.achieved_rps), num(r.requests)])));
  } else if (!noPerf && perStep && perStep.length) {
    parts.push('<h2>The ramp, step by step</h2>');
    if (!slo.max_p95_ms) {
      parts.push('<p class="note">This run recorded no SLO, so the chart has no limit line: it was archived '
        + 'before the summary carried its thresholds. The curve is the measurement; where the limit sat is '
        + 'not something this page will guess.</p>');
    }
    const rampOpts = {
      maxP95: slo.max_p95_ms || null,
      guillotineMs: s.guillotine_ms || null,
      knee: s.knee || null,
    };
    parts.push(rampChart(perStep, rampOpts));
    const hidden = rampDomain(perStep.filter((r) => r && r.p95 !== null && r.p95 !== undefined), rampOpts).hidden;
    if (hidden.length) {
      // A threshold that is simply not drawn reads as a threshold nothing came near. Naming it costs one
      // sentence; forcing it into the scale would squash the curve into the bottom of the picture.
      parts.push(`<p class="note">Above the top of this chart, and therefore not drawn: `
        + `${hidden.map((h) => `the ${esc(h.name)} at ${esc(h.value)} ms`).join(', ')}. `
        + 'Nothing in this run came close enough for the line to fit without flattening the curve.</p>');
    }
    if (perStep.some((r) => r.partial)) {
      parts.push('<p class="note">A hollow marker and a dashed segment mark a <strong>partial</strong> step: '
        + 'the run ended inside it, so those numbers are a fraction of that step — usually its worst '
        + 'fraction, since the brake fires while latency is climbing. It is evidence, not a result for that '
        + 'rate.</p>');
    }
    parts.push(table('the same numbers', ['step', 'asked req/s', 'achieved', 'p50', 'p95', 'p99', 'failed', `past ${num(s.guillotine_ms)} ms`],
      perStep.map((r) => [stepLabel(r) + (r.partial ? ' (partial)' : ''), num(r.requested_rps),
        num(r.achieved_rps), ms(r.p50), ms(r.p95), ms(r.p99), pct(r.failed_rate), pct(r.over_guillotine_rate)])));

    parts.push('<h2>Requested against delivered</h2>');
    parts.push('<p class="note">A step where the two diverge is a step that measured this generator rather '
      + 'than the target. The run-level verdict above is the one that decides validity; this is where you '
      + 'see it happen.</p>');
    parts.push(rateChart(perStep));
  } else if (!noPerf) {
    parts.push('<h2>The ramp, step by step</h2>');
    parts.push('<p class="note">This run has no per-step numbers, so there is no curve to draw: a journey '
      + 'run does not ramp in steps, and runs archived before 1.16.0 did not record them. For a knee, use '
      + '<code>--shape mix</code> with <code>--steps</code>.</p>');
  }

  if (!noPerf && s.per_class && Object.keys(s.per_class).length) {
    parts.push('<h2>Per class</h2>');
    parts.push('<p class="note">Each bar is that class against the limit it is actually held to — a class '
      + 'may declare a sharper one than the profile\'s, and one line across every bar would be the wrong '
      + 'line for most of them.</p>');
    parts.push(classChart(s.per_class, { maxP95: slo.max_p95_ms || null, classSlo: slo.per_class || {} }));
    parts.push(table('the same numbers', ['class', 'target req/s', 'requests', 'p50', 'p95', 'p99', 'failed', 'past the timeout'],
      Object.keys(s.per_class).map((c) => {
        const k = s.per_class[c];
        return [c, num(k.rps_target), num(k.reqs), ms(k.med), ms(k.p95), ms(k.p99), pct(k.failed),
          pct(k.over_guillotine)];
      })));
  }

  if (s.cache && Object.keys(s.cache).length) {
    parts.push('<h2>Cache</h2>');
    parts.push(cacheChart(s.cache));
    parts.push('<p class="note">A layer whose header never appeared is <code>unknown</code>, never a miss: '
      + 'that is usually a wrong header name in the profile rather than a cold cache, and a 0% bar would '
      + 'hide the difference.</p>');
  }

  // ── 5. what the numbers are worth ───────────────────────────────────────────────────────────────
  parts.push('<h2>What these numbers are worth</h2>');
  const caveats = [];
  if (invalid) {
    caveats.push('<strong>Nothing.</strong> The generator did not hold the rate. This page exists to show '
      + 'that, and to be thrown away with the run.');
  } else if (unreachable) {
    caveats.push('<strong>Nothing about capacity.</strong> The target never answered: fix the path, then '
      + 'measure.');
  } else {
    caveats.push('<strong>Only the delta travels.</strong> These absolutes describe this URL pool, which is '
      + 'colder than real traffic — a synthetic pool of distinct cold URLs is a harder test than the mix '
      + 'your visitors produce. Quote the change between two runs at an identical pool, not the number.');
    caveats.push('<strong>A rate the ramp swept through is not a rate that was sustained.</strong> Only the '
      + '<code>--hold</code> step holds one. A climbing step passed through its rate on the way up.');
    if (!s.warmup) {
      caveats.push('<strong>No warm-up.</strong> The first seconds of this run measured an empty cache, a '
        + 'cold pool and an unJITted app, and they are inside the p95 above. <code>--warmup</code> runs the '
        + 'generator first and throws those numbers away.');
    }
    if (s.is_warmup) {
      caveats.push('<strong>This run IS a warm-up.</strong> It has no brake and it is not a result.');
    }
  }
  // A login ceiling measured with 50 accounts across 400 VUs is partly a statement about 50 accounts.
  // The generator records it; this is where it reaches whoever reads the result.
  if (s.auth && s.auth.sharing_note) {
    caveats.push(`<strong>The accounts were shared.</strong> ${esc(s.auth.sharing_note)}`);
  } else if (s.auth && s.auth.users) {
    caveats.push(`<strong>${esc(s.auth.users)} account(s) signed in</strong>, one per virtual user or `
      + 'better, so the sign-in numbers describe the provider rather than the account count.');
  }
  caveats.push('<strong>The mix is an input, not a finding.</strong> These numbers describe the traffic mix '
    + 'this profile declares. If those weights were not measured on your own edge log '
    + '(<code>crowdsim weights</code>), the shape under test is not the shape your visitors produce.');
  parts.push(`<ul class="caveats">${caveats.map((c) => `<li>${c}</li>`).join('')}</ul>`);

  parts.push(`<footer>Written by <strong>${esc(o.generatedBy || 'crowdsim')}</strong> from `
    + `<code>summary-${esc(s.run_id)}.json</code>. Self-contained: no scripts, no fonts, nothing fetched — `
    + 'it renders the same offline in a year. The tables under each chart carry the same numbers, for '
    + 'quoting and for a screen reader.</footer>');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crowdsim ${esc(s.run_id)} — ${esc(s.profile)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${parts.filter(Boolean).join('\n')}
</main>
</body>
</html>
`;
}
