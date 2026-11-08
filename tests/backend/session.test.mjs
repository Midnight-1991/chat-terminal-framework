import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  createFakeRetriever,
  citationItem,
  createFetchMock,
  sseResponse,
  standardUpstreamEvents,
  postChat,
} from './helpers.mjs';

function standardMock() {
  return createFetchMock(() => sseResponse(standardUpstreamEvents({ text: '第一段。第二段。' })));
}

test('GET /api/session/{id}：未知会话返回空 turns', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });
  const response = await fetch(`${baseUrl}/api/session/s-never-used`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { sessionId: 's-never-used', turns: [] });
});

test('GET /api/session/{id}：非法 sessionId 返回 400', async (t) => {
  const { baseUrl } = await startServer(t, { retriever: createFakeRetriever([]) });
  for (const path of ['/api/session/has%20space', `/api/session/${'x'.repeat(65)}`]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_REQUEST');
  }
});

test('多轮上下文：第二轮请求带上 user/assistant 历史 + 当轮 user 检索内容', async (t) => {
  const mock = standardMock();
  const retriever = createFakeRetriever([citationItem()]);
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  const first = await postChat(baseUrl, { message: '我最近很孤独', sessionId: 's-multi' });
  assert.equal(first.events[0].data.sessionId, 's-multi');

  const second = await postChat(baseUrl, { message: '那我今晚能做什么', sessionId: 's-multi' });
  assert.equal(second.status, 200);

  const body = mock.lastBody();
  assert.equal(body.messages.length, 3);
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  );
  // 历史 user 轮原样保留（不含当轮证据块），assistant 轮是上一轮完整回答
  assert.equal(body.messages[0].content[0].text, '我最近很孤独');
  assert.equal(body.messages[1].content[0].text, '第一段。第二段。');
  assert.ok(body.messages[2].content[0].text.endsWith('[用户] 那我今晚能做什么'));
  assert.ok(body.messages[2].content[0].text.includes('[资料 c1]'));

  const session = await (await fetch(`${baseUrl}/api/session/s-multi`)).json();
  assert.equal(session.turns.length, 4);
  assert.deepEqual(
    session.turns.map((turn) => turn.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(session.turns[1].content, '第一段。第二段。');
  for (const turn of session.turns) assert.equal(typeof turn.ts, 'number');
});

test('会话只保留最近 12 轮（最多 24 条消息）', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });

  for (let round = 1; round <= 13; round += 1) {
    const { events } = await postChat(baseUrl, { message: `第${round}轮`, sessionId: 's-trim' });
    assert.equal(events.at(-1).event, 'done');
  }

  // 第 13 轮请求时历史为 12 轮 → 24 条 + 当轮 user 1 条
  const body = mock.lastBody();
  assert.equal(body.messages.length, 25);
  // 第 12、13 轮的会话（内存里只保留最近 12 轮 = 24 条）
  const session = await (await fetch(`${baseUrl}/api/session/s-trim`)).json();
  assert.equal(session.turns.length, 24);
  assert.equal(session.turns[0].role, 'user');
  assert.equal(session.turns[0].content, '第2轮');
  assert.equal(session.turns.at(-1).content, '第一段。第二段。');

  // 第 14 轮：历史裁剪后仍只拼 24 条（最早保留第 2 轮）
  await postChat(baseUrl, { message: '第14轮', sessionId: 's-trim' });
  assert.equal(mock.lastBody().messages.length, 25);
  assert.equal(mock.lastBody().messages[0].content[0].text, '第2轮');
});

test('同一 sessionId 复用会话，meta 中的 sessionId 一致', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });
  const first = await postChat(baseUrl, { message: '你好', sessionId: 'reuse-me' });
  const second = await postChat(baseUrl, { message: '再来', sessionId: 'reuse-me' });
  assert.equal(first.events[0].data.sessionId, 'reuse-me');
  assert.equal(second.events[0].data.sessionId, 'reuse-me');
});

test('上游报错的一轮不写入会话历史', async (t) => {
  let callCount = 0;
  const mock = createFetchMock(() => {
    callCount += 1;
    if (callCount === 1) return new Response('boom', { status: 500 });
    return sseResponse(standardUpstreamEvents({ text: '这一次成功。' }));
  });
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });

  const failed = await postChat(baseUrl, { message: '会失败的一轮', sessionId: 's-fail' });
  assert.equal(failed.events.at(-1).event, 'error');
  const sessionAfterFail = await (await fetch(`${baseUrl}/api/session/s-fail`)).json();
  assert.equal(sessionAfterFail.turns.length, 0);

  await postChat(baseUrl, { message: '成功的一轮', sessionId: 's-fail' });
  const body = mock.lastBody();
  assert.equal(body.messages.length, 1, '失败轮不应进入历史');
  assert.ok(body.messages[0].content[0].text.endsWith('[用户] 成功的一轮'));
});
