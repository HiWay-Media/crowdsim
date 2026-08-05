/*
 * profiles.js — the profile directory as seen by the GUI.
 *
 * A profile is a map of someone's infrastructure: hostnames, internal addresses, real routes. So this
 * module is deliberately narrow — one flat directory, one filename pattern, no traversal, no symlink
 * following out of the directory. The GUI is a convenience over the CLI, not a file manager.
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateProfile } from './validate.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;

export class BadProfile extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BadProfile';
    this.status = status || 400;
  }
}

/**
 * Resolve a profile name to an absolute path inside `dir`, or throw.
 * The name is matched against a whitelist pattern AND the resolved path is checked to still be inside
 * the directory: the pattern alone would be a single regex between the GUI and the filesystem.
 */
export function profilePath(dir, name) {
  if (!NAME.test(String(name || ''))) {
    throw new BadProfile('profile name must look like my-site.json (letters, digits, . _ -)');
  }
  const base = fs.realpathSync(dir);
  const full = path.resolve(base, String(name));
  if (path.dirname(full) !== base) throw new BadProfile('profile name must not contain a path');
  return full;
}

export function listProfiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names.filter((n) => NAME.test(n)).sort().map((name) => {
    const full = path.join(dir, name);
    let stat = null;
    try { stat = fs.statSync(full); } catch (e) { /* raced with a delete: skip the metadata */ }
    let parsed = null;
    let error = null;
    try { parsed = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { error = e.message; }
    const v = parsed ? validateProfile(parsed) : null;
    return {
      name,
      size: stat ? stat.size : null,
      modified: stat ? stat.mtime.toISOString() : null,
      title: parsed && parsed.name ? parsed.name : null,
      example: name === 'example.json',
      ok: v ? v.ok : false,
      parse_error: error,
      errors: v ? v.errors.length : null,
      warnings: v ? v.warnings.length : null,
      targets: v ? v.summary.targets.map((t) => t.name) : [],
      default_target: v ? v.summary.default_target : null,
      safe_peak_rps: v ? v.summary.safe_peak_rps : null,
    };
  });
}

export function readProfile(dir, name) {
  const full = profilePath(dir, name);
  let raw;
  try { raw = fs.readFileSync(full, 'utf8'); } catch (e) { throw new BadProfile(`no such profile: ${name}`, 404); }
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(raw); } catch (e) { parseError = e.message; }
  return {
    name,
    raw,
    parsed,
    parse_error: parseError,
    validation: parsed ? validateProfile(parsed) : null,
  };
}

/**
 * Write a profile. Refuses invalid JSON and refuses profiles with validation ERRORS — warnings go
 * through, because a profile can legitimately be saved half-built. `example.json` is read-only: it is
 * the documentation, and the repo ships it.
 */
export function writeProfile(dir, name, raw, opts) {
  const options = opts || {};
  const full = profilePath(dir, name);
  if (name === 'example.json' && !options.allowExample) {
    throw new BadProfile('example.json is the shipped documentation: save it under another name');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new BadProfile(`not valid JSON: ${e.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadProfile('a profile must be a JSON object');
  }
  const validation = validateProfile(parsed);
  if (!validation.ok && !options.force) {
    const e = new BadProfile('profile has errors: fix them or save with force', 422);
    e.validation = validation;
    throw e;
  }
  // Pretty-printed on purpose: profiles are read and diffed by humans, and they live in git.
  writeOrExplain(full, JSON.stringify(parsed, null, 2) + '\n');
  return { name, validation };
}

/**
 * A read-only profile directory is a completely normal setup — it is what `-v ./profiles:/profiles:ro`
 * gives you, and mounting your infrastructure map read-only is a reasonable thing to do. Reporting it as
 * a 500 tells the operator the server is broken when in fact the server is behaving exactly as asked, so
 * the filesystem's own refusal is translated instead of leaking as an internal error.
 */
function writeOrExplain(full, contents) {
  try {
    fs.writeFileSync(full, contents, 'utf8');
  } catch (e) {
    if (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM') {
      throw new BadProfile(
        `the profile directory is not writable (${e.code}): the GUI can read and run profiles but not ` +
        'save them. Mount it read-write, or edit the file outside the GUI.', 409);
    }
    throw e;
  }
}

export function deleteProfile(dir, name) {
  const full = profilePath(dir, name);
  if (name === 'example.json') throw new BadProfile('example.json is shipped with the repo');
  try {
    fs.unlinkSync(full);
  } catch (e) {
    if (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM') {
      throw new BadProfile(`the profile directory is not writable (${e.code})`, 409);
    }
    throw new BadProfile(`no such profile: ${name}`, 404);
  }
  return { name, deleted: true };
}
