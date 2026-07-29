#!/usr/bin/env node
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const VERSION = '0.1.0';
const FORMS = ['headless-disposable', 'headed-disposable', 'headed-persistent'];

const TOOL_DEFINITIONS = [
  {
    name: 'browser_chrome_status',
    description: 'Report browser-chrome control policy state, configured forms, headed-persistent reachability, and MCP guidance without exposing private profile paths.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'browser_chrome_acquire_session',
    description: 'Acquire or validate a browser session policy lease before using browser-chrome DevTools MCP servers.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        form: { type: 'string', enum: FORMS, default: 'headless-disposable' },
        purpose: { type: 'string', description: 'Short task purpose for local lease bookkeeping. Do not include secrets.' },
        requiresPersistent: { type: 'boolean', description: 'Set true when saved auth/session/profile state is required.' },
        requiresSavedAuth: { type: 'boolean', description: 'Alias for requiresPersistent.' },
        requiresProfile: { type: 'boolean', description: 'Alias for requiresPersistent.' },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'browser_chrome_assert_persistent',
    description: 'Assert that the configured headed-persistent browser is the required form and is reachable after script-first open/reuse.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        form: { type: 'string', enum: FORMS, default: 'headed-persistent' },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'browser_chrome_release',
    description: 'Release a browser-chrome control lease. Headed-persistent release never closes the whole headed browser.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        form: { type: 'string', enum: FORMS, default: 'headed-persistent' },
        leaseId: { type: 'string', description: 'Lease id returned by browser_chrome_acquire_session.' },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

export function getToolNames(tools = TOOL_DEFINITIONS) {
  return tools.map((tool) => tool.name);
}

export function createControlServer(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const skillDir = options.skillDir || env.BROWSER_CHROME_SKILL_DIR || path.resolve(moduleDir, '..');
  return {
    env,
    skillDir,
    tools: TOOL_DEFINITIONS,
  };
}

export async function handleJsonRpcRequest(server, request) {
  if (!request || request.jsonrpc !== '2.0') {
    return jsonRpcError(request?.id ?? null, -32600, 'Invalid JSON-RPC request');
  }

  if (request.method === 'notifications/initialized') {
    return null;
  }

  try {
    switch (request.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'browser-chrome-control', version: VERSION },
          },
        };
      case 'tools/list':
        return { jsonrpc: '2.0', id: request.id, result: { tools: server.tools } };
      case 'tools/call':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: await callTool(server, request.params?.name, request.params?.arguments || {}),
        };
      default:
        return jsonRpcError(request.id, -32601, `Unsupported method: ${request.method}`);
    }
  } catch (error) {
    return jsonRpcError(request.id, -32603, error.message || 'Internal error');
  }
}

async function callTool(server, name, args) {
  switch (name) {
    case 'browser_chrome_status':
      return toolSuccess(await status(server));
    case 'browser_chrome_acquire_session':
      return toolResult(await acquireSession(server, args));
    case 'browser_chrome_assert_persistent':
      return toolResult(await assertPersistent(server, args));
    case 'browser_chrome_release':
      return toolResult(await releaseSession(server, args));
    default:
      return toolError(`Unknown browser-chrome control tool: ${name}`);
  }
}

function toolResult(result) {
  return result.ok === false ? toolError(result.error, result.details) : toolSuccess(result);
}

function toolSuccess(data) {
  return { content: [{ type: 'text', text: `${JSON.stringify(data, null, 2)}\n` }] };
}

function toolError(error, details = {}) {
  return {
    isError: true,
    content: [{ type: 'text', text: `${JSON.stringify({ ok: false, error, ...details }, null, 2)}\n` }],
  };
}

