/*
 * The canary for the front-end suite.
 *
 * `tests/cli/00-environment.bats` exists because a suite that cannot fail is worse than no suite — it was
 * written after discovering that ~300 assertions had been no-ops on every macOS machine. This is the same
 * idea for the newest suite: before trusting anything below, prove this runner reports a failure, and prove
 * it is actually loading the front end's code rather than something that merely resolves.
 *
 * Why `node --test` and no framework: the decisions under test are plain ES modules with no JSX and no React
 * import, and node imports them directly from gui/ui/src/lib — verified, not assumed. That keeps one runner
 * for the whole repository and adds no dependency to a project whose UI carries react and vite and nothing
 * else.
 *
 * What this layer does NOT cover, stated rather than skipped quietly:
 *   · anything that needs a DOM — clicking, focus, effects firing;
 *   · that a component actually calls these functions.
 * The first is why the safety-critical wording lives in a module here instead of inside JSX; the second is
 * covered by the browser pass in tests/e2e, which loads the real page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiLib = path.resolve(here, '../../gui/ui/src/lib');

test('a failing assertion fails this suite', () => {
  // Not tautological: it is the property the rest of the file depends on. If node:test ever stopped
  // propagating, every test below would report ok against any code at all.
  assert.throws(() => assert.equal(1, 2), assert.AssertionError);
});

test('the modules under test are the ones the page imports', async () => {
  // A test suite that imports a copy is a suite that passes while the app is broken.
  const files = fs.readdirSync(uiLib).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 4, `expected the decision modules in gui/ui/src/lib, found ${files.join(', ')}`);

  const components = path.resolve(here, '../../gui/ui/src');
  const sources = [
    fs.readFileSync(path.join(components, 'App.jsx'), 'utf8'),
    fs.readFileSync(path.join(components, 'components/RunPanel.jsx'), 'utf8'),
    fs.readFileSync(path.join(components, 'components/HistoryPanel.jsx'), 'utf8'),
    fs.readFileSync(path.join(components, 'components/CompareCard.jsx'), 'utf8'),
  ].join('\n');
  for (const f of files) {
    const mod = f.replace(/\.js$/, '');
    assert.ok(sources.includes(`lib/${mod}.js`), `nothing imports lib/${mod}.js — the test would be alone`);
  }
});

test('the decision modules are free of JSX and of React', async () => {
  // The moment one of them imports React it stops being loadable here, and this suite quietly shrinks.
  for (const f of fs.readdirSync(uiLib).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(uiLib, f), 'utf8');
    assert.ok(!/from ['"]react/.test(src), `${f} imports React`);
    assert.ok(!/<[A-Za-z][^>]*>/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')),
      `${f} contains markup`);
    await import(path.join(uiLib, f));   // and it really loads
  }
});
