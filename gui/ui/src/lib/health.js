/*
 * What the page says about the machine the runs come from. (#49)
 *
 * The generator's own limits are the most common reason a run is invalid, and the page that starts runs is
 * where somebody would notice. Until now it reported k6's version, the allowlist and the output directory —
 * while `doctor`, the measured generator ceiling, and even crowdsim's own version lived only in a terminal
 * or in `/api/env`, shown nowhere. A page served by a stale server looks exactly like a current one; that
 * cost an afternoon during the audit.
 *
 * Everything here is presentation of what the server reports. Nothing is measured, inferred or rounded into
 * a claim the archive does not make — in particular the ceiling keeps the caveat the artefact carries.
 */

/** One row per thing worth knowing about this host. */
export function hostHealth(env) {
  const e = env || {};
  return [
    e.version
      ? { label: 'crowdsim', value: e.version, tone: 'ok' }
      : { label: 'crowdsim', value: 'unknown version', tone: 'warn',
          note: 'this server cannot say which version it is — a stale one looks exactly like a current one' },
    e.k6
      ? { label: 'k6', value: e.k6, tone: 'ok' }
      : { label: 'k6', value: 'not installed', tone: 'bad',
          note: 'a load run will exit 5 until it is' },
    { label: 'output', value: e.out_dir || '—', tone: 'note' },
    e.allow_targets
      ? { label: 'allowlist', value: e.allow_targets, tone: 'ok' }
      : { label: 'allowlist', value: 'from the profile', tone: 'note',
          note: 'no CROWDSIM_ALLOW_TARGETS here: every run relies on the profile\'s safety.allow_hosts' },
  ];
}

/**
 * The generator ceiling `doctor --bench` measured, if anybody ever measured it.
 *
 * A measurement taken inside a container in a VM describes the VM's own network and not the path to any
 * target — the bandwidth estimate refuses to use it as a ceiling, and this must not quietly undo that by
 * printing it as a plain fact.
 */
export function benchLine(bench) {
  if (!bench || !bench.mbits_per_second) {
    return {
      tone: 'note',
      text: 'This machine has never been measured. `crowdsim doctor --bench` measures what it can push, '
        + 'on loopback, without touching any target.',
    };
  }
  const rate = `${Math.round(bench.req_per_second || 0)} req/s · ${Math.round(bench.mbits_per_second)} Mbit/s`;
  if (bench.virtualised) {
    return {
      tone: 'warn',
      text: `${rate}, but measured inside a container in a VM (${bench.measured_at}): that describes the `
        + 'VM\'s own network and says nothing about the path to a real target — which is the layer that '
        + 'throttles the run. Measure on the host that will generate the load.',
    };
  }
  return {
    tone: 'ok',
    text: `${rate} on loopback (${bench.measured_at}). An upper bound for this machine: every real path is `
      + 'narrower.',
  };
}
