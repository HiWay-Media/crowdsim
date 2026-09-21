/*
 * server-metrics.js — collect server-side metrics (CPU, memory, throttling) from a metrics endpoint
 * during a load test.
 *
 * The target exposes metrics at a configured endpoint (e.g. Prometheus, custom API). We periodically
 * scrape them during the ramp and hold, aligning each sample with the run's own timeline.
 *
 * Pure and runnable in node. Exported function returns a series: [{ t: epoch_ms, v: value }, …]
 * suitable for passing to correlate.js. If collection failed (no endpoint, no samples), returns
 * { refused: true, reason: "...", fix: "..." }.
 *
 * SCOPE: reads an existing endpoint, does not instrument the target. A user provides
 * server_metrics_endpoint in the profile, and we read from it.
 */

export function isCollectionEnabled(profile) {
  return !!(profile && profile.server_metrics_endpoint && profile.server_metrics_metric_name);
}

/**
 * Parse a simple key=value metrics format or Prometheus text format.
 * Returns object: { metric_name: value, … }
 *
 * Example (custom format): "cpu_throttled=5\nmemory_mb=1024"
 * Example (Prometheus): "cpu_throttled_periods_total 5\nmemory_usage_bytes 1024"
 */
export function parseMetrics(body, metricName) {
  const lines = (body || '').trim().split('\n');
  for (const line of lines) {
    if (line.startsWith('#')) continue;  // Prometheus comment
    const [key, value] = line.includes('=')
      ? line.split('=')
      : line.split(/\s+/);
    if (key && key.trim() === metricName) {
      const v = parseFloat(value);
      return isNaN(v) ? null : v;
    }
  }
  return null;
}

export const DEFAULT_COLLECTION_INTERVAL_S = 1;  // Scrape every 1 second
export const DEFAULT_TIMEOUT_MS = 5000;
