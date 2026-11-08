// BYOK 记忆抽取单测（两族非流式协议 + 失败不回落官方 + 出站 DNS 校验钩子）。
// 网络边界：只连本机假上游（http.createServer 监听 127.0.0.1 随机端口），绝不发起真实第三方请求。
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { ByokError } from '../../server/byok-providers.mjs';
import { createByokService } from '../../server/byok.mjs';
import { createMemoryService } from '../../server/memory.mjs';
import {
  MEMORY_EXTRACT_DEFAULT_MAX_TOKENS,
  buildExtractRequest,
  createMemoryExtractCaller,
  extractViaByok,
  parseExtractResponse,
} from '../../server/memory-extract.mjs';
import { createPinnedTransport } from '../../server/pinned-http.mjs';
import { createCapturingLogger, makeTmpDir } from './helpers.mjs';

const API_KEY = 'test-key-test-A1b2';
const USER_ID = 'u111111111111';
const OPENAI_BASE = 'http://127.0.0.1:18088/v1';
const ANTHROPIC_BASE = 'http://127.0.0.1:18089/v1';
const EXTRACT_PROMPT = '抽取规则：只输出 JSON 数组。';
const MEMORY_TEXT = '用户正在准备一场演讲';
const MEMORY_JSON = JSON.stringify([
  { text: MEMORY_TEXT, kind: 'fact', level: 'core', category: 'academic' },
]);

/* ------------------------------ 本机假上游 ------------------------------ */

