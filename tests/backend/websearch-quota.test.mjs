// 每用户每日联网次数配额（WEBSEARCH_PER_USER_PER_DAY）集成测试。
// 走真实 usage.mjs（AUTH=on 多用户），聊天上游用 CHAT_MOCK=1 + WEBSEARCH_MOCK_MODE=ok 保证零真实网络。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createCapturingLogger,
  postChat,
  startAuthedServer,
  startServer,
} from './helpers.mjs';

const USER = { username: 'searchuser', password: 'user-pass-123' };

function authHeaders(session) {
  return { cookie: session.cookieHeader, 'x-csrf-token': session.csrf };
}

function payloadOf(chatResult, eventName) {
  const found = chatResult.events.filter((item) => item.event === eventName);
  return found.length > 0 ? found[0].data : null;
}

async function startQuotaServer(t, { env = {} } = {}) {
  const logger = createCapturingLogger();
  const started = await startAuthedServer(t, {
    logger,
    users: [USER],
    env: {
      CHAT_MOCK: '1',
      MOCK_DELAY_MS: '0',
      WEBSEARCH: 'on',
      WEBSEARCH_MOCK_MODE: 'ok',
      WEBSEARCH_PER_USER_PER_DAY: '1',
      ...env,
    },
  });
  const session = await started.login(USER.username, USER.password);
  assert.equal(session.status, 200);
  const account = started.accounts.find((item) => item.username === USER.username);
  return { started, logger, userHeaders: authHeaders(session), userId: account.id };
}

async function readUsageRows(started, userId) {
  try {
    await started.ctx.usage.flush?.();
  } catch {
    /* 老实现没有 flush 时忽略（文件追加已在 record 内 await） */
  }
  const dir = path.join(started.dataDir, 'usage', userId);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  const rows = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      rows.push(JSON.parse(line));
    }
  }
  return rows;
}

test('limit=1 时第一次真正联网、第二次自动关闭联网（不 429）且配额字段/计数正确', async (t) => {
  const { started, userHeaders, userId } = await startQuotaServer(t);

  const first = await postChat(
    started.baseUrl,
    { message: '帮我查一下今天的天气和出行建议', effort: 'low', webSearch: 'on' },
    { headers: userHeaders },
  );
  assert.equal(first.status, 200, first.text);
  const firstMeta = payloadOf(first, 'meta');
  assert.ok(firstMeta.webSearchUsed > 0, `首次请求应真正联网（webSearchUsed=${firstMeta.webSearchUsed}）`);
  assert.equal(Object.hasOwn(firstMeta, 'webSearchQuota'), false, 'allowed=true 时 meta 不得输出 webSearchQuota');

  let rows = await readUsageRows(started, userId);
  assert.equal(rows.length, 1, '首次请求应落一条 usage 行');
  assert.equal(rows[0].webSearch, true, '真正联网的 usage 行必须带 webSearch:true');

  const second = await postChat(
    started.baseUrl,
    { message: '再帮我查一下明天的天气', effort: 'low', webSearch: 'on' },
    { headers: userHeaders },
  );
  assert.equal(second.status, 200, '超限不得 429，只在 meta 说明配额');
  const secondMeta = payloadOf(second, 'meta');
  assert.equal(secondMeta.webSearchUsed, 0, '超限后本轮必须自动不联网');
  assert.equal(Object.hasOwn(secondMeta, 'webSearchQuota'), true, '超限时 meta 必须带 webSearchQuota');
  assert.equal(secondMeta.webSearchQuota.allowed, false);
  assert.equal(secondMeta.webSearchQuota.limit, 1);
  assert.equal(secondMeta.webSearchQuota.used, 1);
  assert.equal(typeof secondMeta.webSearchQuota.resetAt, 'string');
  assert.ok(secondMeta.webSearchQuota.resetAt.length > 0, 'resetAt 应为次日重置时间');

  // 配额计数只统计真正联网轮次：两轮对话但联网次数仍为 1。
  rows = await readUsageRows(started, userId);
  assert.equal(rows.length, 2, '两轮对话各落一条 usage 行');
  assert.equal(rows.filter((row) => row.webSearch === true).length, 1);
  assert.equal(rows[1].webSearch, undefined, '未联网行不写 webSearch 字段（旧行兼容）');
  const summary = await started.ctx.usage.userSummary(userId, { days: 1 });
  assert.equal(summary.totals.webSearchRequests, 1);
  assert.equal(summary.series[0].webSearchRequests, 1);
  assert.equal(summary.totals.requests, 2);

  // 超限期间 webSearch='off' 的普通请求不受影响，也不产生配额字段。
  const plain = await postChat(started.baseUrl, { message: '普通对话', effort: 'low' }, { headers: userHeaders });
  assert.equal(plain.status, 200);
  const plainMeta = payloadOf(plain, 'meta');
  assert.equal(Object.hasOwn(plainMeta, 'webSearchQuota'), false);
});

