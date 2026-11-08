//  / 契约 6-7 10 + BYOK 与 chat 集成测试（/ + 钉扎/开关/白名单/峰谷）。
// 起 BYOK 出站（check/对话/记忆抽取）走 pinned 传输：应用层无法注入 transport（app.mjs 不可改），
// 因此 BYOK 路径用真实 127.0.0.1 本机假上游（BYOK_ALLOW_LOOPBACK=on，属测试例外），官方路径仍用 fetchImpl mock；
// 断言直接读取本机上游记录的 method/path/headers/body/remoteAddress，验证 DNS 钉扎与 Host 保持。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { resolveOfficialModel } from '../../server/model-policy.mjs';
import {
  apiJson,
  createCapturingLogger,
  postChat,
  sseResponse,
  standardUpstreamEvents,
  startAuthedServer,
  startServer,
} from './helpers.mjs';

const BYOK_API_KEY = 'test-key-test-A1b2';
const BASE_MODEL = 'deepseek-v4-pro';
const PEAK_MODEL = 'deepseek-v4-flash';
const USER = { username: 'byokuser', password: 'user-pass-123' };

function authHeaders(session) {
  return { cookie: session.cookieHeader, 'x-csrf-token': session.csrf };
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 标准 OpenAI 兼容假上游 SSE：文本增量 + finish_reason + 末帧 usage + [DONE]。 */
function byokChatSseBody({ text = '你好，我是自定义模型。' } = {}) {
  return [
    sseFrame({ choices: [{ delta: { content: text } }] }),
    sseFrame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sseFrame({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
    }),
    'data: [DONE]\n\n',
  ].join('');
}

function defaultByokHandler(call, req, res) {
  if (req.method === 'GET' && call.path.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }));
    return;
  }
  if (req.method === 'POST' && call.path.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(byokChatSseBody());
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"not found"}}');
}

/**
 * 真实本机 HTTP 假上游（BYOK baseUrl 指向它）：记录每次请求的 method/path/headers/body/remoteAddress。
 * handler 可自定义（返回状态码 / 销毁 socket / 重定向 / 自定义 SSE）。
 */
function startByokUpstream(t, handler = null) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const port = server.address().port;
      const call = {
        method: req.method,
        path: req.url,
        url: `http://127.0.0.1:${port}${req.url}`,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        remoteAddress: req.socket.remoteAddress,
      };
      calls.push(call);
      Promise.resolve()
        .then(() => (handler ?? defaultByokHandler)(call, req, res))
        .catch(() => {
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
        });
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      t.after(() => new Promise((done) => server.close(done)));
      resolve({
        server,
        port,
        calls,
        origin: `http://127.0.0.1:${port}`,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelsCalls: () => calls.filter((call) => call.path.endsWith('/models')),
        chatCalls: () => calls.filter((call) => call.path.endsWith('/chat/completions')),
      });
    });
    server.once('error', reject);
  });
}

function statusHandler(status, body = '{}') {
  return (call, req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };
}

function redirectHandler(location) {
  return (call, req, res) => {
    res.writeHead(302, { location });
    res.end('redirect');
  };
}

function networkErrorHandler() {
  return (call, req, res) => {
    req.socket.destroy();
  };
}

/** 官方上游仍走 fetchImpl mock（只记录、不触网）。 */
function createOfficialMock(handler = null) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (handler) return handler(String(url), init);
    return sseResponse(standardUpstreamEvents());
  };
  return { fetchImpl, calls };
}

async function startByokServer(t, { env = {}, handler = null, officialHandler = null, users = [USER] } = {}) {
  const upstream = await startByokUpstream(t, handler);
  const official = createOfficialMock(officialHandler);
  const logger = createCapturingLogger();
  const started = await startAuthedServer(t, {
    logger,
    fetchImpl: official.fetchImpl,
    users,
    env: {
      BYOK: 'on',
      BYOK_ALLOW_LOOPBACK: 'on',
      CHAT_MOCK: '0',
      MOCK_DELAY_MS: '0',
      QUOTA_DAY_TOKENS: '200000',
      ...env,
    },
  });
  const userSession = await started.login(USER.username, USER.password);
  assert.equal(userSession.status, 200);
  return {
    started,
    upstream,
    official,
    logger,
    userHeaders: authHeaders(userSession),
    byokBase: upstream.baseUrl,
  };
}

