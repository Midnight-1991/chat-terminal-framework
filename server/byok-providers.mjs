// BYOK 多厂商协议纯函数。
//
// 事实口径（docs/briefs/m42-interface-contract.md 3 冻结签名；
// reviews/m40-metering-byok-research.md 1.2/1.3/1.4 的 A 级核验结论）：
// - 两族协议：openai（OpenAI 兼容：DeepSeek/OpenAI/Kimi/Qwen/自定义）与 anthropic；
// - openai 流式：请求体必须 stream:true + stream_options:{include_usage:true}，以 `[DONE]` 结束；
//   usage 映射 inputTokens = prompt_tokens - cached（或 prompt_cache_miss_tokens）、
//   cacheReadInputTokens = prompt_tokens_details.cached_tokens、outputTokens = completion_tokens；
// - anthropic 流式：以 message_start/content_block_delta/message_delta/message_stop 事件组织，
//   usage 口径：input_tokens（未命中，不含 cache）、cache_read_input_tokens（命中）、output_tokens；
//   最终 message_delta.usage 为唯一口径（不与 message_start 相加）；
// - 请求体 messages 兼容字符串与 [{type:'text',text}] 两种 content（historyToMessages 产出后者）。
//
// 边界：本模块是纯函数集合，零网络、零 I/O、不读取环境变量；key 只拼进鉴权头，绝不记录。
// 注意：buildHeaders 按契约只返回鉴权头（content-type / accept 由 byok-upstream 自补）。

/** 支持的协议族（契约冻结）。 */
export const BYOK_PROTOCOLS = Object.freeze(['anthropic', 'openai']);

/** Anthropic 协议版本（与 server/upstream.mjs 官方路径保持一致）。 */
export const BYOK_ANTHROPIC_VERSION = '2023-06-01';

/** 模型名白名单正则（契约冻结）：首字符字母/数字，其余字母/数字/._:/-，最长 128。 */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;

/** 未显式给 maxTokens 时的兜底值。 */
const DEFAULT_MAX_TOKENS = 1024;

/** provider id 落库时的最大长度（清洗用，非契约限制）。 */
const MAX_PROVIDER_CHARS = 64;

/**
 * BYOK 预设（契约 3 冻结；id/label/protocol/baseUrl/modelHint 顺序与字面量一致）。
 * custom 的 baseUrl 由用户填写（requiresBaseUrl:true）。
 */
export const BYOK_PRESETS = Object.freeze(
  [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      modelHint: 'deepseek-chat',
    },
    {
      id: 'openai',
      label: 'OpenAI（ChatGPT）',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelHint: 'gpt-4o-mini',
    },
    {
      id: 'moonshot',
      label: 'Kimi（月之暗面）',
      protocol: 'openai',
      baseUrl: 'https://api.moonshot.cn/v1',
      modelHint: 'moonshot-v1-8k',
    },
    {
      id: 'qwen',
      label: '通义千问（DashScope）',
      protocol: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelHint: 'qwen-plus',
    },
    {
      id: 'anthropic',
      label: 'Anthropic Claude',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      modelHint: 'claude-sonnet-4-5',
    },
    {
      id: 'custom',
      label: '自定义（OpenAI 兼容）',
      protocol: 'openai',
      baseUrl: null,
      requiresBaseUrl: true,
    },
  ].map((preset) => Object.freeze(preset)),
);

/**
 * BYOK 统一错误。code 取值（契约 3/4/5）：
 * INVALID_PROVIDER / INVALID_MODEL / BYOK_URL_INVALID / BYOK_KEY_INVALID / BYOK_CHECK_FAILED
 * （上游探活/流式错误另由 byok.mjs / byok-upstream.mjs 归一为 BYOK_ENDPOINT_INVALID / BYOK_TIMEOUT 等）。
 */
export class ByokError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?:number}} [options]
   */
  constructor(code, message, { status = 0 } = {}) {
    super(typeof message === 'string' ? message : String(message));
    this.name = 'ByokError';
    this.code = typeof code === 'string' && code.length > 0 ? code : 'BYOK_CHECK_FAILED';
    this.status = Number.isInteger(status) && status > 0 ? status : 0;
  }
}

