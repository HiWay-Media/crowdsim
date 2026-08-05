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
  startRun: (body) => call('POST', '/api/runs', body),
  runs: () => call('GET', '/api/runs'),
  run: (id) => call('GET', `/api/runs/${encodeURIComponent(id)}`),
  stopRun: (id) => call('POST', `/api/runs/${encodeURIComponent(id)}/stop`),
  history: () => call('GET', '/api/history'),
  historyRun: (runId) => call('GET', `/api/history/${encodeURIComponent(runId)}`),
};

/**
 * Live log. EventSource cannot send an Authorization header, so when a token is configured it goes in the
 * query string — acceptable only because that mode is for a trusted network behind TLS, and the token is
 * a run-launching credential either way. Loopback (the default) needs no token at all.
 */
export function streamRun(id, onLine, onEnd) {
  const token = getToken();
  const url = `/api/runs/${encodeURIComponent(id)}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const es = new EventSource(url);
  es.addEventListener('line', (e) => onLine(JSON.parse(e.data).line));
  es.addEventListener('end', (e) => { onEnd(JSON.parse(e.data)); es.close(); });
  es.onerror = () => es.close();
  return () => es.close();
}