async function putByok(started, headers, body) {
  return apiJson(started.baseUrl, '/api/me/byok', { method: 'PUT', body, headers });
}

function eventsOf(chatResult, eventName) {
  return chatResult.events.filter((item) => item.event === eventName);
}

function payloadOf(chatResult, eventName) {
  const found = eventsOf(chatResult, eventName);
  return found.length > 0 ? found[0].data : null;
}

/* ------------------------------  配置接口 ------------------------------ */

test('PUT/GET /api/me/byok 形状正确，只回传 keyHint/baseUrlOrigin，不泄露明文', async (t) => {
  const { started, userHeaders, upstream, byokBase } = await startByokServer(t);
  const put = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: `${byokBase}/`,
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.data.byok.enabled, true);
  assert.equal(put.data.byok.configured, true);
  assert.equal(put.data.byok.model, 'gpt-4o-mini');
  assert.equal(put.data.byok.keyHint, 'test-key-…A1b2');
  assert.equal(put.data.byok.baseUrlOrigin, upstream.origin);
  assert.equal(put.data.byok.provider.id, 'custom');
  assert.equal(put.data.byok.provider.protocol, 'openai');
  assert.ok(Array.isArray(put.data.presets));
  assert.equal(put.data.presets.length, 6);
  const custom = put.data.presets.find((item) => item.id === 'custom');
  assert.equal(custom.requiresBaseUrl, true);
  assert.deepEqual(
    put.data.presets.map((item) => item.id),
    ['deepseek', 'openai', 'moonshot', 'qwen', 'anthropic', 'custom'],
  );
  assert.ok(!put.text.includes(BYOK_API_KEY), 'PUT 响应不得含明文 key');
  assert.ok(!put.text.includes('/v1'), 'PUT 响应不得含 baseUrl 路径');

  const get = await apiJson(started.baseUrl, '/api/me/byok', { headers: userHeaders });
  assert.equal(get.status, 200);
  assert.equal(get.data.byok.configured, true);
  assert.equal(get.data.byok.keyHint, 'test-key-…A1b2');
  assert.ok(!get.text.includes(BYOK_API_KEY));
  assert.ok(!get.text.includes('/v1'));
});

