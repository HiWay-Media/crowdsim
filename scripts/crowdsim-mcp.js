#!/usr/bin/env node

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliPath = path.join(rootDir, 'bin', 'crowdsim');

function normalizePath(value) {
  if (!value) return value;
  if (path.isAbsolute(value)) return value;
  return path.resolve(rootDir, value);
}

async function runCrowdsim(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const { stdout, stderr } = await execFileAsync(cliPath, args, {
    cwd: rootDir,
    env
  });

  return {
    command: [cliPath, ...args].join(' '),
    exitCode: 0,
    stdout,
    stderr
  };
}

async function runCrowdsimAllowingFailure(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, args, {
      cwd: rootDir,
      env,
      shell: false
    });

    return {
      command: [cliPath, ...args].join(' '),
      exitCode: 0,
      stdout,
      stderr
    };
  } catch (error) {
    return {
      command: [cliPath, ...args].join(' '),
      exitCode: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? ''
    };
  }
}

const server = new McpServer({
  name: 'crowdsim',
  version: '1.0.0'
}, {
  capabilities: {
    logging: {}
  }
});

server.registerTool('crowdsim_help', {
  description: 'Return the CLI synopsis and command help for the crowdsim driver.',
  inputSchema: {}
}, async () => {
  const result = await runCrowdsimAllowingFailure(['--help']);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_validate_profile', {
  description: 'Validate a crowdsim profile without launching a load test.',
  inputSchema: {
    profile: z.string().describe('Path to the JSON profile to validate. Relative paths are resolved from the repo root.'),
    allowTargets: z.string().optional().describe('Optional comma-separated allowlist override for target validation.')
  }
}, async ({ profile, allowTargets }) => {
  const normalizedProfile = normalizePath(profile);
  const env = allowTargets ? { CROWDSIM_ALLOW_TARGETS: allowTargets } : {};
  const result = await runCrowdsimAllowingFailure(['validate', normalizedProfile], env);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_probe', {
  description: 'Run a preflight probe against a target using a crowdsim profile.',
  inputSchema: {
    profile: z.string().describe('Path to the profile JSON file.'),
    target: z.string().optional().describe('Named target in the profile, e.g. default or edge.'),
    insecure: z.boolean().optional().describe('Skip TLS verification.'),
    allowTargets: z.string().optional().describe('Optional allowlist override for the target host.')
  }
}, async ({ profile, target, insecure, allowTargets }) => {
  const normalizedProfile = normalizePath(profile);
  const args = ['probe', '--profile', normalizedProfile];
  if (target) args.push('--target', target);
  if (insecure) args.push('--insecure');
  const env = allowTargets ? { CROWDSIM_ALLOW_TARGETS: allowTargets } : {};
  const result = await runCrowdsimAllowingFailure(args, env);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_load', {
  description: 'Run a crowdsim load test with a profile and a target, optionally doing a dry run.',
  inputSchema: {
    profile: z.string().describe('Path to the profile JSON file.'),
    target: z.string().optional().describe('Target name from the profile.'),
    peak: z.number().optional().describe('Total peak requests per second at the top of the ramp.'),
    start: z.number().optional().describe('Rate of the first ramp step.'),
    steps: z.number().optional().describe('Number of ramp steps.'),
    stepDur: z.string().optional().describe('Duration of each ramp step, such as 60s.'),
    hold: z.string().optional().describe('Time held at the peak, such as 120s.'),
    dryRun: z.boolean().optional().describe('Print the exact k6 command instead of running the test.'),
    safePeak: z.number().optional().describe('Safe peak ceiling for the profile.'),
    iKnowThisBreaksProduction: z.boolean().optional().describe('Bypass the safe-peak gate.'),
    warmup: z.string().optional().describe('Warm-up duration to run before the measured test, such as 30s.'),
    insecure: z.boolean().optional().describe('Skip TLS verification.'),
    allowTargets: z.string().optional().describe('Optional allowlist override for the target host.')
  }
}, async ({ profile, target, peak, start, steps, stepDur, hold, dryRun, safePeak, iKnowThisBreaksProduction, warmup, insecure, allowTargets }) => {
  const normalizedProfile = normalizePath(profile);
  const args = ['load', '--profile', normalizedProfile];
  if (target) args.push('--target', target);
  if (typeof peak === 'number') args.push('--peak', String(peak));
  if (typeof start === 'number') args.push('--start', String(start));
  if (typeof steps === 'number') args.push('--steps', String(steps));
  if (stepDur) args.push('--step-dur', stepDur);
  if (hold) args.push('--hold', hold);
  if (dryRun) args.push('--dry-run');
  if (typeof safePeak === 'number') args.push('--safe-peak', String(safePeak));
  if (iKnowThisBreaksProduction) args.push('--i-know-this-breaks-production');
  if (warmup) args.push('--warmup', warmup);
  if (insecure) args.push('--insecure');
  const env = allowTargets ? { CROWDSIM_ALLOW_TARGETS: allowTargets } : {};
  const result = await runCrowdsimAllowingFailure(args, env);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_history', {
  description: 'Read recent crowdsim history rows and optionally return machine-readable JSON output.',
  inputSchema: {
    last: z.number().optional().describe('Number of newest rows to show.'),
    target: z.string().optional().describe('Substring match for the target host.'),
    profile: z.string().optional().describe('Profile name to filter by.'),
    json: z.boolean().optional().describe('Return JSON instead of the table view.')
  }
}, async ({ last, target, profile, json }) => {
  const args = ['history'];
  if (typeof last === 'number') args.push('--last', String(last));
  if (target) args.push('--target', target);
  if (profile) args.push('--profile', profile);
  if (json) args.push('--json');
  const result = await runCrowdsimAllowingFailure(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('crowdsim MCP server error:', error);
  process.exit(1);
});
