// v2 配置与集成测试：DATA_DIR / MEMORY / RERANK / QUERY_EXPAND 解析、dataDir 相对路径、health.storage。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { loadConfig } from '../../server/config.mjs';
import { apiJson, citationItem, createFakeRetriever, makeTmpDir, postChat, startServer } from './helpers.mjs';

test('loadConfig v2 默认值：data/memory/rerank/queryExpand', () => {
  const config = loadConfig({}, { credentialPath: path.join(makeTmpDir('wild-cfg-'), 'nope.yaml') });
  assert.equal(config.dataDir, './data');
  assert.equal(config.memory, true);
  assert.equal(config.memoryMax, 20);
  assert.equal(config.memoryExtractModel, '');
  assert.equal(config.memoryExtractTimeoutMs, 15_000);
  assert.equal(config.rerank, 'off');
  assert.equal(config.queryExpand, 'heuristic');
  assert.equal(config.mock, false);
});

test('loadConfig v2：环境变量覆盖与非法值回退', () => {
  const credentialPath = path.join(makeTmpDir('wild-cfg-'), 'nope.yaml');
  const custom = loadConfig(
    {
      DATA_DIR: '/tmp/wild-data',
      MEMORY: 'off',
      MEMORY_MAX: '7',
      MEMORY_EXTRACT_MODEL: 'deepseek-v4-flash',
      MEMORY_EXTRACT_TIMEOUT_MS: '3000',
      RERANK: 'llm',
      QUERY_EXPAND: 'off',
    },
    { credentialPath },
  );
  assert.equal(custom.dataDir, '/tmp/wild-data');
  assert.equal(custom.memory, false);
  assert.equal(custom.memoryMax, 7);
  assert.equal(custom.memoryExtractModel, 'deepseek-v4-flash');
  assert.equal(custom.memoryExtractTimeoutMs, 3000);
  assert.equal(custom.rerank, 'llm');
  assert.equal(custom.queryExpand, 'off');

  const invalid = loadConfig(
    { MEMORY: 'definitely-maybe', MEMORY_MAX: '0', RERANK: 'bogus', QUERY_EXPAND: 'BOGUS' },
    { credentialPath },
  );
  assert.equal(invalid.memory, true, '无法识别的开关回退默认 on');
  assert.equal(invalid.memoryMax, 20, '0 回退默认上限');
  assert.equal(invalid.rerank, 'off');
  assert.equal(invalid.queryExpand, 'heuristic');
});

test('DATA_DIR 相对路径按 repoRoot 解析（默认仓库根 data/）', async (t) => {
  const repoRoot = makeTmpDir('wild-repo-relative-');
  const { ctx } = await startServer(t, {
    repoRoot,
    env: { DATA_DIR: 'persist-x' },
    dataDir: null,
  });
  assert.equal(ctx.dataDir, path.join(repoRoot, 'persist-x'));

  const { ctx: defaultCtx } = await startServer(t, {
    repoRoot: makeTmpDir('wild-repo-default-'),
    dataDir: null,
  });
  assert.equal(defaultCtx.dataDir, path.join(defaultCtx.repoRoot, 'data'));
});

test('health.storage 反映会话/记忆数量（只加不改）', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { CHAT_MOCK: '1', MEMORY: '1' },
    retriever: createFakeRetriever([]),
  });
  let health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.deepEqual(health.storage, { ok: true, conversations: 0, memories: 0, atRest: 'off', envelope: 'off' });

  await postChat(baseUrl, { message: '你好' });
  await apiJson(baseUrl, '/api/memories', { method: 'POST', body: { text: '用户叫小林', kind: 'profile' } });
  health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.deepEqual(health.storage, { ok: true, conversations: 1, memories: 1, atRest: 'off', envelope: 'off' });
});

test('v2 chat 契约：conversationId/title/memoryUsed 字段存在且类型正确', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { CHAT_MOCK: '1' },
    retriever: createFakeRetriever([]),
  });
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '我最近很累', effort: 'low' }),
  });
  const text = await response.text();
  const metaLine = text.split('\n\n').find((block) => block.startsWith('event: meta'));
  const meta = JSON.parse(metaLine.split('\n').find((line) => line.startsWith('data:')).slice(5));
  assert.match(meta.conversationId, /^c[0-9a-f]{12}$/);
  assert.equal(typeof meta.title, 'string');
  assert.ok(meta.title.length > 0);
  assert.equal(meta.memoryUsed, 0);
  assert.equal(meta.effort, 'low');
  assert.ok(Array.isArray(meta.citations));

  // 非法 conversationId / memory 参数 → 400（在 SSE 之前）
  for (const payload of [
    { message: '你好', conversationId: 'has space' },
    { message: '你好', conversationId: 'x'.repeat(65) },
    { message: '你好', memory: 'maybe' },
  ]) {
    const bad = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(bad.status, 400, JSON.stringify(payload));
    const body = await bad.json();
    assert.equal(body.error.code, 'INVALID_REQUEST');
  }
});

test('RAG 接线：retrieve 第三参透传 rerank/expand（RERANK=llm + QUERY_EXPAND=off）', async (t) => {
  const retriever = createFakeRetriever([citationItem()]);
  const { baseUrl } = await startServer(t, {
    env: { CHAT_MOCK: '1', RERANK: 'llm', QUERY_EXPAND: 'off' },
    retriever,
  });
  const chat = await postChat(baseUrl, { message: '最近睡不好' });
  assert.equal(chat.status, 200);
  assert.equal(retriever.calls.length, 1);
  assert.deepEqual(retriever.calls[0].retrieveOpts, { rerank: true, expand: false });
});

test('RAG 接线：QUERY_EXPAND=heuristic → expand true；RERANK=off → rerank false', async (t) => {
  const retriever = createFakeRetriever([citationItem()]);
  const { baseUrl } = await startServer(t, {
    env: { CHAT_MOCK: '1', QUERY_EXPAND: 'heuristic' },
    retriever,
  });
  await postChat(baseUrl, { message: '最近睡不好' });
  assert.deepEqual(retriever.calls[0].retrieveOpts, { rerank: false, expand: true });
});

test('RAG 接线：注入 reranker 原样保留；无 rag/rerank.mjs 时降级 null 且不崩', async (t) => {
  const injected = { rerank: async (query, candidates) => candidates.slice(0, 5) };
  const { ctx } = await startServer(t, {
    env: { CHAT_MOCK: '1', RERANK: 'llm' },
    retriever: createFakeRetriever([]),
    reranker: injected,
  });
  assert.equal(ctx.reranker, injected);

  const { ctx: fallbackCtx } = await startServer(t, {
    env: { CHAT_MOCK: '1', RERANK: 'llm' },
    retriever: createFakeRetriever([]),
  });
  assert.equal(fallbackCtx.reranker, null, '空仓库没有 rag/rerank.mjs 时降级为 null');
});
