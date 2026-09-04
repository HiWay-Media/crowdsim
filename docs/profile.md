# Profile reference

The profile is the whole configuration. The tool knows nothing about any particular site: hostnames, the
request mix, URL pools, cache headers, SLOs and the safety allowlist all live in one JSON file supplied at
runtime.

**Keep yours in your own private repo.** A profile is a map of your infrastructure — hostnames, internal
addresses, real routes, build hashes. This repo ships `profiles/example.json` and refuses the rest via
`.gitignore`.

Keys beginning with `_` are documentation. JSON has no comments, and a profile that cannot explain itself
gets copied wrong; the driver strips them before the generator ever sees them.

```json
{
  "name": "example-nextjs",
  "description": "…",
  "targets": { "default": "edge", "list": { … } },
  "classes": [ … ],
  "pools":   { … },
  "rsc":     { … },
  "cache_headers": [ … ],
  "headers": { … },
  "slo":     { … },
  "safety":  { … },
  "discover":{ … },
  "journey": { … }
}
```

---

## `targets`

Named places to point the load. `default` is used when `--target` is absent.

```json
"targets": {
  "default": "edge",
  "list": {
    "public":   { "base_url": "https://www.example.test" },
    "edge":     { "base_url": "https://www.example.test",
                  "bypass": "www.example.test=203.0.113.10" },
    "proxy-node": { "base_url": "https://10.0.0.11:8092",
                    "host_header": "www.example.test", "insecure": true },
    "app-instance": { "base_url": "http://10.0.0.21:3000",
                      "skip_classes": "proxy_only" }
  }
}
```

| Key | Type | What it does |
|---|---|---|
| `base_url` | string, required | Scheme, host, optional port. Paths come from the pools. |
| `host_header` | string | Overrides the `Host` header, to address a tier directly while it still routes by name. |
| `bypass` | `host=address` | Skips a CDN while keeping SNI and `Host` correct — this is how you measure **your** origin instead of somebody's edge cache. Becomes k6's `hosts` map. |
| `insecure` | bool | Skip TLS verification, for a node addressed by IP presenting a certificate for a name. Saves remembering `--insecure` on every run against that target. |
| `skip_classes` | `"a,b"` | Classes this tier does not serve. Overridable with `--skip-classes`. |

Choosing a target is choosing what you measure:

```
public       → the CDN (and your egress bill), not your origin
edge         → your own load balancer, CDN bypassed        ← usually the one you want
proxy-node   → one caching-proxy node, load balancer skipped
app-instance → one application instance: per-instance capacity
```

**`skip_classes` matters more than it looks.** Hitting an app instance directly means the routes only the
reverse proxy serves answer 404 — that class goes to 100% failed, the brake trips at a couple of req/s, and
the instance looks far weaker than it is.

---

## `classes` — the mix

The heart of it. Each class is a kind of request with a **weight**: its share of user requests per second,
measured on your own edge access log during the spike you want to replay. `--peak` is the total; each class
gets `weight / total × peak`.

```json
{ "name": "rsc_page", "label": "RSC navigation", "weight": 43.2,
  "kind": "rsc", "pool": "pages" }
```