test('PUT 校验错误返回 400（缺 key / 非法模型 / 未知厂商）', async (t) => {
  const { started, userHeaders, byokBase } = await startByokServer(t);
  const cases = [
    [{ provider: 'custom', model: 'gpt-4o-mini', baseUrl: byokBase }, 'BYOK_KEY_INVALID'],
    [{ provider: 'custom', model: 'bad model', apiKey: BYOK_API_KEY, baseUrl: byokBase }, 'INVALID_MODEL'],
    [{ provider: 'unknown-provider', model: 'gpt-4o-mini', apiKey: BYOK_API_KEY }, 'INVALID_PROVIDER'],
  ];
  for (const [body, code] of cases) {
    const result = await putByok(started, userHeaders, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.data.error.code, code);
  }
  // 未登录 401。
  const anon = await putByok(started, {}, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(anon.status, 401);
});

/* ------------------------------  chat 集成 ------------------------------ */

test('BYOK 对话走自定义上游（pinned 传输/Host/头/体/模型/usage/meta），官方 totals 不含 BYOK 用量', async (t) => {
  const { started, official, userHeaders, upstream, byokBase } = await startByokServer(t);
  const configured = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(configured.status, 200, configured.text);

  const chat = await postChat(started.baseUrl, { message: '你好', effort: 'low' }, { headers: userHeaders });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(upstream.calls.length, 1, '应只调用 BYOK 上游一次');
  assert.equal(official.calls.length, 0, 'BYOK 对话不得调用官方上游');
  const call = upstream.chatCalls()[0];
  assert.equal(call.url, `${byokBase}/chat/completions`);
  assert.equal(call.headers.authorization, `Bearer ${BYOK_API_KEY}`);
  // pinned 传输必须连到已校验 IP，Host 仍是 URL 原始 host。
  assert.equal(call.remoteAddress, '127.0.0.1', '连接必须落在已校验 IP');
  assert.equal(call.headers.host, `127.0.0.1:${upstream.port}`, 'Host 头必须保持 URL 原始 host');
  const requestBody = JSON.parse(call.body);
  assert.equal(requestBody.model, 'gpt-4o-mini');
  assert.equal(requestBody.stream, true);
  assert.deepEqual(requestBody.stream_options, { include_usage: true });
  assert.ok(Array.isArray(requestBody.messages) && requestBody.messages.length >= 2);

  const meta = payloadOf(chat, 'meta');
  assert.equal(meta.model, 'gpt-4o-mini');
  assert.equal(meta.modelSource, 'byok');
  const text = eventsOf(chat, 'text_delta').map((item) => item.data.text).join('');
  assert.equal(text, '你好，我是自定义模型。');
  const done = payloadOf(chat, 'done');
  assert.deepEqual(done.usage, { inputTokens: 8, outputTokens: 4, cacheReadInputTokens: 2 });

  // 日志/事件全文不得含明文 key。
  const allText = JSON.stringify(chat.events);
  assert.ok(!allText.includes(BYOK_API_KEY), 'SSE 事件不得含明文 key');

  // 用量：BYOK 只进 bySource.byok，官方 totals 保持 0。
  const usage = await apiJson(started.baseUrl, '/api/me/usage?days=1', { headers: userHeaders });
  assert.equal(usage.status, 200);
  assert.equal(Number(usage.data.totals?.tokens ?? 0), 0, '官方口径不得包含 BYOK 用量');
  assert.equal(usage.data.bySource.byok.requests, 1);
  assert.equal(Number(usage.data.bySource.byok.tokens), 14);
  assert.equal(usage.data.bySource.byok.costUsd, null);
  assert.equal(usage.data.bySource.official.requests, 0);
});

test('BYOK 跳过 token 配额；删除配置后回落官方并受配额约束', async (t) => {
  const { started, official, userHeaders, byokBase } = await startByokServer(t, { env: { QUOTA_DAY_TOKENS: '1' } });
  const configured = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(configured.status, 200, configured.text);

  const first = await postChat(started.baseUrl, { message: '第一条', effort: 'low' }, { headers: userHeaders });
  const second = await postChat(started.baseUrl, { message: '第二条', effort: 'low' }, { headers: userHeaders });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'BYOK 不应受平台 token 配额限制');
  assert.equal(payloadOf(second, 'meta').modelSource, 'byok');

  // 删除配置 → 回官方模型。
  const removed = await apiJson(started.baseUrl, '/api/me/byok', { method: 'DELETE', headers: userHeaders });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.byok.configured, false);
  assert.equal(removed.data.byok.enabled, true);
  const officialCallsBefore = official.calls.length;
  const officialFirst = await postChat(started.baseUrl, { message: '官方一', effort: 'low' }, { headers: userHeaders });
  assert.equal(officialFirst.status, 200, officialFirst.text);
  assert.equal(payloadOf(officialFirst, 'meta').modelSource, 'official');
  assert.equal(official.calls.length, officialCallsBefore + 1, '删除配置后对话应走官方上游');
  const officialSecond = await postChat(started.baseUrl, { message: '官方二', effort: 'low' }, { headers: userHeaders });
  assert.equal(officialSecond.status, 429, '官方模型第二次应触发配额 429');
  assert.equal(JSON.parse(officialSecond.text).error.code, 'QUOTA_EXCEEDED');
  assert.equal(official.calls.length, officialCallsBefore + 1, '配额 429 不得请求上游');
});

