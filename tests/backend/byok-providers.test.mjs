// server/byok-providers.mjs 纯函数单元测试（离线、零依赖、不联网、不 sleep）。
// 覆盖契约 3 冻结签名：预设/厂商解析、鉴权头、两族请求体、URL 构造、流式事件解析、
// usage 提取（OpenAI 命中/未命中不双算、Anthropic 最终口径）、模型列表解析与 ByokError。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BYOK_PROTOCOLS,
  BYOK_PRESETS,
  BYOK_ANTHROPIC_VERSION,
  MODEL_PATTERN,
  ByokError,
  normalizeProvider,
  resolveProvider,
  buildHeaders,
  buildRequestBody,
  buildChatUrl,
  listModelsUrl,
  parseStreamEvent,
  extractUsage,
  parseModels,
} from '../../server/byok-providers.mjs';

// ---------------------------------------------------------------------------
// 常量 / 预设（契约 3 字面量）
// ---------------------------------------------------------------------------

test('常量：BYOK_PROTOCOLS 与契约一致且冻结', () => {
  assert.deepEqual([...BYOK_PROTOCOLS], ['anthropic', 'openai']);
  assert.equal(Object.isFrozen(BYOK_PROTOCOLS), true);
  assert.equal(BYOK_ANTHROPIC_VERSION, '2023-06-01');
});