function jsonResponse(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function startUpstream(handler, { delayMs = 0 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const call = { method: req.method, url: req.url, headers: req.headers, body, raw };
      calls.push(call);
      const respond = () => Promise.resolve(handler(req, res, call)).catch(() => {
        jsonResponse(res, 500, { error: 'handler error' });
      });
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    calls,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ------------------------------ memory 内存版 store ------------------------------ */

function createStateStore(initial = []) {
  const state = initial.map((memory) => ({ ...memory }));
  return {
    state,
    listMemories: () => state.map((memory) => ({ ...memory })),
    getActiveMemories: () => state.filter((memory) => !memory.validTo).map((memory) => ({ ...memory })),
    memoryTextList: () => state.map((memory) => memory.text),
    addMemory: async (input = {}) => {
      const memory = {
        id: `m${String(state.length + 1).padStart(12, '0')}`,
        kind: 'fact',
        level: 'core',
        category: 'other',
        source: 'auto',
        createdAt: Date.now(),
        validFrom: Date.now(),
        validTo: null,
        ...input,
      };
      if (memory.level === 'trivia') memory.category = 'other';
      state.push(memory);
      return { ...memory };
    },
    invalidateMemory: async (id) => {
      const memory = state.find((entry) => entry.id === id);
      if (!memory) return false;
      memory.validTo = Date.now();
      return true;
    },
    updateMemory: async (id, patch = {}) => {
      const memory = state.find((entry) => entry.id === id);
      if (!memory) return null;
      Object.assign(memory, patch);
      return { ...memory };
    },
  };
}

/* ------------------------------ BYOK ctx 构造 ------------------------------ */

/**
 * 构造与 app per-user scoped ctx 同形的测试 ctx：
 * - byok.getSecret 返回给定 secret；
 * - byok.assertRequestUrl 用真实 createByokService（allowLoopback 测试模式）做 DNS 校验；
 * - resolveChatModelSource 需要的 authMode/userId/user.modelSource/getByokEnabled 一并提供。
 */
function makeByokContext({
  protocol,
  baseUrl,
  model = 'fake-model-1',
  officialCallModel = null,
  logger,
  config = {},
  assertRequestUrlImpl = null,
} = {}) {
  const dataDir = makeTmpDir('wild-mem-byok-');
  const byokConfig = { byokAllowLoopback: true, byokEnabled: true };
  const byokService = createByokService({
    baseDataDir: dataDir,
    atRestKey: null,
    config: byokConfig,
    logger,
    dnsLookup: async () => [{ address: '93.184.216.34' }],
  });
  const secret = {
    provider: protocol === 'anthropic' ? 'anthropic' : 'openai',
    protocol,
    model,
    baseUrl,
    apiKey: API_KEY,
    keyHint: 'test-key-…A1b2',
  };
  const ctx = {
    authMode: 'on',
    userId: USER_ID,
    user: { id: USER_ID, modelSource: 'byok', status: 'active' },
    byok: {
      getSecret: async () => secret,
      // 记忆抽取同样走 pinned 传输（allowLoopback 测试例外，连本机假上游）。
      transport: byokService.transport,
      assertRequestUrl:
        assertRequestUrlImpl ?? ((url) => byokService.assertRequestUrl(url)),
    },
    getByokEnabled: async () => true,
    config: {
      mock: false,
      memory: true,
      memoryMax: 20,
      memoryExtractTimeoutMs: 3_000,
      memoryExtractMaxTokens: 256,
      ...config,
    },
    fetchImpl: globalThis.fetch,
    logger,
  };
  return { ctx, secret, dataDir, byokService };
}

function makeMemoryStack({ ctx, officialCallModel = null, logger }) {
  const store = createStateStore();
  const callModel = createMemoryExtractCaller({ ctx, officialCallModel, logger });
  const service = createMemoryService({
    store,
    config: { memory: true, memoryMax: 20, mock: false, memoryExtractTimeoutMs: 3_000 },
    logger,
    callModel,
    extractPrompt: EXTRACT_PROMPT,
  });
  return { store, callModel, service };
}

function extractMessages() {
  return [
    { role: 'user', content: '我下周要参加一场演讲，有点紧张。' },
    { role: 'assistant', content: '听起来你有些紧张，可以多练习几次。' },
  ];
}

/* ------------------------------ 纯函数：buildExtractRequest ------------------------------ */

test('buildExtractRequest：openai 协议 → /chat/completions + stream:false + Bearer 头', () => {
  const request = buildExtractRequest({
    protocol: 'openai',
    model: 'fake-model-1',
    baseUrl: OPENAI_BASE,
    prompt: '抽取 prompt',
    maxTokens: 256,
    apiKey: API_KEY,
  });
  assert.equal(request.url, `${OPENAI_BASE}/chat/completions`);
  assert.equal(request.body.model, 'fake-model-1');
  assert.equal(request.body.max_tokens, 256);
  assert.equal(request.body.stream, false);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: '抽取 prompt' }]);
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.ok(!JSON.stringify(request.headers).includes('x-api-key'));
});

test('buildExtractRequest：anthropic 协议 → /v1/messages + content block + x-api-key 头', () => {
  const request = buildExtractRequest({
    protocol: 'anthropic',
    model: 'claude-test-1',
    baseUrl: ANTHROPIC_BASE,
    prompt: '抽取 prompt',
    apiKey: API_KEY,
  });
  assert.equal(request.url, `${ANTHROPIC_BASE}/messages`);
  assert.equal(request.body.model, 'claude-test-1');
  assert.equal(request.body.max_tokens, MEMORY_EXTRACT_DEFAULT_MAX_TOKENS);
  assert.equal(request.body.stream, undefined, 'anthropic 非流式请求不带 stream 字段');
  assert.deepEqual(request.body.messages, [
    { role: 'user', content: [{ type: 'text', text: '抽取 prompt' }] },
  ]);
  assert.equal(request.headers['x-api-key'], API_KEY);
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.ok(!request.headers.authorization);
});

test('buildExtractRequest：未提供 apiKey 时只返回基础头（不泄露、不抛错）', () => {
  const request = buildExtractRequest({
    protocol: 'openai',
    model: 'fake-model-1',
    baseUrl: OPENAI_BASE,
    prompt: 'x',
  });
  assert.deepEqual(request.headers, { 'content-type': 'application/json', accept: 'application/json' });
});

