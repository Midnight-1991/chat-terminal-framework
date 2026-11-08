// 反馈 webhook 通知 + deleteByUser（合规注销）测试。
// 铁律：全部离线（fake fetch / fake req-res，不发真实网络请求）；mkdtemp；无 sleep；无第三方依赖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';

import {
  createFeedbackService,
  handleFeedback,
  FEEDBACK_FILE_NAME,
} from '../../server/feedback.mjs';

const FIXED_NOW = new Date('2026-11-07T00:00:00.000Z');

function fixedNow() {
  return new Date(FIXED_NOW);
}

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-webhook-test-'));
  if (t) {
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  return dir;
}

function createCapturingLogger() {
  const logs = [];
  const push = (level) => (...args) => {
    logs.push({ level, text: args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ') });
  };
  return {
    logs,
    log: push('log'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  };
}

/** 等待 fire-and-forget 的 Promise 链跑完（setImmediate，不引入 sleep/定时等待）。 */
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** fake fetch：记录调用并返回固定响应；可配置抛错/非 2xx。 */
function createFakeFetch({ error = null, status = 200, ok = true } = {}) {
  const calls = [];
  async function fetchImpl(url, options = {}) {
    calls.push({
      url,
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      rawBody: options.body,
      body: typeof options.body === 'string' ? JSON.parse(options.body) : null,
    });
    if (error) throw error;
    return { ok, status };
  }
  return { calls, fetchImpl };
}

/* ------------------------------- fake req/res ------------------------------- */

function makeReq({ method = 'GET', url = '/', body } = {}) {
  const chunks =
    body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    rawBody: '',
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.writableEnded = true;
      this.rawBody = body === undefined || body === null ? '' : String(body);
    },
  };
}

async function callHandler(ctx, { method = 'GET', url = '/', body, segments } = {}) {
  const req = makeReq({ method, url, body });
  const res = makeRes();
  await handleFeedback(req, res, ctx, segments ?? url.split('/').filter(Boolean));
  return { res, json: res.rawBody ? JSON.parse(res.rawBody) : null };
}

function makeCtx({ service, overrides = {} } = {}) {
  return {
    user: { id: 'u_a', username: 'alice', role: 'user' },
    userId: 'u_a',
    config: { feedbackWebhookUrl: '' },
    feedback: service,
    logger: createCapturingLogger(),
    ...overrides,
  };
}

/* ------------------------------- webhook：服务层 ------------------------------- */

test('webhook：配置 URL 时 add 成功后 fire-and-forget POST 一次，payload 固定且 bodyPreview≤200', async (t) => {
  const dir = makeTmpDir(t);
  const logger = createCapturingLogger();
  const fake = createFakeFetch();
  const service = createFeedbackService({
    dataDir: dir,
    logger,
    now: fixedNow,
    config: { feedbackWebhookUrl: 'http://localhost:9999/hook' },
    fetchImpl: fake.fetchImpl,
  });
  const body = 'x'.repeat(300);
  const entry = await service.add({ userId: 'u_a', body }, { username: 'alice' });
  await flushMicrotasks();

  assert.equal(fake.calls.length, 1, 'webhook 恰好发送一次');
  const call = fake.calls[0];
  assert.equal(call.url, 'http://localhost:9999/hook');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.ok(call.body, '请求体是 JSON');
  assert.deepEqual(Object.keys(call.body).sort(), [
    'bodyPreview',
    'createdAt',
    'id',
    'type',
    'username',
  ]);
  assert.equal(call.body.type, 'feedback');
  assert.equal(call.body.id, entry.id);
  assert.equal(call.body.createdAt, entry.createdAt);
  assert.equal(call.body.username, 'alice');
  assert.equal(Array.from(call.body.bodyPreview).length, 200, 'bodyPreview 截断为 200 字');
  assert.equal(call.body.bodyPreview, 'x'.repeat(200));
  assert.ok(!Object.hasOwn(call.body, 'body'), '不发送 body 字段以外的全文字段');
  assert.equal(fake.calls.length, 1);
});

test('webhook：未配置 feedbackWebhookUrl 时不发请求（字符串空/缺省）', async (t) => {
  const dir = makeTmpDir(t);
  const fake = createFakeFetch();
  for (const config of [{}, null, { feedbackWebhookUrl: '' }, { feedbackWebhookUrl: '   ' }]) {
    const service = createFeedbackService({
      dataDir: dir,
      logger: createCapturingLogger(),
      now: fixedNow,
      config,
      fetchImpl: fake.fetchImpl,
    });
    await service.add({ userId: 'u_a', body: '没有配置 webhook' });
  }
  await flushMicrotasks();
  assert.equal(fake.calls.length, 0);
});

test('webhook：发送失败/非 2xx 只 warn，不影响 add 返回值与落盘', async (t) => {
  const dir = makeTmpDir(t);
  for (const options of [{ error: new Error('ECONNREFUSED') }, { status: 500, ok: false }]) {
    const logger = createCapturingLogger();
    const fake = createFakeFetch(options);
    const service = createFeedbackService({
      dataDir: dir,
      logger,
      now: fixedNow,
      config: { feedbackWebhookUrl: 'http://127.0.0.1:1/hook' },
      fetchImpl: fake.fetchImpl,
    });
    const entry = await service.add({ userId: 'u_a', body: 'webhook 失败测试' });
    await flushMicrotasks();
    assert.equal(entry.body, 'webhook 失败测试');
    assert.ok(fake.calls.length >= 1);
    assert.ok(
      logger.logs.some((line) => line.level === 'warn' && /webhook/i.test(line.text)),
      '失败应 warn',
    );
    assert.equal(fs.existsSync(path.join(dir, FEEDBACK_FILE_NAME)), true);
  }
});

test('webhook：add(input, options) 可覆盖 URL/fetch/username（不依赖 config）', async (t) => {
  const dir = makeTmpDir(t);
  const defaultFake = createFakeFetch();
  const overrideFake = createFakeFetch();
  const service = createFeedbackService({
    dataDir: dir,
    logger: createCapturingLogger(),
    now: fixedNow,
  });
  const entry = await service.add(
    { userId: 'u_b', body: '覆盖参数' },
    { webhookUrl: 'http://example.test/override', fetchImpl: overrideFake.fetchImpl, username: 'bob' },
  );
  await flushMicrotasks();
  assert.equal(defaultFake.calls.length, 0);
  assert.equal(overrideFake.calls.length, 1);
  assert.equal(overrideFake.calls[0].url, 'http://example.test/override');
  assert.equal(overrideFake.calls[0].body.id, entry.id);
  assert.equal(overrideFake.calls[0].body.username, 'bob');
});

/* ------------------------------- deleteByUser ------------------------------- */

test('deleteByUser：只删目标用户、保留他人、原子落盘、重复调用返回 0', async (t) => {
  const dir = makeTmpDir(t);
  const logger = createCapturingLogger();
  const service = createFeedbackService({ dataDir: dir, logger, now: fixedNow });
  await service.add({ userId: 'u_a', body: 'A 的第一条' });
  await service.add({ userId: 'u_b', body: 'B 的一条' });
  await service.add({ userId: 'u_a', body: 'A 的第二条' });

  assert.equal(await service.deleteByUser('u_a'), 2, '返回删除条数');
  assert.deepEqual(await service.listByUser('u_a'), []);
  const bList = await service.listByUser('u_b');
  assert.equal(bList.length, 1);
  assert.equal(bList[0].body, 'B 的一条');
  assert.deepEqual(await service.counts(), { open: 1, total: 1 });

  const filePath = path.join(dir, FEEDBACK_FILE_NAME);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.feedback.length, 1);
  assert.equal(onDisk.feedback[0].userId, 'u_b');

  assert.equal(await service.deleteByUser('u_a'), 0, '再次调用返回 0');
  assert.equal(await service.deleteByUser('u_b'), 1);
  assert.deepEqual(await service.counts(), { open: 0, total: 0 });
  assert.equal((await service.list({})).length, 0);
});