test('管理员豁免联网配额（limit=1 仍可连续联网）', async (t) => {
  const { started } = await startQuotaServer(t);
  const adminHeaders = authHeaders(started.session); // startAuthedServer 默认登录 admin
  for (const index of [1, 2]) {
    const chat = await postChat(
      started.baseUrl,
      { message: `管理员联网检索 ${index}`, effort: 'low', webSearch: 'on' },
      { headers: adminHeaders },
    );
    assert.equal(chat.status, 200, chat.text);
    const meta = payloadOf(chat, 'meta');
    assert.ok(meta.webSearchUsed > 0, `管理员第 ${index} 次仍应联网`);
    assert.equal(Object.hasOwn(meta, 'webSearchQuota'), false, '管理员不输出配额字段');
  }
  const adminId = started.accounts[0].id;
  const summary = await started.ctx.usage.userSummary(adminId, { days: 1 });
  assert.equal(summary.totals.webSearchRequests, 2, '管理员联网仍计入可观测计数（只是不设限）');
});

test('AUTH=off 单用户路径不强制联网配额（也不写 webSearch 行字段的用户计数）', async (t) => {
  const started = await startServer(t, {
    env: {
      CHAT_MOCK: '1',
      MOCK_DELAY_MS: '0',
      WEBSEARCH: 'on',
      WEBSEARCH_MOCK_MODE: 'ok',
      WEBSEARCH_PER_USER_PER_DAY: '1',
    },
  });
  for (const index of [1, 2]) {
    const chat = await postChat(
      started.baseUrl,
      { message: `单用户联网检索 ${index}`, effort: 'low', webSearch: 'on' },
      { headers: {} },
    );
    assert.equal(chat.status, 200, chat.text);
    const meta = payloadOf(chat, 'meta');
    assert.ok(meta.webSearchUsed > 0, `AUTH=off 第 ${index} 次仍应联网`);
    assert.equal(Object.hasOwn(meta, 'webSearchQuota'), false, 'AUTH=off 不强制配额、不输出配额字段');
  }
  // AUTH=off 没有 usage 服务/用户维度：不落按用户配额统计（避免把单用户路径算进多用户观测）。
  assert.equal(started.ctx.usage, null, 'AUTH=off 不应创建 usage 服务');
  assert.equal(fs.existsSync(path.join(started.dataDir, 'usage')), false, 'AUTH=off 不应写 usage 目录');
});

test('usage.checkWebSearchQuota 直接语义（limit 空/0 不限、跨用户隔离、resetAt 次日）', async (t) => {
  const { started, userId } = await startQuotaServer(t, { env: { WEBSEARCH_PER_USER_PER_DAY: '2' } });
  const usage = started.ctx.usage;
  const first = await usage.checkWebSearchQuota({ userId, limit: 2, now: new Date() });
  assert.deepEqual(
    { allowed: first.allowed, used: first.used, limit: first.limit },
    { allowed: true, used: 0, limit: 2 },
  );
  assert.equal(typeof first.resetAt, 'string');

  // 手动记两条真正联网行（模拟历史用量）。
  for (const model of ['deepseek-v4-pro', 'deepseek-v4-pro']) {
    await usage.record({ userId, model, usage: { inputTokens: 1, outputTokens: 1 }, status: 'ok', webSearch: true });
  }
  const second = await usage.checkWebSearchQuota({ userId, limit: 2, now: new Date() });
  assert.equal(second.allowed, false);
  assert.equal(second.used, 2);
  // limit 0/空 = 不限（由 usage 层保证；config 层 min=1 不会传 0）。
  for (const limit of [0, null, undefined]) {
    const unlimited = await usage.checkWebSearchQuota({ userId, limit, now: new Date() });
    assert.equal(unlimited.allowed, true);
    assert.equal(unlimited.limit, null);
  }
  // 跨用户隔离：其他用户不受影响。
  const other = started.accounts[0].id;
  const otherQuota = await usage.checkWebSearchQuota({ userId: other, limit: 2, now: new Date() });
  assert.equal(otherQuota.allowed, true);
  assert.equal(otherQuota.used, 0);
});
