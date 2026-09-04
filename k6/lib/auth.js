/*
 * Authenticated classes: login, authenticated reads, signup.
 *
 * WHY THIS EXISTS — every class crowdsim shipped until now was an anonymous GET, and that hides the
 * component that breaks first. On a real campaign the web tier held over 7,000 concurrent users without
 * effort while sign-in saturated at ~150 logins/s: the ceiling was in authentication, which no anonymous
 * profile can reach. A load test that cannot log in confirms what you already knew and stays silent about
 * the only thing that was wrong.
 *
 * Pure logic only — no k6 imports — so the arithmetic and the failure modes are unit-testable. The HTTP
 * calls live in live-event.js, which is wiring.
 */

/**
 * Parse a credentials CSV: `username,password` per line. Blank lines, `#` comments and an optional
 * header are skipped. Semicolon is accepted as a separator because spreadsheets in some locales export
 * that way, and a file that "looks fine" but yields zero users is a painful way to start a run.
 */
export function parseUsersCsv(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Pick the separator that actually appears first. Comparing indexOf() directly is wrong when one
    // of the two is absent: indexOf returns -1, which compares as "earliest" and silently drops the
    // line (caught by the semicolon case in tests/unit/auth.test.js).
    const iSemi = line.indexOf(';');
    const iComma = line.indexOf(',');
    const sep = iSemi >= 0 && (iComma < 0 || iSemi < iComma) ? ';' : ',';
    const parts = line.split(sep);
    if (parts.length < 2) continue;
    const username = parts[0].trim();
    const password = parts.slice(1).join(sep).trim();
    if (!username || !password) continue;
    if (username.toLowerCase() === 'username' || username.toLowerCase() === 'user') continue; // header
    out.push({ username, password });
  }
  return out;
}

/**
 * Which account this virtual user signs in with. Deterministic, one account per VU.
 *
 * WHY NOT RANDOM, AND WHY NOT ONE SHARED ACCOUNT: with a single account every login lands on the same
 * subject, so you measure how the identity provider handles one user's sessions, not how it handles
 * load. Deterministic assignment also makes a run reproducible: VU 7 is always the same account, so a
 * failure can be traced to a specific credential instead of "some user".
 */
export function pickUser(users, vuId) {
  if (!users || users.length === 0) return null;
  const i = ((Number(vuId) || 1) - 1) % users.length;
  return users[i];
}

/**
 * How many distinct accounts a login rate needs before per-account behaviour starts to dominate.
 * Successful logins do not trip brute-force detection, but they do pile up sessions per subject, and
 * some providers serialise work per user. One account per concurrent VU is the safe shape.
 */
export function usersNeeded(peakRps, sessionSeconds) {
  const r = Number(peakRps) || 0;
  const s = Number(sessionSeconds) || 0;
  return Math.max(1, Math.ceil(r * s));
}

/** Request for the OAuth2 password grant (`Direct Access Grants` in Keycloak). */
export function tokenRequest(auth, user) {
  const form = {
    grant_type: 'password',
    client_id: auth.client_id,
    username: user.username,
    password: user.password,
  };
  if (auth.client_secret) form.client_secret = auth.client_secret;
  if (auth.scope) form.scope = auth.scope;
  return {
    url: auth.token_url,
    body: encodeForm(form),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  };
}

/** Request that ends a session, when the profile asks for it (see `shouldLogout`). */
export function logoutRequest(auth, refreshToken) {
  if (!auth.logout_url || !refreshToken) return null;
  const form = { client_id: auth.client_id, refresh_token: refreshToken };
  if (auth.client_secret) form.client_secret = auth.client_secret;
  return {
    url: auth.logout_url,
    body: encodeForm(form),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  };
}

/**
 * Sessions are a resource too. 150 logins/s for one minute is 9,000 sessions on the identity provider,
 * and the memory they hold is a variable of the result: a second run that starts from a loaded provider
 * is not comparable with the first. `auth.logout: true` keeps runs comparable at the cost of one extra
 * request per iteration.
 */
export function shouldLogout(auth) {
  return Boolean(auth && auth.logout && auth.logout_url);
}

