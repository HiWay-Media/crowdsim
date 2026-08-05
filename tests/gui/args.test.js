/*
 * The GUI's command-line builder. This is where a web form meets a tool that generates real load, so the
 * tests are mostly about what must NOT be possible: no unknown flags, no shell metacharacters that mean
 * anything, and no way to reach the production override without asking for it by name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLoadArgs, buildProbeArgs, buildDiscoverArgs, InvalidRun } from '../../gui/server/lib/args.js';

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
