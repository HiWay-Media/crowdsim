/*
 * trend.mjs — calculate trend (linear regression) and SLO tracking across runs
 */

export function linearTrend(runs) {
  if (!runs || runs.length < 2) return null;
  
  const n = runs.length;
  const x = runs.map((_, i) => i);
  const y = runs.map(r => Number(r.p95) || 0);
  
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  return { slope, intercept };
}

export function sloStatus(runs, maxP95) {
  if (!maxP95) return { status: 'unknown', passing: 0, total: runs.length };
  
  const passing = runs.filter(r => Number(r.p95) <= maxP95).length;
  return {
    status: passing === runs.length ? 'pass' : 'fail',
    passing,
    total: runs.length,
    threshold: maxP95
  };
}

export function forecastP95(trend, runIndex) {
  if (!trend) return null;
  return Math.max(0, trend.intercept + trend.slope * runIndex);
}