test('BYOK 上游错误映射为 BYOK_UPSTREAM_*（脱敏、不回落官方）', async (t) => {
  const cases = [
    ['401 鉴权', statusHandler(401, '{"error":{"message":"invalid api key"}}'), 'BYOK_UPSTREAM_AUTH', false],
    ['429 限流', statusHandler(429, 'rate limited'), 'BYOK_UPSTREAM_RATE_LIMIT', true],
    ['500 服务端', statusHandler(500, 'boom'), 'BYOK_UPSTREAM_ERROR', true],
    ['网络异常', networkErrorHandler(), 'BYOK_UPSTREAM_ERROR', true],
  ];
  for (const [label, handler, expectedCode, expectedRetryable] of cases) {
    const { started, official, userHeaders, upstream, byokBase } = await startByokServer(t, { handler });
    await putByok(started, userHeaders, {
      provider: 'custom',
      model: 'gpt-4o-mini',
      apiKey: BYOK_API_KEY,
      baseUrl: byokBase,
    });
    const chat = await postChat(started.baseUrl, { message: '错误用例', effort: 'low' }, { headers: userHeaders });
    assert.equal(chat.status, 200, `${label}：SSE 响应本身应 200`);
    const error = payloadOf(chat, 'error');
    assert.ok(error, `${label}：应返回 error 事件`);
    assert.equal(error.code, expectedCode, label);
    assert.equal(error.retryable, expectedRetryable, label);
    assert.ok(!JSON.stringify(error).includes(BYOK_API_KEY), `${label}：错误消息不得含明文 key`);
    assert.equal(official.calls.length, 0, `${label}：不得回落官方上游`);
    assert.equal(payloadOf(chat, 'meta').modelSource, 'byok');
    assert.ok(upstream.chatCalls().length >= 1, `${label}：应实际请求过 BYOK 上游`);
  }
});

/* ------------------------------  安全 ------------------------------ */

test('SSRF baseUrl 变体全部 400；跨用户隔离；AUTH=off 不启用', async (t) => {
  const { started, userHeaders } = await startByokServer(t, { env: { BYOK_ALLOW_LOOPBACK: 'off' } });
  const invalid = [
    'https://127.0.0.1/v1',
    'https://10.0.0.5/v1',
    'https://169.254.169.254/latest',
    'https://localhost/v1',
    // IPv4-mapped IPv6：WHATWG 会把 [::ffff:127.0.0.1] 规范化为 [::ffff:7f00:1]，不得绕过。
    'https://[::ffff:127.0.0.1]/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://[::ffff:169.254.169.254]/v1',
    'https://[::ffff:a9fe:a9fe]/v1',
    'https://[::ffff:a00:5]/v1',
    'http://api.example.com/v1',
    'https://api.example.com:8443/v1',
    'https://user:pass@api.example.com/v1',
  ];
  for (const baseUrl of invalid) {
    const result = await putByok(started, userHeaders, {
      provider: 'custom',
      model: 'gpt-4o-mini',
      apiKey: BYOK_API_KEY,
      baseUrl,
    });
    assert.equal(result.status, 400, `baseUrl ${baseUrl} 应 400`);
    assert.equal(result.data.error.code, 'BYOK_URL_INVALID');
  }

  // 允许回环后再配置，跨用户不可见。
  const allow = await startByokServer(t, { users: [USER, { username: 'otheruser', password: 'other-pass-123' }] });
  const ownerHeaders = allow.userHeaders;
  const configured = await putByok(allow.started, ownerHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: allow.byokBase,
  });
  assert.equal(configured.status, 200, configured.text);
  const other = await allow.started.login('otheruser', 'other-pass-123');
  const otherGet = await apiJson(allow.started.baseUrl, '/api/me/byok', { headers: authHeaders(other) });
  assert.equal(otherGet.status, 200);
  assert.equal(otherGet.data.byok.configured, false);
  assert.ok(!otherGet.text.includes(BYOK_API_KEY));

  // AUTH=off：BYOK 接口不存在、ctx.byok 为 null、chat meta 不带 modelSource。
  const off = await startServer(t, { env: { CHAT_MOCK: '1' } });
  assert.equal(off.ctx.byok === null || off.ctx.byok === undefined, true);
  const offGet = await apiJson(off.baseUrl, '/api/me/byok');
  assert.equal(offGet.status, 404);
  const offChat = await postChat(off.baseUrl, { message: '单用户', effort: 'low' }, { headers: {} });
  assert.equal(offChat.status, 200);
  const offMeta = payloadOf(offChat, 'meta');
  assert.equal(Object.hasOwn(offMeta, 'modelSource'), false, 'AUTH=off meta 不得新增 modelSource 字段');
});

