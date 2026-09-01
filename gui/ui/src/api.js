/*
 * The only place the UI talks to the server. Errors are surfaced with the server's own message and, when
 * present, the offending field — a load tool that says "400 Bad Request" and nothing else teaches people
 * to click Run again until it works.
 */

const TOKEN_KEY = 'crowdsim.token';

export function getToken() {
  try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}
export function setToken(v) {
  try { v ? window.localStorage.setItem(TOKEN_KEY, v) : window.localStorage.removeItem(TOKEN_KEY); } catch (e) { /* private mode */ }
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body || {};
    this.field = this.body.field || null;
    this.validation = this.body.validation || null;
    this.active = this.body.active || null;
  }
}

async function call(method, url, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* html error page */ }
  if (!res.ok) throw new ApiError((json && json.error) || `${method} ${url} failed (${res.status})`, res.status, json);
  return json;
}

export const api = {
  env: () => call('GET', '/api/env'),
  profiles: () => call('GET', '/api/profiles'),
  profile: (name) => call('GET', `/api/profiles/${encodeURIComponent(name)}`),
  saveProfile: (name, raw, force) => call('PUT', `/api/profiles/${encodeURIComponent(name)}`, { raw, force: !!force }),
  deleteProfile: (name) => call('DELETE', `/api/profiles/${encodeURIComponent(name)}`),
  validate: (raw) => call('POST', '/api/validate', { raw }),
  // Preview and launch go to two endpoints that share one argv builder on the server. Never render a
  // command line here: see components/CommandPreview.jsx.
  preview: (body) => call('POST', '/api/preview', body),
  startRun: (body) => call('POST', '/api/runs', body),
  runs: () => call('GET', '/api/runs'),
  run: (id) => call('GET', `/api/runs/${encodeURIComponent(id)}`),
  stopRun: (id) => call('POST', `/api/runs/${encodeURIComponent(id)}/stop`),
  history: () => call('GET', '/api/history'),
  // The comparison is computed by `crowdsim compare --json`, spawned by the server. Never re-derive a
  // verdict here: the refusals are the feature, and two copies of them would eventually disagree.
  compare: (a, b) => call('GET', `/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  historyRun: (runId) => call('GET', `/api/history/${encodeURIComponent(runId)}`),
  // The report is markdown, not JSON, and it is produced by `crowdsim report` on the server. Fetched here
  // rather than linked with an <a href>, because a link cannot carry the bearer token the off-loopback mode
  // requires — a download that works on loopback and silently 401s behind a token is worse than a button.
  // format 'md' for a ticket, 'html' for the same run drawn. The server spawns `crowdsim report` either
  // way: the page renders no report of its own, in either format.
  report: (runId, format) => text('GET', `/api/history/${encodeURIComponent(runId)}/report`
    + `?format=${encodeURIComponent(format || 'md')}`),
};

async function text(method, url) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers });
  const body = await res.text();
  if (!res.ok) {
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch (e) { /* not json */ }
    throw new ApiError((json && json.error) || `${method} ${url} failed (${res.status})`, res.status, json);
  }
  return body;
}

/**
 * Live log. EventSource cannot send an Authorization header, so when a token is configured it goes in the
 * query string — acceptable only because that mode is for a trusted network behind TLS, and the token is
 * a run-launching credential either way. Loopback (the default) needs no token at all.
 *
 * It used to end with `es.onerror = () => es.close()`: one line that threw away EventSource's own
 * reconnection AND said nothing, so a server that went away looked exactly like a run that had gone quiet.
 * Now the error is reported and the retry is left to the browser, which is what EventSource is for.
 *
 * handlers:
 *   onSnapshot(lines)  everything the server has for this run — REPLACES what the page holds
 *   onLine(line)       one new line
 *   onEnd(run)         the run finished; the stream is closed and will not retry
 *   onState({phase, attempts})  'open' | 'retrying' | 'ended'
 */
export function streamRun(id, handlers) {
  const h = handlers || {};
  const noop = () => {};
  const onSnapshot = h.onSnapshot || noop;
  const onLine = h.onLine || noop;
  const onEnd = h.onEnd || noop;
  const onState = h.onState || noop;

  const token = getToken();
  const url = `/api/runs/${encodeURIComponent(id)}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const es = new EventSource(url);
  let attempts = 0;

  es.addEventListener('open', () => { attempts = 0; onState({ phase: 'open', attempts: 0 }); });
  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data).lines || []));
  es.addEventListener('line', (e) => onLine(JSON.parse(e.data).line));
  es.addEventListener('end', (e) => {
    onState({ phase: 'ended', attempts: 0 });
    onEnd(JSON.parse(e.data));
    es.close();
  });
  es.onerror = () => {
    // readyState CLOSED means it will not come back on its own; anything else is the browser retrying.
    attempts += 1;
    if (es.readyState === 2) {
      onState({ phase: 'retrying', attempts, willRetry: false });
      return;
    }
    onState({ phase: 'retrying', attempts, willRetry: true });
  };
  return () => es.close();
}