/* ------------------------------ 纯函数：parseExtractResponse ------------------------------ */

test('parseExtractResponse：openai choices[0].message.content', () => {
  assert.equal(
    parseExtractResponse('openai', { choices: [{ message: { content: MEMORY_JSON } }] }),
    MEMORY_JSON,
  );
  assert.equal(parseExtractResponse('openai', { choices: [] }), '');
  assert.equal(parseExtractResponse('openai', null), '');
  assert.equal(parseExtractResponse('openai', { choices: [{ message: { content: 42 } }] }), '');
});

test('parseExtractResponse：anthropic content[] 中 text 块拼接，非 text 块忽略', () => {
  assert.equal(
    parseExtractResponse('anthropic', {
      content: [
        { type: 'thinking', thinking: 'ignore' },
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    }),
    '第一段第二段',
  );
  assert.equal(parseExtractResponse('anthropic', { content: [] }), '');
  assert.equal(parseExtractResponse('anthropic', { content: 'oops' }), '');
  assert.equal(parseExtractResponse('anthropic', null), '');
});

/* ------------------------------ extractViaByok：真实本机上游 ------------------------------ */

test('extractViaByok：openai 本机上游返回 JSON 正文（Bearer 头 + 非流式 body）', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 200, { choices: [{ message: { content: MEMORY_JSON } }] });
  });
  t.after(() => upstream.close());

  const logger = createCapturingLogger();
  const text = await extractViaByok({
    secret: {
      provider: 'openai',
      protocol: 'openai',
      model: 'fake-model-1',
      baseUrl: upstream.baseUrl,
      apiKey: API_KEY,
    },
    prompt: '抽取 prompt',
    transport: createPinnedTransport({ allowLoopback: true }),
    timeoutMs: 3_000,
    maxTokens: 256,
    logger,
  });
  assert.equal(text, MEMORY_JSON);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].method, 'POST');
  assert.equal(upstream.calls[0].url, '/v1/chat/completions');
  assert.equal(upstream.calls[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(upstream.calls[0].body.stream, false);
  assert.equal(upstream.calls[0].body.max_tokens, 256);
  assert.ok(!logger.logs.some((entry) => entry.text.includes(API_KEY)), '日志不得含明文 key');
});

test('extractViaByok：anthropic 本机上游（x-api-key 头 + content block）', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 200, { content: [{ type: 'text', text: MEMORY_JSON }] });
  });
  t.after(() => upstream.close());

  const text = await extractViaByok({
    secret: {
      provider: 'anthropic',
      protocol: 'anthropic',
      model: 'claude-test-1',
      baseUrl: upstream.baseUrl,
      apiKey: API_KEY,
    },
    prompt: '抽取 prompt',
    fetchImpl: globalThis.fetch,
  });
  assert.equal(text, MEMORY_JSON);
  assert.equal(upstream.calls[0].url, '/v1/messages');
  assert.equal(upstream.calls[0].headers['x-api-key'], API_KEY);
  assert.ok(!upstream.calls[0].headers.authorization);
  assert.equal(upstream.calls[0].body.messages[0].content[0].type, 'text');
});

test('extractViaByok：非 2xx 抛错且错误消息不含明文 key', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 500, { error: `invalid key ${API_KEY}` });
  });
  t.after(() => upstream.close());

  await assert.rejects(
    extractViaByok({
      secret: { protocol: 'openai', model: 'fake-model-1', baseUrl: upstream.baseUrl, apiKey: API_KEY },
      prompt: 'x',
      transport: createPinnedTransport({ allowLoopback: true }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.ok(!error.message.includes(API_KEY), '错误消息不得含明文 key');
      return true;
    },
  );
});