test('管理员设置可全局关闭 BYOK（PUT/CHECK 403，GET enabled=false，DELETE 仍可用）', async (t) => {
  const { started, userHeaders, byokBase } = await startByokServer(t);
  const patch = await apiJson(started.baseUrl, '/api/admin/settings', {
    method: 'PATCH',
    headers: authHeaders(started.session),
    body: { byokEnabled: false },
  });
  assert.equal(patch.status, 200, patch.text);

  const get = await apiJson(started.baseUrl, '/api/me/byok', { headers: userHeaders });
  assert.equal(get.status, 200);
  assert.equal(get.data.byok.enabled, false);
  const put = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(put.status, 403);
  assert.equal(put.data.error.code, 'BYOK_DISABLED');
  const check = await apiJson(started.baseUrl, '/api/me/byok/check', { method: 'POST', headers: userHeaders });
  assert.equal(check.status, 403);
  const removed = await apiJson(started.baseUrl, '/api/me/byok', { method: 'DELETE', headers: userHeaders });
  assert.equal(removed.status, 200);
});

/* ------------------------------ 限流 / 探活 ------------------------------ */

test('BYOK 仍受每用户限流（admin 豁免）', async (t) => {
  const { started, userHeaders, byokBase } = await startByokServer(t, { env: { RATE_PER_MINUTE: '1' } });
  await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  const first = await postChat(started.baseUrl, { message: '一', effort: 'low' }, { headers: userHeaders });
  assert.equal(first.status, 200, first.text);
  const second = await postChat(started.baseUrl, { message: '二', effort: 'low' }, { headers: userHeaders });
  assert.equal(second.status, 429);
  const body = JSON.parse(second.text);
  assert.ok(['RATE_LIMITED', 'CONCURRENCY_LIMITED'].includes(body.error.code));
  assert.ok(Number(second.headers['retry-after'] ?? 0) >= 1);

  // 管理员不受限流/配额约束。
  const adminHeaders = authHeaders(started.session);
  const adminPut = await putByok(started, adminHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: 'test-key-test-Admin1',
    baseUrl: byokBase,
  });
  assert.equal(adminPut.status, 200, adminPut.text);
  const adminFirst = await postChat(started.baseUrl, { message: '管理员一', effort: 'low' }, { headers: adminHeaders });
  const adminSecond = await postChat(started.baseUrl, { message: '管理员二', effort: 'low' }, { headers: adminHeaders });
  assert.equal(adminFirst.status, 200, adminFirst.text);
  assert.equal(adminSecond.status, 200, '管理员应豁免限流');
});