async function status(server) {
  const endpoint = headedUrl(server.env);
  const portPolicy = validateHeadedPort(server.env);
  const reachable = portPolicy.ok ? await endpointOk(endpoint, server.env) : false;
  const lease = await readLease(server).catch(() => null);
  return {
    ok: true,
    forms: [
      {
        form: 'headless-disposable',
        persistent: false,
        available: true,
        mcpServer: 'browser-chrome-headless',
        guidance: 'Use browser-chrome-headless for anonymous/disposable chrome_devtools_* actions. Control MCP does not pre-open headless in Phase 1.',
      },
      {
        form: 'headed-disposable',
        persistent: false,
        available: false,
        guidance: 'No disposable-headed launcher is provided in Phase 1; use headless-disposable or headed-persistent as appropriate.',
      },
      {
        form: 'headed-persistent',
        persistent: true,
        available: portPolicy.ok,
        mcpServer: 'browser-chrome-headed',
        guidance: 'Use browser-chrome-headed for chrome_devtools_* actions after acquire/assert succeeds.',
      },
    ],
    headedPersistent: {
      endpoint,
      reachable,
      portPolicy,
      profileConfigured: Boolean(headedUserDataDir(server.env)),
      profileDirectory: headedProfileDirectory(server.env),
      lock: lease
        ? { active: true, leaseId: lease.leaseId, pid: lease.pid, createdAt: lease.createdAt }
        : { active: false },
    },
  };
}

async function acquireSession(server, args) {
  const form = normalizeForm(args.form || 'headless-disposable');
  if (!form.ok) return form;

  if (requiresPersistent(args) && form.value !== 'headed-persistent') {
    return fail('Saved auth/session/profile state requires form=headed-persistent. Do not use headless-disposable or headed-disposable for logged-in profile tasks.');
  }

  if (form.value === 'headless-disposable') {
    return {
      ok: true,
      form: form.value,
      persistent: false,
      controlOwnsBrowser: false,
      mcpServer: 'browser-chrome-headless',
      guidance: 'Use browser-chrome-headless for chrome_devtools_* actions; its wrapper opens and closes an isolated headless browser.',
    };
  }

  if (form.value === 'headed-disposable') {
    return fail('headed-disposable is modeled but not launched by Phase 1 control MCP. Use headless-disposable for disposable checks or headed-persistent when saved auth/session/profile state is required.');
  }

  const portPolicy = validateHeadedPort(server.env);
  if (!portPolicy.ok) return fail(portPolicy.error);
  const lease = await acquireHeadedLock(server, args.purpose || 'browser-chrome-control');
  if (!lease.ok) return lease;

  try {
    const opened = await openHeaded(server);
    if (!opened.ok) return await failAndRelease(server, lease.leaseId, opened.error);
    const reachable = await endpointOk(opened.url, server.env);
    if (!reachable) return await failAndRelease(server, lease.leaseId, 'headed-persistent endpoint was not reachable after scripts/open-headed.sh completed.');
    return {
      ok: true,
      form: 'headed-persistent',
      persistent: true,
      leaseId: lease.leaseId,
      endpoint: opened.url,
      mcpServer: 'browser-chrome-headed',
      guidance: 'Use browser-chrome-headed for chrome_devtools_* actions. Release this control lease when done; release does not close headed Chrome.',
    };
  } catch (error) {
    return await failAndRelease(server, lease.leaseId, error.message || 'headed-persistent acquisition failed');
  }
}

async function assertPersistent(server, args) {
  const form = normalizeForm(args.form || 'headed-persistent');
  if (!form.ok) return form;
  if (form.value !== 'headed-persistent') {
    return fail('Persistent profile/auth assertions require form=headed-persistent. Disposable forms cannot satisfy saved session/profile requirements.');
  }
  const portPolicy = validateHeadedPort(server.env);
  if (!portPolicy.ok) return fail(portPolicy.error);
  if (!headedUserDataDir(server.env)) {
    return fail('headed-persistent profile configuration is missing. Set BROWSER_CHROME_HEADED_USER_DATA_DIR or use the default browser-chrome home.');
  }
  const opened = await openHeaded(server);
  if (!opened.ok) return opened;
  const reachable = await endpointOk(opened.url, server.env);
  if (!reachable) return fail('headed-persistent endpoint was not reachable after scripts/open-headed.sh completed.');
  return {
    ok: true,
    persistent: true,
    form: 'headed-persistent',
    reachable: true,
    endpoint: opened.url,
    mcpServer: 'browser-chrome-headed',
    guidance: 'Use browser-chrome-headed for chrome_devtools_* actions; do not switch to disposable/headless for saved auth/session tasks.',
  };
}

