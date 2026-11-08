// v2 会话持久化接口测试：/api/conversations* + chat 的 conversationId 集成。
// 铁律：上游一律 fetchImpl 注入，绝不发真实网络请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  apiJson,
  citationItem,
  createFakeRetriever,
  createFetchMock,
  makeTmpDir,
  postChat,
  sseResponse,
  standardUpstreamEvents,
  startServer,
} from './helpers.mjs';

const CONVERSATION_ID_RE = /^c[0-9a-f]{12}$/;

function chatMock(text = '第一段。第二段。') {
  return createFetchMock(() => sseResponse(standardUpstreamEvents({ text })));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('POST /api/conversations：201 + 契约字段 + index.json / conversations/<id>.json 落盘', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, { retriever: createFakeRetriever([]) });
  const { status, data } = await apiJson(baseUrl, '/api/conversations', { method: 'POST', body: {} });

  assert.equal(status, 201);
  const conversation = data.conversation;
  assert.match(conversation.id, CONVERSATION_ID_RE);
  assert.equal(conversation.title, '新对话');
  assert.equal(conversation.turnCount, 0);
  assert.ok(Number.isFinite(conversation.createdAt));
  assert.ok(Number.isFinite(conversation.updatedAt));

  const index = readJson(path.join(dataDir, 'index.json'));
  assert.equal(index.conversations.length, 1);
  assert.equal(index.conversations[0].id, conversation.id);
  const record = readJson(path.join(dataDir, 'conversations', `${conversation.id}.json`));
  assert.equal(record.id, conversation.id);
  assert.deepEqual(record.messages, []);

  // 显式标题
  const custom = await apiJson(baseUrl, '/api/conversations', { method: 'POST', body: { title: '关于睡眠' } });
  assert.equal(custom.status, 201);
  assert.equal(custom.data.conversation.title, '关于睡眠');

  // 非法标题
  for (const title of ['', '   ', 'x'.repeat(61), 42, null]) {
    const bad = await apiJson(baseUrl, '/api/conversations', { method: 'POST', body: { title } });
    assert.equal(bad.status, 400, `title=${String(title)} 应返回 400`);
    assert.equal(bad.data.error.code, 'INVALID_REQUEST');
  }
});

test('GET /api/conversations：按 updatedAt 倒序返回摘要（不含消息）', async (t) => {
  const mock = chatMock();
  const retriever = createFakeRetriever([citationItem()]);
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  const first = (await apiJson(baseUrl, '/api/conversations', { method: 'POST', body: { title: '旧会话' } })).data
    .conversation;
  const second = (await apiJson(baseUrl, '/api/conversations', { method: 'POST', body: { title: '新会话' } })).data
    .conversation;
  // 让旧会话变成最近更新
  await postChat(baseUrl, { message: '你好', conversationId: first.id });

  const list = (await apiJson(baseUrl, '/api/conversations')).data.conversations;
  // 空白会话（second 还没发过消息）不进入历史：用户要求「无信息发送的空白对话不需要保存」。
  assert.deepEqual(
    list.map((item) => item.id),
    [first.id],
  );
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'id', 'title', 'turnCount', 'updatedAt']);
  assert.equal(list[0].turnCount, 1); // 1 轮 = 1 条 user
});

test('chat 不带 conversationId：自动建会话、meta 携带 conversationId、标题取首条用户消息、消息落盘', async (t) => {
  const mock = chatMock('第一段。第二段。');
  const retriever = createFakeRetriever([citationItem()]);
  const { baseUrl, dataDir } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  const { events } = await postChat(baseUrl, { message: '我最近总是睡不好', effort: 'high' });
  const meta = events[0].data;
  assert.equal(events[0].event, 'meta');
  assert.match(meta.conversationId, CONVERSATION_ID_RE);
  assert.equal(meta.title, '我最近总是睡不好');
  assert.equal(meta.memoryUsed, 0);

  const detail = (await apiJson(baseUrl, `/api/conversations/${meta.conversationId}`)).data;
  assert.equal(detail.conversation.id, meta.conversationId);
  assert.equal(detail.conversation.title, '我最近总是睡不好');
  assert.deepEqual(
    detail.messages.map((message) => message.role),
    ['user', 'assistant'],
  );
  assert.equal(detail.messages[0].text, '我最近总是睡不好');
  assert.equal(detail.messages[1].text, '第一段。第二段。');
  assert.ok(Array.isArray(detail.messages[1].citations));

  // assistant 的思考过程也落盘
  const record = readJson(path.join(dataDir, 'conversations', `${meta.conversationId}.json`));
  assert.equal(record.messages[1].thinking, '先想一下。');
});