test('BYOK_PRESETS：六项预设的 id/label/protocol/baseUrl/modelHint 与契约一致', () => {
  assert.equal(BYOK_PRESETS.length, 6);
  assert.equal(Object.isFrozen(BYOK_PRESETS), true);
  assert.ok(BYOK_PRESETS.every((preset) => Object.isFrozen(preset)));
  assert.deepEqual(
    BYOK_PRESETS.map((preset) => [preset.id, preset.label, preset.protocol, preset.baseUrl, preset.modelHint]),
    [
      ['deepseek', 'DeepSeek', 'openai', 'https://api.deepseek.com/v1', 'deepseek-chat'],
      ['openai', 'OpenAI（ChatGPT）', 'openai', 'https://api.openai.com/v1', 'gpt-4o-mini'],
      ['moonshot', 'Kimi（月之暗面）', 'openai', 'https://api.moonshot.cn/v1', 'moonshot-v1-8k'],
      ['qwen', '通义千问（DashScope）', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
      ['anthropic', 'Anthropic Claude', 'anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-5'],
      ['custom', '自定义（OpenAI 兼容）', 'openai', null, undefined],
    ],
  );
  const custom = BYOK_PRESETS.find((preset) => preset.id === 'custom');
  assert.equal(custom.requiresBaseUrl, true);
  assert.equal(BYOK_PRESETS.filter((preset) => preset.id !== 'custom').every((preset) => !preset.requiresBaseUrl), true);
});

test('MODEL_PATTERN：合法模型名通过、非法字符/超长/首字符非字母数字拒绝', () => {
  for (const model of ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini', 'claude-sonnet-4-5', 'qwen-plus', 'a', 'a'.repeat(128)]) {
    assert.equal(MODEL_PATTERN.test(model), true, `应通过：${model}`);
  }
  for (const model of ['', '-gpt', '.gpt', '_gpt', 'gpt 4o', '模型名', 'a'.repeat(129), '/v1/models']) {
    assert.equal(MODEL_PATTERN.test(model), false, `应拒绝：${JSON.stringify(model)}`);
  }
});

test('ByokError：code/message/status/name 与默认值', () => {
  const error = new ByokError('INVALID_MODEL', '模型名不合法', { status: 400 });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ByokError');
  assert.equal(error.code, 'INVALID_MODEL');
  assert.equal(error.message, '模型名不合法');
  assert.equal(error.status, 400);

  const defaults = new ByokError('BYOK_CHECK_FAILED', '探活失败');
  assert.equal(defaults.status, 0);
  assert.equal(new ByokError('', 'x').code, 'BYOK_CHECK_FAILED');
});

test('normalizeProvider：trim/截断 64、非字符串或空串 → null', () => {
  assert.equal(normalizeProvider('  openai  '), 'openai');
  assert.equal(normalizeProvider('p'.repeat(100)), 'p'.repeat(64));
  assert.equal(normalizeProvider(''), null);
  assert.equal(normalizeProvider('   '), null);
  assert.equal(normalizeProvider(42), null);
  assert.equal(normalizeProvider(null), null);
  assert.equal(normalizeProvider(undefined), null);
});

// ---------------------------------------------------------------------------
// resolveProvider
// ---------------------------------------------------------------------------

test('resolveProvider：固定预设使用预设 baseUrl，requiresBaseUrl=false', () => {
  assert.deepEqual(resolveProvider({ provider: 'deepseek' }), {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresBaseUrl: false,
  });
  assert.deepEqual(resolveProvider({ provider: 'anthropic' }), {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresBaseUrl: false,
  });
  // 固定预设忽略传入的 baseUrl（防越权改写官方厂商端点）。
  assert.equal(resolveProvider({ provider: 'openai', baseUrl: 'https://evil.example/v1' }).baseUrl, 'https://api.openai.com/v1');
});

test('resolveProvider：custom 使用传入 baseUrl（去尾斜杠）且 requiresBaseUrl=true', () => {
  assert.deepEqual(resolveProvider({ provider: 'custom', baseUrl: '  http://127.0.0.1:9988/v1/  ' }), {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:9988/v1',
    requiresBaseUrl: true,
  });
});

test('resolveProvider：未知厂商 → INVALID_PROVIDER；custom 缺/非法 baseUrl → BYOK_URL_INVALID', () => {
  for (const provider of ['unknown', 'DEEPSEEK', '', null, undefined, 42]) {
    assert.throws(
      () => resolveProvider({ provider }),
      (error) => error instanceof ByokError && error.code === 'INVALID_PROVIDER',
      `provider=${JSON.stringify(provider)}`,
    );
  }
  for (const baseUrl of [undefined, null, '', '   ', 'not-a-url', 'ftp://example.com/v1', 'https://example.com/v1?x=1', 'https://example.com/v1#frag']) {
    assert.throws(
      () => resolveProvider({ provider: 'custom', baseUrl }),
      (error) => error instanceof ByokError && error.code === 'BYOK_URL_INVALID',
      `baseUrl=${JSON.stringify(baseUrl)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// buildHeaders
// ---------------------------------------------------------------------------

test('buildHeaders：openai → Bearer；anthropic → x-api-key + anthropic-version（只返回鉴权头）', () => {
  assert.deepEqual(buildHeaders('openai', 'test-key-test-A1b2'), { authorization: 'Bearer test-key-test-A1b2' });
  assert.deepEqual(buildHeaders('anthropic', 'test-key-ant-test'), {
    'x-api-key': 'test-key-ant-test',
    'anthropic-version': '2023-06-01',
  });
  // 契约只要求鉴权头；content-type/accept 由 byok-upstream 自补（避免两边重复/冲突）。
  const headers = buildHeaders('openai', 'test-key-test');
  assert.equal(Object.hasOwn(headers, 'content-type'), false);
  assert.equal(Object.hasOwn(headers, 'accept'), false);
});

test('buildHeaders：非法协议 → INVALID_PROVIDER；空/非字符串 key → BYOK_KEY_INVALID', () => {
  assert.throws(
    () => buildHeaders('gemini', 'test-key-test'),
    (error) => error instanceof ByokError && error.code === 'INVALID_PROVIDER',
  );
  for (const key of ['', '   ', null, undefined, 42]) {
    assert.throws(
      () => buildHeaders('openai', key),
      (error) => error instanceof ByokError && error.code === 'BYOK_KEY_INVALID',
      `key=${JSON.stringify(key)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// buildRequestBody
// ---------------------------------------------------------------------------

test('buildRequestBody（openai）：system 首条消息 + stream:true + stream_options.include_usage + max_tokens', () => {
  const body = buildRequestBody({
    protocol: 'openai',
    model: 'deepseek-chat',
    system: 'SYS',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，我在。' },
      { role: 'user', content: '继续' },
    ],
    maxTokens: 256,
  });
  assert.deepEqual(body, {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，我在。' },
      { role: 'user', content: '继续' },
    ],
    max_tokens: 256,
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('buildRequestBody（openai）：content 支持 [{type:"text",text}]（historyToMessages 产出）并归一为字符串', () => {
  const body = buildRequestBody({
    protocol: 'openai',
    model: 'moonshot-v1-8k',
    messages: [
      { role: 'user', content: '普通字符串' },
      { role: 'assistant', content: [{ type: 'text', text: '块一' }, { type: 'text', text: '块二' }] },
    ],
  });
  assert.deepEqual(body.messages, [
    { role: 'user', content: '普通字符串' },
    { role: 'assistant', content: '块一\n块二' },
  ]);
  // maxTokens 缺省兜底 1024；无 system 时不插 system 消息。
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.messages.some((message) => message.role === 'system'), false);
});

test('buildRequestBody（anthropic）：顶层 system + messages content 为 [{type:"text",text}]，无 stream_options', () => {
  const body = buildRequestBody({
    protocol: 'anthropic',
    model: 'claude-sonnet-4-5',
    system: '你是安全的',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    maxTokens: 512,
  });
  assert.deepEqual(body, {
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    system: '你是安全的',
  });
  assert.equal(Object.hasOwn(body, 'stream_options'), false);
  // 空 system 不带字段（Anthropic 空 system 无意义）。
  const noSystem = buildRequestBody({ protocol: 'anthropic', model: 'claude-sonnet-4-5', messages: [] });
  assert.equal(Object.hasOwn(noSystem, 'system'), false);
  assert.deepEqual(noSystem.messages, []);
});

test('buildRequestBody：maxTokens 取整/兜底；非法模型 → INVALID_MODEL；非法协议 → INVALID_PROVIDER', () => {
  const floored = buildRequestBody({
    protocol: 'openai',
    model: 'gpt-4o-mini',
    messages: [],
    maxTokens: 100.9,
  });
  assert.equal(floored.max_tokens, 100);
  assert.equal(buildRequestBody({ protocol: 'openai', model: 'gpt-4o-mini', messages: [], maxTokens: 0 }).max_tokens, 1024);
  assert.equal(buildRequestBody({ protocol: 'openai', model: 'gpt-4o-mini', messages: [], maxTokens: -5 }).max_tokens, 1024);

  // 模型名两端空白会被 trim 归一（与 byok.mjs 落库清洗一致）。
  assert.equal(buildRequestBody({ protocol: 'openai', model: '  gpt-4o-mini  ', messages: [] }).model, 'gpt-4o-mini');
  for (const model of ['', 'gpt 4o', '模型', '-bad']) {
    assert.throws(
      () => buildRequestBody({ protocol: 'openai', model, messages: [] }),
      (error) => error instanceof ByokError && error.code === 'INVALID_MODEL',
      `model=${JSON.stringify(model)}`,
    );
  }
  assert.throws(
    () => buildRequestBody({ protocol: 'gemini', model: 'gpt-4o-mini', messages: [] }),
    (error) => error instanceof ByokError && error.code === 'INVALID_PROVIDER',
  );
});

// ---------------------------------------------------------------------------
// URL 构造
// ---------------------------------------------------------------------------

test('buildChatUrl：openai → <base>/chat/completions；anthropic → <base>/v1/messages（v1 去重）', () => {
  assert.equal(buildChatUrl('openai', 'https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(buildChatUrl('openai', 'https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(
    buildChatUrl('openai', 'http://127.0.0.1:9988/v1'),
    'http://127.0.0.1:9988/v1/chat/completions',
  );
  assert.equal(buildChatUrl('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.equal(buildChatUrl('anthropic', 'https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages');
  assert.equal(buildChatUrl('anthropic', 'https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1/messages');
});

test('listModelsUrl：openai → <base>/models；anthropic → <base>/v1/models（v1 去重）', () => {
  assert.equal(listModelsUrl('openai', 'https://api.openai.com/v1'), 'https://api.openai.com/v1/models');
  assert.equal(listModelsUrl('openai', 'https://api.openai.com/v1/'), 'https://api.openai.com/v1/models');
  assert.equal(listModelsUrl('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/models');
  assert.equal(listModelsUrl('anthropic', 'https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1/models');
});

test('buildChatUrl/listModelsUrl：非法 baseUrl → BYOK_URL_INVALID；非法协议 → INVALID_PROVIDER', () => {
  for (const baseUrl of [undefined, null, '', 'not-a-url', 'ftp://example.com', 'https://x.example/v1?q=1']) {
    assert.throws(
      () => buildChatUrl('openai', baseUrl),
      (error) => error instanceof ByokError && error.code === 'BYOK_URL_INVALID',
      `baseUrl=${JSON.stringify(baseUrl)}`,
    );
    assert.throws(
      () => listModelsUrl('openai', baseUrl),
      (error) => error instanceof ByokError && error.code === 'BYOK_URL_INVALID',
    );
  }
  assert.throws(
    () => buildChatUrl('gemini', 'https://example.com'),
    (error) => error instanceof ByokError && error.code === 'INVALID_PROVIDER',
  );
});

// ---------------------------------------------------------------------------
// parseStreamEvent：OpenAI 兼容流
// ---------------------------------------------------------------------------

test('parseStreamEvent（openai）：content → text；reasoning_content → thinking；finish_reason → done', () => {
  assert.deepEqual(parseStreamEvent('openai', { choices: [{ delta: { content: '你好' } }] }), {
    type: 'text',
    text: '你好',
  });
  assert.deepEqual(parseStreamEvent('openai', { choices: [{ delta: { reasoning_content: '想一想' } }] }), {
    type: 'thinking',
    text: '想一想',
  });
  // 同帧 thinking 优先于 content（推理先于正文）。
  assert.deepEqual(
    parseStreamEvent('openai', { choices: [{ delta: { reasoning_content: '想', content: '答' } }] }),
    { type: 'thinking', text: '想' },
  );
  assert.deepEqual(parseStreamEvent('openai', { choices: [{ delta: {}, finish_reason: 'stop' }] }), { type: 'done' });
  // 空 delta / finish_reason=null / 空 choices → ignore。
  assert.deepEqual(parseStreamEvent('openai', { choices: [{ delta: {} }] }), { type: 'ignore' });
  assert.deepEqual(parseStreamEvent('openai', { choices: [] }), { type: 'ignore' });
  assert.deepEqual(parseStreamEvent('openai', { choices: [{ delta: { content: '' } }] }), { type: 'ignore' });
});

test('parseStreamEvent（openai）：usage 帧与 [DONE]；末帧 finish_reason+usage 同时返回 done+usage', () => {
  const usage = { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } };
  assert.deepEqual(parseStreamEvent('openai', { choices: [], usage }), {
    type: 'usage',
    usage: { inputTokens: 7, outputTokens: 4, cacheReadInputTokens: 3 },
  });
  // DeepSeek 等实现把 usage 搭载在最后内容 chunk（finish_reason 同帧）：done 必须携带 usage。
  assert.deepEqual(parseStreamEvent('openai', { choices: [{ delta: {}, finish_reason: 'stop' }], usage }), {
    type: 'done',
    usage: { inputTokens: 7, outputTokens: 4, cacheReadInputTokens: 3 },
  });
  assert.deepEqual(parseStreamEvent('openai', '[DONE]'), { type: 'done' });
  // 已是 JSON 字符串的帧也接受。
  assert.deepEqual(parseStreamEvent('openai', JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })), {
    type: 'text',
    text: 'ok',
  });
  // 上游 error 帧交给 byok-upstream 检查原始帧；解析层 ignore，不 throw。
  assert.deepEqual(parseStreamEvent('openai', { error: { message: 'bad key' } }), { type: 'ignore' });
  assert.deepEqual(parseStreamEvent('openai', 'not-json'), { type: 'ignore' });
  assert.deepEqual(parseStreamEvent('openai', null), { type: 'ignore' });
});

// ---------------------------------------------------------------------------
// parseStreamEvent：Anthropic 流
// ---------------------------------------------------------------------------

test('parseStreamEvent（anthropic）：message_start/message_delta → usage；text/thinking delta；message_stop → done', () => {
  assert.deepEqual(
    parseStreamEvent('anthropic', {
      type: 'message_start',
      message: { usage: { input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 0 } },
    }),
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 2 } },
  );
  assert.deepEqual(
    parseStreamEvent('anthropic', { type: 'message_delta', usage: { output_tokens: 9 } }),
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 9, cacheReadInputTokens: 0 } },
  );
  assert.deepEqual(
    parseStreamEvent('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } }),
    { type: 'text', text: '你' },
  );
  assert.deepEqual(
    parseStreamEvent('anthropic', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '嗯' } }),
    { type: 'thinking', text: '嗯' },
  );
  assert.deepEqual(parseStreamEvent('anthropic', { type: 'message_stop' }), { type: 'done' });
  // ping / error / 未知事件 → ignore（不 throw，错误由 byok-upstream 归一）。
  assert.deepEqual(parseStreamEvent('anthropic', { type: 'ping' }), { type: 'ignore' });
  assert.deepEqual(parseStreamEvent('anthropic', { type: 'error', error: { type: 'overloaded_error' } }), { type: 'ignore' });
  assert.deepEqual(parseStreamEvent('anthropic', { type: 'content_block_stop' }), { type: 'ignore' });
});

test('parseStreamEvent：非法协议 → INVALID_PROVIDER', () => {
  assert.throws(
    () => parseStreamEvent('gemini', { choices: [] }),
    (error) => error instanceof ByokError && error.code === 'INVALID_PROVIDER',
  );
});

// ---------------------------------------------------------------------------
// extractUsage
// ---------------------------------------------------------------------------

test('extractUsage（openai）：inputTokens = prompt_tokens - cached，不重复计 cacheRead', () => {
  const usage = extractUsage('openai', {
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
  });
  assert.deepEqual(usage, { inputTokens: 70, outputTokens: 20, cacheReadInputTokens: 30 });
  // 总 token 不变：input + cacheRead + output === prompt_tokens + completion_tokens（无双算）。
  assert.equal(usage.inputTokens + usage.cacheReadInputTokens + usage.outputTokens, 100 + 20);
});

test('extractUsage（openai）：无缓存字段/命中率 0；prompt_cache_hit_tokens 与 miss 字段兼容；无 usage → null', () => {
  assert.deepEqual(extractUsage('openai', { usage: { prompt_tokens: 8, completion_tokens: 3 } }), {
    inputTokens: 8,
    outputTokens: 3,
    cacheReadInputTokens: 0,
  });
  assert.deepEqual(
    extractUsage('openai', { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 4 } }),
    { inputTokens: 6, outputTokens: 1, cacheReadInputTokens: 4 },
  );
  assert.deepEqual(
    extractUsage('openai', { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_miss_tokens: 6, prompt_cache_hit_tokens: 4 } }),
    { inputTokens: 6, outputTokens: 1, cacheReadInputTokens: 4 },
  );
  // 直接传 usage 对象也可（方便非流式/单测）。
  assert.deepEqual(extractUsage('openai', { prompt_tokens: 5, completion_tokens: 2 }), {
    inputTokens: 5,
    outputTokens: 2,
    cacheReadInputTokens: 0,
  });
  assert.equal(extractUsage('openai', {}), null);
  assert.equal(extractUsage('openai', { usage: {} }), null);
  assert.equal(extractUsage('openai', null), null);
});

test('extractUsage（anthropic）：input_tokens 为未命中口径、cache_read 单列、cached 不重复相加', () => {
  assert.deepEqual(
    extractUsage('anthropic', {
      message: { usage: { input_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 3 } },
    }),
    { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 },
  );
  // 最终 message_delta.usage 口径（只带 output_tokens 时其它字段为 0，由消费方取最新覆盖）。
  assert.deepEqual(extractUsage('anthropic', { usage: { output_tokens: 7 } }), {
    inputTokens: 0,
    outputTokens: 7,
    cacheReadInputTokens: 0,
  });
  assert.deepEqual(extractUsage('anthropic', { input_tokens: 4, output_tokens: 2 }), {
    inputTokens: 4,
    outputTokens: 2,
    cacheReadInputTokens: 0,
  });
  assert.equal(extractUsage('anthropic', {}), null);
  assert.equal(extractUsage('anthropic', { usage: {} }), null);
});

test('extractUsage：非法协议 → INVALID_PROVIDER', () => {
  assert.throws(
    () => extractUsage('gemini', {}),
    (error) => error instanceof ByokError && error.code === 'INVALID_PROVIDER',
  );
});

// ---------------------------------------------------------------------------
// parseModels
// ---------------------------------------------------------------------------

test('parseModels：openai data[].id（有 name 时保留）；anthropic 用 display_name 作 name', () => {
  const openai = parseModels('openai', {
    data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o', name: 'GPT-4o' }, null, { id: '' }],
  });
  assert.deepEqual(openai, [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o', name: 'GPT-4o' }]);

  const anthropic = parseModels('anthropic', {
    data: [
      { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5', display_name: '' },
    ],
  });
  assert.deepEqual(anthropic, [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }, { id: 'claude-haiku-4-5' }]);
});

test('parseModels：异常输入/非法协议 → []（不 throw）', () => {
  assert.deepEqual(parseModels('openai', null), []);
  assert.deepEqual(parseModels('openai', {}), []);
  assert.deepEqual(parseModels('openai', { data: 'nope' }), []);
  assert.deepEqual(parseModels('openai', { data: [{}] }), []);
  assert.deepEqual(parseModels('gemini', { data: [{ id: 'x' }] }), []);
});

// ---------------------------------------------------------------------------
// 契约映射不变量
// ---------------------------------------------------------------------------

test('两族 usage 映射：总量口径与本仓 normalizeUsage 对齐（四字段、不双算）', () => {
  const openaiUsage = extractUsage('openai', {
    usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } },
  });
  const anthropicUsage = extractUsage('anthropic', {
    usage: { input_tokens: 400, cache_read_input_tokens: 600, cache_creation_input_tokens: 0, output_tokens: 200 },
  });
  // 同一逻辑请求在两族协议下映射后的总量应当一致。
  for (const usage of [openaiUsage, anthropicUsage]) {
    assert.deepEqual(Object.keys(usage).sort(), ['cacheReadInputTokens', 'inputTokens', 'outputTokens']);
    assert.equal(usage.inputTokens + usage.cacheReadInputTokens + usage.outputTokens, 1200);
    assert.ok(usage.inputTokens >= 0 && usage.outputTokens >= 0 && usage.cacheReadInputTokens >= 0);
  }
});
