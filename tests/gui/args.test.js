/*
 * The GUI's command-line builder. This is where a web form meets a tool that generates real load, so the
 * tests are mostly about what must NOT be possible: no unknown flags, no shell metacharacters that mean
 * anything, and no way to reach the production override without asking for it by name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLoadArgs, buildProbeArgs, buildDiscoverArgs, InvalidRun, buildTrendArgs, buildComparePageArgs,
} from '../../gui/server/lib/args.js';

const P = '/tmp/profiles/site.json';
const NAME = 'my-site';

test('a minimal request becomes a load command with the profile and the peak', () => {
  assert.deepEqual(buildLoadArgs({ peak: 60, target: 'edge' }, P, NAME),
    ['load', '--profile', P, '--target', 'edge', '--peak', '60']);
});

test('every ramp field is passed through with its own flag', () => {
  const argv = buildLoadArgs({
    target: 'edge', peak: 120, start: 20, steps: 6, stepDur: '45s', hold: '2m',
    shape: 'mix', rscMode: 'random', maxP95: 3000, max5xx: 0.02, safePeak: 200,
    skipClasses: 'proxy_only,static', touchAndGo: true, insecure: true, dryRun: true,
  }, P, NAME);
  const joined = argv.join(' ');
  for (const expected of ['--peak 120', '--start 20', '--steps 6', '--step-dur 45s', '--hold 2m',
    '--shape mix', '--rsc-mode random', '--max-p95 3000', '--max-5xx 0.02', '--safe-peak 200',
    '--skip-classes proxy_only,static', '--touch-and-go', '--insecure', '--dry-run']) {
    assert.ok(joined.includes(expected), `missing ${expected} in: ${joined}`);
  }
});

test('the production override is never inferred — it needs the profile name typed back', () => {
  // A checkbox someone leaves ticked is not consent. The CLI demands the flag on every command line;
  // the GUI demands the confirmation on every run.
  assert.throws(() => buildLoadArgs({ peak: 900, force: true }, P, NAME),
    (e) => e instanceof InvalidRun && e.field === 'confirm' && /my-site/.test(e.message));
  assert.throws(() => buildLoadArgs({ peak: 900, force: true, confirm: 'yes' }, P, NAME), /confirmation/);

  const argv = buildLoadArgs({ peak: 900, force: true, confirm: NAME }, P, NAME);
  assert.ok(argv.includes('--i-know-this-breaks-production'));
});

test('without force the override flag is absent even if a confirmation was sent', () => {
  const argv = buildLoadArgs({ peak: 40, confirm: NAME }, P, NAME);
  assert.ok(!argv.includes('--i-know-this-breaks-production'));
});

test('unknown fields in the request body are ignored, not forwarded', () => {
  const argv = buildLoadArgs({ peak: 10, '--exec': 'evil', extraArgs: '--whatever', env: 'X=1' }, P, NAME);
  assert.deepEqual(argv, ['load', '--profile', P, '--peak', '10']);
});

test('a target name is a name, not a place to hide arguments', () => {
  for (const bad of ['edge --peak 9000', '--peak', 'a b', '../../etc', 'x;y']) {
    assert.throws(() => buildLoadArgs({ target: bad, peak: 10 }, P, NAME), /target/);
  }
  // no target at all is legitimate: the profile's targets.default applies, as on the command line
  assert.deepEqual(buildLoadArgs({ target: '', peak: 10 }, P, NAME), ['load', '--profile', P, '--peak', '10']);
});

test('baseUrl is normalised to an origin and must be http(s) without credentials', () => {
  assert.ok(buildLoadArgs({ baseUrl: 'http://127.0.0.1:8081/ignored/path', peak: 10 }, P, NAME)
    .includes('http://127.0.0.1:8081'));
  assert.throws(() => buildLoadArgs({ baseUrl: 'file:///etc/passwd', peak: 10 }, P, NAME), /http or https/);
  assert.throws(() => buildLoadArgs({ baseUrl: 'http://user:pw@example.test', peak: 10 }, P, NAME), /credentials/);
  assert.throws(() => buildLoadArgs({ baseUrl: 'not a url', peak: 10 }, P, NAME), /not a URL/);
});

test('baseUrl wins over target, mirroring the CLI', () => {
  const argv = buildLoadArgs({ baseUrl: 'http://127.0.0.1:8082', target: 'edge', peak: 10 }, P, NAME);
  assert.ok(argv.includes('--base-url'));
  assert.ok(!argv.includes('--target'));
});

test('numbers are validated, not coerced from whatever arrived', () => {
  assert.throws(() => buildLoadArgs({ peak: 'lots' }, P, NAME), /peak must be an integer/);
  assert.throws(() => buildLoadArgs({ peak: 0 }, P, NAME), /peak/);
  assert.throws(() => buildLoadArgs({ peak: 10, steps: 999 }, P, NAME), /steps/);
  assert.throws(() => buildLoadArgs({ peak: 10, max5xx: 5 }, P, NAME), /between 0 and 1/);
  assert.throws(() => buildLoadArgs({ peak: 10.5 }, P, NAME), /integer/);
});

test('durations must be durations: "60" is fine, "60 s; rm" is not', () => {
  assert.ok(buildLoadArgs({ peak: 10, hold: '60' }, P, NAME).includes('60'));
  assert.throws(() => buildLoadArgs({ peak: 10, hold: '60 s; rm -rf /' }, P, NAME), /hold must look like/);
  assert.throws(() => buildLoadArgs({ peak: 10, stepDur: '$(id)' }, P, NAME), /stepDur must look like/);
});

test('shape and rsc mode are closed sets', () => {
  assert.throws(() => buildLoadArgs({ peak: 10, shape: 'flood' }, P, NAME), /shape must be one of/);
  assert.throws(() => buildLoadArgs({ peak: 10, rscMode: 'chaos' }, P, NAME), /rscMode must be one of/);
});

test('hold=0s survives validation: it is how --touch-and-go asks for no hold', () => {
  assert.ok(buildLoadArgs({ peak: 10, hold: '0s' }, P, NAME).includes('0s'));
});

test('probe and discover build their own narrow commands', () => {
  assert.deepEqual(buildProbeArgs({ target: 'edge' }, P), ['probe', '--profile', P, '--target', 'edge']);
  assert.deepEqual(buildDiscoverArgs({ limit: 400 }, P), ['discover', '--profile', P, '--limit', '400']);
  assert.throws(() => buildDiscoverArgs({ limit: -1 }, P), /limit/);
  // neither can be talked into generating load
  assert.ok(!buildProbeArgs({ peak: 9000, force: true, confirm: 'x' }, P).join(' ').includes('peak'));
});

// ── the warm-up: two flags the CLI had and the page did not (#53) ────────────────────────────────────

test('a warm-up is passed through as its own two flags', () => {
  const argv = buildLoadArgs({ target: 'edge', peak: 60, warmup: '30s', warmupPeak: 20 }, P, NAME);
  const joined = argv.join(' ');
  assert.ok(joined.includes('--warmup 30s'), joined);
  assert.ok(joined.includes('--warmup-peak 20'), joined);
});

test('a warm-up rate without a duration is refused: it would do nothing at all', () => {
  assert.throws(() => buildLoadArgs({ peak: 60, warmupPeak: 20 }, P, NAME),
    (e) => e instanceof InvalidRun && e.field === 'warmup');
});

test('the warm-up duration is validated as a duration, and its rate as an integer', () => {
  assert.throws(() => buildLoadArgs({ peak: 60, warmup: 'a while' }, P, NAME),
    (e) => e instanceof InvalidRun && e.field === 'warmup');
  assert.throws(() => buildLoadArgs({ peak: 60, warmup: '30s', warmupPeak: 'fast' }, P, NAME),
    (e) => e instanceof InvalidRun && e.field === 'warmupPeak');
  assert.throws(() => buildLoadArgs({ peak: 60, warmup: '30s', warmupPeak: 0 }, P, NAME),
    (e) => e instanceof InvalidRun && e.field === 'warmupPeak');
});

test('no warm-up means no flags: a run that did not ask for one gets exactly what it got before', () => {
  const argv = buildLoadArgs({ target: 'edge', peak: 60, warmup: '', warmupPeak: '' }, P, NAME);
  assert.deepEqual(argv, ['load', '--profile', P, '--target', 'edge', '--peak', '60']);
});

test('a warm-up does not arm the override, and the override still needs the typed name', () => {
  // The safe-peak gate for a warm-up lives in bin/crowdsim, which re-runs it with the warm-up rate. What
  // must not happen here is the GUI granting the override because a warm-up was requested.
  const argv = buildLoadArgs({ peak: 60, warmup: '30s', warmupPeak: 900 }, P, NAME);
  assert.ok(!argv.includes('--i-know-this-breaks-production'));
  assert.throws(() => buildLoadArgs({ peak: 60, warmup: '30s', warmupPeak: 900, force: true }, P, NAME),
    (e) => e instanceof InvalidRun && e.field === 'confirm');
});

// ── the follow-up flags, which are not ordinary form fields (#79) ────────────────────────────────────
// Two of these start a SECOND run. `args.js` had no entry for any of the six added in 1.30.0 and
// 1.31.0, which is the same complaint as #53 — that one was about two flags.

test('--recalibrate and its floor are expressible, and validated', () => {
  const a = buildLoadArgs({ peak: 10, recalibrate: true, recalibrateFloor: 4 }, P, NAME);
  assert.ok(a.includes('--recalibrate'));
  assert.deepEqual(a.slice(a.indexOf('--recalibrate-floor'), a.indexOf('--recalibrate-floor') + 2),
    ['--recalibrate-floor', '4']);
});

test('a floor without --recalibrate would do nothing, so it is refused', () => {
  assert.throws(() => buildLoadArgs({ peak: 10, recalibrateFloor: 4 }, P, NAME), /recalibrate/i);
});

test('--certify and its hold are expressible, and the hold is a duration', () => {
  const a = buildLoadArgs({ peak: 10, certify: true, certifyHold: '90s' }, P, NAME);
  assert.ok(a.includes('--certify'));
  assert.deepEqual(a.slice(a.indexOf('--certify-hold'), a.indexOf('--certify-hold') + 2),
    ['--certify-hold', '90s']);
  assert.throws(() => buildLoadArgs({ peak: 10, certify: true, certifyHold: 'soon' }, P, NAME), /certifyHold/);
});

test('the two follow-up flags cannot be combined: one is a retry, the other a certification', () => {
  // The driver picks recalibrate over certify silently. A page that lets both be ticked describes a run
  // that will not happen.
  assert.throws(() => buildLoadArgs({ peak: 10, recalibrate: true, certify: true }, P, NAME), /recalibrate|certify/i);
});

test('--server-metrics needs a label, and the path goes through the same traversal refusal', () => {
  // Since 1.40.0 a series is read only from a configured directory (#91): with none, the field is
  // refused rather than resolved against the server's own cwd. So this needs one.
  const { series } = seriesFixture();
  const a = buildLoadArgs({ peak: 10, serverMetrics: 'cpu.csv',
    serverMetricsLabel: 'cpu_throttled_periods' }, P, NAME, { seriesDir: series });
  assert.ok(a.includes('--server-metrics'));
  assert.ok(a.includes('--server-metrics-label'));

  assert.throws(() => buildLoadArgs({ peak: 10, serverMetrics: 'cpu.csv' }, P, NAME,
    { seriesDir: series }), (e) => e.field === 'serverMetricsLabel');
  for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b']) {
    assert.throws(() => buildLoadArgs({ peak: 10, serverMetrics: bad,
      serverMetricsLabel: 'x' }, P, NAME),
      (e) => e.field === 'serverMetrics', bad);
  }
});

test('a label must look like a metric name, not a sentence the page renders', () => {
  assert.throws(() => buildLoadArgs({ peak: 10, serverMetrics: 'a.csv',
    serverMetricsLabel: 'oh no <script>' }, P, NAME),
    (e) => e.field === 'serverMetricsLabel');
});

test('none of them appear when the page did not ask for them', () => {
  const a = buildLoadArgs({ peak: 10 }, P, NAME);
  for (const f of ['--recalibrate', '--recalibrate-floor', '--certify', '--certify-hold',
    '--server-metrics', '--server-metrics-label']) {
    assert.ok(!a.includes(f), f);
  }
});

// ── the drawn pages the archive can hand over (#90) ──────────────────────────────────────────────────
// The page had a route for `report --html` and none for the trend or the delta. These two builders are
// the same shape as buildProbeArgs/buildDiscoverArgs: known flags, validated values, no shell — the
// values reach an argv, so a filter typed into a URL cannot become an argument the driver did not expect.

test('the trend argv draws every run when nothing is filtered', () => {
  assert.deepEqual(buildTrendArgs({}, '/tmp/t.html'), ['history', '--html', '--out', '/tmp/t.html']);
});

test('the trend argv carries the filters `history` itself accepts', () => {
  const argv = buildTrendArgs({ last: 10, target: 'edge.example.test', profile: 'site' }, '/tmp/t.html');
  assert.deepEqual(argv, ['history', '--html', '--out', '/tmp/t.html',
    '--last', '10', '--target', 'edge.example.test', '--profile', 'site']);
});

test('a filter the CLI would not accept is refused here, not passed through', () => {
  // The whole reason argv is built in this module: a value from a URL must not reach the driver unchecked.
  for (const bad of [{ last: 0 }, { last: -3 }, { last: 'many' }, { last: 1e9 }]) {
    assert.throws(() => buildTrendArgs(bad, '/tmp/t.html'), /last/, JSON.stringify(bad));
  }
  for (const bad of [{ target: 'a b' }, { target: 'x;rm -rf /' }, { target: '--peak' }]) {
    assert.throws(() => buildTrendArgs(bad, '/tmp/t.html'), /target/, JSON.stringify(bad));
  }
  for (const bad of [{ profile: '../etc/passwd' }, { profile: 'a b' }, { profile: '--json' }]) {
    assert.throws(() => buildTrendArgs(bad, '/tmp/t.html'), /profile/, JSON.stringify(bad));
  }
});

test('the trend needs somewhere to write: history --html names its file by invocation, not by run', () => {
  // Without --out the driver writes trend-<this invocation>.html and the server would have to guess.
  assert.throws(() => buildTrendArgs({}, ''), /out/);
});

test('the delta argv is two run ids and nothing else', () => {
  assert.deepEqual(buildComparePageArgs('20260901T101500Z', '20260901T121500Z'),
    ['compare', '20260901T101500Z', '20260901T121500Z', '--html']);
});

test('a delta between things that are not run ids is refused', () => {
  for (const pair of [['x', '20260901T121500Z'], ['20260901T101500Z', 'latest'],
    ['20260901T101500Z', '../../etc/passwd'], ['', '']]) {
    assert.throws(() => buildComparePageArgs(pair[0], pair[1]), /run/, JSON.stringify(pair));
  }
});

test('`latest` and `previous` are the CLI resolving a run id, and the page does not get to use them', () => {
  // The page always knows the exact run: it is showing the archive. A selector here would mean the page
  // and the file it hands over could name different runs.
  assert.throws(() => buildComparePageArgs('latest', 'previous'), /run/);
});

// ── the series path, resolved rather than pattern-matched (#91) ──────────────────────────────────────
//
// Two places let a browser name a file on the server's filesystem, and they were checked to different
// standards. gui/server/lib/profiles.js resolves and contains:
//
//     const base = fs.realpathSync(dir);
//     const full = path.resolve(base, String(name));
//     if (path.dirname(full) !== base) throw new BadProfile(…);
//
// args.js matched a pattern and stopped. The pattern refuses an absolute path and any `..` segment —
// the traversal that matters most — and does not resolve, so a symlink under the allowed directory
// satisfied it and the driver then read whatever it pointed at. The weaker of two checks guarding the
// same kind of thing, in the newer code.

function seriesFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdsim-series-'));
  const series = path.join(dir, 'series');
  fs.mkdirSync(path.join(series, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(series, 'cpu.csv'), '1757325600,0\n');
  fs.writeFileSync(path.join(series, 'nested', 'cpu.csv'), '1757325600,0\n');
  // The escape the pattern cannot see: a name with no `..` in it that resolves outside.
  fs.writeFileSync(path.join(dir, 'outside.csv'), 'secret\n');
  fs.symlinkSync(path.join(dir, 'outside.csv'), path.join(series, 'escape.csv'));
  return { dir, series };
}

const withSeries = (run, seriesDir) =>
  buildLoadArgs(Object.assign({ profile: 'p.json', peak: 10 }, run), '/p.json', 'p', { seriesDir });

test('a series inside the allowed directory is accepted, nested or not', () => {
  const { series } = seriesFixture();
  for (const rel of ['cpu.csv', 'nested/cpu.csv', './cpu.csv']) {
    const argv = withSeries({ serverMetrics: rel, serverMetricsLabel: 'cpu' }, series);
    const at = argv.indexOf('--server-metrics');
    assert.ok(at !== -1, rel);
    // Handed over resolved, so the driver reads the file that was checked and not a name re-resolved
    // against whatever directory it happens to run in.
    assert.equal(argv[at + 1], fs.realpathSync(path.join(series, rel)), rel);
  }
});

test('a symlink that escapes the allowed directory is refused — the case a pattern cannot see', () => {
  const { series } = seriesFixture();
  assert.throws(() => withSeries({ serverMetrics: 'escape.csv', serverMetricsLabel: 'cpu' }, series),
    /outside/i);
});

test('an absolute path and a .. segment are still refused, and say which it was', () => {
  const { series } = seriesFixture();
  assert.throws(() => withSeries({ serverMetrics: '/etc/passwd', serverMetricsLabel: 'x' }, series),
    /outside|relative/i);
  assert.throws(() => withSeries({ serverMetrics: '../outside.csv', serverMetricsLabel: 'x' }, series),
    /outside|relative/i);
});

test('a file that is not there is refused as missing, not as an escape', () => {
  // The two refusals send you to different places: one is a typo, the other is a path you may not use.
  const { series } = seriesFixture();
  assert.throws(() => withSeries({ serverMetrics: 'nope.csv', serverMetricsLabel: 'x' }, series),
    /not there|no such|does not exist/i);
});

test('with no allowed directory configured the field is refused, and names the setting', () => {
  // Failing closed: a server with nowhere to read series from must not fall back to its own cwd, which
  // is what made this weaker than the profile browser in the first place.
  assert.throws(() => withSeries({ serverMetrics: 'cpu.csv', serverMetricsLabel: 'x' }, ''),
    /CROWDSIM_SERIES_DIR/);
});

test('no series asked for is not an error', () => {
  const { series } = seriesFixture();
  const argv = withSeries({}, series);
  assert.equal(argv.indexOf('--server-metrics'), -1);
});
