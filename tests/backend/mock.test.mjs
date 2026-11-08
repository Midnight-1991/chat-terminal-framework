import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer, createFakeRetriever, citationItem, postChat } from './helpers.mjs';

function mockSetup(t, options = {}) {
  const retriever = createFakeRetriever(options.items ?? [citationItem(), citationItem({ chunkId: 'seasonal-01#s3p1', anchor: 's3', para: 1, score: 7.2 })]);
  const fetchImpl = () => {
    throw new Error('CHAT_MOCK=1 时不得调用真实上游 fetch');
  };
  return startServer(t, {
    retriever,
    fetchImpl,
    env: { CHAT_MOCK: '1', MOCK_DELAY_MS: '0' },
    ...options.serverOptions,
  }).then((started) => ({ ...started, retriever }));
}

test('CHAT_MOCK=1：不调上游，发 meta → thinking_delta → text_delta → done', async (t) => {
  const { baseUrl } = await mockSetup(t);
  const { status, headers, events } = await postChat(baseUrl, { message: '我最近很孤独', effort: 'high' });

  assert.equal(status, 200);
  assert.equal(headers['content-type'], 'text/event-stream; charset=utf-8');

  assert.equal(events[0].event, 'meta');
  assert.equal(events.at(-1).event, 'done');
  const names = events.map((event) => event.event);
  assert.ok(!names.includes('error'));

  const thinking = events.filter((event) => event.event === 'thinking_delta');
  assert.ok(thinking.length >= 1 && thinking.length <= 3, `thinking 段数 1–3，实际 ${thinking.length}`);
  assert.ok(thinking.every((event) => typeof event.data.text === 'string' && event.data.text.length > 0));

  const textDeltas = events.filter((event) => event.event === 'text_delta');
  assert.ok(textDeltas.length > 1, '正文应逐字分块流式输出');
  const answer = textDeltas.map((event) => event.data.text).join('');
  assert.match(answer, /\[\[c1\]\]/);
  assert.ok(events[0].data.citations.length === 2);
});

test('CHAT_MOCK=1：effort=off 不发 thinking，但正文照常', async (t) => {
  const { baseUrl } = await mockSetup(t);
  const { events } = await postChat(baseUrl, { message: '孤独', effort: 'off' });
  assert.equal(events[0].data.effort, 'off');
  assert.ok(!events.some((event) => event.event === 'thinking_delta'), 'effort=off 不应有 thinking_delta');
  const answer = events
    .filter((event) => event.event === 'text_delta')
    .map((event) => event.data.text)
    .join('');
  assert.ok(answer.length > 0);
  assert.equal(events.at(-1).event, 'done');
});

test('CHAT_MOCK=1：无检索命中时正文不出现引用标记', async (t) => {
  const { baseUrl } = await mockSetup(t, { items: [] });
  const { events } = await postChat(baseUrl, { message: '完全无关的问题' });
  assert.deepEqual(events[0].data.citations, []);
  const answer = events
    .filter((event) => event.event === 'text_delta')
    .map((event) => event.data.text)
    .join('');
  assert.ok(!/\[\[c\d+\]\]/.test(answer), `无命中不应有引用标记：${answer}`);
  assert.match(answer, /资料里没有直接对应的条目/);
  assert.equal(events.at(-1).event, 'done');
});

test('CHAT_MOCK=1：done 带 usage（inputTokens/outputTokens/cacheReadInputTokens）', async (t) => {
  const { baseUrl } = await mockSetup(t);
  const { events } = await postChat(baseUrl, { message: '孤独' });
  const done = events.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.data.stopReason, 'end_turn');
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens']) {
    assert.equal(typeof done.data.usage[key], 'number');
  }
  assert.ok(done.data.usage.inputTokens > 0);
  assert.ok(done.data.usage.outputTokens > 0);
});

test('CHAT_MOCK=1：问答写入会话历史（前端刷新可恢复）', async (t) => {
  const { baseUrl } = await mockSetup(t);
  const { events } = await postChat(baseUrl, { message: '我最近很孤独', sessionId: 's-mock-session' });
  const answer = events
    .filter((event) => event.event === 'text_delta')
    .map((event) => event.data.text)
    .join('');

  const session = await (await fetch(`${baseUrl}/api/session/s-mock-session`)).json();
  assert.equal(session.sessionId, 's-mock-session');
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns[0].role, 'user');
  assert.equal(session.turns[0].content, '我最近很孤独');
  assert.equal(session.turns[1].role, 'assistant');
  assert.equal(session.turns[1].content, answer);
});

test('CHAT_MOCK=1 时 /api/health 的 mock=true', async (t) => {
  const { baseUrl } = await mockSetup(t);
  const body = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(body.mock, true);
});
