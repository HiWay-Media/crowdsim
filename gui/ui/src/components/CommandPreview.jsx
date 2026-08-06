import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { SAFE_PEAK } from '../lib/messages.js';

/*
 * The command about to be authorised, as the server itself renders it.
 *
 * The UI does not assemble this string. It sends the form to /api/preview and prints what comes back, which
 * is built by the same function that builds the argv the server spawns. A preview written here would be a
 * second implementation of the command line, and the first time the two disagreed it would be reassuring
 * about a run that does something else.
 *
 * It also doubles as live form validation: a peak of "lots" comes back as a field error before the button
 * is ever pressed.
 */
export default function CommandPreview({ body, disabled }) {
  const [state, setState] = useState({ command: null, error: null, field: null, armed: false });
  const [copied, setCopied] = useState(false);
  const key = JSON.stringify(body);

  useEffect(() => {
    if (disabled) return undefined;
    let alive = true;
    // Debounced: this fires on every keystroke in the rate fields.
    const t = setTimeout(() => {
      api.preview(body).then((r) => {
        if (alive) setState({ command: r.command, error: null, field: null, armed: r.needs_confirmation });
      }).catch((e) => {
        if (alive) setState({ command: null, error: e.message, field: e.field || null, armed: false });
      });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [key, disabled]);

  useEffect(() => { setCopied(false); }, [key]);

  if (disabled) return null;

  return (
    <section className="card wide preview">
      <h2>
        The command this will run
        <span className="note">built by the server, not by this page — it is the line it will execute</span>
      </h2>

      {state.error ? (
        <div className="banner bad">
          {state.field ? <strong>{state.field}: </strong> : null}{state.error}
        </div>
      ) : (
        <>
          <pre className="command mono">{state.command || 'building…'}</pre>
          <div className="actions">
            <button
              disabled={!state.command}
              onClick={() => {
                navigator.clipboard.writeText(state.command).then(() => setCopied(true), () => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="note">
              Paste it into a terminal and you get the same run. `CROWDSIM_ALLOW_TARGETS` is included when
              this server has one, because without it the CLI refuses to start (exit 3).
            </span>
          </div>
        </>
      )}

      {state.armed ? (
        <div className="banner warn">
          <strong>This line carries <code>--i-know-this-breaks-production</code>.</strong>{' '}
          {SAFE_PEAK.previewArmed}
        </div>
      ) : null}
    </section>
  );
}
