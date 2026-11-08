import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer, createFakeRetriever, citationItem, rawRequest } from './helpers.mjs';

test('GET /api/health 返回契约字段，语料统计优先取检索器 stats()', async (t) => {
  const retriever = createFakeRetriever([citationItem()], { docs: 7, chunks: 42 });
  const { baseUrl } = await startServer(t, { retriever });

  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();

  assert.deepEqual(Object.keys(body).sort(), [
    'corpus',
    // 记录摘要字段（无数据时 days={}、lastImportedAt=null、summary 空结构）
    'days',
    'defaultEffort',
    'lastImportedAt',
    'maxTokens',
    'mock',
    'model',
    'ok',
    'storage',
    'summary',
    'updatedAt',
    'uptimeSec',
    'version',
    // 联网搜索能力字段（默认关闭；前端据此隐藏联网开关）
    'webSearch',
  ]);
  // WEBSEARCH 默认 off（enabled=false），provider 仅作展示。
  assert.equal(body.webSearch?.enabled, false);
  assert.equal(typeof body.webSearch?.provider, 'string');
  assert.deepEqual(body.days, {});
  assert.equal(body.lastImportedAt, null);
  assert.equal(body.updatedAt, null);
  assert.equal(body.summary.last7.workoutsCount, 0);
  assert.equal(body.ok, true);
  assert.equal(body.version, '1.0.0');
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.equal(body.defaultEffort, 'high');
  assert.equal(body.mock, false);
  assert.deepEqual(body.corpus, { docs: 7, chunks: 42 });
  assert.ok(Number.isFinite(body.uptimeSec));
  // auto 模式：显示 defaultEffort=high 的实际生效值（统一模型输出上限）
  assert.equal(body.maxTokens, 1000000);
  // v2：持久化 store 状态（健康检查新增字段，只加不改）；追加 atRest 模式
  assert.deepEqual(body.storage, { ok: true, conversations: 0, memories: 0, atRest: 'off', envelope: 'off' });
});

test('CHAT_MOCK=1 时 health mock=true；检索模块缺失时语料统计回退 docStore 并告警', async (t) => {
  const { baseUrl, logger } = await startServer(t, { env: { CHAT_MOCK: '1' } });

  const body = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(body.mock, true);
  // 测试仓库根没有 rag/index.mjs，回退到 fixtures/corpus：1 篇 3 个 chunk。
  assert.deepEqual(body.corpus, { docs: 1, chunks: 3 });
  assert.ok(
    logger.logs.some((entry) => entry.text.includes('[rag]')),
    '检索模块缺失时应有 warn 降级日志',
  );
});

test('未知 /api 路由返回 404 JSON 错误结构', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const response = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(typeof body.error.message, 'string');
});

test('非 GET 访问 /api/health 返回 404 JSON 而不是崩溃', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const result = await rawRequest(baseUrl, { path: '/api/health', method: 'POST', headers: { 'content-length': '0' } });
  assert.equal(result.status, 404);
  assert.equal(JSON.parse(result.body).error.code, 'NOT_FOUND');
});

test('health.maxTokens：显式 MAX_TOKENS 覆盖时显示该值', async (t) => {
  const { baseUrl } = await startServer(t, { env: { MAX_TOKENS: '1200' } });
  const body = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(body.maxTokens, 1200);
});