test('extractViaByok：超时（AbortSignal.timeout）抛错', async (t) => {
  const upstream = await startUpstream(
    (req, res) => jsonResponse(res, 200, { choices: [{ message: { content: '' } }] }),
    { delayMs: 500 },
  );
  t.after(() => upstream.close());
  await assert.rejects(
    extractViaByok({
      secret: { protocol: 'openai', model: 'fake-model-1', baseUrl: upstream.baseUrl, apiKey: API_KEY },
      prompt: 'x',
      transport: createPinnedTransport({ allowLoopback: true }),
      timeoutMs: 80,
    }),
    /超时/,
  );
});

test('extractViaByok：assertRequestUrl 拒绝时不发请求（ 记忆抽取路径）', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 200, { choices: [{ message: { content: MEMORY_JSON } }] });
  });
  t.after(() => upstream.close());
  await assert.rejects(
    extractViaByok({
      secret: { protocol: 'openai', model: 'fake-model-1', baseUrl: upstream.baseUrl, apiKey: API_KEY },
      prompt: 'x',
      transport: createPinnedTransport({ allowLoopback: true }),
      assertRequestUrl: async () => {
        throw new ByokError('BYOK_ENDPOINT_INVALID', '受限地址');
      },
    }),
    /受限地址/,
  );
  assert.equal(upstream.calls.length, 0, '端点被拒时不得发起出站请求');
});

/* ------------------------------ createMemoryExtractCaller + memory 集成 ------------------------------ */

test('BYOK 用户（openai）：extractAfterTurn 走用户自己的模型并落库记忆', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 200, { choices: [{ message: { content: MEMORY_JSON } }] });
  });
  t.after(() => upstream.close());

  const logger = createCapturingLogger();
  const officialCalls = [];
  const { ctx } = makeByokContext({
    protocol: 'openai',
    baseUrl: upstream.baseUrl,
    logger,
  });
  const { service, store } = makeMemoryStack({
    ctx,
    officialCallModel: async (prompt) => {
      officialCalls.push(prompt);
      return MEMORY_JSON;
    },
    logger,
  });

  const result = await service.extractAfterTurn({ conversationId: 'c1', messages: extractMessages() });
  assert.equal(upstream.calls.length, 1, '应只调用一次 BYOK 抽取上游');
  assert.equal(officialCalls.length, 0, 'BYOK 用户不得回落官方抽取');
  assert.equal(upstream.calls[0].url, '/v1/chat/completions');
  assert.equal(upstream.calls[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(upstream.calls[0].body.stream, false);
  assert.equal(upstream.calls[0].body.max_tokens, 256, 'max_tokens 沿用 MEMORY_EXTRACT_MAX_TOKENS');
  const prompt = upstream.calls[0].body.messages[0].content;
  assert.ok(prompt.includes(EXTRACT_PROMPT), '抽取 prompt 应包含配置的抽取规则');
  assert.ok(prompt.includes('演讲'), '抽取 prompt 应包含本轮对话');
  assert.equal(result.added.length, 1);
  assert.equal(store.state.length, 1);
  assert.equal(store.state[0].text, MEMORY_TEXT);
  assert.ok(!JSON.stringify(logger.logs).includes(API_KEY), '日志不得含明文 key');
});

test('BYOK 用户（anthropic）：extractAfterTurn 走 /v1/messages 并落库记忆', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 200, { content: [{ type: 'text', text: MEMORY_JSON }] });
  });
  t.after(() => upstream.close());

  const logger = createCapturingLogger();
  const { ctx } = makeByokContext({ protocol: 'anthropic', baseUrl: upstream.baseUrl, logger });
  const { service, store } = makeMemoryStack({ ctx, logger });

  const result = await service.extractAfterTurn({ conversationId: 'c1', messages: extractMessages() });
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].url, '/v1/messages');
  assert.equal(upstream.calls[0].headers['x-api-key'], API_KEY);
  assert.equal(result.added.length, 1);
  assert.equal(store.state[0].text, MEMORY_TEXT);
});

