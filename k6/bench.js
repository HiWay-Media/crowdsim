/*
 * bench.js — what can THIS machine generate?
 *
 * Not a load test: the target is a throwaway HTTP server the driver starts on loopback, and the number that
 * comes out describes the generator, not anything of yours. `crowdsim doctor --bench` runs it.
 *
 * Why it exists: `load` warns you before a run the generator cannot sustain, by comparing the bandwidth a
 * peak implies against `safety.generator_mbps` — a value typed into a profile by hand, usually once, usually
 * copied. So the warning that exists to predict `generator_ok: false` rested on a guess. This measures it.
 *
 * What it measures, precisely, because the number is easy to over-read:
 *  · a CLOSED model (fixed VUs, no pacing) so the result is a ceiling, not a rate somebody chose;
 *  · over loopback, so the network is as good as it will ever be. The path to a real target is narrower,
 *    always. This is an upper bound on the generator, not a promise about a run.
 *
 * ES2019-compatible and free of profile logic: it is deliberately not the live-event generator.
 */

import http from 'k6/http';
import { check } from 'k6';

const URL = __ENV.BENCH_URL;
const OUT = __ENV.BENCH_OUT || 'bench.json';

export const options = {
  scenarios: {
    bench: {
      executor: 'constant-vus',
      vus: Number(__ENV.BENCH_VUS || 40),
      duration: __ENV.BENCH_DUR || '10s',
      gracefulStop: '2s',
    },
  },
  // Thresholds would abort a measurement whose whole job is to find where it stops being comfortable.
  thresholds: {},
  discardResponseBodies: false,   // the bytes are the measurement
  noConnectionReuse: false,
};

export default function bench() {
  const r = http.get(URL, { timeout: '10s' });
  check(r, { 'answered 200': (res) => res.status === 200 });
}

export function handleSummary(data) {
  const m = data.metrics || {};
  const reqs = (m.http_reqs && m.http_reqs.values) || {};
  const recv = (m.data_received && m.data_received.values) || {};
  const dur = (m.http_req_duration && m.http_req_duration.values) || {};
  const failed = (m.http_req_failed && m.http_req_failed.values) || {};

  const bytesPerSecond = recv.rate || 0;
  const out = {
    measured_at: __ENV.BENCH_RUN_ID || null,
    url: URL,
    vus: Number(__ENV.BENCH_VUS || 40),
    duration: __ENV.BENCH_DUR || '10s',
    requests: reqs.count || 0,
    req_per_second: reqs.rate || 0,
    bytes_per_second: bytesPerSecond,
    mbytes_per_second: bytesPerSecond / 1e6,
    mbits_per_second: (bytesPerSecond * 8) / 1e6,
    p95_ms: dur['p(95)'] || null,
    failed_rate: failed.rate === undefined ? null : failed.rate,
    // Stated in the artefact itself, so a number read back next month carries its own caveat.
    caveat: 'measured over loopback against a local server: an upper bound on this generator, not a '
      + 'prediction for any real target. The path to a target is narrower, always.',
  };
  const res = {
    stdout: `\n  generator ceiling on this host: ${out.req_per_second.toFixed(0)} req/s · `
      + `${out.mbytes_per_second.toFixed(1)} MB/s (${out.mbits_per_second.toFixed(0)} Mbit/s)\n`,
  };
  res[OUT] = JSON.stringify(out, null, 1);
  return res;
}
