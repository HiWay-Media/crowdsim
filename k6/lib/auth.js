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
    // Header detection, by either column. Only `username`/`user` were checked, so an `email,password`
    // header became an account that could never log in — one guaranteed failure in the rotation, forever,
    // which with 50 accounts is 2% of logins and the same order of magnitude as max_failed_rate.
    const u = username.toLowerCase();
    const p = password.toLowerCase();
    if (u === 'username' || u === 'user' || u === 'email' || u === 'login'
        || (p === 'password' && (u === 'email' || u === 'username' || u === 'user' || u === 'login'))) {
      continue;
    }
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

/**
 * Build the sign-in request. There are two shapes, and which one you use changes WHAT you measure:
 *
 *   `password_grant` — straight at the identity provider's token endpoint. Measures the provider:
 *                      password verification is CPU-bound on purpose, so this finds ITS ceiling.
 *   `form`           — the application's own login endpoint, which talks to the provider server-side.
 *                      Measures the whole chain, and it is the realistic one: on a real campaign the
 *                      provider sat at 26% CPU while the application saturated, because its threads
 *                      were blocked waiting for authentication. Testing only the provider would have
 *                      reported headroom that users could not feel.
 *
 * Default is `form` when no client_id is given, because an application endpoint needs no client.
 */
export function tokenRequest(auth, user) {
  const mode = auth.mode || (auth.client_id ? 'password_grant' : 'form');
  const fields = auth.fields || {};
  const userField = fields.username || 'username';
  const passField = fields.password || 'password';

  const form = {};
  if (mode === 'password_grant') {
    form.grant_type = 'password';
    form.client_id = auth.client_id;
    if (auth.client_secret) form.client_secret = auth.client_secret;
    if (auth.scope) form.scope = auth.scope;
  }
  form[userField] = user.username;
  form[passField] = user.password;
  for (const k of Object.keys(fields.extra || {})) form[k] = fields.extra[k];

  const json = String(auth.body || '').toLowerCase() === 'json';
  return {
    url: auth.token_url,
    body: json ? JSON.stringify(form) : encodeForm(form),
    headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
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
export function parseToken(bodyText, tokenPath, refreshPath) {
  let j;
  try {
    j = JSON.parse(bodyText);
  } catch (e) {
    return { error: 'token response is not JSON' };
  }
  // An absent body is not an unparseable one, and the distinction matters: the k6 runtime returns
  // undefined for res.body when response bodies are discarded, and JSON.parse of that yields
  // undefined rather than throwing. Reading `.error` off it aborted the whole scenario mid-ramp.
  if (j === null || typeof j !== 'object') return { error: 'token response body is empty' };
  if (j.error) return { error: String(j.error_description || j.error) };
  // An application endpoint usually wraps its payload — `data.access_token` — while a raw token
  // endpoint puts it at the top. Guessing wrong reads as "the login works but returns no token", so
  // the path is part of the profile.
  const path = tokenPath || 'access_token';
  const token = dig(j, path);
  if (!token) return { error: `token response has no ${path}` };
  return {
    token: String(token),
    refreshToken: dig(j, refreshPath || 'refresh_token') || null,
    expiresIn: Number(dig(j, 'expires_in') || dig(j, 'data.expires_in')) || 0,
  };
}

/** Read a dotted path out of a parsed body: `data.access_token`. */
export function dig(obj, path) {
  let cur = obj;
  for (const key of String(path || '').split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
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
  // split/join and not String.replace: with a string pattern replace() substitutes ONE occurrence, so a
  // template that used {tag} twice sent a body with a literal `{tag}` still in it — a 400 from the API,
  // read as the write path rejecting load. (`replaceAll` is ES2021; k6/lib stays ES2019.)
  const fill = (text) => String(text).split('{email}').join(email).split('{tag}').join(tag);
  const email = String(template.email_pattern || 'crowdsim+{tag}@example.test').split('{tag}').join(tag);
  const body = {};
  for (const k of Object.keys(template.body || {})) {
    body[k] = fill(template.body[k]);
  }
  if (!Object.keys(body).length) {
    body.email = email;
    body.password = template.password || 'crowdsim-throwaway';
  }
  return { email, body };
}

/**
 * Zero accounts is a refusal, not a quiet run.
 *
 * THE BUG THIS REPLACES: `pickUser` returns null on an empty list, `login()` returned false without
 * sending anything, and the caller ignored the return value — so the login class emitted ZERO requests. A
 * class with no requests is dropped from `per_step` (a row of zeros reads as a step that was fast) and
 * filtered out of the per-class table, so the run completed, clean, with the whole authenticated half
 * never attempted. Every way of getting here is a file that looks fine: a header-only CSV, the wrong
 * separator, comments only.
 *
 * Returns the message, or null when there is nothing to refuse. The generator throws it in the init
 * context, where a refusal costs nothing and a wrong answer costs a campaign.
 */
export function credentialsRefusal(users, classes, path) {
  // Only the classes that SIGN IN need accounts. A `signup` class creates them, so demanding a credentials
  // file for it refuses a registration run over a file it has no use for — which is what 1.20.4 did,
  // because it asked usesAuth() (true for signup as well) instead of asking who signs in. validateAuth()
  // drew this line correctly from the start; found by running a signup class against a real endpoint.
  const signsIn = (classes || []).some(
    (c) => c && (c.kind === 'login' || c.kind === 'authed'));
  if (!signsIn) return null;
  if (users && users.length > 0) return null;
  return `no accounts in the credentials file (${path || 'unset'}).

  This run signs in, so it needs at least one \`username,password\` line. The file was read and parsed to
  nothing, which is what a header-only file, a space-separated one, or the wrong separator look like.
  Refusing here on purpose: without accounts the login class sends no requests at all, and a class with
  no requests is left out of the tables — the run would look clean with its authenticated half missing.`;
}

/**
 * Fewer accounts than virtual users, said out loud.
 *
 * `pickUser` assigns by `vuId % users.length`, so 50 accounts across 400 VUs means each account is
 * signing in from eight of them at once. Successful logins do not trip brute-force detection, but some
 * providers serialise work per subject — so part of the ceiling you measure is your account count rather
 * than the provider's capacity. `usersNeeded()` was written for this question and nothing asked it.
 *
 * A note and not a refusal: one account against one provider is a legitimate thing to measure, as long as
 * nobody reads the result as a capacity figure.
 */
export function accountSharingNote(userCount, vus) {
  const n = Number(userCount) || 0;
  const v = Number(vus) || 0;
  if (n <= 0 || v <= 0 || n >= v) return null;
  const per = Math.ceil(v / n);
  const label = n === 1 ? '1 account' : `${n} accounts`;
  return `${label} for ${v} virtual users: each account signs in from about ${per} of them at once. `
    + 'Some identity providers serialise work per subject, so part of what this run measures is the '
    + 'account count and not the provider. One account per VU is the shape that measures the provider.';
}

/**
 * How to find, afterwards, the accounts a signup run created.
 *
 * WHY THIS EXISTS — a signup class at 40/s for five minutes creates twelve thousand real accounts in a
 * real identity provider. The StreamWay+ campaign left ~2,970 of them behind and had to open a ticket to
 * hunt them down; they were findable only because somebody had thought to use a dedicated mail domain. The
 * tool that created them is the one thing that knows exactly what they were, and it recorded nothing.
 *
 * Every identity is `email_pattern` with `{tag}` replaced by `<runId>-<vu>-<iteration>`, so ONE run's
 * accounts are exactly the ones whose tag starts with that run id. That prefix is the cleanup key, and it
 * is worth more than a list: it stays correct when the list is truncated, and it works in a provider's own
 * search box.
 *
 * What this deliberately does not carry: **no password, ever**, not even the throwaway one from the
 * template. A file that lists credentials for a real system is a different category of object from a run
 * artefact, and this one is written next to the summary — in `out/`, which is gitignored, and which is
 * still not a place for secrets.
 */
export function signupIdentity(template, runId) {
  const pattern = String((template || {}).email_pattern || 'crowdsim+{tag}@example.test');
  const prefix = String(runId || 'run') + '-';
  return {
    email_pattern: pattern,
    tag_prefix: prefix,
    // What to paste into the provider's search: every identity this run created and nothing else.
    email_glob: pattern.split('{tag}').join(prefix + '*'),
  };
}

/**
 * The manifest itself. Pure so its shape is asserted rather than eyeballed once: this file is the input to
 * somebody's deletion script, and a field that quietly changes name breaks a cleanup nobody re-reads.
 *
 * `emails` is what the run actually logged as created — exact, and possibly incomplete if a log was
 * truncated or rotated, which is why the glob is there as well. The two are not alternatives: the list is
 * for reading, the glob is for sweeping.
 */
export function signupManifest(o) {
  const opts = o || {};
  const id = signupIdentity(opts.template, opts.runId);
  const emails = (opts.emails || []).filter(function (e) { return typeof e === 'string' && e; });
  return {
    run_id: opts.runId || null,
    class: opts.className || null,
    target: opts.target || null,
    signup_url: (opts.template || {}).url || null,
    email_pattern: id.email_pattern,
    tag_prefix: id.tag_prefix,
    email_glob: id.email_glob,
    created: opts.created === undefined ? emails.length : Number(opts.created),
    failed: opts.failed === undefined ? 0 : Number(opts.failed),
    emails: emails,
    // Said in the file, because the file is what somebody finds three weeks later.
    _comment: 'These accounts EXIST on the target above. crowdsim created them and will not delete them: '
      + 'removing accounts from somebody\'s identity provider is not a load generator\'s job, and a tool '
      + 'that could do it would be a tool that could do it by accident. Use email_glob to find them. No '
      + 'password is recorded here, by design — and this file names real accounts on a real system, so it '
      + 'belongs where the run output belongs: out/ is gitignored, keep it that way and out of any public '
      + 'repository.',
  };
}

/**
 * Does this profile sign in at all? Asked in three places — the generator (to decide whether to read the
 * credentials file), the profile linter, and validateAuth itself — so it lives here once. Three copies of
 * the same predicate is how one of them ends up disagreeing.
 */
export function usesAuth(classes) {
  return (classes || []).some(
    (c) => c && (c.kind === 'login' || c.kind === 'authed' || c.kind === 'signup'));
}

/**
 * Fail fast, with a message that says what to fix. A profile that is missing the token endpoint would
 * otherwise produce a class at 100% failures and a run that looks like a capacity result.
 */
export function validateAuth(profile, env) {
  const errs = [];
  const classes = (profile && profile.classes) || [];
  const kinds = classes.map((c) => c.kind);
  if (!usesAuth(classes)) return errs;

  const auth = (profile && profile.auth) || {};
  const usersPath = (env && env.CROWDSIM_AUTH_USERS) || auth.users_csv;

  if (kinds.includes('login') || kinds.includes('authed')) {
    if (!auth.token_url) errs.push('auth.token_url is required by the login/authed classes');
    // client_id belongs to the password grant only: an application login endpoint needs no client.
    if ((auth.mode || (auth.client_id ? 'password_grant' : 'form')) === 'password_grant' &&
        !auth.client_id) {
      errs.push('auth.client_id is required with mode "password_grant" (drop it for an application ' +
                'login endpoint, which is mode "form")');
    }
    if (auth.mode && auth.mode !== 'form' && auth.mode !== 'password_grant') {
      errs.push('auth.mode must be "form" (application endpoint) or "password_grant" (token endpoint)');
    }
    if (!usersPath) {
      errs.push('a credentials CSV is required: set CROWDSIM_AUTH_USERS=<path> (preferred: keeps ' +
                'credentials out of the profile) or auth.users_csv');
    }
  }
  if (kinds.includes('authed') && !kinds.includes('login')) {
    errs.push('an `authed` class needs a `login` class in the same profile: the token comes from there');
  }
  // A class with no URLs sends nothing, and a class that sends nothing is absent from every table in the
  // summary rather than reported as broken — the same invisibility that made a zero-account credentials
  // file look like a working run. `probe` checks the other half (that the URLs actually require the
  // token); this half needs no target and so is refused here, at init.
  //
  // Membership is only claimed when the pools were actually handed over. The generator calls this with a
  // SUBSET of the profile — `{ auth, classes }`, because --skip-classes has already been applied — and
  // reading `profile.pools` off that subset made every authenticated run die in k6's init context
  // claiming a pool was missing from a profile that had it. Not being shown the pools is not evidence
  // that a pool is absent.
  const pools = profile && profile.pools;
  for (const c of classes) {
    if (!c || c.kind !== 'authed') continue;
    const name = c.name || '(unnamed)';
    if (!c.pool) {
      errs.push(`the authed class \`${name}\` names no pool, so it has no URL to request`);
    } else if (pools && (!Array.isArray(pools[c.pool]) || !pools[c.pool].length)) {
      errs.push(`the authed class \`${name}\` draws from the pool "${c.pool}", which is `
        + `${Array.isArray(pools[c.pool]) ? 'empty' : 'not in this profile'}`);
    }
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
