import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer, rawRequest } from './helpers.mjs';

test('GET / 返回 public/index.html（html content-type）', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8/);
  const body = await response.text();
  assert.ok(body.includes('CTF-INDEX-MARKER'));
});

test('静态资源返回正确 content-type（css / nested js）', async (t) => {
  const { baseUrl } = await startServer(t, {});

  const css = await fetch(`${baseUrl}/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css; charset=utf-8/);

  const js = await fetch(`${baseUrl}/nested/deep.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript; charset=utf-8/);
  assert.ok((await js.text()).includes('DEEP-JS-MARKER'));
});

test('不存在的静态文件返回 404', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const response = await fetch(`${baseUrl}/missing-file.html`);
  assert.equal(response.status, 404);
});

test('路径穿越（编码 ../）被拒绝，不泄漏 public 之外的文件', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const attacks = [
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/nested/%2e%2e/%2e%2e/secret.txt',
    '/%2e%2e%2f%2e%2e%2fpackage.json',
  ];
  for (const attack of attacks) {
    const result = await rawRequest(baseUrl, { path: attack });
    assert.equal(result.status, 404, `路径穿越应返回 404：${attack}`);
    assert.ok(!result.body.includes('TOP-SECRET-DO-NOT-SERVE'), `不得泄漏文件内容：${attack}`);
  }
});

test('目录路径（nested/）不崩溃，找不到 index 返回 404', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const result = await rawRequest(baseUrl, { path: '/nested/' });
  assert.equal(result.status, 404);
});