async function releaseSession(server, args) {
  const form = normalizeForm(args.form || 'headed-persistent');
  if (!form.ok) return form;
  if (form.value === 'headless-disposable') {
    return {
      ok: true,
      form: form.value,
      released: false,
      closedBrowser: false,
      guidance: 'No control-owned headless browser was acquired in Phase 1. browser-chrome-headless owns its own cleanup.',
    };
  }
  if (form.value === 'headed-disposable') {
    return {
      ok: true,
      form: form.value,
      released: false,
      closedBrowser: false,
      guidance: 'No headed-disposable control lease exists in Phase 1.',
    };
  }
  if (!args.leaseId) return fail('leaseId is required to release a headed-persistent control lease.');
  const lease = await readLease(server).catch(() => null);
  if (!lease) {
    return { ok: true, form: form.value, released: false, closedBrowser: false, guidance: 'No headed-persistent control lease was active.' };
  }
  if (lease.leaseId !== args.leaseId) {
    return fail('headed-persistent control lease is held by a different leaseId; not releasing it.');
  }
  await rm(lockDir(server), { recursive: true, force: true });
  return {
    ok: true,
    form: form.value,
    leaseId: args.leaseId,
    released: true,
    closedBrowser: false,
    guidance: 'Released the control lease only. The headed Chrome browser was not closed.',
  };
}

function normalizeForm(form) {
  if (!FORMS.includes(form)) {
    return fail(`Unsupported browser form: ${form}. Expected one of: ${FORMS.join(', ')}.`);
  }
  return { ok: true, value: form };
}

function requiresPersistent(args) {
  return Boolean(args.requiresPersistent || args.requiresSavedAuth || args.requiresProfile);
}

function validateHeadedPort(env) {
  const endpoint = env.BROWSER_CHROME_HEADED_URL;
  let portText;
  try {
    portText = endpoint ? new URL(endpoint).port : String(env.BROWSER_CHROME_HEADED_PORT || '9233');
  } catch {
    return { ok: false, error: 'BROWSER_CHROME_HEADED_URL must be a valid URL when set for headed-persistent browser policy.' };
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 9200 || port > 9300) {
    return { ok: false, error: 'BROWSER_CHROME_HEADED_PORT / headed endpoint port must be an integer in the 9200-9300 range for headed-persistent browser policy.' };
  }
  return { ok: true, port, range: '9200-9300' };
}

function headedUrl(env) {
  if (env.BROWSER_CHROME_HEADED_URL) return env.BROWSER_CHROME_HEADED_URL;
  const host = env.BROWSER_CHROME_HEADED_HOST || '127.0.0.1';
  const port = env.BROWSER_CHROME_HEADED_PORT || '9233';
  return `http://${host}:${port}`;
}

function headedUserDataDir(env) {
  return env.BROWSER_CHROME_HEADED_USER_DATA_DIR || path.join(browserChromeHome(env), 'headed-profile');
}

function headedProfileDirectory(env) {
  return env.BROWSER_CHROME_HEADED_PROFILE_DIRECTORY || 'Default';
}

function browserChromeHome(env) {
  return env.BROWSER_CHROME_HOME || path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache'), 'browser-chrome');
}

function lockDir(server) {
  return path.join(browserChromeHome(server.env), 'control', 'headed-persistent.lock');
}

function leasePath(server) {
  return path.join(lockDir(server), 'lease.json');
}