test('POST /api/me/byok/check 返回模型数（pinned 传输），失败归一化，3 次/分钟限流', async (t) => {
  const { started, userHeaders, upstream, byokBase } = await startByokServer(t);
  const unconfigured = await apiJson(started.baseUrl, '/api/me/byok/check', { method: 'POST', headers: userHeaders });
  assert.equal(unconfigured.status, 400);
  assert.equal(unconfigured.data.error.code, 'BYOK_NOT_CONFIGURED');

  await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  const first = await apiJson(started.baseUrl, '/api/me/byok/check', { method: 'POST', headers: userHeaders });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.ok, true);
  assert.equal(first.data.modelCount, 2);
  assert.ok(first.data.latencyMs >= 0);
  assert.equal(upstream.modelsCalls().length, 1);
  const modelsCall = upstream.modelsCalls()[0];
  assert.equal(modelsCall.url, `${byokBase}/models`);
  assert.equal(modelsCall.headers.authorization, `Bearer ${BYOK_API_KEY}`);
  assert.equal(modelsCall.remoteAddress, '127.0.0.1');

  // 3 次/分：再两次成功，第 4 次 429。
  await apiJson(started.baseUrl, '/api/me/byok/check', { method: 'POST', headers: userHeaders });
  await apiJson(started.baseUrl, '/api/me/byok/check', { method: 'POST', headers: userHeaders });
  const limited = await apiJson(started.baseUrl, '/api/me/byok/check', { method: 'POST', headers: userHeaders });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, 'BYOK_CHECK_RATE_LIMITED');

  // 探活失败归一化（新 server：admin 账号，避免限流窗口影响）。
  const failing = await startByokServer(t, { handler: statusHandler(401, '{"error":{"message":"invalid api key"}}') });
  const adminHeaders = authHeaders(failing.started.session);
  await putByok(failing.started, adminHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: failing.byokBase,
  });
  const failedCheck = await apiJson(failing.started.baseUrl, '/api/me/byok/check', {
    method: 'POST',
    headers: adminHeaders,
  });
  assert.equal(failedCheck.status, 200, failedCheck.text);
  assert.equal(failedCheck.data.ok, false);
  assert.equal(failedCheck.data.errorCode, 'BYOK_KEY_INVALID');
  assert.ok(!failedCheck.text.includes(BYOK_API_KEY));
});

test('AUTH=off 时提供 BYOK 配置也无效（无 route，chat 仍官方）', async (t) => {
  const official = createOfficialMock();
  const off = await startServer(t, {
    fetchImpl: official.fetchImpl,
    env: { CHAT_MOCK: '0', MOCK_DELAY_MS: '0' },
  });
  const put = await apiJson(off.baseUrl, '/api/me/byok', {
    method: 'PUT',
    body: { provider: 'custom', model: 'gpt-4o-mini', apiKey: BYOK_API_KEY, baseUrl: 'http://127.0.0.1:1/v1' },
  });
  assert.equal(put.status, 404);
  const chat = await postChat(off.baseUrl, { message: 'hello', effort: 'low' }, { headers: {} });
  assert.equal(chat.status, 200);
  assert.equal(Object.hasOwn(payloadOf(chat, 'meta'), 'modelSource'), false);
  assert.ok(official.calls.every((call) => !call.url.includes('127.0.0.1')));
});

/* --------------------- BYOK 对话出站前 DNS 重校验钩子 --------------------- */

test('BYOK 对话出站前调用 assertRequestUrl 钩子（参数为存储 baseUrl，未改动正常行为）', async (t) => {
  const { started, userHeaders, upstream, byokBase } = await startByokServer(t);
  const put = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(put.status, 200, put.text);

  const byok = started.ctx.byok;
  assert.equal(typeof byok?.assertRequestUrl, 'function', 'AUTH=on 时 ctx.byok 应提供 assertRequestUrl');
  const seen = [];
  const original = byok.assertRequestUrl.bind(byok);
  byok.assertRequestUrl = async (url) => {
    seen.push(url);
    return original(url);
  };

  const chat = await postChat(started.baseUrl, { message: '你好', effort: 'low' }, { headers: userHeaders });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(payloadOf(chat, 'meta').modelSource, 'byok');
  assert.deepEqual(seen, [byokBase], '每次出站前应以存储 baseUrl 调用一次钩子');

  assert.equal(upstream.chatCalls().length, 1);
  assert.equal(upstream.chatCalls()[0].url, `${byokBase}/chat/completions`);
  assert.ok(!chat.text.includes(BYOK_API_KEY), 'SSE 不得含明文 key');
});

