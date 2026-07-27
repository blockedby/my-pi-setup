import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createControlServer,
  getToolNames,
  handleJsonRpcRequest,
} from './server.mjs';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'browser-chrome-control-test-'));
}

async function withEndpoint(fn) {
  let selected;
  let server;
  for (let port = 9290; port <= 9300; port += 1) {
    server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'FakeChrome/1.0' }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      selected = port;
      break;
    } catch {
      server.close();
      server = undefined;
    }
  }
  if (!server || !selected) {
    throw new Error('no free test port in 9290-9300');
  }
  try {
    return await fn(`http://127.0.0.1:${selected}`, selected);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function fakeSkillDir(baseDir, logPath) {
  const scripts = path.join(baseDir, 'scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(
    path.join(scripts, 'open-headed.sh'),
    `#!/usr/bin/env bash\nset -euo pipefail\necho open-headed >> ${JSON.stringify(logPath)}\nprintf 'OPEN mode=headed url=%s reused=1\\n' \"$BROWSER_CHROME_HEADED_URL\"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(scripts, 'close-headless.sh'),
    `#!/usr/bin/env bash\nset -euo pipefail\necho close-headless >> ${JSON.stringify(logPath)}\n`,
    { mode: 0o755 },
  );
  return baseDir;
}

function resultJson(response) {
  assert.equal(response.error, undefined);
  const text = response.result.content[0].text;
  return JSON.parse(text);
}

async function call(server, name, args = {}) {
  return resultJson(await handleJsonRpcRequest(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }));
}

test('MCP initialize and tools/list expose only browser_chrome policy tools', async () => {
  const base = await tempDir();
  const log = path.join(base, 'calls.log');
  const skillDir = await fakeSkillDir(base, log);
  const server = createControlServer({ skillDir, env: { BROWSER_CHROME_HOME: path.join(base, 'home') } });

  const initialized = await handleJsonRpcRequest(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  assert.equal(initialized.result.serverInfo.name, 'browser-chrome-control');

  const listed = await handleJsonRpcRequest(server, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  assert.deepEqual(getToolNames(listed.result.tools), [
    'browser_chrome_status',
    'browser_chrome_acquire_session',
    'browser_chrome_assert_persistent',
    'browser_chrome_release',
  ]);
  const statusTool = listed.result.tools.find((tool) => tool.name === 'browser_chrome_status');
  assert.deepEqual(statusTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('status models all browser forms without leaking the user-data-dir path', async () => {
  await withEndpoint(async (url) => {
    const base = await tempDir();
    const log = path.join(base, 'calls.log');
    const skillDir = await fakeSkillDir(base, log);
    const privateProfilePath = path.join(base, 'very-private-profile');
    const server = createControlServer({
      skillDir,
      env: {
        BROWSER_CHROME_HOME: path.join(base, 'home'),
        BROWSER_CHROME_HEADED_URL: url,
        BROWSER_CHROME_HEADED_USER_DATA_DIR: privateProfilePath,
      },
    });

    const status = await call(server, 'browser_chrome_status');
    assert.deepEqual(status.forms.map((form) => form.form), [
      'headless-disposable',
      'headed-disposable',
      'headed-persistent',
    ]);
    assert.equal(status.headedPersistent.reachable, true);
    assert.equal(JSON.stringify(status).includes(privateProfilePath), false);
  });
});

test('saved auth/session acquisition is rejected unless form is headed-persistent', async () => {
  const base = await tempDir();
  const log = path.join(base, 'calls.log');
  const skillDir = await fakeSkillDir(base, log);
  const server = createControlServer({ skillDir, env: { BROWSER_CHROME_HOME: path.join(base, 'home') } });

  const rejected = await handleJsonRpcRequest(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'browser_chrome_acquire_session',
      arguments: { form: 'headless-disposable', purpose: 'needs existing login', requiresPersistent: true },
    },
  });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /headed-persistent/);
});

test('headed-persistent acquisition locks across processes, releases without closing Chrome, then can reacquire', async () => {
  await withEndpoint(async (url) => {
    const base = await tempDir();
    const log = path.join(base, 'calls.log');
    const skillDir = await fakeSkillDir(base, log);
    const env = {
      BROWSER_CHROME_HOME: path.join(base, 'home'),
      BROWSER_CHROME_HEADED_URL: url,
    };
    const first = createControlServer({ skillDir, env });
    const second = createControlServer({ skillDir, env });

    const acquired = await call(first, 'browser_chrome_acquire_session', {
      form: 'headed-persistent',
      purpose: 'test persistent session',
    });
    assert.equal(acquired.form, 'headed-persistent');
    assert.equal(acquired.mcpServer, 'browser-chrome-headed');
    assert.match(acquired.leaseId, /^headed-persistent-/);

    const busy = await handleJsonRpcRequest(second, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'browser_chrome_acquire_session', arguments: { form: 'headed-persistent' } },
    });
    assert.equal(busy.result.isError, true);
    assert.match(busy.result.content[0].text, /busy|locked/i);

    const released = await call(first, 'browser_chrome_release', {
      form: 'headed-persistent',
      leaseId: acquired.leaseId,
    });
    assert.equal(released.released, true);
    assert.equal(released.closedBrowser, false);
    const callsAfterRelease = await readFile(log, 'utf8');
    assert.match(callsAfterRelease, /open-headed/);
    assert.doesNotMatch(callsAfterRelease, /close-headless/);

    const reacquired = await call(second, 'browser_chrome_acquire_session', {
      form: 'headed-persistent',
    });
    assert.equal(reacquired.form, 'headed-persistent');
  });
});

