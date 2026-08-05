# Cache A/B

Two reverse proxies in front of the **same origin**, identical except for the change you are evaluating,
loaded with the **same pool** in the **same window**.

```
                     crowdsim load --base-url http://127.0.0.1:8081
                                    │
   ┌────────────────────────────────▼──────────┐
   │  leg A "asis"        :8081  →  ┐          │
   │    faithful copy of production ├─► origin │   same origin, same second,
   │  leg B "candidate"   :8082  →  ┘          │   same URL pool
   │    one behavioural change                 │
   └───────────────────────────────────────────┘
                                    │
                     X-Proxy-Cache + X-AB-Leg on every response
                     → crowdsim reports hit ratio per class per leg
```

## Why two legs instead of one before/after

A cache's hit ratio depends on the traffic mix. Enabling it in production and comparing to "yesterday"
conflates the change with whatever the traffic happened to do. Two legs at the same instant removes that
variable, and the *ratio* between them survives the fact that these containers are not tuned like your
production proxy.

## Setup

1. **Replace `asis.conf.template`** with a faithful copy of your production proxy config, changing only
   the upstream. If it currently caches nothing, that is fine — it is the baseline you have to beat.
2. **Edit `candidate.conf.template`** to hold exactly one behavioural change against leg A. One change
   per A/B, or you will not know which line bought you the offload.
3. Keep `add_header X-Proxy-Cache $upstream_cache_status` in both, and keep the header name in sync with
   your profile's `cache_headers` — otherwise crowdsim reports the hit ratio as `n/a`.

```bash
export ORIGIN_ADDR=203.0.113.10          # where to connect
export ORIGIN_HOST=www.example.test      # Host header + TLS SNI the origin expects
export CACHE_TTL=10
docker compose up -d
```

Or let the driver do it: `crowdsim cache-ab --profile p.json --ttl 10` derives both values from the
profile's resolved target.

## Traps

- **Pin the image to your production nginx minor** if you can. The cache directives used here have been
  stable for years, so the comparison holds either way — but never quote these containers for *absolute*
  nginx performance.
- **The cache lives on tmpfs**, sized at 2g. Below your working set you measure evictions instead of
  hits; on a disk volume you measure your disk.
- **`proxy_read_timeout` must match production.** It is where 504s are born, and the whole point of the
  measurement is how much of the traffic crosses it.
- **The cache key is the hardest line in the file.** Include a header that varies per user and the hit
  ratio collapses; omit one that genuinely changes the response and you serve the wrong body to the wrong
  visitor. When the origin does not send a correct `Vary`, nginx cannot help you — you are deciding by
  hand.

## Adding a third leg

Copy a service block in `docker-compose.yml` with a new template and port. The useful third leg is
normally the **narrow subset** of your full fix that you can actually ship this week — measured in the
same run, so you know what shipping the narrow version is worth.