test('对话出站前重校验失败（rebinding）→ SSE BYOK_UPSTREAM_ERROR，不发上游、不回落官方', async (t) => {
  const { started, logger, userHeaders, upstream, official, byokBase } = await startByokServer(t);
  const put = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(put.status, 200, put.text);

  // 模拟保存后 DNS rebinding：出站前钩子重新解析到受限地址 → 拒绝。
  started.ctx.byok.assertRequestUrl = async () => {
    throw new Error('自定义模型端点解析到受限地址（已拒绝）');
  };

  const chat = await postChat(started.baseUrl, { message: '你好', effort: 'low' }, { headers: userHeaders });
  assert.equal(chat.status, 200, chat.text);
  const meta = payloadOf(chat, 'meta');
  assert.equal(meta.modelSource, 'byok');
  assert.equal(meta.model, 'gpt-4o-mini');

  const error = payloadOf(chat, 'error');
  assert.equal(error.code, 'BYOK_UPSTREAM_ERROR');
  assert.match(error.message, /受限地址/);
  assert.ok(!chat.text.includes(BYOK_API_KEY), 'SSE 不得含明文 key');
  assert.ok(!JSON.stringify(logger.logs).includes(BYOK_API_KEY), '日志不得含明文 key');
  assert.equal(upstream.chatCalls().length, 0, '端点被拒时不得请求 BYOK 上游');
  assert.equal(official.calls.length, 0, '不得静默回落官方上游');
});

/* ------------------------------ 新增强化 ------------------------------ */

test('BYOK_CHECK_ENABLED=off → check 403 BYOK_CHECK_DISABLED（PUT 仍可配置，不发探活请求）', async (t) => {
  const { started, userHeaders, upstream, byokBase } = await startByokServer(t, {
    env: { BYOK_CHECK_ENABLED: 'off' },
  });
  const put = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(put.status, 200, put.text);

  const check = await apiJson(started.baseUrl, '/api/me/byok/check', { method: 'POST', headers: userHeaders });
  assert.equal(check.status, 403);
  assert.equal(check.data.error.code, 'BYOK_CHECK_DISABLED');
  assert.equal(upstream.modelsCalls().length, 0, '关闭探活后不得请求上游 /models');
});

test('BYOK_ALLOWED_MODELS / BYOK_ALLOWED_HOSTS 白名单 → PUT/check 400 对应错误码', async (t) => {
  const { started, userHeaders, upstream, byokBase } = await startByokServer(t, {
    env: { BYOK_ALLOWED_MODELS: 'gpt-4o-mini', BYOK_ALLOWED_HOSTS: '127.0.0.1' },
  });
  const allowed = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(allowed.status, 200, allowed.text);

  const badModel = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(badModel.status, 400);
  assert.equal(badModel.data.error.code, 'BYOK_MODEL_NOT_ALLOWED');

  const badHost = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: `http://localhost:${upstream.port}/v1`,
  });
  assert.equal(badHost.status, 400);
  assert.equal(badHost.data.error.code, 'BYOK_HOST_NOT_ALLOWED');

  // 白名单内的配置可正常探活。
  const check = await apiJson(started.baseUrl, '/api/me/byok/check', { method: 'POST', headers: userHeaders });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.data.ok, true);
});

test('BYOK 上游 302 重定向不跟随（SSE BYOK_UPSTREAM_ERROR，重定向目标不被请求）', async (t) => {
  let targetHits = 0;
  const handler = (call, req, res) => {
    if (call.path.endsWith('/chat/completions')) {
      res.writeHead(302, { location: `http://127.0.0.1:1/steal` });
      res.end('redirect');
      return;
    }
    targetHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  };
  const { started, official, userHeaders, byokBase, upstream } = await startByokServer(t, { handler });
  await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  const chat = await postChat(started.baseUrl, { message: '重定向用例', effort: 'low' }, { headers: userHeaders });
  assert.equal(chat.status, 200);
  const error = payloadOf(chat, 'error');
  assert.equal(error.code, 'BYOK_UPSTREAM_ERROR');
  assert.equal(error.retryable, false);
  assert.match(error.message, /重定向/);
  assert.equal(upstream.chatCalls().length, 1, '只发一次，不跟随重定向');
  assert.equal(targetHits, 0, '重定向目标不得被请求');
  assert.equal(official.calls.length, 0);
});