test('BYOK 抽取失败（HTTP 500）：仅 warn 跳过、不回落官方、不落库', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 500, { error: 'boom' });
  });
  t.after(() => upstream.close());

  const logger = createCapturingLogger();
  const officialCalls = [];
  const { ctx } = makeByokContext({ protocol: 'openai', baseUrl: upstream.baseUrl, logger });
  const { service, store } = makeMemoryStack({
    ctx,
    officialCallModel: async (prompt) => {
      officialCalls.push(prompt);
      return MEMORY_JSON;
    },
    logger,
  });

  const result = await service.extractAfterTurn({ conversationId: 'c1', messages: extractMessages() });
  assert.equal(result.added.length, 0);
  assert.equal(store.state.length, 0);
  assert.equal(officialCalls.length, 0, '失败不得静默回落官方模型');
  assert.ok(
    logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('抽取失败')),
    '应有 warn 跳过日志',
  );
  assert.ok(!JSON.stringify(logger.logs).includes(API_KEY), '日志不得含明文 key');
});

test('BYOK 抽取响应结构不符：按空处理（不抛错、不落库）', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 200, { unexpected: true });
  });
  t.after(() => upstream.close());

  const logger = createCapturingLogger();
  const { ctx } = makeByokContext({ protocol: 'openai', baseUrl: upstream.baseUrl, logger });
  const { service, store } = makeMemoryStack({ ctx, logger });

  const result = await service.extractAfterTurn({ conversationId: 'c1', messages: extractMessages() });
  assert.equal(result.added.length, 0);
  assert.equal(store.state.length, 0);
});

test('官方用户：走 officialCallModel，不请求 BYOK 上游（官方路径零变化）', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 200, { choices: [{ message: { content: MEMORY_JSON } }] });
  });
  t.after(() => upstream.close());

  const logger = createCapturingLogger();
  const officialCalls = [];
  const { ctx } = makeByokContext({ protocol: 'openai', baseUrl: upstream.baseUrl, logger });
  ctx.user = { id: USER_ID, modelSource: 'official', status: 'active' };
  const { service, store } = makeMemoryStack({
    ctx,
    officialCallModel: async (prompt) => {
      officialCalls.push(prompt);
      return MEMORY_JSON;
    },
    logger,
  });

  const result = await service.extractAfterTurn({ conversationId: 'c1', messages: extractMessages() });
  assert.equal(upstream.calls.length, 0, '官方用户不得请求 BYOK 上游');
  assert.equal(officialCalls.length, 1);
  assert.equal(result.added.length, 1);
  assert.equal(store.state[0].text, MEMORY_TEXT);
});

test('官方用户且 officialCallModel 缺失：抛错（memory 层 warn 跳过，与现状一致）', async () => {
  const logger = createCapturingLogger();
  const { ctx } = makeByokContext({ protocol: 'openai', baseUrl: OPENAI_BASE, logger });
  ctx.user = { id: USER_ID, modelSource: 'official', status: 'active' };
  const callModel = createMemoryExtractCaller({ ctx, officialCallModel: null, logger });
  await assert.rejects(callModel('probe'), /未配置抽取模型调用/);
});

test('BYOK 用户：assertRequestUrl 拒绝（rebinding）→ 记忆抽取被拒、无出站请求、不回落官方', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 200, { choices: [{ message: { content: MEMORY_JSON } }] });
  });
  t.after(() => upstream.close());

  const logger = createCapturingLogger();
  const officialCalls = [];
  const { ctx } = makeByokContext({
    protocol: 'openai',
    baseUrl: upstream.baseUrl,
    logger,
    assertRequestUrlImpl: async () => {
      throw new ByokError('BYOK_ENDPOINT_INVALID', '自定义模型端点解析到受限地址（已拒绝）');
    },
  });
  const { service, store } = makeMemoryStack({
    ctx,
    officialCallModel: async (prompt) => {
      officialCalls.push(prompt);
      return MEMORY_JSON;
    },
    logger,
  });

  const result = await service.extractAfterTurn({ conversationId: 'c1', messages: extractMessages() });
  assert.equal(result.added.length, 0);
  assert.equal(store.state.length, 0);
  assert.equal(upstream.calls.length, 0, 'DNS 重校验失败时不得发起 fetch');
  assert.equal(officialCalls.length, 0, '不得回落官方模型');
  assert.ok(logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('受限地址')));
});

