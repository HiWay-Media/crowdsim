#!/usr/bin/env node
/*
 * crowdsim GUI server. Started by `crowdsim serve`, or directly with `node gui/server/index.js`.
 *
 * Environment:
 *   CROWDSIM_GUI_PORT      port to listen on (default 8787)
 *   CROWDSIM_GUI_BIND      address to bind (default 127.0.0.1)
 *   CROWDSIM_GUI_TOKEN     bearer token; REQUIRED when binding off-loopback
 *   CROWDSIM_PROFILES      profile directory (default ./profiles)
 *   CROWDSIM_OUT           output directory, shared with the CLI (default ./out)
 *   CROWDSIM_ALLOW_TARGETS inherited by every run, exactly as on the command line
 *
 * Why loopback by default: this page can start a load generator. On a shared network an open port that
 * fires 500 req/s at your production is not a convenience, it is an incident waiting for a stranger's
 * curiosity. Binding elsewhere is allowed, but only with a token — the server refuses otherwise.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const port = Number(process.env.CROWDSIM_GUI_PORT || 8787);
const bind = process.env.CROWDSIM_GUI_BIND || '127.0.0.1';
const token = process.env.CROWDSIM_GUI_TOKEN || null;
const profilesDir = path.resolve(process.env.CROWDSIM_PROFILES || path.join(root, 'profiles'));
const outDir = path.resolve(process.env.CROWDSIM_OUT || path.join(process.cwd(), 'out'));
const uiDir = path.join(root, 'gui/ui/dist');

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
if (LOOPBACK.indexOf(bind) === -1 && !token) {
  console.error(`refusing to bind ${bind} without CROWDSIM_GUI_TOKEN.

  This server starts load generators. Off loopback it needs a token, and it should sit behind something
  that terminates TLS. If you only want it on this machine, leave CROWDSIM_GUI_BIND unset.`);
  process.exit(3);
}

let version = null;
try {
  version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
} catch (e) { /* running from an image without package.json: version is cosmetic */ }

const app = createApp({
  crowdsimBin: process.env.CROWDSIM_BIN || path.join(root, 'bin/crowdsim'),
  profilesDir,
  outDir,
  uiDir,
  token,
  version,
});

app.listen(port, bind, () => {
  console.log(`crowdsim GUI  http://${bind}:${port}`);
  console.log(`  profiles  ${profilesDir}`);
  console.log(`  output    ${outDir}`);
  console.log(`  allowlist ${process.env.CROWDSIM_ALLOW_TARGETS || '(unset — runs will rely on safety.allow_hosts)'}`);
  if (!fs.existsSync(uiDir)) console.log('  ⚠️  UI not built: run `npm run gui:build`');
  if (token) console.log('  token required on /api');
});
