import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  startServer,
  createFakeRetriever,
  createFetchMock,
  hangingUpstreamResponse,
  waitFor,
} from './helpers.mjs';

/** 发起原始 chat 请求，收到第一个 SSE 事件后立刻断开连接。 */
function postAndAbortAfterFirstChunk(baseUrl, payload = { message: '我最近很孤独' }) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: '/api/chat',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('event: meta')) {
            req.destroy();
            resolve({ receivedMeta: true });
          }
        });
        res.on('error', () => resolve({ receivedMeta: buffer.includes('event: meta') }));
      },
    );
    req.on('error', (error) => {
      if (error.code === 'ECONNRESET') return;
      reject(error);
    });
    req.end(body);
  });
}

// 默认 on 不中止上游；off 保留 语义（断开即 abort、不落 assistant）。
test('客户端断开时中止上游请求（signal aborted），服务继续存活', async (t) => {
  const mock = createFetchMock((call) => hangingUpstreamResponse(call.init.signal));
  const { baseUrl } = await startServer(t, {
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([]),
    env: { BACKGROUND_GENERATION: 'off' },
  });

  const { receivedMeta } = await postAndAbortAfterFirstChunk(baseUrl);
  assert.equal(receivedMeta, true, '断开前应已收到 meta 事件');

  const aborted = await waitFor(() => mock.calls.length === 1 && mock.calls[0].init.signal.aborted === true, {
    timeoutMs: 3000,
  });
  assert.equal(aborted, true, '客户端断开后必须 abort 上游 fetch 的 AbortSignal');

  // 服务仍可继续服务
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

test('客户端断开后不再向上游写 done / 不泄漏连接', async (t) => {
  const mock = createFetchMock((call) => hangingUpstreamResponse(call.init.signal));
  const { server, baseUrl, logger } = await startServer(t, {
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([]),
    // 默认 on 不中止上游；off 保留 语义。
    env: { BACKGROUND_GENERATION: 'off' },
  });

  await postAndAbortAfterFirstChunk(baseUrl, { message: '我最近很孤独', sessionId: 's-abort' });
  await waitFor(() => mock.calls.length === 1 && mock.calls[0].init.signal.aborted === true, { timeoutMs: 3000 });
  // 给收尾一点时间
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(server.ctx.sessions.getTurns('s-abort').length, 0, '中断的一轮不应写入会话');
  const errorLogs = logger.logs.filter((entry) => entry.level === 'error');
  assert.equal(errorLogs.length, 0, `中断属于正常路径，不应打 error 日志：${JSON.stringify(errorLogs)}`);
});