test('deleteByUser：userId 缺失/非法返回 0，不改变数据', async (t) => {
  const dir = makeTmpDir(t);
  const service = createFeedbackService({ dataDir: dir, logger: createCapturingLogger(), now: fixedNow });
  await service.add({ userId: 'u_a', body: '保留' });
  for (const bad of [null, undefined, '', 123, {}, []]) {
    assert.equal(await service.deleteByUser(bad), 0);
  }
  assert.equal((await service.list({})).length, 1);
});

test('deleteByUser：落盘后新实例恢复，删除结果持久化', async (t) => {
  const dir = makeTmpDir(t);
  const first = createFeedbackService({ dataDir: dir, logger: createCapturingLogger(), now: fixedNow });
  await first.add({ userId: 'u_a', body: '删掉' });
  await first.add({ userId: 'u_b', body: '保留' });
  assert.equal(await first.deleteByUser('u_a'), 1);

  const reloaded = createFeedbackService({ dataDir: dir, logger: createCapturingLogger(), now: fixedNow });
  const rows = await reloaded.list({});
  assert.deepEqual(
    rows.map((entry) => entry.userId),
    ['u_b'],
  );
});

/* ------------------------------- webhook：HTTP handler ------------------------------- */

test('handler：POST /api/feedback 成功后按 ctx.config/ctx.fetchImpl 触发 webhook（username 来自登录用户）', async (t) => {
  const dir = makeTmpDir(t);
  const fake = createFakeFetch();
  const service = createFeedbackService({ dataDir: dir, logger: createCapturingLogger(), now: fixedNow });
  const ctx = makeCtx({
    service,
    overrides: {
      config: { feedbackWebhookUrl: 'http://localhost:9999/hook' },
      fetchImpl: fake.fetchImpl,
    },
  });
  const { res, json } = await callHandler(ctx, {
    method: 'POST',
    url: '/api/feedback',
    body: { body: '希望反馈能通知到管理员', conversationId: 'c123', allowContext: true },
  });
  await flushMicrotasks();
  assert.equal(res.statusCode, 201);
  assert.equal(json.feedback.userId, 'u_a');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].body.id, json.feedback.id);
  assert.equal(fake.calls[0].body.username, 'alice');
});

test('handler：未配置 webhook 时提交正常 201 且不发请求；webhook 失败也不影响 201', async (t) => {
  const dir = makeTmpDir(t);
  const service = createFeedbackService({ dataDir: dir, logger: createCapturingLogger(), now: fixedNow });
  const healthy = createFakeFetch();

  const noWebhook = await callHandler(makeCtx({ service }), {
    method: 'POST',
    url: '/api/feedback',
    body: { body: '无 webhook' },
  });
  await flushMicrotasks();
  assert.equal(noWebhook.res.statusCode, 201);
  assert.equal(healthy.calls.length, 0);

  const failing = createFakeFetch({ error: new Error('boom') });
  const failedCtx = makeCtx({
    service,
    overrides: { config: { feedbackWebhookUrl: 'http://localhost:9999/hook' }, fetchImpl: failing.fetchImpl },
  });
  const failed = await callHandler(failedCtx, {
    method: 'POST',
    url: '/api/feedback',
    body: { body: 'webhook 挂掉也要提交成功' },
  });
  await flushMicrotasks();
  assert.equal(failed.res.statusCode, 201);
  assert.equal(failed.json.feedback.body, 'webhook 挂掉也要提交成功');
  assert.equal(failing.calls.length, 1);
});
