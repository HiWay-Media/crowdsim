import test from 'node:test';
import assert from 'node:assert/strict';
import { isCollectionEnabled, parseMetrics } from '../../k6/lib/server-metrics.js';

test('isCollectionEnabled returns false when no endpoint', () => {
  assert.equal(isCollectionEnabled(null), false);
  assert.equal(isCollectionEnabled({}), false);
  assert.equal(isCollectionEnabled({ server_metrics_endpoint: 'http://localhost' }), false);
});

test('isCollectionEnabled returns true when both endpoint and metric_name provided', () => {
  const profile = {
    server_metrics_endpoint: 'http://localhost:9090/metrics',
    server_metrics_metric_name: 'cpu_throttled_periods'
  };
  assert.equal(isCollectionEnabled(profile), true);
});

test('parseMetrics: Prometheus format key value', () => {
  const body = `# HELP cpu_throttled CPU throttle periods
# TYPE cpu_throttled counter
cpu_throttled_periods_total 42
memory_bytes 1024000`;
  const value = parseMetrics(body, 'cpu_throttled_periods_total');
  assert.equal(value, 42);
});

test('parseMetrics: custom key=value format', () => {
  const body = 'cpu_throttled=10\nmemory_mb=2048';
  const value = parseMetrics(body, 'cpu_throttled');
  assert.equal(value, 10);
});

test('parseMetrics returns null when metric not found', () => {
  const body = 'foo=1\nbar=2';
  assert.equal(parseMetrics(body, 'missing'), null);
});

test('parseMetrics handles empty body', () => {
  assert.equal(parseMetrics('', 'cpu'), null);
  assert.equal(parseMetrics(null, 'cpu'), null);
});

test('parseMetrics ignores Prometheus comments', () => {
  const body = `# HELP metric desc
# TYPE metric gauge
some_other=1
metric 99`;
  assert.equal(parseMetrics(body, 'metric'), 99);
});
