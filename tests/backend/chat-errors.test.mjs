import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  createFakeRetriever,
  createFetchMock,
  sseResponse,
  standardUpstreamEvents,
  postChat,
  postRaw,
  messageStart,
  messageStop,
} from './helpers.mjs';

async function setup(t, handler, options = {}) {
  const mock = createFetchMock(handler);
  const { baseUrl, logger } = await startServer(t, {
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([]),
    ...options,
  });
  return { mock, baseUrl, logger };
}

async function assertHealthy(baseUrl) {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
}

test('参数校验：缺少 message → 400 INVALID_REQUEST', async (t) => {
  const { baseUrl } = await setup(t, () => assert.fail('校验失败不应调用上游'));
  const { status, body } = await postRaw(baseUrl, '/api/chat', JSON.stringify({}), {
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(status, 400);
  assert.equal(JSON.parse(body).error.code, 'INVALID_REQUEST');
});

test('参数校验：message 为空 / 纯空白 / 非字符串 → 400', async (t) => {
  const { baseUrl } = await setup(t, () => assert.fail('校验失败不应调用上游'));
  for (const payload of [{ message: '' }, { message: '   ' }, { message: 42 }]) {
    const { status, body } = await postRaw(baseUrl, '/api/chat', JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(status, 400, `payload=${JSON.stringify(payload)}`);
    assert.equal(JSON.parse(body).error.code, 'INVALID_REQUEST');
  }
});

test('参数校验：message 超过 4000 字符 → 400', async (t) => {
  const { baseUrl } = await setup(t, () => assert.fail('校验失败不应调用上游'));
  const { status, body } = await postRaw(baseUrl, '/api/chat', JSON.stringify({ message: '哀'.repeat(4001) }), {
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(status, 400);
  assert.equal(JSON.parse(body).error.code, 'INVALID_REQUEST');
});

test('参数校验：effort 不在 off|low|high|max → 400', async (t) => {
  const { baseUrl } = await setup(t, () => assert.fail('校验失败不应调用上游'));
  for (const effort of ['turbo', 'HIGH', 3]) {
    const { status, body } = await postRaw(baseUrl, '/api/chat', JSON.stringify({ message: '孤独', effort }), {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(status, 400, `effort=${JSON.stringify(effort)}`);
    assert.equal(JSON.parse(body).error.code, 'INVALID_REQUEST');
  }
});

test('参数校验：sessionId 格式非法 → 400', async (t) => {
  const { baseUrl } = await setup(t, () => assert.fail('校验失败不应调用上游'));
  for (const sessionId of ['has space', '../evil', 'x'.repeat(65), 7]) {
    const { status, body } = await postRaw(baseUrl, '/api/chat', JSON.stringify({ message: '孤独', sessionId }), {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(status, 400, `sessionId=${JSON.stringify(sessionId)}`);
    assert.equal(JSON.parse(body).error.code, 'INVALID_REQUEST');
  }
});

test('参数校验：非法 JSON / 空请求体 → 400', async (t) => {
  const { baseUrl } = await setup(t, () => assert.fail('校验失败不应调用上游'));
  for (const body of ['{"message":', '']) {
    const { status, text } = await postRaw(baseUrl, '/api/chat', body, {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(status, 400);
    assert.equal(JSON.parse(text).error.code, 'INVALID_REQUEST');
  }
});

test('上游 429：error 事件 code=RATE_LIMIT、retryable=true、之后无 done', async (t) => {
  const { baseUrl } = await setup(
    t,
    () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }),
  );
  const { events } = await postChat(baseUrl, { message: '孤独' });
  const errorEvent = events.find((event) => event.event === 'error');
  assert.ok(errorEvent, '应有 error 事件');
  assert.equal(errorEvent.data.code, 'RATE_LIMIT');
  assert.equal(errorEvent.data.retryable, true);
  assert.ok(!events.some((event) => event.event === 'done'), 'error 之后不得再发 done');
  await assertHealthy(baseUrl);
});

test('上游 500：error 事件 code=UPSTREAM、retryable=true', async (t) => {
  const { baseUrl } = await setup(t, () => new Response('upstream boom', { status: 500 }));
  const { events } = await postChat(baseUrl, { message: '孤独' });
  const errorEvent = events.find((event) => event.event === 'error');
  assert.equal(errorEvent.data.code, 'UPSTREAM');
  assert.equal(errorEvent.data.retryable, true);
  assert.ok(!events.some((event) => event.event === 'done'));
});

test('上游 400：error 事件 retryable=false', async (t) => {
  const { baseUrl } = await setup(t, () => new Response('bad request', { status: 400 }));
  const { events } = await postChat(baseUrl, { message: '孤独' });
  const errorEvent = events.find((event) => event.event === 'error');
  assert.equal(errorEvent.data.code, 'UPSTREAM');
  assert.equal(errorEvent.data.retryable, false);
});

test('网络错误（fetch 抛错）：error 事件 retryable=true', async (t) => {
  const { baseUrl } = await setup(t, () => {
    throw new TypeError('fetch failed');
  });
  const { events } = await postChat(baseUrl, { message: '孤独' });
  const errorEvent = events.find((event) => event.event === 'error');
  assert.ok(errorEvent, '应有 error 事件');
  assert.equal(errorEvent.data.code, 'UPSTREAM');
  assert.equal(errorEvent.data.retryable, true);
  assert.match(errorEvent.data.message, /无法连接上游服务/);
});

test('上游 SSE error 事件 → 转成 error 事件且不发 done', async (t) => {
  const { baseUrl } = await setup(t, () =>
    sseResponse([
      messageStart(),
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
    ]),
  );
  const { events } = await postChat(baseUrl, { message: '孤独' });
  assert.equal(events[0].event, 'meta');
  const errorEvent = events.find((event) => event.event === 'error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.data.code, 'UPSTREAM');
  assert.ok(!events.some((event) => event.event === 'done'));
});

test('上游流在 message_stop 前中断 → error 事件 retryable=true', async (t) => {
  const { baseUrl } = await setup(t, () =>
    sseResponse([messageStart(), { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } }]),
  );
  const { events } = await postChat(baseUrl, { message: '孤独' });
  const errorEvent = events.find((event) => event.event === 'error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.data.retryable, true);
  assert.match(errorEvent.data.message, /中断/);
});

test('缺少 API key：meta 之后发 error 事件，不调用上游', async (t) => {
  const { baseUrl, mock } = await setup(t, () => assert.fail('缺 key 不应发请求'), {
    env: { DEEPSEEK_API_KEY: '' },
  });
  const { events } = await postChat(baseUrl, { message: '孤独' });
  assert.equal(mock.calls.length, 0);
  assert.equal(events[0].event, 'meta');
  assert.equal(events.length, 2);
  assert.equal(events[1].event, 'error');
  assert.equal(events[1].data.code, 'UPSTREAM');
  assert.equal(events[1].data.retryable, false);
  assert.match(events[1].data.message, /DEEPSEEK_API_KEY/);
});

test('上游超时：error 事件 retryable=true，服务不崩', async (t) => {
  const { baseUrl } = await setup(
    t,
    (_call) =>
      new Promise((_resolve, reject) => {
        // 永不返回响应体；仅响应 abort，模拟上游卡死。
        const signal = _call.init.signal;
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    { env: { UPSTREAM_TIMEOUT_MS: '50' } },
  );
  const { events } = await postChat(baseUrl, { message: '孤独' });
  const errorEvent = events.find((event) => event.event === 'error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.data.retryable, true);
  assert.match(errorEvent.data.message, /超时/);
  await assertHealthy(baseUrl);
});

test('正常流无 error 事件；响应与日志不泄漏 API key', async (t) => {
  const mock = createFetchMock(() => sseResponse(standardUpstreamEvents()));
  const { baseUrl, logger } = await startServer(t, {
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([]),
  });
  const first = await postChat(baseUrl, { message: '孤独' });
  const second = await postChat(baseUrl, { message: '还是很孤独', sessionId: 's-leak-check' });
  assert.ok(!first.events.some((event) => event.event === 'error'));
  assert.ok(!second.events.some((event) => event.event === 'error'));
  assert.ok(!first.text.includes('test-key-123'), 'SSE 响应中不得出现 API key');
  assert.ok(!second.text.includes('test-key-123'), 'SSE 响应中不得出现 API key');
  const allLogs = logger.logs.map((entry) => entry.text).join('\n');
  assert.ok(!allLogs.includes('test-key-123'), '日志中不得出现 API key');
  assert.equal(mock.calls.length, 2);
});
