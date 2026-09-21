/*
 * export.js — filtering and exporting run data as JSON or CSV.
 * Used by HistoryPanel to offer archive export.
 */

/**
 * Filter runs based on user-provided criteria.
 * Criteria: status (clean|knee|invalid), peak rate range.
 */
export function filterRuns(runs, filters) {
  return runs.filter((r) => {
    // Status filter
    if (filters.status !== 'all') {
      const runStatus = r.generator_ok === false
        ? 'invalid'
        : r.aborted ? 'knee' : 'clean';
      if (runStatus !== filters.status) return false;
    }

    // Peak rate range
    const peak = Number(r.peak);
    if (filters.peakMin && peak < Number(filters.peakMin)) return false;
    if (filters.peakMax && peak > Number(filters.peakMax)) return false;

    return true;
  });
}

/**
 * Export runs as a JSON array with all their data.
 * Input: array of run row objects from history.tsv
 * Output: object with runs array and metadata
 */
export function exportAsJSON(runs) {
  return {
    exported_at: new Date().toISOString(),
    count: runs.length,
    runs: runs.map((r) => ({
      run_id: r.run_id,
      profile: r.profile,
      base_url: r.base_url,
      shape: r.shape,
      peak_rps: Number(r.peak),
      achieved_rps: Number(r.rps),
      p95_ms: Number(r.p95),
      failed_rate: r.failed !== null ? Number(r.failed) : null,
      e504_count: Number(r.e504),
      knee_clean: r.knee_clean !== null ? Number(r.knee_clean) : null,
      knee_crossed: r.knee_crossed !== null ? Number(r.knee_crossed) : null,
      outcome: r.generator_ok === false ? 'invalid' : r.aborted ? 'knee' : 'clean',
      generator_ok: r.generator_ok,
    })),
  };
}

/**
 * Export runs as CSV with headers and data rows.
 * Input: array of run row objects
 * Output: CSV string
 */
export function exportAsCSV(runs) {
  const headers = [
    'run_id', 'profile', 'base_url', 'shape',
    'peak_rps', 'achieved_rps', 'p95_ms', 'failed_rate', 'e504_count',
    'knee_clean', 'knee_crossed', 'outcome', 'generator_ok'
  ];

  const rows = runs.map((r) => [
    r.run_id,
    r.profile,
    r.base_url,
    r.shape,
    r.peak,
    r.rps,
    r.p95,
    r.failed !== null ? r.failed : '',
    r.e504,
    r.knee_clean !== null ? r.knee_clean : '',
    r.knee_crossed !== null ? r.knee_crossed : '',
    r.generator_ok === false ? 'invalid' : r.aborted ? 'knee' : 'clean',
    r.generator_ok
  ]);

  // CSV: escape fields containing comma or quote
  const escape = (field) => {
    const s = String(field || '');
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [
    headers.map(escape).join(','),
    ...rows.map((row) => row.map(escape).join(',')),
  ].join('\n');

  return csv;
}