test('assert_persistent rejects disposable forms and validates headed port policy', async () => {
  await withEndpoint(async (url) => {
    const base = await tempDir();
    const log = path.join(base, 'calls.log');
    const skillDir = await fakeSkillDir(base, log);
    const server = createControlServer({
      skillDir,
      env: { BROWSER_CHROME_HOME: path.join(base, 'home'), BROWSER_CHROME_HEADED_URL: url },
    });

    const disposable = await handleJsonRpcRequest(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'browser_chrome_assert_persistent', arguments: { form: 'headed-disposable' } },
    });
    assert.equal(disposable.result.isError, true);
    assert.match(disposable.result.content[0].text, /headed-persistent/);

    const ok = await call(server, 'browser_chrome_assert_persistent', { form: 'headed-persistent' });
    assert.equal(ok.persistent, true);
    assert.equal(ok.reachable, true);
  });

  const base = await tempDir();
  const log = path.join(base, 'calls.log');
  const skillDir = await fakeSkillDir(base, log);
  const invalid = createControlServer({
    skillDir,
    env: { BROWSER_CHROME_HOME: path.join(base, 'home'), BROWSER_CHROME_HEADED_PORT: '9400' },
  });
  const invalidPort = await handleJsonRpcRequest(invalid, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'browser_chrome_assert_persistent', arguments: { form: 'headed-persistent' } },
  });
  assert.equal(invalidPort.result.isError, true);
  assert.match(invalidPort.result.content[0].text, /9200-9300/);
});

test('headless-disposable acquisition returns guidance without opening Chrome', async () => {
  const base = await tempDir();
  const log = path.join(base, 'calls.log');
  const skillDir = await fakeSkillDir(base, log);
  const server = createControlServer({ skillDir, env: { BROWSER_CHROME_HOME: path.join(base, 'home') } });

  const acquired = await call(server, 'browser_chrome_acquire_session', {
    form: 'headless-disposable',
    purpose: 'anonymous smoke',
  });
  assert.equal(acquired.form, 'headless-disposable');
  assert.equal(acquired.mcpServer, 'browser-chrome-headless');
  assert.equal(acquired.controlOwnsBrowser, false);
  await assert.rejects(access(log, constants.F_OK), /ENOENT/);
});
