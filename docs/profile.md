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

---

## `safety` — the two gates

```json
"safety": {
  "safe_peak_rps": 150,
  "allow_hosts": ["www.example.test", "10.0.0.*", "127.0.0.1"]
}
```

| Key | What it does |
|---|---|
| `allow_hosts` | Hostname globs the tool may generate load against. Hostnames only — no scheme, no port, no path. `CROWDSIM_ALLOW_TARGETS` overrides it. **No default anywhere**: a load test aimed at the wrong hostname is indistinguishable from an attack. `"*"` is rejected — it is not an allowlist. |
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
