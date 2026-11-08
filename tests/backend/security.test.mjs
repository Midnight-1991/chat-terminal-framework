// 部署加固回归测试：安全响应头 / 同源校验 / JSON Content-Type / 数据目录权限 / 单实例锁。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, makeTmpDir } from './helpers.mjs';
import { createStore } from '../../server/store.mjs';

test('所有响应带安全响应头，且 CSP 不放开内联脚本', async (t) => {
  const { baseUrl } = await startServer(t, {});
  for (const url of ['/', '/api/health']) {
    const response = await fetch(`${baseUrl}${url}`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', url);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', url);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', url);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'CSP 不应放开内联脚本');
  }
});

test('跨站 Origin 的 POST 被 403 拒绝', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error?.code, 'FORBIDDEN');
});

test('同源 Origin 的 POST 正常放行（进入业务校验而非被拦）', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const origin = new URL(baseUrl).origin;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: '{}',
  });
  assert.equal(response.status, 400, '空消息应由业务层返回 400');
});

test('带 body 且非 JSON Content-Type 的接口请求返回 415', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"message":"hi"}',
  });
  assert.equal(response.status, 415);
});

test('无 Origin 的 CLI 请求（curl）仍可用', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 400);
});

test('DATA_DIR 权限收紧：目录 700、写入文件 600', async (t) => {
  const dataDir = makeTmpDir('wild-perm-');
  const logger = { log() {}, warn() {}, error() {} };
  const store = await createStore({ dataDir, logger });
  await store.createConversation({ title: '权限测试' });
  await store.flush?.();
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    const convDir = path.join(dataDir, 'conversations');
    assert.equal(fs.statSync(convDir).mode & 0o777, 0o700);
    const files = fs.readdirSync(convDir).filter((name) => name.endsWith('.json'));
    assert.ok(files.length >= 1);
    for (const name of files) {
      assert.equal(fs.statSync(path.join(convDir, name)).mode & 0o777, 0o600, name);
    }
  }
  t.diagnostic(`data=${dataDir}`);
});

test('单实例锁：DATA_DIR 被存活进程占用时拒绝启动', async (t) => {
  const dataDir = makeTmpDir('wild-lock-');
  // 起一个只等待的 Node 子进程模拟"另一个正在运行的实例"。
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(dataDir, '.lock'), `${child.pid}\n`);
    const logger = { log() {}, warn() {}, error() {} };
    await assert.rejects(
      () => createStore({ dataDir, logger }),
      /DATA_DIR 已被运行中的进程/,
    );
  } finally {
    child.kill('SIGKILL');
  }
});

test('单实例锁：过期锁（进程已不存在）自动接管', async (t) => {
  const dataDir = makeTmpDir('wild-lock-stale-');
  fs.writeFileSync(path.join(dataDir, '.lock'), '999999\n');
  const logger = { log() {}, warn() {}, error() {} };
  const store = await createStore({ dataDir, logger });
  await store.createConversation({ title: '接管测试' });
  assert.equal(fs.readFileSync(path.join(dataDir, '.lock'), 'utf8').trim(), String(process.pid));
});