test('BYOK 用户：chat mock 模式不触发模型抽取 caller（mock 分支优先级）', async () => {
  const logger = createCapturingLogger();
  const { ctx } = makeByokContext({ protocol: 'openai', baseUrl: OPENAI_BASE, logger });
  ctx.config.mock = true;
  const store = createStateStore();
  const calls = [];
  const callModel = createMemoryExtractCaller({
    ctx,
    officialCallModel: async () => {
      calls.push('official');
      return MEMORY_JSON;
    },
    logger,
  });
  const service = createMemoryService({
    store,
    config: { memory: true, memoryMax: 20, mock: true, memoryExtractTimeoutMs: 1_000 },
    logger,
    callModel,
    extractPrompt: EXTRACT_PROMPT,
  });
  const result = await service.extractAfterTurn({
    conversationId: 'c1',
    messages: [{ role: 'user', content: '记住：我下周要参加演讲' }],
  });
  assert.ok(result);
  assert.equal(calls.length, 0, 'mock 分支不应调用任何真实抽取模型');
});

test('BYOK 用户：按最新用户记录判定 modelSource（缓存快照过期时不误走官方）', async (t) => {
  const upstream = await startUpstream((req, res) => {
    jsonResponse(res, 200, { choices: [{ message: { content: MEMORY_JSON } }] });
  });
  t.after(() => upstream.close());

  const logger = createCapturingLogger();
  const officialCalls = [];
  // 闭包快照仍是 official（scoped ctx 首次创建时的 user），但 users.json 最新记录已是 byok。
  const { ctx } = makeByokContext({ protocol: 'openai', baseUrl: upstream.baseUrl, logger });
  ctx.user = { id: USER_ID, modelSource: 'official', status: 'active' };
  let latestUser = { id: USER_ID, modelSource: 'byok', status: 'active' };
  ctx.users = { get: async () => latestUser };
  const { service, store } = makeMemoryStack({
    ctx,
    officialCallModel: async (prompt) => {
      officialCalls.push(prompt);
      return MEMORY_JSON;
    },
    logger,
  });

  const result = await service.extractAfterTurn({ conversationId: 'c1', messages: extractMessages() });
  assert.equal(upstream.calls.length, 1, '应按最新 modelSource=byok 走用户自己的模型');
  assert.equal(officialCalls.length, 0, '不得因缓存快照过期而误走官方模型');
  assert.equal(result.added.length, 1);
  assert.equal(store.state[0].text, MEMORY_TEXT);

  // 反向：闭包快照 byok、最新记录 official → 走官方模型、不再请求 BYOK 上游。
  ctx.user = { id: USER_ID, modelSource: 'byok', status: 'active' };
  latestUser = { id: USER_ID, modelSource: 'official', status: 'active' };
  const reverseStore = createStateStore();
  const reverseService = createMemoryService({
    store: reverseStore,
    config: { memory: true, memoryMax: 20, mock: false, memoryExtractTimeoutMs: 3_000 },
    logger,
    callModel: createMemoryExtractCaller({
      ctx,
      officialCallModel: async (prompt) => {
        officialCalls.push(prompt);
        return MEMORY_JSON;
      },
      logger,
    }),
    extractPrompt: EXTRACT_PROMPT,
  });
  const reverseResult = await reverseService.extractAfterTurn({
    conversationId: 'c2',
    messages: extractMessages(),
  });
  assert.equal(upstream.calls.length, 1, '最新 official 时不得再请求 BYOK 上游');
  assert.equal(officialCalls.length, 1);
  assert.equal(reverseResult.added.length, 1);
});