function assertProtocol(protocol) {
  if (!BYOK_PROTOCOLS.includes(protocol)) {
    throw new ByokError('INVALID_PROVIDER', `不支持的厂商协议：${String(protocol).slice(0, 32)}`, { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// 内部工具：URL / 消息内容归一化
// ---------------------------------------------------------------------------

/** 校验并返回去尾斜杠的 Base URL；非法 → ByokError('BYOK_URL_INVALID')。 */
function normalizeBaseUrl(baseUrl) {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!raw) throw new ByokError('BYOK_URL_INVALID', 'Base URL 缺失', { status: 400 });
  const stripped = raw.replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(stripped);
  } catch {
    throw new ByokError('BYOK_URL_INVALID', 'Base URL 不是合法 URL', { status: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ByokError('BYOK_URL_INVALID', 'Base URL 仅支持 http/https', { status: 400 });
  }
  if (!parsed.hostname) throw new ByokError('BYOK_URL_INVALID', 'Base URL 缺少主机名', { status: 400 });
  if (parsed.search || parsed.hash) {
    throw new ByokError('BYOK_URL_INVALID', 'Base URL 不允许携带查询串或锚点', { status: 400 });
  }
  return stripped;
}

/** content 归一化为纯文本：支持 string / [{type:'text',text}] / {text}。 */
function contentTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** messages 归一化：role 只保留 assistant，其余按 user；空文本消息丢弃。 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const normalized = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const text = contentTextOf(message.content);
    if (!text) continue;
    normalized.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  return normalized;
}

function normalizeMaxTokens(maxTokens) {
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens >= 1) {
    return Math.trunc(maxTokens);
  }
  return DEFAULT_MAX_TOKENS;
}

function toNonNegativeInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function intOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/**
 * 清洗 provider id（落库用）：非字符串 → null；trim 后截断 64 字符；空串 → null。
 * @param {unknown} provider
 * @returns {string|null}
 */
export function normalizeProvider(provider) {
  if (typeof provider !== 'string') return null;
  const trimmed = provider.trim().slice(0, MAX_PROVIDER_CHARS);
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// 厂商解析
// ---------------------------------------------------------------------------

/**
 * 解析厂商配置：固定预设用预设 baseUrl；custom 用传入 baseUrl（必填）。
 * @param {{provider?:string, baseUrl?:string|null}} [options]
 * @returns {{id:string,label:string,protocol:'openai'|'anthropic',baseUrl:string,requiresBaseUrl:boolean}}
 */
export function resolveProvider({ provider, baseUrl } = {}) {
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    throw new ByokError('INVALID_PROVIDER', '未选择厂商', { status: 400 });
  }
  const id = provider.trim();
  const preset = BYOK_PRESETS.find((item) => item.id === id);
  if (!preset) {
    throw new ByokError('INVALID_PROVIDER', `未知的厂商：${id.slice(0, 64)}`, { status: 400 });
  }
  if (preset.requiresBaseUrl === true) {
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
      throw new ByokError('BYOK_URL_INVALID', '自定义厂商必须提供 Base URL', { status: 400 });
    }
    // 只做 URL 形状校验（SSRF/回环等策略由 server/byok.mjs 负责）。
    const normalized = normalizeBaseUrl(baseUrl);
    return {
      id: preset.id,
      label: preset.label,
      protocol: preset.protocol,
      baseUrl: normalized,
      requiresBaseUrl: true,
    };
  }
  return {
    id: preset.id,
    label: preset.label,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    requiresBaseUrl: false,
  };
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/**
 * 鉴权头（契约 3）：openai → Bearer；anthropic → x-api-key + anthropic-version。
 * 只返回鉴权头，content-type / accept 由调用方补。
 * @param {'openai'|'anthropic'} protocol
 * @param {string} apiKey
 * @returns {Record<string,string>}
 */
export function buildHeaders(protocol, apiKey) {
  assertProtocol(protocol);
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new ByokError('BYOK_KEY_INVALID', '缺少 API Key', { status: 400 });
  }
  if (protocol === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': BYOK_ANTHROPIC_VERSION };
  }
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * 流式请求体（契约 3）：
 * - openai：messages 首条为 system（若有），stream:true + stream_options.include_usage:true；
 * - anthropic：顶层 system 字段 + messages content 为 [{type:'text',text}]。
 */
export function buildRequestBody({ protocol, model, system = '', messages = [], maxTokens } = {}) {
  assertProtocol(protocol);
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!MODEL_PATTERN.test(normalizedModel)) {
    throw new ByokError('INVALID_MODEL', `模型名不合法：${normalizedModel.slice(0, 128)}`, { status: 400 });
  }
  const normalizedMessages = normalizeMessages(messages);
  const systemText = typeof system === 'string' ? system : '';
  const resolvedMaxTokens = normalizeMaxTokens(maxTokens);

  if (protocol === 'openai') {
    const withSystem =
      systemText.length > 0
        ? [{ role: 'system', content: systemText }, ...normalizedMessages]
        : normalizedMessages;
    return {
      model: normalizedModel,
      messages: withSystem,
      max_tokens: resolvedMaxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  const body = {
    model: normalizedModel,
    max_tokens: resolvedMaxTokens,
    stream: true,
    messages: normalizedMessages.map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: message.content }],
    })),
  };
  if (systemText.length > 0) body.system = systemText;
  return body;
}

