// 反馈服务与路由测试（接口契约  4）。
// 铁律：全部离线；DATA_DIR 用 mkdtemp；无 sleep；只用 fake ctx + 直接调用 handler（不依赖 /102 模块）。
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
  FEEDBACK_MAX_CHARS,
  FEEDBACK_STATUSES,
} from '../../server/feedback.mjs';

const FIXED_NOW = new Date('2026-11-07T00:00:00.000Z');

function fixedNow() {
  return new Date(FIXED_NOW);
}

function makeTmpDir(prefix = 'wild-feedback-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

/* ------------------------------- fake req/res ------------------------------- */

function makeReq({ method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
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
  const json = res.rawBody ? JSON.parse(res.rawBody) : null;
  return { res, json };
}

function makeCtx(overrides = {}) {
  const logger = overrides.logger ?? createCapturingLogger();
  return {
    user: { id: 'u_a', username: 'alice', role: 'user' },
    userId: 'u_a',
    baseDataDir: overrides.baseDataDir ?? makeTmpDir(),
    logger,
    ...overrides,
  };
}

/* ------------------------------- service tests ------------------------------- */

test('反馈服务：add 成功落盘（0600、原文不转义），entry 结构符合契约', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  const service = createFeedbackService({ dataDir: dir, logger, now: fixedNow });
  const rawBody = '<script>alert(1)</script> 最近很担忧，想找人聊聊';
  const entry = await service.add({
    userId: 'u_a',
    body: rawBody,
    conversationId: 'c0ffee',
    allowContext: true,
  });

  assert.match(entry.id, /^f[0-9a-f]{8}$/);
  assert.equal(entry.userId, 'u_a');
  assert.equal(entry.body, rawBody, '服务端只存原文，不做 HTML 转义');
  assert.equal(entry.conversationId, 'c0ffee');
  assert.equal(entry.allowContext, true);
  assert.equal(entry.status, 'open');
  assert.equal(entry.reply, null);
  assert.equal(entry.createdAt, FIXED_NOW.toISOString());
  assert.equal(entry.updatedAt, entry.createdAt);
  assert.deepEqual(Object.keys(entry).sort(), [
    'allowContext',
    'body',
    'conversationId',
    'createdAt',
    'id',
    'reply',
    'status',
    'updatedAt',
    'userId',
  ]);

  const filePath = path.join(dir, FEEDBACK_FILE_NAME);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, 'feedback.json 权限 0600');
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.feedback.length, 1);
  assert.equal(onDisk.feedback[0].body, rawBody, '落盘保留原文（转义由前端渲染方负责）');
  assert.equal(onDisk.feedback[0].conversationId, 'c0ffee', '只存 conversationId，不读对话正文');
  assert.equal(logger.logs.filter((row) => row.level === 'warn').length, 0);
});

