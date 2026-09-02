/*
 * bin.js — which driver the GUI spawns.
 *
 * The GUI is a form over `bin/crowdsim`: every run is a child process of it. So the one thing the server
 * must never be wrong about is where that script is — and it was, inside the published image, from the day
 * that image first shipped (1.2.0) until 1.19.2 — thirty releases.
 *
 * What happened, because it is the shape of the bug and not a detail: the image copies the driver to
 * `/usr/local/bin/crowdsim` and the rest of the tool to `/crowdsim`, and sets `CROWDSIM_ROOT=/crowdsim` so
 * the driver can find the generator. The server, meanwhile, derived its default from its OWN path —
 * `gui/server/../../bin/crowdsim`, i.e. `/crowdsim/bin/crowdsim` — which does not exist in the image. The
 * documentation said the default was `$CROWDSIM_ROOT/bin/crowdsim`, which is what anybody would reasonably
 * assume and was not true, so `CROWDSIM_ROOT=/crowdsim` looked like it covered this and did not.
 *
 * The result: the page started, said nothing, and every run failed with `spawn ENOENT` after the click. It
 * was found by somebody running the container and working around it in a Nomad job.
 *
 * Two fixes, and they are different fixes:
 *  · the image now sets `CROWDSIM_BIN` explicitly (one line in the Dockerfile);
 *  · this module makes the documented order the real order, and — the part that matters — makes the
 *    failure happen at STARTUP with the variable named, instead of at the first run with a path nobody
 *    recognises. A server that cannot spawn the driver has no job to do.
 *
 * Pure: the filesystem and the environment are injected, so every branch is testable without a container.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Is this path a file we could actually execute? */
export function executable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/**
 * Where to find the driver, in the order the documentation states.
 *
 *   1. `CROWDSIM_BIN` — an explicit answer, and the only one that cannot be wrong for the wrong reason.
 *      Taken as given: if it is set and not executable, that is an error to report, not a reason to fall
 *      back to a path the operator did not choose. A GUI that silently spawns a different driver from the
 *      one it was told to is worse than one that refuses.
 *   2. `$CROWDSIM_ROOT/bin/crowdsim` — what the docs always claimed, now true. This is the variable the
 *      container sets, and the one people reach for first.
 *   3. `<the server's own directory>/../../bin/crowdsim` — a git checkout, which is where the GUI is
 *      usually developed.
 *   4. `crowdsim` on `PATH` — an installed driver, whatever the layout around it.
 *
 * @param {object} o
 * @param {object} o.env          the environment (process.env)
 * @param {string} o.serverRoot   the repository root as the server sees it
 * @param {function} [o.isExecutable]  injected for the tests
 * @param {string[]} [o.pathDirs] injected for the tests; defaults to splitting o.env.PATH
 * @returns {{bin: string|null, source: string, tried: string[]}}
 *          `bin` is null when nothing was found; `source` names which rule answered, for the log and for
 *          the refusal message.
 */
export function resolveBin(o) {
  const env = (o && o.env) || {};
  const isExecutable = (o && o.isExecutable) || executable;
  const tried = [];

  if (env.CROWDSIM_BIN) {
    // Deliberately not a candidate among others: an explicit setting that does not work is reported as
    // itself. Falling through would hide a typo behind a driver from somewhere else.
    return {
      bin: isExecutable(env.CROWDSIM_BIN) ? env.CROWDSIM_BIN : null,
      source: 'CROWDSIM_BIN',
      tried: [env.CROWDSIM_BIN],
    };
  }

  const candidates = [];
  if (env.CROWDSIM_ROOT) candidates.push([path.join(env.CROWDSIM_ROOT, 'bin/crowdsim'), 'CROWDSIM_ROOT']);
  if (o && o.serverRoot) candidates.push([path.join(o.serverRoot, 'bin/crowdsim'), 'this checkout']);
  const pathDirs = (o && o.pathDirs) || String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) candidates.push([path.join(dir, 'crowdsim'), 'PATH']);

  for (const [candidate, source] of candidates) {
    tried.push(candidate);
    if (isExecutable(candidate)) return { bin: candidate, source, tried };
  }
  return { bin: null, source: 'nothing', tried };
}

/**
 * The refusal, as text. Startup is where this belongs: the alternative is a page that looks healthy and
 * fails at the click, with a path in the log that means nothing to whoever is reading it.
 */
export function unresolvedMessage(resolved) {
  const r = resolved || {};
  if (r.source === 'CROWDSIM_BIN') {
    return `CROWDSIM_BIN is set to ${r.tried[0]}, which is not an executable file.

  That is the driver this server would spawn for every run, so it refuses to start rather than accept
  every click and fail each one. Point it at bin/crowdsim, or unset it and let the server look in
  $CROWDSIM_ROOT/bin/crowdsim, its own checkout, and PATH.`;
  }
  const list = (r.tried || []).slice(0, 6).map((t) => `      ${t}`).join('\n');
  return `cannot find the crowdsim driver to spawn.

  The GUI runs no load itself: every run is a child process of bin/crowdsim, and without it this server
  has nothing to do — so it refuses to start instead of failing at the first click.

  Set CROWDSIM_BIN to the driver, e.g. CROWDSIM_BIN=/usr/local/bin/crowdsim (that is where the container
  image puts it), or run the GUI from a checkout that has bin/crowdsim.

  Looked in:
${list}`;
}
