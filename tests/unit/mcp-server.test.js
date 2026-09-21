import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const serverPath = new URL('../../scripts/crowdsim-mcp.js', import.meta.url);

test('MCP server advertises the crowdsim tools', async () => {
  const child = spawn(process.execPath, [serverPath.pathname], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CROWDSIM_ALLOW_TARGETS: 'example.test'
    }
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', chunk => stdoutChunks.push(chunk));
  child.stderr.on('data', chunk => stderrChunks.push(chunk));

  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {}
  }) + '\n';

  child.stdin.write(request);
  child.stdin.end();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('MCP server did not respond in time'));
    }, 5000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString();
  const stderr = Buffer.concat(stderrChunks).toString();

  assert.match(stdout, /crowdsim_help|crowdsim_validate_profile|crowdsim_validate|crowdsim_doctor|crowdsim_discover|crowdsim_probe|crowdsim_load|crowdsim_cache_ab|crowdsim_history|crowdsim_compare|crowdsim_report|crowdsim_weights|crowdsim_init|crowdsim_next|crowdsim_record|crowdsim_serve/);
  assert.equal(stderr, '');
});
