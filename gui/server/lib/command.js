/*
 * command.js — rendering an argv as a line somebody can paste into a terminal.
 *
 * This is display only, and it exists for one reason: a web page that generates real traffic should let
 * you read the command BEFORE you agree to it. The form fills in defaults, and defaults you cannot see are
 * decisions somebody else made for you.
 *
 * The direction matters. The server does not build a command string and then run it — it runs the argv, and
 * this module renders that same array afterwards. Quoting a string to be re-parsed by a shell is where
 * injection bugs live; nothing here is ever executed, and no run path consumes its output.
 */

// Characters a POSIX shell leaves alone. Everything else gets single-quoted.
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Single-quote for POSIX sh: wrap in quotes and close/escape/reopen for each embedded quote. */
export function shellQuote(value) {
  const s = String(value);
  if (s === '') return "''";
  if (SAFE.test(s)) return s;
  return `'${s.split("'").join(`'\\''`)}'`;
}

/**
 * The pasteable line for an argv.
 *   bin  — how to invoke the driver (rendered as `crowdsim`, since a reader's PATH is not the server's)
 *   env  — variables that must be set for the line to behave the same way outside the GUI. The allowlist
 *          is the one that matters: without it the CLI refuses to start (exit 3), which is the correct
 *          behaviour and a confusing surprise if the preview omitted it.
 */
export function commandLine(argv, opts) {
  const o = opts || {};
  const parts = [];
  for (const key of Object.keys(o.env || {})) {
    const v = o.env[key];
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${key}=${shellQuote(v)}`);
  }
  parts.push(o.bin || 'crowdsim');
  for (const a of argv || []) parts.push(shellQuote(a));
  return parts.join(' ');
}