test('chat 带 conversationId：上游 messages 带上历史、turnCount 累加、标题保持', async (t) => {
  const mock = chatMock('先深呼吸。');
  const retriever = createFakeRetriever([citationItem()]);
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  const created = (await apiJson(baseUrl, '/api/conversations', { method: 'POST', body: { title: '睡眠' } })).data
    .conversation;
  const first = await postChat(baseUrl, { message: '我睡不着', conversationId: created.id });
  assert.equal(first.events[0].data.title, '睡眠');

  const second = await postChat(baseUrl, { message: '那我该做什么', conversationId: created.id });
  const body = mock.lastBody();
  assert.equal(body.messages.length, 3);
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(body.messages[0].content[0].text, '我睡不着');
  assert.equal(body.messages[1].content[0].text, '先深呼吸。');
  assert.ok(body.messages[2].content[0].text.endsWith('[用户] 那我该做什么'));
  assert.equal(second.events[0].data.title, '睡眠');

  const detail = (await apiJson(baseUrl, `/api/conversations/${created.id}`)).data;
  assert.equal(detail.messages.length, 4);
  assert.equal(
    (await apiJson(baseUrl, '/api/conversations')).data.conversations[0].turnCount,
    2, // 2 轮 = 2 条 user
  );
});

test('chat 指定不存在的 conversationId → 404 NOT_FOUND JSON（不启动 SSE）', async (t) => {
  const mock = chatMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });
  const { status, text, data } = await (async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你好', conversationId: 'c00000000000' }),
    });
    const body = await response.text();
    return { status: response.status, text: body, data: JSON.parse(body) };
  })();
  assert.equal(status, 404);
  assert.equal(data.error.code, 'NOT_FOUND');
  assert.equal(mock.calls.length, 0, '会话不存在时不得调用上游');
  assert.ok(!text.includes('event:'), '不得返回 SSE');
});

test('PATCH 标题：200 生效并落盘；非法标题 400；不存在 404', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, { retriever: createFakeRetriever([]) });
  const created = (await apiJson(baseUrl, '/api/conversations', { method: 'POST', body: {} })).data.conversation;

  const renamed = await apiJson(baseUrl, `/api/conversations/${created.id}`, {
    method: 'PATCH',
    body: { title: '重新命名' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.conversation.title, '重新命名');
  const record = readJson(path.join(dataDir, 'conversations', `${created.id}.json`));
  assert.equal(record.title, '重新命名');

  for (const title of ['', 'x'.repeat(61), 42]) {
    const bad = await apiJson(baseUrl, `/api/conversations/${created.id}`, { method: 'PATCH', body: { title } });
    assert.equal(bad.status, 400);
  }
  const missing = await apiJson(baseUrl, '/api/conversations/c00000000000', {
    method: 'PATCH',
    body: { title: 'x' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'NOT_FOUND');
});

test('DELETE 会话：{ok:true}、文件删除、再 GET 404、重复 DELETE 404', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, { retriever: createFakeRetriever([]) });
  const created = (await apiJson(baseUrl, '/api/conversations', { method: 'POST', body: {} })).data.conversation;
  const filePath = path.join(dataDir, 'conversations', `${created.id}.json`);
  assert.ok(fs.existsSync(filePath));

  const removed = await apiJson(baseUrl, `/api/conversations/${created.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data, { ok: true });
  assert.ok(!fs.existsSync(filePath));
  assert.equal((await apiJson(baseUrl, `/api/conversations/${created.id}`)).status, 404);
  assert.equal((await apiJson(baseUrl, `/api/conversations/${created.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await apiJson(baseUrl, '/api/conversations')).data.conversations.length, 0);
});

test('非法 / 路径穿越 conversationId → 404，不泄漏文件系统错误', async (t) => {
  const { baseUrl } = await startServer(t, { retriever: createFakeRetriever([]) });
  for (const id of ['../../../etc/passwd', '..%2f..%2fetc%2fpasswd', 'has space', 'x'.repeat(65)]) {
    const { status, data } = await apiJson(baseUrl, `/api/conversations/${encodeURIComponent(id)}`);
    assert.equal(status, 404, id);
    assert.equal(data.error.code, 'NOT_FOUND');
  }
});

test('会话持久化跨重启：同一 DATA_DIR 重启后列表与消息仍在', async (t) => {
  const dataDir = makeTmpDir('wild-persist-');
  const firstMock = chatMock('重启前回答。');
  const first = await startServer(t, {
    fetchImpl: firstMock.fetchImpl,
    retriever: createFakeRetriever([]),
    dataDir,
  });
  const { events } = await postChat(first.baseUrl, { message: '重启前的对话' });
  const conversationId = events[0].data.conversationId;

  const second = await startServer(t, {
    fetchImpl: chatMock().fetchImpl,
    retriever: createFakeRetriever([]),
    dataDir,
  });
  const list = (await apiJson(second.baseUrl, '/api/conversations')).data.conversations;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, conversationId);
  const detail = (await apiJson(second.baseUrl, `/api/conversations/${conversationId}`)).data;
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].text, '重启前的对话');
});

test('未知 /api/conversations 子路径与不支持的 method → 404 JSON', async (t) => {
  const { baseUrl } = await startServer(t, { retriever: createFakeRetriever([]) });
  const unknown = await apiJson(baseUrl, '/api/conversations/abc/messages');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error.code, 'NOT_FOUND');
  const put = await apiJson(baseUrl, '/api/conversations', { method: 'PUT', body: {} });
  assert.equal(put.status, 404);
});