/**
 * Read the access token out of a token response. Returns `{ error }` instead of throwing: a token
 * endpoint that answers 200 with an unexpected body is a configuration problem, and the run should
 * report it per class rather than abort in the middle of a ramp.
 */
export function parseToken(bodyText) {
  let j;
  try {
    j = JSON.parse(bodyText);
  } catch (e) {
    return { error: 'token response is not JSON' };
  }
  if (j.error) return { error: String(j.error_description || j.error) };
  if (!j.access_token) return { error: 'token response has no access_token' };
  return {
    token: j.access_token,
    refreshToken: j.refresh_token || null,
    expiresIn: Number(j.expires_in) || 0,
  };
}

/** Add the bearer token without mutating the shared base headers. */
export function bearer(headers, token) {
  const h = {};
  for (const k of Object.keys(headers || {})) h[k] = headers[k];
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

/**
 * A token issued at the start of a ramp expires while the ramp is still climbing. Without a re-login
 * the authenticated class degrades to 100% failures and trips the emergency brake — reporting a
 * collapse that is an artefact of the test, not of the system under test.
 */
export function needsRelogin(status, token, expiresAtMs, nowMs, skewMs) {
  if (!token) return true;
  if (status === 401 || status === 403) return true;
  if (!expiresAtMs) return false;
  return nowMs >= expiresAtMs - (skewMs === undefined ? 5000 : skewMs);
}

export function expiryFrom(nowMs, expiresIn) {
  const s = Number(expiresIn) || 0;
  return s > 0 ? nowMs + s * 1000 : 0;
}

/**
 * Signup body with a unique identity per iteration.
 *
 * WHY UNIQUE: replaying the same address means the first request creates the account and every one after
 * measures the conflict. The class would look fast and successful — or fast and failing — and either way
 * it would not be measuring the write path.
 */
export function signupPayload(template, seq, runId) {
  const tag = `${runId || 'run'}-${seq}`;
  const email = String(template.email_pattern || 'crowdsim+{tag}@example.test').replace('{tag}', tag);
  const body = {};
  for (const k of Object.keys(template.body || {})) {
    body[k] = String(template.body[k]).replace('{email}', email).replace('{tag}', tag);
  }
  if (!Object.keys(body).length) {
    body.email = email;
    body.password = template.password || 'crowdsim-throwaway';
  }
  return { email, body };
}

/**
 * Fail fast, with a message that says what to fix. A profile that is missing the token endpoint would
 * otherwise produce a class at 100% failures and a run that looks like a capacity result.
 */
export function validateAuth(profile, env) {
  const errs = [];
  const classes = (profile && profile.classes) || [];
  const kinds = classes.map((c) => c.kind);
  const needsAuth = kinds.some((k) => k === 'login' || k === 'authed' || k === 'signup');
  if (!needsAuth) return errs;

  const auth = (profile && profile.auth) || {};
  const usersPath = (env && env.CROWDSIM_AUTH_USERS) || auth.users_csv;

  if (kinds.includes('login') || kinds.includes('authed')) {
    if (!auth.token_url) errs.push('auth.token_url is required by the login/authed classes');
    if (!auth.client_id) errs.push('auth.client_id is required by the login/authed classes');
    if (!usersPath) {
      errs.push('a credentials CSV is required: set CROWDSIM_AUTH_USERS=<path> (preferred: keeps ' +
                'credentials out of the profile) or auth.users_csv');
    }
  }
  if (kinds.includes('authed') && !kinds.includes('login')) {
    errs.push('an `authed` class needs a `login` class in the same profile: the token comes from there');
  }
  if (kinds.includes('signup')) {
    const s = classes.find((c) => c.kind === 'signup') || {};
    if (!s.signup || !s.signup.url) errs.push('the signup class needs signup.url');
  }
  if (auth.logout && !auth.logout_url) {
    errs.push('auth.logout is on but auth.logout_url is missing: sessions would pile up silently');
  }
  return errs;
}

function encodeForm(obj) {
  const parts = [];
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined || obj[k] === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
  }
  return parts.join('&');
}
