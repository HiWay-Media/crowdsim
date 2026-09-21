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

server.registerTool('crowdsim_validate', {
  description: 'Alias for validating a crowdsim profile without launching a load test.',
  inputSchema: {
    profile: z.string().describe('Path to the JSON profile to validate. Relative paths are resolved from the repo root.'),
    allowTargets: z.string().optional().describe('Optional comma-separated allowlist override for target validation.')
  }
}, async ({ profile, allowTargets }) => {
  return await server._registeredTools.crowdsim_validate_profile.handler({ profile, allowTargets });
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

server.registerTool('crowdsim_doctor', {
  description: 'Check what is missing on this machine and validate a profile if provided.',
  inputSchema: {
    profile: z.string().optional().describe('Profile to validate structurally.'),
    bench: z.boolean().optional().describe('Measure what this machine can generate against a local loopback target.')
  }
}, async ({ profile, bench }) => {
  const args = ['doctor'];
  if (profile) args.push('--profile', normalizePath(profile));
  if (bench) args.push('--bench');
  const result = await runCrowdsimAllowingFailure(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_discover', {
  description: 'Fetch a sitemap and write a pool of real URLs for a target profile.',
  inputSchema: {
    profile: z.string().describe('Path to the profile JSON file.'),
    target: z.string().optional().describe('Named target in the profile.'),
    limit: z.number().optional().describe('Maximum URLs in the pool.'),
    verify: z.boolean().optional().describe('Request each path and keep only those returning 2xx.'),
    allowTargets: z.string().optional().describe('Optional allowlist override for the target host.')
  }
}, async ({ profile, target, limit, verify, allowTargets }) => {
  const normalizedProfile = normalizePath(profile);
  const args = ['discover', '--profile', normalizedProfile];
  if (target) args.push('--target', target);
  if (typeof limit === 'number') args.push('--limit', String(limit));
  if (verify) args.push('--verify');
  const result = await runCrowdsimAllowingFailure(args, allowTargets ? { CROWDSIM_ALLOW_TARGETS: allowTargets } : {});
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_cache_ab', {
  description: 'Run a local A/B cache experiment with the same origin and a candidate config.',
  inputSchema: {
    profile: z.string().optional().describe('Path to the profile JSON file, unless using --new-leg.'),
    target: z.string().optional().describe('Named target from the profile.'),
    peak: z.number().optional().describe('Requests/s each leg is loaded at.'),
    ttl: z.number().optional().describe('Cache TTL for the candidate leg.'),
    third: z.string().optional().describe('A third leg template.'),
    run: z.boolean().optional().describe('Load every leg in turn and compare them.'),
    newLeg: z.string().optional().describe('Scaffold a new leg template file and exit.')
  }
}, async ({ profile, target, peak, ttl, third, run, newLeg }) => {
  const args = ['cache-ab'];
  if (profile) args.push('--profile', normalizePath(profile));
  if (target) args.push('--target', target);
  if (typeof peak === 'number') args.push('--peak', String(peak));
  if (typeof ttl === 'number') args.push('--ttl', String(ttl));
  if (third) args.push('--third', normalizePath(third));
  if (run) args.push('--run');
  if (newLeg) args.push('--new-leg', normalizePath(newLeg));
  const result = await runCrowdsimAllowingFailure(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_compare', {
  description: 'Compare two crowdsim runs or draw the delta as HTML.',
  inputSchema: {
    runA: z.string().describe('First run id or symbolic name such as previous.'),
    runB: z.string().describe('Second run id or symbolic name such as latest.'),
    json: z.boolean().optional().describe('Emit JSON instead of plain text.'),
    html: z.boolean().optional().describe('Draw the comparison as a self-contained HTML page.'),
    out: z.string().optional().describe('Write the HTML page to a file.')
  }
}, async ({ runA, runB, json, html, out }) => {
  const args = ['compare', runA, runB];
  if (json) args.push('--json');
  if (html) args.push('--html');
  if (out) args.push('--out', out);
  const result = await runCrowdsimAllowingFailure(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_report', {
  description: 'Render a crowdsim run as markdown or as a self-contained HTML report.',
  inputSchema: {
    run: z.string().describe('Run id to report.'),
    compare: z.string().optional().describe('Run id to compare against.'),
    out: z.string().optional().describe('Write markdown output to a file.'),
    html: z.boolean().optional().describe('Draw the report as HTML instead of markdown.')
  }
}, async ({ run, compare, out, html }) => {
  const args = ['report', run];
  if (compare) args.push('--compare', compare);
  if (out) args.push('--out', out);
  if (html) args.push('--html');
  const result = await runCrowdsimAllowingFailure(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_weights', {
  description: 'Convert an access log to the class mix used by a crowdsim profile.',
  inputSchema: {
    profile: z.string().describe('Path to the crowdsim profile JSON file.'),
    log: z.string().optional().describe('Access log file path. Reads stdin if omitted.'),
    format: z.string().optional().describe('The log format, e.g. time method path status.'),
    top: z.number().optional().describe('Top N suggested patterns to print.'),
    json: z.boolean().optional().describe('Emit machine-readable JSON output.')
  }
}, async ({ profile, log, format, top, json }) => {
  const args = ['weights'];
  if (log) args.push(log);
  args.push('--profile', normalizePath(profile));
  if (format) args.push('--format', format);
  if (typeof top === 'number') args.push('--top', String(top));
  if (json) args.push('--json');
  const result = await runCrowdsimAllowingFailure(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_init', {
  description: 'Draft a first crowdsim profile from discovered and probed measurements.',
  inputSchema: {
    out: z.string().optional().describe('Output profile path.'),
    accessLog: z.string().optional().describe('Access log to count weights from automatically.')
  }
}, async ({ out, accessLog }) => {
  const args = ['init'];
  if (out) args.push('--out', normalizePath(out));
  if (accessLog) args.push('--access-log', normalizePath(accessLog));
  const result = await runCrowdsimAllowingFailure(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_next', {
  description: 'Show where the current project is and what to run next.',
  inputSchema: {}
}, async () => {
  const result = await runCrowdsimAllowingFailure(['next']);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_record', {
  description: 'Convert a HAR export into a journey file for a crowdsim run.',
  inputSchema: {
    file: z.string().describe('Path to the HAR export.'),
    out: z.string().optional().describe('Output journey JSON path.'),
    origin: z.string().optional().describe('Origin URL for the journey.'),
    rscQuery: z.string().optional().describe('The query parameter used for RSC requests.'),
    force: z.boolean().optional().describe('Overwrite an existing output file.')
  }
}, async ({ file, out, origin, rscQuery, force }) => {
  const args = ['record', normalizePath(file)];
  if (out) args.push('--out', normalizePath(out));
  if (origin) args.push('--origin', origin);
  if (rscQuery) args.push('--rsc-query', rscQuery);
  if (force) args.push('--force');
  const result = await runCrowdsimAllowingFailure(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
});

server.registerTool('crowdsim_serve', {
  description: 'Serve the crowdsim GUI on loopback or on a configured bind address.',
  inputSchema: {
    port: z.number().optional().describe('Port to bind the GUI to.'),
    bind: z.string().optional().describe('Bind address, such as 127.0.0.1 or 0.0.0.0.'),
    token: z.string().optional().describe('GUI bearer token, required for non-loopback binds.')
  }
}, async ({ port, bind, token }) => {
  const args = ['serve'];
  if (typeof port === 'number') args.push('--port', String(port));
  if (bind) args.push('--bind', bind);
  if (token) process.env.CROWDSIM_GUI_TOKEN = token;
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