async function acquireHeadedLock(server, purpose) {
  const dir = lockDir(server);
  try {
    await mkdir(dir, { recursive: false });
  } catch (error) {
    if (error.code === 'ENOENT') {
      await mkdir(path.dirname(dir), { recursive: true });
      return acquireHeadedLock(server, purpose);
    }
    if (error.code === 'EEXIST') {
      const lease = await readLease(server).catch(() => null);
      return fail('headed-persistent control lease is busy/locked by another process.', {
        lock: lease ? { active: true, leaseId: lease.leaseId, pid: lease.pid, createdAt: lease.createdAt } : { active: true },
      });
    }
    throw error;
  }

  const lease = {
    leaseId: `headed-persistent-${crypto.randomUUID()}`,
    form: 'headed-persistent',
    pid: process.pid,
    createdAt: new Date().toISOString(),
    purpose: String(purpose).slice(0, 160),
  };
  await writeFile(leasePath(server), `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, ...lease };
}

async function readLease(server) {
  return JSON.parse(await readFile(leasePath(server), 'utf8'));
}

async function failAndRelease(server, leaseId, error) {
  await releaseSession(server, { form: 'headed-persistent', leaseId }).catch(() => null);
  return fail(error);
}

function fail(error, details = {}) {
  return { ok: false, error, ...details };
}

async function openHeaded(server) {
  const script = path.join(server.skillDir, 'scripts', 'open-headed.sh');
  const result = await execFileCapture(script, [], server.env);
  if (result.code !== 0) {
    return fail('scripts/open-headed.sh failed to open/reuse headed-persistent Chrome. Check local Chrome/start-command configuration.');
  }
  const url = parseField(result.stdout, 'url') || headedUrl(server.env);
  return { ok: true, url };
}

function execFileCapture(file, args, env) {
  const timeout = Number(env.BROWSER_CHROME_CONTROL_SCRIPT_TIMEOUT_MS || '30000');
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 1024 * 64 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, signal: error?.signal, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function parseField(output, field) {
  const match = output.match(new RegExp(`(?:^|\\s)${field}=([^\\s]+)`));
  return match?.[1];
}

async function endpointOk(url, env) {
  const timeoutMs = Math.max(100, Number(env.BROWSER_CHROME_CURL_TIMEOUT_MS || env.BROWSER_CHROME_CONTROL_ENDPOINT_TIMEOUT_MS || '750'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/json/version`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function runStdio(server = createControlServer()) {
  let buffer = Buffer.alloc(0);
  let transport = 'line';
  process.stdin.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const parsed = readMessage(buffer);
      if (!parsed) break;
      transport = parsed.transport;
      buffer = parsed.remaining;
      let response;
      try {
        response = await handleJsonRpcRequest(server, JSON.parse(parsed.body));
      } catch (error) {
        response = jsonRpcError(null, -32700, error.message || 'Parse error');
      }
      if (response) writeMessage(response, transport);
    }
  });
}

function readMessage(buffer) {
  if (buffer.length === 0) return null;

  if (buffer.subarray(0, Math.min(buffer.length, 14)).toString('utf8').toLowerCase().startsWith('content-length')) {
    return readContentLengthMessage(buffer);
  }

  const newline = buffer.indexOf('\n');
  if (newline < 0) return null;
  const line = buffer.subarray(0, newline).toString('utf8').trim();
  if (!line) {
    return { body: '{}', remaining: buffer.subarray(newline + 1), transport: 'line' };
  }
  return { body: line, remaining: buffer.subarray(newline + 1), transport: 'line' };
}

function readContentLengthMessage(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const header = buffer.subarray(0, headerEnd).toString('utf8');
  const lengthMatch = header.match(/Content-Length: *(\d+)/i);
  if (!lengthMatch) throw new Error('Missing Content-Length header');
  const length = Number(lengthMatch[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return null;
  return {
    body: buffer.subarray(bodyStart, bodyEnd).toString('utf8'),
    remaining: buffer.subarray(bodyEnd),
    transport: 'content-length',
  };
}

function writeMessage(message, transport = 'line') {
  const body = JSON.stringify(message);
  if (transport === 'content-length') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    return;
  }
  process.stdout.write(`${body}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const skillDirArgIndex = process.argv.indexOf('--skill-dir');
  const options = {};
  if (skillDirArgIndex >= 0 && process.argv[skillDirArgIndex + 1]) {
    options.skillDir = process.argv[skillDirArgIndex + 1];
  }
  await runStdio(createControlServer(options));
}