test('反馈服务：body 按 Array.from 计 1..2000，非法输入 400 INVALID_INPUT', async () => {
  const service = createFeedbackService({ dataDir: makeTmpDir(), now: fixedNow });

  const maxBody = '😀'.repeat(FEEDBACK_MAX_CHARS); // 2000 个码点
  assert.equal(Array.from(maxBody).length, FEEDBACK_MAX_CHARS);
  const ok = await service.add({ userId: 'u_a', body: maxBody });
  assert.equal(ok.body, maxBody);

  await assert.rejects(
    () => service.add({ userId: 'u_a', body: '😀'.repeat(FEEDBACK_MAX_CHARS + 1) }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.add({ userId: 'u_a', body: '' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.add({ userId: 'u_a', body: 42 }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.add({ body: '没有用户' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.add({ userId: 'u_a', body: 'ok', conversationId: '../etc/passwd' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.add({ userId: 'u_a', body: 'ok', conversationId: 'a/b' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.add({ userId: 'u_a', body: 'ok', allowContext: 'yes' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.add({ userId: 'u_a', body: 'ok', conversationId: 12 }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
});

test('反馈服务：listByUser 只返回本人，按 createdAt 新在前；list 支持 status/limit/offset', async () => {
  const service = createFeedbackService({ dataDir: makeTmpDir(), now: fixedNow });
  const first = await service.add({ userId: 'u_a', body: '第一条' });
  const second = await service.add({ userId: 'u_a', body: '第二条' });
  const third = await service.add({ userId: 'u_a', body: '第三条' });
  await service.add({ userId: 'u_b', body: '别人的反馈' });

  const mine = await service.listByUser('u_a');
  assert.equal(mine.length, 3);
  assert.deepEqual(
    mine.map((entry) => entry.id),
    [third.id, second.id, first.id],
    '新在前',
  );
  assert.equal((await service.listByUser('u_b')).length, 1);
  assert.deepEqual(await service.listByUser('u_nobody'), []);

  await service.update(second.id, { status: 'resolved' });
  const resolved = await service.list({ status: 'resolved' });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, second.id);
  const opened = await service.list({ status: 'open' });
  assert.equal(opened.length, 3);

  // 全量按 createdAt 新在前：u_b 最新 → third → second → first；offset=1 取第 2、3 条
  const page = await service.list({ limit: 2, offset: 1 });
  assert.equal(page.length, 2);
  assert.deepEqual(
    page.map((entry) => entry.id),
    [third.id, second.id],
  );

  await assert.rejects(
    () => service.list({ status: 'unknown' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.list({ limit: 0 }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.list({ offset: -1 }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
});

test('反馈服务：update 状态/回复、回复可清空、未知 id 404、无字段 400', async () => {
  const service = createFeedbackService({ dataDir: makeTmpDir(), now: fixedNow });
  const entry = await service.add({ userId: 'u_a', body: '需要帮助' });

  const resolved = await service.update(entry.id, { status: 'resolved', reply: '已收到，谢谢反馈' });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.reply, '已收到，谢谢反馈');
  assert.ok(Date.parse(resolved.updatedAt) > Date.parse(resolved.createdAt), 'updatedAt 前进');

  const reopened = await service.update(entry.id, { status: 'open' });
  assert.equal(reopened.status, 'open');

  const cleared = await service.update(entry.id, { reply: null });
  assert.equal(cleared.reply, null, '回复可清空');

  await assert.rejects(
    () => service.update(entry.id, { status: 'closed' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.update(entry.id, { reply: 'x'.repeat(FEEDBACK_MAX_CHARS + 1) }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => service.update('f00000000', { status: 'resolved' }),
    (error) => error.status === 404 && error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => service.update(entry.id, {}),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
});

test('反馈服务：counts 统计与重启后磁盘数据可恢复', async () => {
  const dir = makeTmpDir();
  const service = createFeedbackService({ dataDir: dir, now: fixedNow });
  const a = await service.add({ userId: 'u_a', body: 'A' });
  await service.add({ userId: 'u_b', body: 'B' });
  await service.add({ userId: 'u_b', body: 'C' });
  await service.update(a.id, { status: 'resolved' });
  assert.deepEqual(await service.counts(), { open: 2, total: 3 });

  const reloaded = createFeedbackService({ dataDir: dir, now: fixedNow });
  const mine = await reloaded.listByUser('u_a');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, a.id);
  assert.equal(mine[0].status, 'resolved');
  assert.deepEqual(await reloaded.counts(), { open: 2, total: 3 });
});

test('反馈服务：feedback.json 损坏时降级为空数据并 warn（不抛错）', async () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, FEEDBACK_FILE_NAME), '{not-json', { mode: 0o600 });
  const logger = createCapturingLogger();
  const service = createFeedbackService({ dataDir: dir, logger, now: fixedNow });
  assert.deepEqual(await service.listByUser('u_a'), []);
  assert.ok(
    logger.logs.some((row) => row.level === 'warn' && row.text.includes('[feedback]')),
    '应有 warn 日志',
  );
});

/* ------------------------------- handler tests ------------------------------- */

test('handleFeedback：POST /api/feedback（完整 segments）→ 201，GET /api/me/feedback → 本人列表', async () => {
  const service = createFeedbackService({ dataDir: makeTmpDir(), now: fixedNow });
  const ctx = makeCtx({ feedback: service });

  const posted = await callHandler(ctx, {
    method: 'POST',
    url: '/api/feedback',
    body: { body: '我想反馈一个使用问题', conversationId: 'c0ffee', allowContext: true },
    segments: ['api', 'feedback'],
  });
  assert.equal(posted.res.statusCode, 201);
  assert.equal(posted.json.feedback.userId, 'u_a');
  assert.equal(posted.json.feedback.conversationId, 'c0ffee');
  assert.equal(posted.json.feedback.allowContext, true);

  const mine = await callHandler(ctx, {
    method: 'GET',
    url: '/api/me/feedback',
    segments: ['api', 'me', 'feedback'],
  });
  assert.equal(mine.res.statusCode, 200);
  assert.equal(mine.json.feedback.length, 1);
  assert.equal(mine.json.feedback[0].body, '我想反馈一个使用问题');

  // 另一个用户看不到 alice 的反馈
  const otherCtx = makeCtx({ feedback: service, user: { id: 'u_b', role: 'user' }, userId: 'u_b' });
  const other = await callHandler(otherCtx, {
    method: 'GET',
    url: '/api/me/feedback',
    segments: ['api', 'me', 'feedback'],
  });
  assert.deepEqual(other.json.feedback, []);
});

test('handleFeedback：兼容已归一化 segments（无 api 前缀）与 GET /api/feedback', async () => {
  const service = createFeedbackService({ dataDir: makeTmpDir(), now: fixedNow });
  const ctx = makeCtx({ feedback: service });

  const posted = await callHandler(ctx, {
    method: 'POST',
    url: '/api/feedback',
    body: { body: '归一化入口' },
    segments: ['feedback'],
  });
  assert.equal(posted.res.statusCode, 201);

  const list = await callHandler(ctx, {
    method: 'GET',
    url: '/api/feedback',
    segments: ['feedback'],
  });
  assert.equal(list.res.statusCode, 200);
  assert.equal(list.json.feedback.length, 1);

  const me = await callHandler(ctx, {
    method: 'GET',
    url: '/api/me/feedback',
    segments: ['me', 'feedback'],
  });
  assert.equal(me.res.statusCode, 200);
  assert.equal(me.json.feedback.length, 1);
});

test('handleFeedback：未登录 401、非法 body 400、超长 400、未知路由 404、服务缺失 500', async () => {
  const service = createFeedbackService({ dataDir: makeTmpDir(), now: fixedNow });
  const ctx = makeCtx({ feedback: service });

  const anonymous = await callHandler(
    { ...ctx, user: null, userId: null },
    { method: 'GET', url: '/api/me/feedback', segments: ['api', 'me', 'feedback'] },
  );
  assert.equal(anonymous.res.statusCode, 401);
  assert.equal(anonymous.json.error.code, 'UNAUTHORIZED');

  const malformed = await callHandler(ctx, {
    method: 'POST',
    url: '/api/feedback',
    body: '{oops',
    segments: ['api', 'feedback'],
  });
  assert.equal(malformed.res.statusCode, 400);
  assert.equal(malformed.json.error.code, 'INVALID_REQUEST');

  const tooLong = await callHandler(ctx, {
    method: 'POST',
    url: '/api/feedback',
    body: { body: 'x'.repeat(FEEDBACK_MAX_CHARS + 1) },
    segments: ['api', 'feedback'],
  });
  assert.equal(tooLong.res.statusCode, 400);
  assert.equal(tooLong.json.error.code, 'INVALID_INPUT');

  const tooBig = await callHandler(ctx, {
    method: 'POST',
    url: '/api/feedback',
    body: JSON.stringify({ body: 'x'.repeat(70 * 1024) }),
    segments: ['api', 'feedback'],
  });
  assert.equal(tooBig.res.statusCode, 400);
  assert.equal(tooBig.json.error.code, 'INVALID_REQUEST');

  const unknown = await callHandler(ctx, {
    method: 'GET',
    url: '/api/feedback/extra',
    segments: ['api', 'feedback', 'extra'],
  });
  assert.equal(unknown.res.statusCode, 404);
  assert.equal(unknown.json.error.code, 'NOT_FOUND');

  const wrongMethod = await callHandler(ctx, {
    method: 'DELETE',
    url: '/api/me/feedback',
    segments: ['api', 'me', 'feedback'],
  });
  assert.equal(wrongMethod.res.statusCode, 404);

  const noService = await callHandler(makeCtx(), {
    method: 'GET',
    url: '/api/me/feedback',
    segments: ['api', 'me', 'feedback'],
  });
  assert.equal(noService.res.statusCode, 500);
  assert.equal(noService.json.error.code, 'INTERNAL');
});

test('反馈状态常量与契约一致', () => {
  assert.deepEqual([...FEEDBACK_STATUSES], ['open', 'resolved']);
  assert.equal(FEEDBACK_MAX_CHARS, 2000);
});