/** 流式对话 URL：openai → <base>/chat/completions；anthropic → <base>/v1/messages（v1 去重）。 */
export function buildChatUrl(protocol, baseUrl) {
  assertProtocol(protocol);
  const base = normalizeBaseUrl(baseUrl);
  if (protocol === 'anthropic') {
    return `${base.endsWith('/v1') ? base : `${base}/v1`}/messages`;
  }
  return `${base}/chat/completions`;
}

/** 模型列表 URL：openai → <base>/models；anthropic → <base>/v1/models（v1 去重）。 */
export function listModelsUrl(protocol, baseUrl) {
  assertProtocol(protocol);
  const base = normalizeBaseUrl(baseUrl);
  if (protocol === 'anthropic') {
    return `${base.endsWith('/v1') ? base : `${base}/v1`}/models`;
  }
  return `${base}/models`;
}

// ---------------------------------------------------------------------------
// 流式事件解析 / usage 提取
// ---------------------------------------------------------------------------

/**
 * 解析一帧 SSE data（已 JSON.parse 的对象；也接受字符串 '[DONE]'）。
 *
 * 返回 {type, text?, usage?}：
 * - type:'text'     文本增量（text 字段）；
 * - type:'thinking' 思考增量（text 字段，DeepSeek reasoning_content / Anthropic thinking_delta）；
 * - type:'usage'    携带 usage（usage 字段），消费方应覆盖记录为最新用量口径；
 * - type:'done'     流结束（可能同时携带 usage：OpenAI 兼容实现末帧 finish_reason 与 usage 同帧时，
 *                   消费方必须先取 usage 再结束）；
 * - type:'ignore'   无有效事件（ping/未知帧/上游 error 帧；error 帧由 byok-upstream 检查原始数据识别）。
 *
 * @param {'openai'|'anthropic'} protocol
 * @param {unknown} json
 * @returns {{type:'text'|'thinking'|'usage'|'done'|'ignore', text?:string, usage?:object}}
 */
export function parseStreamEvent(protocol, json) {
  assertProtocol(protocol);
  if (typeof json === 'string') {
    const text = json.trim();
    if (text === '[DONE]') return { type: 'done' };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { type: 'ignore' };
    }
    return parseStreamEvent(protocol, parsed);
  }
  if (protocol === 'anthropic') return parseAnthropicStreamEvent(json);
  return parseOpenAIStreamEvent(json);
}

function parseOpenAIStreamEvent(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { type: 'ignore' };
  // 上游错误帧：形状因厂商而异，交给 byok-upstream 检查原始帧并归一错误码。
  if (json.error) return { type: 'ignore' };
  const choice = Array.isArray(json.choices) && json.choices.length > 0 ? json.choices[0] : null;
  const usage = json.usage ? extractOpenAIUsage(json) : null;
  const delta = choice && choice.delta && typeof choice.delta === 'object' ? choice.delta : null;
  if (delta) {
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      return { type: 'thinking', text: delta.reasoning_content };
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      return { type: 'text', text: delta.content };
    }
  }
  if (choice && choice.finish_reason) {
    // DeepSeek 等实现把 usage 搭载在 finish_reason 同帧（choices 恰 1、无新内容）。
    return usage ? { type: 'done', usage } : { type: 'done' };
  }
  if (usage) return { type: 'usage', usage };
  return { type: 'ignore' };
}