| Key | Required | What it does |
|---|---|---|
| `name` | yes | Metric tag and `--skip-classes` key. Must be unique — duplicates would merge silently. |
| `label` | no | Shown in k6 output. Defaults to `name`. |
| `weight` | yes | Positive number. Only relative values matter. |
| `kind` | no | `plain` (default) or `rsc` (Next.js React Server Components navigation: `RSC: 1`, `Next-Router-Prefetch`, `Accept: text/x-component`, and the `_rsc` query parameter). |
| `pool` | yes | Which pool the path comes from. |
| `path_suffix_pool` | no | A second pool appended to the path (pagination, filters). |
| `path_prefix` | no | Prepended (a route only one tier serves). |
| `rsc_state_path` | no | The path used to build `Next-Router-State-Tree`, when it differs from the requested one (search). |
| `max_p95_ms` | no | This class's own p95 limit, sharper than the profile's, which aborts the run for this class alone — see [A class may set its own limit](#a-class-may-set-its-own-limit). |
| `max_failed_rate` | no | This class's own failed-rate limit, same rule. |
| `log_match` | no | Path globs identifying this class in an access log, for [`crowdsim weights`](cli.md#weights). No effect on a run — see [`log_match`](#log_match). |
| `rate_rps` | no | An absolute rate for this class **instead of** a weight — see [Aiming one class](#aiming-one-class). A class declares one or the other, never both. |

Rules the tool enforces, and why:

- **Only count what the client requests.** Sub-requests the app makes to itself are a *consequence* of a
  page view; generating them yourself double-counts the load.
- **Weights are renormalised** over the classes that actually run, so `--peak` keeps meaning the total even
  when a class is skipped or dropped.
- **An empty pool drops the class**, loudly, and the rest is renormalised. There is no honest fallback:
  pointing the class at another pool would measure the wrong request type under the right label — a
  rendered 404 counted as a static asset.
- **Keep search separate.** It is frequently the most expensive class per request; averaged into the
  others it hides the thing that actually falls over.

### Aiming one class

A finding is usually about one class. *"The login saturates at ~150 login/s"* is the answer a campaign
comes back with, and to reproduce it through a weight you set a global `--peak` and solve for the weight by
hand — arithmetic in the wrong direction, redone every time the question changes.

```json
{ "name": "login",  "kind": "login",  "rate_rps": 150 }
{ "name": "html",   "kind": "plain",  "weight": 70, "pool": "pages" }
{ "name": "static", "kind": "plain",  "weight": 30, "pool": "static" }
```

With `--peak 250`: `login` gets **exactly 150**, and `html`/`static` split the remaining 100 by weight —
70 and 30. The two compose, and that composition is the point:

- **`--peak` keeps meaning the total.** It is also what the safe-peak gate reads, so a per-class rate is
  not a way past a ceiling: pin one class at 40 and leave a weighted one, ask for `--peak 200` against a
  ceiling of 50, and the run is refused with exit 3 like any other.
- **Fixed rates above `--peak` are refused**, naming both numbers, before k6 is started. They are never
  scaled down to fit: the run would then measure a rate nobody asked for and report it under the one they
  did.
- **A pinned rate is the rate at peak.** The class still ramps with everybody else — holding it flat from
  the first step would put the total above that step's own total and `--start`/`--steps` would stop meaning
  anything.
- **If every class is pinned**, `--peak` becomes a ceiling rather than a target: the run generates the sum
  of the fixed rates and says so, in the panel and in `validate`.

The rate each class was aimed at, and whether it came from a pin or a weight, is in the summary
(`allocation`) and in the per-class table as `target req/s`.

### `log_match`

How `crowdsim weights` recognises this class in an access log. A list of path globs, anchored at the start of
the path, where `*` spans slashes:

```json
{ "name": "static", "weight": 9.8, "pool": "static",
  "log_match": ["/_next/static/*", "/assets/*"] }
```

It has **no effect on a run**: a profile without it generates identical traffic, it just cannot have its mix
measured. Which is the point of declaring it — the weights are the one input this tool insists must come from
a measurement, and [`weights`](cli.md#weights) is what turns a log into them.

With no `log_match`, a class is still recognised by its `path_prefix` and by membership of its own pool, plus
the hard filter that an `rsc` class only ever matches a request carrying the navigation parameter. That is
enough for classes drawing on a `discover` pool of real page paths, and not enough for a class whose pool is
a list of build-hashed asset URLs — which is exactly where a rule is worth declaring.

Nothing is inferred from the shape of a URL: whatever no class claims is reported as an **unclassified
share**, and that number is what tells you the mix is incomplete. `validate` refuses a pattern that does not
start with `/`, because such a pattern can never match and an unclassified share is a slow way to find out.

---

## `pools` — the URLs

```json
"pools": {
  "pages": ["/", "/news", "/news/latest"],
  "searches": ["/search?q=alpha", "/search?q=beta"],
  "static": "@pool-static.json"
}
```

A list of paths, or `"@file.json"` — a path relative to the profile, inlined by the driver at run time.
`crowdsim discover` writes exactly that kind of file.

- Paths must **render**. A 404 is cheap for the app tier (or is itself rendered), so a pool of them yields
  a flattering number for a load that never reached the renderer.
- Regenerate static pools after every deploy: they contain build hashes.
- Two runs are only comparable at an **identical pool**. A synthetic pool of distinct cold URLs is harsher
  than real traffic concentrated on a few hot keys: the tool measures deltas honestly and absolutes
  optimistically.

---

## `rsc`

```json
"rsc": { "param": "_rsc", "hashes": ["1dxlt", "9y2af", "…"] }
```

On a Next.js build the `_rsc` value depends on route and build, **not** on the request: one measured event
had tens of thousands of navigation requests collapsing onto ~13 distinct values. That repetitiveness is
the entire premise of "a shared micro-cache would absorb most of this".

- `--rsc-mode repeat` (default) replays it, using `hashes` (a built-in list is used if you omit them).
- `--rsc-mode random` is a real cache-buster — a fresh value per request. It measures what the load *would*
  cost if the parameter were per-request, which is usually the hypothesis you want to disprove.

Do not mix the two when comparing runs.

---

## `cache_headers`

Which response header reveals each layer's cache state, and what counts as a hit.

```json
"cache_headers": [
  { "label": "proxy", "header": "X-Proxy-Cache", "hit": "HIT|STALE|UPDATING|REVALIDATED" },
  { "label": "cdn",   "header": "X-Cache",       "hit": "Hit" },
  { "label": "souin", "header": "Cache-Status",  "hit": "hit" }
]
```

`hit` is a case-insensitive regular expression matched against the header **value** — nginx says `HIT`, a
CDN says `Hit from cloudfront`, RFC 9211 says `hit; detail=…`, so substring matching is the only thing that
works across layers. Omit it and `hit` is assumed.

**A missing header is not a miss.** If the header never appears, that layer reports `n/a`, not 0% — because
"the cache missed everything" and "this layer was never in the path, or the header name in the profile is
wrong" are opposite conclusions from the same number.

---

## `headers`

Extra request headers for every request, e.g. `{"Accept-Language": "en-GB,en;q=0.9"}`. Every request also
carries `User-Agent: crowdsim/…` and `X-Crowdsim-Run: <run_id>`, so you can exclude the test from your own
traffic forensics and recognise it in access logs.

---

## `slo` — the brake

```json
"slo": { "max_failed_rate": 0.05, "max_p95_ms": 5000,
         "guillotine_ms": 7000, "brake_class": "rsc_page" }
```

| Key | Default | What it does |
|---|---|---|
| `max_failed_rate` | `0.05` | Abort when the overall failed rate crosses this. |
| `max_p95_ms` | `5000` | Abort when `brake_class`'s p95 crosses this. |
| `guillotine_ms` | `7000` | **Your reverse proxy's read timeout.** Not a brake: requests slower than this become 504s for real visitors, so crowdsim reports the share of each class that crossed it. That percentage is your margin. |
| `brake_class` | first class | Which class's p95 aborts the run. Pick the one that actually falls over. |

Set `guillotine_ms` **above** `max_p95_ms`. Inverted, the brake would only fire after real users were
already getting 504s.

### A class may set its own limit

One SLO for every class is one SLO too few. A document that takes 2 s is unpleasant; a navigation request
that takes 2 s means the app is already queueing, and by the time the *document* crosses a shared 5 s limit
the run has spent a minute measuring a system that was already gone. So a class can declare its own:

```json
"classes": [
  { "name": "rsc_page", "weight": 45, "pool": "pages", "max_p95_ms": 800 },
  { "name": "html",     "weight": 40, "pool": "pages" },
  { "name": "search",   "weight": 15, "pool": "queries", "max_failed_rate": 0.01 }
],
"slo": { "max_p95_ms": 2500, "max_failed_rate": 0.05, "guillotine_ms": 6000, "brake_class": "html" }
```

Both keys are optional, both default to the profile's, and **both may only be sharper**. A per-class limit
looser than the profile's is refused by `validate` — it would move the knee *later* for that class, so a run
would sail past the SLO the profile states, which is the opposite of what a brake is for:

```
❌ classes[0].max_p95_ms  3000 ms is looser than the profile's 2500 ms: the brake would fire later than the
                          profile asks for. A per-class limit may only make it sharper.
⚠️  classes[2].max_p95_ms  40 ms is below what a healthy origin answers in over a real network: this would
                          abort on the ramp and read as a knee
```

Whichever limit is crossed first stops the run, and the run **says which one**, in the panel and in the
summary — with per-class SLOs "the brake tripped" is no longer enough information to act on:

```
  outcome       ⛔ ABORTED by the brake (knee exceeded)
                stopped by class rsc_page — p(95)<300, reached 534
```

`brake_class` keeps its meaning for classes that declare nothing: it is the one whose p95 is held to the
profile's `max_p95_ms`. A class with its own limit is always its own brake.

---

## `auth` — signing in

Everything above generates anonymous GETs, and that hides the component that usually breaks first. On a
real campaign the web tier held over **7,000 concurrent users** without effort while **sign-in saturated
at ~150 logins/s**: the ceiling was in authentication, and no anonymous profile can reach it. A load test
that cannot log in confirms what you already knew and stays silent about the only thing that was wrong.

Three class kinds use this block: `login`, `authed` and `signup`.

```json
"auth": {
  "token_url": "https://auth.example.test/realms/example/protocol/openid-connect/token",
  "client_id": "example-web",
  "logout": false,
  "logout_url": "https://auth.example.test/realms/example/protocol/openid-connect/logout"
}
```

| Key | Meaning |
|---|---|
| `token_url` | the OAuth2 token endpoint. Absolute: the identity provider is a different host from the site, and the URL is not prefixed with the target's base URL |
| `client_id` | the client to authenticate as. Prefer a **public** client for load tests |
| `client_secret` | only for confidential clients. A secret in a profile is a secret in a file that gets copied around |
| `scope` | optional, passed through to the token request |
| `logout` / `logout_url` | end each session instead of leaving it to expire — see [sessions are a resource](#sessions-are-a-resource) |
| `mode` | `form` (default) posts the credentials to an **application** login endpoint; `password_grant` sends the OAuth2 password grant, and then `client_id` is required |
| `token_path` | dotted path to the token in the response. Default `access_token`; an application endpoint usually wraps it (`data.access_token`) |
| `refresh_path` | same, for the refresh token. Default `refresh_token` |
| `fields` | the field names the endpoint expects: `{"username": "email", "password": "pass", "extra": {"remember": "1"}}` |
| `body` | `form` (default) or `json` for an endpoint that wants a JSON body |

**Which mode is yours is a question about the load, not about style.** The campaign that motivated all of
this saturated at ~150 logins/s while the identity provider sat at 26%, because the site signs in through
its own API and the provider is never on the path of the request being measured. Pointing a profile at the
provider's token endpoint measures a component that was not the bottleneck.

```json
"auth": {
  "token_url": "https://www.example.test/api/auth/login",
  "token_path": "data.access_token"
}
```

Guessing that the token sits at the top level of the body reads as *the login works but returns no token*,
which is why the path is declared rather than inferred. A login that answers without a usable token is
counted as `no token:` in the summary (`cs_auth_fail`) — it is not an HTTP error, and nothing else
would show it.

**An `authed` class needs an endpoint that actually refuses an anonymous request.** This is worth checking
with `curl` before the run: an endpoint that answers 200 with the same body and no token proves nothing,
and the class then measures an anonymous GET wearing an `Authorization` header. `401/403` in the summary
(`cs_denied`) is the counter that tells you the opposite case — an authenticated class being *refused*
under load, which is neither a 5xx nor a 404.

**With `mode: "password_grant"` the grant is the OAuth2 password grant** (`Direct Access Grants` in
Keycloak). If your client only allows
Authorization Code + PKCE, do not script the login form: create a **client dedicated to load tests** with
the password grant enabled. Parsing a login page is three requests of HTML scraping that break on the
next redesign, and the numbers you get are about the form, not about authentication.

### Credentials stay out of the profile

```bash
# username,password — one per line. `#` comments and a header row are skipped.
printf 'username,password\nuser1@example.test,pw-one\nuser2@example.test,pw-two\n' > users.csv

CROWDSIM_ALLOW_TARGETS="www.example.test,auth.example.test" \
CROWDSIM_AUTH_USERS=./users.csv \
  crowdsim load --profile profiles/example.json --peak 10 --steps 2 --step-dur 10s --dry-run
```

`CROWDSIM_AUTH_USERS` wins over `auth.users_csv`, and it is the way to pass credentials: profiles get
shared, secrets should not travel with them. In the container the file must be **mounted**, and the path
is the one inside the container.

**One account per virtual user**, assigned deterministically: VU 7 always signs in as the same account.
With a single shared account you would measure how the provider handles one subject's sessions rather
than how it handles load, and a failure could not be traced to a credential.

**A file that parses to no accounts refuses the run** (exit 4, from the generator's init context). Every
way of getting there looks fine from the outside: a header-only CSV, a space-separated one, the wrong
separator, comments only. It has to be a refusal rather than a warning, because the failure it replaces
was silent — `pickUser` had nothing to return, the login class sent **no requests at all**, and a class
with no requests is dropped from the per-step table and filtered out of the per-class one. The run
completed, clean, with its whole authenticated half missing. A refusal costs a second; that costs a
campaign.

**Fewer accounts than virtual users is reported, not refused.** With 50 accounts and 400 VUs each account
signs in from about eight of them at once, and some identity providers serialise work per subject — so
part of the ceiling you measure is your account count. The run says so at the start, the summary records
it in `auth` (`users`, `vus`, `sharing_note`), and both reports carry it as a caveat next to the numbers.
Measuring one account against one provider is legitimate; reading that result as a capacity figure is
not.

### Their weights do not come from an access log

`crowdsim weights` counts GETs, so a `login` or `signup` class — both POSTs — is reported as **not
countable** rather than as zero, and `init --access-log` says the same in the draft it writes. Their weight
comes from a rate you measured yourself: logins per second in the window you care about, from the identity
provider or the application logs. An `authed` class is a GET and is counted normally, if your log lets you
tell it apart (that is what `log_match` is for).

### The three kinds

```json
{ "name": "login",      "kind": "login",  "weight": 2.0, "max_p95_ms": 1500 }
{ "name": "authed_api", "kind": "authed", "weight": 3.0, "pool": "api", "max_p95_ms": 800 }
{ "name": "signup",     "kind": "signup", "weight": 0.5, "max_p95_ms": 2000,
  "signup": { "url": "/api/auth/register", "email_pattern": "crowdsim+{tag}@example.test",
              "body": { "email": "{email}", "password": "throwaway", "name": "load test {tag}" } } }
```

- **`login`** posts the password grant and keeps the token for that VU. It takes no `pool`: its URL is
  `auth.token_url`.
- **`authed`** sends `Authorization: Bearer` and draws paths from its `pool`. It **needs a `login` class
  in the same profile** — the validator refuses the profile otherwise, because the token would have no
  source. The token is refreshed on its own when it is about to expire or when the API answers 401: a
  token issued at the start of a ramp expires while the ramp is still climbing, and without that the
  class would collapse to 100% failures and trip the brake for a reason that is not the system's.
- **`signup`** registers a **new identity per iteration**. Replaying one address would create the account
  on the first request and measure the conflict on every one after. `{email}` and `{tag}` are substituted
  in the body; `{tag}` includes the run id and the VU, so two runs never collide.

A note on the templates: `{email}` and `{tag}` are substituted **everywhere they appear** in a value. Until
1.20.4 only the first occurrence was replaced, so a template that used `{tag}` twice sent a body with a
literal `{tag}` still in it — a 400 from the API, read as the write path rejecting load.

⚠️ **The accounts a signup class creates are real**, and from 1.23.0 the run tells you exactly which ones.

Every identity is `email_pattern` with `{tag}` replaced by `<run id>-<vu>-<iteration>`, so one run's
accounts are precisely those carrying its run id. After the run:

```
  ⚠️  this run CREATED 40 accounts on https://www.example.test — they still exist
     manifest: out/signups-20260904T153647Z.json  (40 listed by address)
     find them all: load+20260904T153647Z-*@example.test
     crowdsim will not delete them: that is not a load generator's job. And do not commit that
     file — it names real accounts on a real system.
```

`out/signups-<run-id>.json` carries the run id, the target, the pattern, the glob, the counts and the
addresses. Two things it will never carry, and both are asserted by a test:

- **No password**, not even the throwaway one the template declares. A file that lists credentials for a
  real system is a different category of object from a run artefact.
- **No deletion.** crowdsim will not remove accounts from an identity provider — a tool that could do that
  is a tool that could do it by accident. The glob is there so your own script, or the provider's own
  search, can.

The list comes out of the run log, because a k6 virtual user has no other channel: VUs are isolated, so
there is no shared array to collect into. That also means the list can be short of the count if a log was
truncated — which is why the glob is in the file as well. The count comes from a metric and is exact.

⚠️ **`out/` is gitignored, and this file is the reason to keep it that way.** It names real accounts on a
real system: it belongs with the run output and in your private ops repository, never in a public one. Use
a dedicated mail domain, as the campaign did — it is what made ~3,000 leftover accounts findable at all.

### Running it on a scheduler

`CROWDSIM_AUTH_USERS` is set once for the environment, and the generator reads the file **only when a
class in that run signs in** — so an anonymous profile on the same job does not care whether it exists,
and `--skip-classes login,authed,signup` makes an authenticated profile run without credentials.

In the parameterized Nomad job (`ci/nomad/crowdsim.nomad.hcl`) the variable already points at the
allocation's secrets directory. The CSV is rendered from a Nomad variable, so it exists for the life of
the run and nowhere else:

```bash
nomad var put nomad/jobs/crowdsim auth_users=@users.csv
```

then uncomment the `secrets/users.csv` template in the job file. The GUI needs nothing extra: every run
is a child process of `bin/crowdsim` and inherits the environment.

If the file is missing when a class needs it, the run is refused at init with the path and the fix:

```
credentials file not found: /secrets/users.csv. The login/authed classes need a `username,password`
CSV: point CROWDSIM_AUTH_USERS at one, or drop the authenticated classes with --skip-classes.
```

### Sessions are a resource

150 logins/s for one minute is **9,000 sessions** on the identity provider, and the memory they hold is a
variable of the result: a second run that starts from a loaded provider is not comparable with the first.
`"logout": true` (with `logout_url`) keeps runs comparable at the cost of one extra request per iteration.
Leaving it off is fine for a one-off; it is not fine for a before/after.

### What to know before pointing this at production

- **Brute-force detection**: successful logins do not trip it, but a single wrong credential in the CSV
  does — and from that point the run measures lockouts, not capacity. Check the CSV against one account
  by hand first.
- **The login class is normally the first to knee**, so give it its own `max_p95_ms`: without one it
  inherits the global SLO and the brake fires on the wrong class.
- **Sign-in is not cacheable**, so a CDN in front changes nothing here: whatever you point at, the
  identity provider takes the full rate.

## `safety` — the two gates

```json
"safety": {
  "safe_peak_rps": 150,
  "allow_hosts": ["www.example.test", "10.0.0.*", "127.0.0.1"]
}
```

| Key | What it does |
|---|---|
| `allow_hosts` | Hostname globs the tool may generate load against. Hostnames only — no scheme, no port, no path. `CROWDSIM_ALLOW_TARGETS` overrides it. **No default anywhere**: a load test aimed at the wrong hostname is indistinguishable from an attack. `"*"` is rejected — it is not an allowlist, and neither is `[]`: declared-and-empty is an error, because a profile that looks complete and is refused at the gate tells you nothing about why. Omitting the key is fine — then the allowlist has to come from the environment. |
| `safe_peak_rps` | The ceiling above which a run needs `--i-know-this-breaks-production` on the command line. Falls back to 150 if absent, which is a guess about *your* system. Set it to a level you have already proven harmless — not to what you hope is harmless. |
| `generator_mbps` | Optional: what the **generator's** link can sustain, in Mbit/s. With it, `load` and `doctor` compare the bandwidth the requested peak implies (page weight × peak, from the newest `probe`) and warn before a run comes back `generator_ok: false`. A warning, never a gate. Leave it out and the estimate falls back to whatever `crowdsim doctor --bench` measured on this machine — a loopback ceiling, labelled as one. Declaring the real uplink is better: it is the only one of the two that knows about your network. |

---

## `discover`

```json
"discover": { "sitemap": "https://www.example.test/sitemap.xml",
              "strip_prefix_regex": "^/(en|es|it)(?=/)" }
```

`strip_prefix_regex` removes locale prefixes the site redirects: testing a 307 measures the redirect, not
the render. `crowdsim discover --verify` then drops whatever still does not answer 2xx, and records what it
dropped — which is the only version of "verify the URLs first" that actually happens for 400 of them.

---

## `journey`

```json
"journey": { "file": "journey.json" }
```

Only for `--shape journey`: a recorded fan-out of `{path, rsc[], static[]}` per page, written by
`crowdsim record <file.har>` from a browser HAR export (see [CLI reference](cli.md#record)), relative to the
profile. One iteration is one visitor session — a document plus its fan-out, then 2–4 in-app navigations
with think time between them. Record it with a real browser against your own site.

The file is passed to the generator **only** in journey shape: naming a journey file that does not exist
would otherwise abort the run in k6's init context with a stack trace instead of a load test.

---

## `journey.think_time` — half of any concurrency figure

```json
"journey": {
  "file": "journey.json",
  "think_time": { "samples": [820, 1400, 3100], "measured": true }
}
```

The reading pauses between pages. It matters more than it looks: **concurrency is sessions/s × session
duration, and the session duration IS the fan-out plus these pauses.** A capacity requirement arrives as
"7,000 concurrent users", so the pause is half of the number that answers it.

| Shape | Meaning |
|---|---|
| `{ "samples": [ms, …], "measured": true }` | Pauses somebody observed. Picked from, not fitted: a uniform range drawn between the smallest and largest would return values nobody ever saw. `crowdsim record` writes this from a browser recording, `measured` included. |
| `{ "min_ms": 2000, "max_ms": 9000 }` | A declared range. |
| absent | `1000-5000 ms`, the value this tool has always used — and the run reports the source as `default`, so a concurrency figure is never read as if the pace had been measured. |

`validate` refuses an inverted range and a pause of `0` inside `samples`: both fall back to the default
silently, and a run whose pace nobody chose still prints a concurrency figure. A deliberate "no pause" is
`{ "min_ms": 0, "max_ms": 0 }`, where it is explicit.

## Validating a profile

```bash
crowdsim validate my-site.json                              # every rule at once, exit 2 on errors
crowdsim doctor --profile my-site.json                      # the same, as a report (always exits 0)
crowdsim load --profile my-site.json --peak 10 --dry-run    # what the generator would receive
```

`validate` reports **errors** and **warnings** separately, and the distinction is deliberate:

| | Meaning | Effect on `load` |
|---|---|---|
| **error** | the profile would fail, or produce a run that means nothing | refused, exit 2, before the safety gates |
| **warning** | it will run, but perhaps not mean what the author thinks | printed, the run proceeds |

An error is reserved for what is fatal to *any* run of this profile: a class pointing at a pool that does
not exist, weights that add to zero, duplicate class names (the metrics would merge), a brake class that is
not in the mix (nothing would abort the run), an allowlist of `*`, a malformed `bypass`, an invalid `hit`
regex. A target declared without a `base_url` is only a **warning** — nobody has to select it, and selecting
it already fails with a precise exit 2.

**One implementation.** The rules live in `lib/validate.mjs`; the CLI reaches them through
`lib/validate-cli.mjs` and the GUI's editor imports the same module, so validation cannot drift from what a
run requires. The cost, stated rather than hidden: that module is JavaScript, so full validation needs
**node** — which the CLI otherwise does not. Without it, `validate` exits 5 and `load` says *"full profile
validation needs node — only the structural checks ran"* before carrying on with what the driver checks by
itself while resolving the profile: pool references, missing pool files, empty pools. The half it cannot
check that way is the interesting half.

## See also

- [`profiles/example.json`](../profiles/example.json) — the same fields, commented inline
- [Running a test](running-a-test.md) · [Reading results](reading-results.md)
