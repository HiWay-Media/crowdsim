# crowdsim — one image: the driver, the generator, and the GUI.
#
# Built on the official k6 image because k6 is the one component you must not substitute: the generator
# has to sustain the target rate, and a rate the generator cannot deliver produces a run that looks like
# a healthy system under load. crowdsim reports `generator_ok` for exactly this reason.
#
# One image and not two, even though the generator needs none of the GUI: two images means two tags to
# keep straight, and the day they drift is the day somebody runs a load test with a driver that does not
# match the page that launched it. Node and the built UI cost about 60 MB on top of the generator — a
# price worth paying to be able to say "this tag is crowdsim".
#
# ⚠️ Do NOT run this image on a laptop to test a remote target. On macOS and Windows the Docker network
#    layer saturates before the target does — measured, not theorised. Run it on a Linux host near the
#    target (that is what the Nomad job is for), or install k6 natively for local runs. The GUI in the
#    image is fine anywhere: it is a page, not a generator.
#
# The image ships NO profile: a profile contains your hostnames, URL pools and measured mix. Mount it,
# or fetch it with a Nomad artifact stanza from your own private repo.
#
#   docker run --rm --network host \
#     -e CROWDSIM_ALLOW_TARGETS='www.example.test' \
#     -v "$PWD/my-profile.json:/profile.json:ro" -v "$PWD/out:/out" \
#     ghcr.io/hiway-media/crowdsim:1.2.0 crowdsim load --profile /profile.json --peak 60
#
#   docker run --rm -p 127.0.0.1:8787:8787 \
#     -e CROWDSIM_GUI_BIND=0.0.0.0 -e CROWDSIM_GUI_TOKEN="$(openssl rand -hex 16)" \
#     -e CROWDSIM_ALLOW_TARGETS='www.example.test' \
#     -v "$PWD/profiles:/profiles" -v "$PWD/out:/out" \
#     ghcr.io/hiway-media/crowdsim:1.2.0 crowdsim serve
#
# Note what that second command does NOT do: it does not publish 8787 on every interface. Inside a
# container "bind loopback" would mean "reachable by nobody", so the bind address is 0.0.0.0 and the
# reachability decision is moved to the port publication — `-p 127.0.0.1:8787:8787` keeps it on the host's
# loopback. The token is still mandatory, because that is what the server demands for any non-loopback
# bind, and inside a container the server cannot tell how narrowly you published the port.

# ─── stage 1: build the UI (vite + react are build-time only; nothing imports them at runtime) ────────
FROM node:18-alpine AS ui
WORKDIR /build
COPY package.json package-lock.json ./
COPY gui/server/package.json gui/server/
COPY gui/ui/package.json gui/ui/
RUN npm ci
COPY gui/ui/ gui/ui/
RUN npm run build --workspace gui/ui

# ─── stage 2: runtime dependencies only (express and its tree; no vite, no react, no bats) ────────────
FROM node:18-alpine AS deps
WORKDIR /build
COPY package.json package-lock.json ./
COPY gui/server/package.json gui/server/
COPY gui/ui/package.json gui/ui/
RUN npm ci --omit=dev

# ─── stage 3: the image ───────────────────────────────────────────────────────────────────────────────
FROM grafana/k6:0.52.0

# Which version is this? The question is asked in the middle of something going wrong, by somebody looking
# at a container they pulled minutes ago — and until now nothing inside the image could answer it: the CLI
# had no flag, and the GUI reads a package.json that is not copied here, so /api/env reported null.
# Baked at build time, and stamped as a label so `docker inspect` answers it too.
ARG CROWDSIM_VERSION=unknown
LABEL org.opencontainers.image.title="crowdsim" \
      org.opencontainers.image.description="Load simulator for live events" \
      org.opencontainers.image.source="https://github.com/HiWay-Media/crowdsim" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${CROWDSIM_VERSION}"

USER root
# nodejs is for `crowdsim serve` only. The driver and the generator need bash, curl and python3.
RUN apk add --no-cache bash curl python3 coreutils util-linux nodejs
# k6's entrypoint is the k6 binary itself; crowdsim drives k6, so it has to be reset.
ENTRYPOINT []

WORKDIR /crowdsim
COPY bin/crowdsim /usr/local/bin/crowdsim
# k6/ includes lib/: the generator imports its arithmetic and summary logic from there (and so do the
# unit tests). Copying only live-event.js would produce an image that fails in the init context.
COPY k6/ /crowdsim/k6/
COPY cache-ab/ /crowdsim/cache-ab/
COPY profiles/example.json /crowdsim/profiles/example.json
# lib/ holds the profile rules, shared by `crowdsim validate`, doctor, load and the GUI. Without it the
# driver would silently degrade to the structural checks inside the image only — the worst kind of drift,
# because the same command would validate differently depending on where it ran.
COPY lib/ /crowdsim/lib/
COPY gui/server/ /crowdsim/gui/server/
COPY --from=ui /build/gui/ui/dist /crowdsim/gui/ui/dist
COPY --from=deps /build/node_modules /crowdsim/node_modules
RUN chmod +x /usr/local/bin/crowdsim

# CROWDSIM_ROOT is what lets the driver live in /usr/local/bin while the tool lives in /crowdsim: without
# it the script would resolve its root to /usr/local and fail to find the GUI and the A/B templates.
#
# CROWDSIM_BIN is the other half of that split, and it was missing for eleven releases. The GUI spawns the
# driver for every run, and it derived the path from its own location — /crowdsim/gui/server/../../bin/crowdsim
# — which is not where this image puts it. So the page started, said nothing, and every run died with
# `spawn /crowdsim/bin/crowdsim ENOENT`. CROWDSIM_ROOT looked like it covered this (the documentation said
# the default was $CROWDSIM_ROOT/bin/crowdsim) and did not. Do not remove this line: tests/image/smoke.sh
# now launches a --dry-run through the API, which is the assertion whose absence let it ship.
ENV CROWDSIM_VERSION=${CROWDSIM_VERSION} \
    CROWDSIM_ROOT=/crowdsim \
    CROWDSIM_BIN=/usr/local/bin/crowdsim \
    CROWDSIM_K6_SCRIPT=/crowdsim/k6/live-event.js \
    CROWDSIM_PROFILES=/profiles \
    CROWDSIM_OUT=/out \
    CROWDSIM_GUI_PORT=8787
# No default for CROWDSIM_ALLOW_TARGETS, on purpose: the tool must refuse to run until somebody names
# the hosts it may generate load against. No default for CROWDSIM_GUI_BIND either — the server's own
# loopback default stands, and opening it up stays a decision made per container, with a token.

# k6 wants a non-root user; /out must be writable by it, and /profiles readable (mounted read-only is
# fine — the GUI's editor then fails to save, which is the correct outcome for a read-only mount).
RUN mkdir -p /out /profiles && chown -R 12345:12345 /out /profiles /crowdsim
USER 12345
VOLUME ["/out"]
EXPOSE 8787

CMD ["crowdsim", "--help"]
