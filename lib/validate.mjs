/*
 * validate.js — read a profile the way the CLI and the generator will read it, and say what is wrong
 * BEFORE a window is agreed and people are watching dashboards.
 *
 * ONE implementation, used by both entry points: `crowdsim validate` (via lib/validate-cli.mjs, which
 * doctor and load also call) and the GUI's editor. Two rule sets would drift, and the day they drift the
 * one that matters is whichever the operator did not run.
 *
 * Pure: it takes a parsed profile and returns { errors, warnings, summary }. Errors are things that will
 * fail or produce a meaningless run; warnings are things that will run but not mean what the author
 * probably thinks. The distinction matters — a profile that "works" and measures the wrong load is the
 * failure mode this whole tool exists to avoid.
 */

const HOST_ONLY = /^[A-Za-z0-9._*?-]+$/;

export function validateProfile(profile) {
  const errors = [];
  const warnings = [];
  const p = profile || {};
  const err = (path, msg) => errors.push({ path, message: msg });
  const warn = (path, msg) => warnings.push({ path, message: msg });

  // ── pools ─────────────────────────────────────────────────────────────────────────────────────────
  const pools = {};
  for (const k of Object.keys(p.pools || {})) {
    if (k.startsWith('_')) continue;                         // documentation key
    const v = p.pools[k];
    if (typeof v === 'string') {
      if (!v.startsWith('@')) err(`pools.${k}`, 'a string pool must be a reference like "@pool-pages.json"');
      pools[k] = null;                                       // resolved at run time by the driver
    } else if (Array.isArray(v)) {
      pools[k] = v.length;
      if (!v.length) warn(`pools.${k}`, 'pool is empty: every class using it will be dropped from the mix');
    } else {
      err(`pools.${k}`, 'a pool must be a list of paths, or "@file.json"');
    }
  }

  // ── classes ───────────────────────────────────────────────────────────────────────────────────────
  const classes = Array.isArray(p.classes) ? p.classes : [];
  if (!classes.length) err('classes', 'a profile with no classes cannot generate anything');
  const seen = new Set();
  let weightTotal = 0;
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i] || {};
    const at = `classes[${i}]`;
    if (!c.name) err(at, 'every class needs a name (it is the metric tag and the --skip-classes key)');
    else if (seen.has(c.name)) err(at, `duplicate class name "${c.name}": the metrics would be merged`);
    else seen.add(c.name);
    const w = Number(c.weight);
    if (!Number.isFinite(w) || w <= 0) err(at, 'weight must be a positive number (its share of the mix)');
    else weightTotal += w;
    if (c.kind && c.kind !== 'plain' && c.kind !== 'rsc') err(at, 'kind must be "plain" or "rsc"');
    for (const key of ['pool', 'path_suffix_pool']) {
      if (c[key] && !(c[key] in pools)) err(`${at}.${key}`, `unknown pool "${c[key]}"`);
    }
    if (!c.pool) err(at, 'a class needs a pool to draw URLs from');
    else if (pools[c.pool] === 0) warn(at, `pool "${c.pool}" is empty: this class will be dropped and the mix renormalised`);

    // A class may hold itself to a TIGHTER threshold than the profile — that is the whole point, since one
    // p95 for a rendered document and a static asset is too lax for the renderer. Looser is refused: a brake
    // that fires later than the profile asked for is worse than no brake, because somebody is watching the
    // outage it existed to cut short.
    const sloAll = p.slo || {};
    if (c.max_p95_ms !== undefined && c.max_p95_ms !== null) {
      const own = Number(c.max_p95_ms);
      if (!Number.isFinite(own) || own <= 0) {
        err(`${at}.max_p95_ms`, 'max_p95_ms is a number of milliseconds');
      } else {
        const profileLimit = Number(sloAll.max_p95_ms);
        if (Number.isFinite(profileLimit) && own > profileLimit) {
          err(`${at}.max_p95_ms`, `${own} ms is looser than the profile's ${profileLimit} ms: the brake would `
            + 'fire later than the profile asks for. A per-class limit may only make it sharper.');
        }
        if (own < 50) {
          warn(`${at}.max_p95_ms`, `${own} ms is below what a healthy origin answers in over a real network: `
            + 'this would abort on the ramp and read as a knee');
        }
      }
    }
    if (c.max_failed_rate !== undefined && c.max_failed_rate !== null) {
      const own = Number(c.max_failed_rate);
      if (!(own >= 0 && own <= 1)) {
        err(`${at}.max_failed_rate`, 'max_failed_rate is a ratio between 0 and 1');
      } else {
        const profileLimit = Number(sloAll.max_failed_rate);
        if (Number.isFinite(profileLimit) && own > profileLimit) {
          err(`${at}.max_failed_rate`, `${own} is looser than the profile's ${profileLimit}: the brake would `
            + 'fire later than the profile asks for. A per-class limit may only make it sharper.');
        }
      }
    }
  }
  if (weightTotal <= 0 && classes.length) err('classes', 'the weights add up to zero: nothing would be generated');

  // ── targets ───────────────────────────────────────────────────────────────────────────────────────
  const list = (p.targets && p.targets.list) || {};
  const targets = Object.keys(list);
  // A warning and not an error: a profile driven entirely by `--base-url` is legitimate, and `load` now
  // refuses on errors — so an over-strict rule here would start rejecting profiles that work today.
  if (!targets.length) warn('targets.list', 'no named targets: every run will have to pass --base-url');
  for (const name of targets) {
    const t = list[name] || {};
    // A warning, not an error: a target nobody selects breaks nothing, and `load` already refuses with a
    // precise exit 2 when you do select it ("target 'x' has no base_url"). Errors are reserved for what is
    // fatal to ANY run of this profile — otherwise `load`, which now gates on errors, would start rejecting
    // profiles that work today.
    if (!t.base_url) warn(`targets.list.${name}`, 'no base_url: this target cannot be used, and selecting it fails with exit 2');
    if (t.bypass && !/^[^=]+=[^=]+$/.test(String(t.bypass))) {
      err(`targets.list.${name}.bypass`, 'bypass must be "host=address" (it keeps SNI and Host correct while skipping a CDN)');
    }
  }
  if (p.targets && p.targets.default && targets.indexOf(p.targets.default) === -1) {
    err('targets.default', `"${p.targets.default}" is not one of the declared targets`);
  }
  if (targets.length && !(p.targets && p.targets.default)) {
    warn('targets.default', 'no default target: every run will have to name one');
  }

  // ── safety ────────────────────────────────────────────────────────────────────────────────────────
  const safety = p.safety || {};
  const allow = safety.allow_hosts;
  if (Array.isArray(allow) && allow.length === 0) {
    // Declared and empty is not the same as absent, and must not be reported as it. Absent is a legitimate
    // choice: the allowlist may come from CROWDSIM_ALLOW_TARGETS. Empty is a profile that LOOKS complete and
    // is refused at the gate with no hint of why — which is exactly the state `crowdsim init` leaves behind
    // on purpose, since a generated allowlist would be crowdsim authorising a host on your behalf.
    err('safety.allow_hosts', 'declared and empty is not an allowlist: fill in the hosts this profile may '
      + 'generate load against, or remove the key and pass CROWDSIM_ALLOW_TARGETS instead');
  } else if (!allow) {
    warn('safety.allow_hosts', 'no allowlist in the profile: runs will only start with CROWDSIM_ALLOW_TARGETS set');
  } else {
    for (const h of allow) {
      if (h === '*' || h === '*.*') err('safety.allow_hosts', 'an allowlist of "*" is not an allowlist');
      else if (!HOST_ONLY.test(String(h))) err('safety.allow_hosts', `"${h}" is not a hostname glob (no scheme, no port, no path)`);
    }
  }
  if (safety.generator_mbps !== undefined && !(Number(safety.generator_mbps) > 0)) {
    err('safety.generator_mbps', 'generator_mbps must be a positive number: what the generator\'s link can sustain, in Mbit/s');
  }
  if (safety.safe_peak_rps === undefined) {
    warn('safety.safe_peak_rps', 'no safe peak declared: the driver falls back to 150 req/s, which is a guess about YOUR system');
  } else if (!(Number(safety.safe_peak_rps) > 0)) {
    // Also the state `init` writes: the ceiling is a decision about how far somebody else's production may
    // be bent, and no tool gets to make it for you.
    err('safety.safe_peak_rps', 'the safe ceiling has to be a positive number of req/s: the rate past which '
      + 'a run needs --i-know-this-breaks-production on the command line');
  }

  // ── slo ───────────────────────────────────────────────────────────────────────────────────────────
  const slo = p.slo || {};
  if (slo.brake_class && !seen.has(slo.brake_class)) {
    err('slo.brake_class', `"${slo.brake_class}" is not a class in this profile: nothing would abort the run`);
  }
  if (!slo.brake_class && classes.length) {
    warn('slo.brake_class', 'no brake class: the first class in the mix is used, which may not be the one that falls over');
  }
  if (slo.guillotine_ms && slo.max_p95_ms && Number(slo.guillotine_ms) < Number(slo.max_p95_ms)) {
    warn('slo.guillotine_ms', 'the read timeout is below the p95 SLO: the brake would abort only after real users are already getting 504s');
  }
  if (slo.max_failed_rate !== undefined && !(Number(slo.max_failed_rate) >= 0 && Number(slo.max_failed_rate) <= 1)) {
    err('slo.max_failed_rate', 'max_failed_rate is a ratio between 0 and 1');
  }
  // These two are the numbers the brake is made of, and a non-numeric one does not fail loudly: it makes
  // every threshold pass, so the run cannot abort at all. guillotine_ms is worse still — it has to be the
  // reverse proxy's read timeout, or the 504s a run produces are invisible to the run that produced them.
  for (const k of ['max_p95_ms', 'guillotine_ms']) {
    if (slo[k] !== undefined && !(Number(slo[k]) > 0)) {
      err('slo.' + k, `${k} has to be a positive number of milliseconds`
        + (/TODO/i.test(String(slo[k])) ? ' — this one is still the TODO a drafted profile carries' : ''));
    }
  }

  // ── placeholders ──────────────────────────────────────────────────────────────────────────────────
  // `crowdsim init` drafts a profile with TODO markers where a human has to decide. Those markers are the
  // whole point of the draft, and a run that reaches one is running on a decision nobody made. _comment
  // fields are exempt: that is where the instructions live.
  const todos = [];
  (function scan(node, path) {
    if (typeof node === 'string') {
      if (/^\s*TODO/i.test(node)) todos.push(path);
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => scan(v, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (k === '_comment' || k.startsWith('_')) continue;
        scan(node[k], path ? `${path}.${k}` : k);
      }
    }
  })(p, '');
  for (const path of todos) {
    // One diagnosis per field: a field already refused for what it is (an SLO that is not a number) does not
    // also need to be told it is a TODO. Two lines about one field reads as two problems.
    if (errors.some(e => e.path === path)) continue;
    err(path, 'still a TODO from a drafted profile: this is a value only you can decide');
  }

  // ── cache headers ─────────────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < (p.cache_headers || []).length; i++) {
    const l = p.cache_headers[i] || {};
    if (!l.label || !l.header) err(`cache_headers[${i}]`, 'each layer needs a label and a header name');
    if (l.hit) {
      try { new RegExp(l.hit); } catch (e) { err(`cache_headers[${i}].hit`, 'hit must be a valid regular expression'); }
    }
  }
  if (!(p.cache_headers || []).length) {
    warn('cache_headers', 'no cache headers declared: the run cannot report a hit ratio for any layer');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      name: p.name || null,
      classes: classes.filter((c) => c && c.name).map((c) => ({
        name: c.name,
        label: c.label || c.name,
        kind: c.kind || 'plain',
        weight: Number(c.weight) || 0,
        share: weightTotal > 0 ? Number(c.weight) / weightTotal : 0,
        pool: c.pool || null,
        pool_size: c.pool ? pools[c.pool] : null,
        // The limits in force for this class: its own where it declared one, so the page and the report can
        // say which threshold the brake is actually watching.
        max_p95_ms: c.max_p95_ms === undefined || c.max_p95_ms === null
          ? (slo.max_p95_ms === undefined ? null : Number(slo.max_p95_ms)) : Number(c.max_p95_ms),
        max_failed_rate: c.max_failed_rate === undefined || c.max_failed_rate === null
          ? (slo.max_failed_rate === undefined ? null : Number(slo.max_failed_rate)) : Number(c.max_failed_rate),
        own_slo: (c.max_p95_ms !== undefined && c.max_p95_ms !== null)
          || (c.max_failed_rate !== undefined && c.max_failed_rate !== null),
      })),
      pools,
      targets: targets.map((name) => ({
        name,
        base_url: list[name].base_url || null,
        host_header: list[name].host_header || null,
        bypass: list[name].bypass || null,
        skip_classes: list[name].skip_classes || null,
      })),
      default_target: (p.targets && p.targets.default) || null,
      safe_peak_rps: safety.safe_peak_rps === undefined ? null : Number(safety.safe_peak_rps),
      generator_mbps: safety.generator_mbps === undefined ? null : Number(safety.generator_mbps),
      allow_hosts: allow || [],
      slo: {
        max_p95_ms: slo.max_p95_ms === undefined ? null : Number(slo.max_p95_ms),
        max_failed_rate: slo.max_failed_rate === undefined ? null : Number(slo.max_failed_rate),
        guillotine_ms: slo.guillotine_ms === undefined ? null : Number(slo.guillotine_ms),
        brake_class: slo.brake_class || null,
      },
      cache_layers: (p.cache_headers || []).map((l) => l && l.label).filter(Boolean),
    },
  };
}