function parseAnthropicStreamEvent(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { type: 'ignore' };
  const type = json.type;
  if (type === 'message_stop') return { type: 'done' };
  if (type === 'message_start' || type === 'message_delta') {
    const usage = extractAnthropicUsage(json);
    return usage ? { type: 'usage', usage } : { type: 'ignore' };
  }
  if (type === 'content_block_delta') {
    const delta = json.delta && typeof json.delta === 'object' ? json.delta : null;
    if (!delta) return { type: 'ignore' };
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      return { type: 'text', text: delta.text };
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
      return { type: 'thinking', text: delta.thinking };
    }
    return { type: 'ignore' };
  }
  if (type === 'content_block_start') {
    const block = json.content_block && typeof json.content_block === 'object' ? json.content_block : null;
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      return { type: 'text', text: block.text };
    }
    return { type: 'ignore' };
  }
  // ping / error / 未知事件：error 帧由 byok-upstream 检查原始帧识别并归一。
  return { type: 'ignore' };
}

/**
 * 从一帧响应/事件中提取 usage；无 usage → null。
 * 映射保证 inputTokens 为「未命中」、cacheReadInputTokens 为「命中」，两者不重复计算。
 * @param {'openai'|'anthropic'} protocol
 * @param {unknown} json
 * @returns {{inputTokens:number, outputTokens:number, cacheReadInputTokens:number}|null}
 */
export function extractUsage(protocol, json) {
  assertProtocol(protocol);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return protocol === 'anthropic' ? extractAnthropicUsage(json) : extractOpenAIUsage(json);
}

function extractOpenAIUsage(json) {
  const usage =
    json.usage && typeof json.usage === 'object'
      ? json.usage
      : typeof json.prompt_tokens === 'number' || typeof json.completion_tokens === 'number'
        ? json
        : null;
  if (!usage) return null;
  const prompt = intOrNull(usage.prompt_tokens);
  const completion = intOrNull(usage.completion_tokens);
  const cachedDetail =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
      ? intOrNull(usage.prompt_tokens_details.cached_tokens)
      : null;
  const cachedHit = cachedDetail === null ? intOrNull(usage.prompt_cache_hit_tokens) : cachedDetail;
  const miss = intOrNull(usage.prompt_cache_miss_tokens);
  if (prompt === null && completion === null && cachedHit === null && miss === null) return null;
  const cacheRead = cachedHit ?? 0;
  // DeepSeek 语义：prompt_tokens 已含命中，未命中 = prompt_tokens - cached（或直接给 miss）。
  const inputTokens = miss !== null ? miss : Math.max(0, (prompt ?? 0) - cacheRead);
  return { inputTokens, outputTokens: completion ?? 0, cacheReadInputTokens: cacheRead };
}

function extractAnthropicUsage(json) {
  const usage =
    json.usage && typeof json.usage === 'object'
      ? json.usage
      : json.message && typeof json.message === 'object' && json.message.usage && typeof json.message.usage === 'object'
        ? json.message.usage
        : typeof json.input_tokens === 'number' || typeof json.output_tokens === 'number'
          ? json
          : null;
  if (!usage) return null;
  const input = intOrNull(usage.input_tokens);
  const output = intOrNull(usage.output_tokens);
  const cacheRead = intOrNull(usage.cache_read_input_tokens);
  const cacheCreation = intOrNull(usage.cache_creation_input_tokens);
  if (input === null && output === null && cacheRead === null && cacheCreation === null) return null;
  // 与官方路径一致：input_tokens 已是「未命中」口径（不含 cache），不再相加。
  return { inputTokens: input ?? 0, outputTokens: output ?? 0, cacheReadInputTokens: cacheRead ?? 0 };
}

// ---------------------------------------------------------------------------
// 模型列表解析
// ---------------------------------------------------------------------------

/**
 * 解析模型列表：openai 用 data[].id（name 仅当厂商给出）；anthropic 用 data[].id + display_name。
 * 任何异常 → []（不 throw，避免影响配置页）。
 * @param {'openai'|'anthropic'} protocol
 * @param {unknown} json
 * @returns {Array<{id:string, name?:string}>}
 */
export function parseModels(protocol, json) {
  if (!BYOK_PROTOCOLS.includes(protocol)) return [];
  try {
    const data = json && typeof json === 'object' && Array.isArray(json.data) ? json.data : [];
    const models = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id) continue;
      const rawName =
        protocol === 'anthropic'
          ? typeof item.display_name === 'string'
            ? item.display_name
            : ''
          : typeof item.name === 'string'
            ? item.name
            : '';
      const name = rawName.trim();
      models.push(name.length > 0 ? { id, name } : { id });
    }
    return models;
  } catch {
    return [];
  }
}

// 供 byok.mjs / 测试复用的内部常量（非契约冻结，不改变 3 语义）。
export const BYOK_DEFAULT_MAX_TOKENS = DEFAULT_MAX_TOKENS;
