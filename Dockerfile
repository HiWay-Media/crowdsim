# crowdsim — load generator image.
#
# Built on the official k6 image because k6 is the one component you must not substitute: the generator
# has to sustain the target rate, and a rate the generator cannot deliver produces a run that looks like
# a healthy system under load. crowdsim reports `generator_ok` for exactly this reason.
#
# ⚠️ Do NOT run this image on a laptop to test a remote target. On macOS and Windows the Docker network
#    layer saturates before the target does — measured, not theorised. Run it on a Linux host near the
#    target (that is what the Nomad job is for), or install k6 natively for local runs.
#
# The image ships NO profile: a profile contains your hostnames, URL pools and measured mix. Mount it,
# or fetch it with a Nomad artifact stanza from your own private repo.
FROM grafana/k6:0.52.0

USER root
RUN apk add --no-cache bash curl python3 coreutils util-linux
# k6's entrypoint is the k6 binary itself; crowdsim drives k6, so it has to be reset.
ENTRYPOINT []

WORKDIR /crowdsim
COPY bin/crowdsim /usr/local/bin/crowdsim
COPY k6/ /crowdsim/k6/
COPY cache-ab/ /crowdsim/cache-ab/
COPY profiles/example.json /crowdsim/profiles/example.json
RUN chmod +x /usr/local/bin/crowdsim

ENV CROWDSIM_K6_SCRIPT=/crowdsim/k6/live-event.js \
    CROWDSIM_OUT=/out
# No default for CROWDSIM_ALLOW_TARGETS, on purpose: the tool must refuse to run until somebody names
# the hosts it may generate load against.

# k6 wants a non-root user; /out must be writable by it.
RUN mkdir -p /out && chown -R 12345:12345 /out /crowdsim
USER 12345
VOLUME ["/out"]

CMD ["crowdsim", "--help"]