test('官方分支按峰谷策略取实际模型（meta/上游请求体一致）', async (t) => {
  const official = createOfficialMock();
  const peakHours = '00:00-23:59'; // 覆盖全天：工作日即峰段、周末即谷段（与 resolveOfficialModel 判定一致）
  const started = await startAuthedServer(t, {
    fetchImpl: official.fetchImpl,
    users: [USER],
    env: {
      CHAT_MOCK: '0',
      MOCK_DELAY_MS: '0',
      PEAK_MODEL_POLICY: 'auto',
      PEAK_MODEL,
      PEAK_HOURS_UTC: peakHours,
      QUOTA_DAY_TOKENS: '200000',
    },
  });
  const session = await started.login(USER.username, USER.password);
  const headers = authHeaders(session);
  const expected = resolveOfficialModel({
    config: { model: BASE_MODEL, peakModelPolicy: 'auto', peakModel: PEAK_MODEL, peakHoursUtc: peakHours },
  });
  assert.equal(expected.model, expected.peak ? PEAK_MODEL : BASE_MODEL);

  const chat = await postChat(started.baseUrl, { message: '峰谷策略用例', effort: 'low' }, { headers });
  assert.equal(chat.status, 200, chat.text);
  const meta = payloadOf(chat, 'meta');
  assert.equal(meta.model, expected.model, 'meta 必须记录实际使用的模型');
  assert.equal(meta.modelSource, 'official');
  assert.equal(official.calls.length, 1);
  assert.equal(JSON.parse(official.calls[0].init.body).model, expected.model, '上游请求体必须用实际模型');

  const account = started.accounts.find((item) => item.username === USER.username);
  const summary = await started.ctx.usage.userSummary(account.id, { days: 1 });
  assert.equal(summary.totals.requests, 1, 'usage 行模型仍以实际模型计（不影响计费口径）');
});

test('PEAK_MODEL_POLICY=off（默认）时官方始终用基础模型', async (t) => {
  const official = createOfficialMock();
  const started = await startAuthedServer(t, {
    fetchImpl: official.fetchImpl,
    users: [USER],
    env: { CHAT_MOCK: '0', MOCK_DELAY_MS: '0', PEAK_MODEL, PEAK_HOURS_UTC: '00:00-23:59' },
  });
  const session = await started.login(USER.username, USER.password);
  const chat = await postChat(started.baseUrl, { message: '默认策略用例', effort: 'low' }, { headers: authHeaders(session) });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(payloadOf(chat, 'meta').model, BASE_MODEL);
  assert.equal(JSON.parse(official.calls[0].init.body).model, BASE_MODEL);
});

test('BYOK 上游为真实本机服务时，check + 对话端到端均经 pinned 传输（无 fetchImpl 参与）', async (t) => {
  const { started, official, userHeaders, upstream, byokBase } = await startByokServer(t);
  const configured = await putByok(started, userHeaders, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: BYOK_API_KEY,
    baseUrl: byokBase,
  });
  assert.equal(configured.status, 200);
  const check = await apiJson(started.baseUrl, '/api/me/byok/check', { method: 'POST', headers: userHeaders });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.data.modelCount, 2);
  const chat = await postChat(started.baseUrl, { message: '端到端', effort: 'low' }, { headers: userHeaders });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(payloadOf(chat, 'meta').modelSource, 'byok');
  assert.equal(upstream.modelsCalls().length, 1);
  assert.equal(upstream.chatCalls().length, 1);
  // 官方分支的 fetchImpl 全程未被使用（BYOK 出站完全走 pinned 传输）。
  assert.equal(official.calls.length, 0);
  // 两次出站都连到已校验回环 IP（DNS 钉扎生效）。
  for (const call of upstream.calls) assert.equal(call.remoteAddress, '127.0.0.1');
});
