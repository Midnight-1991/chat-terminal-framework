// server/memory-extract.mjs — 长期记忆抽取调用（开源框架子集 / 通用化改写版）。
// 抽取规则由 prompts 包提供（memory-extract.md），本文件只保留通用调用/解析/容错逻辑。
// BYOK 用户记忆抽取——使用用户自己的厂商模型（服务端代理由 API 层代理），非流式两族协议。
//
// 职责（契约 3）：
// - buildExtractRequest：把抽取 prompt 构造为 openai `/chat/completions`（stream:false）或
//   anthropic `/v1/messages` 的非流式请求（headers 复用 byok-providers.buildHeaders）；
// - parseExtractResponse：解析两族非流式响应正文，结构不符返回 ''（memory 层按空处理）；
// - extractViaByok：发请求（超时/非 2xx/结构异常 → throw，消息经 redactSecrets，不含明文 key）；
// - createMemoryExtractCaller：注入给 memory 层的 callModel —— 官方用户走 officialCallModel
//   （与 前逐字节一致），BYOK 用户走用户自己的模型；失败 throw 让 memory 层 warn 跳过，
//   **不静默回落官方**。
//
// 红线：不打印/不抛出明文 key；不写 usage、不计配额；无新依赖。
import { buildChatUrl, buildHeaders } from './byok-providers.mjs';
import { redactSecrets, resolveChatModelSource } from './byok.mjs';
import { createFetchTransport, createPinnedTransport } from './pinned-http.mjs';

/** 抽取 max_tokens 默认值（；env MEMORY_EXTRACT_MAX_TOKENS 由 config 注入）。 */
export const MEMORY_EXTRACT_DEFAULT_MAX_TOKENS = 1024;
/** 抽取超时默认值（；env MEMORY_EXTRACT_TIMEOUT_MS 由 config 注入）。 */
export const MEMORY_EXTRACT_DEFAULT_TIMEOUT_MS = 15_000;
/** 错误消息里保留的上游/网络细节上限（先脱敏再截断）。 */
const MAX_ERROR_DETAIL_CHARS = 200;
const LOG_PREFIX = '[memory-extract]';

function warn(logger, message) {
  try {
    logger?.warn?.(`${LOG_PREFIX} ${message}`);
  } catch {
    /* 忽略日志异常 */
  }
}

function positiveIntOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function messageWithDetail(prefix, error, apiKey) {
  const detail = redactSecrets(error?.message ?? String(error), apiKey ?? null).slice(0, MAX_ERROR_DETAIL_CHARS);
  return detail ? `${prefix}：${detail}` : prefix;
}

/**
 * 构造非流式抽取请求（契约 3）。
 * @param {{
 *   protocol: 'openai'|'anthropic', model: string, baseUrl: string, prompt: string,
 *   maxTokens?: number, apiKey?: string|null,
 * }} opts
 * @returns {{url:string, headers:Record<string,string>, body:object}}
 */
export function buildExtractRequest({ protocol, model, baseUrl, prompt, maxTokens, apiKey = null } = {}) {
  const url = buildChatUrl(protocol, baseUrl);
  const text = String(prompt ?? '');
  const maxTokensValue = positiveIntOr(maxTokens, MEMORY_EXTRACT_DEFAULT_MAX_TOKENS);
  const body =
    protocol === 'anthropic'
      ? {
          model,
          max_tokens: maxTokensValue,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        }
      : {
          model,
          messages: [{ role: 'user', content: text }],
          max_tokens: maxTokensValue,
          stream: false,
        };
  const headers = {
    ...(typeof apiKey === 'string' && apiKey.trim() !== '' ? buildHeaders(protocol, apiKey) : {}),
    'content-type': 'application/json',
    accept: 'application/json',
  };
  return { url, headers, body };
}

/**
 * 解析两族非流式 chat completion 正文（契约 3）。结构不符返回 ''。
 * @param {'openai'|'anthropic'} protocol
 * @param {unknown} json
 * @returns {string}
 */
export function parseExtractResponse(protocol, json) {
  if (protocol === 'anthropic') {
    const content = json && typeof json === 'object' ? json.content : null;
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }
  const content = json && typeof json === 'object' ? json?.choices?.[0]?.message?.content : undefined;
  return typeof content === 'string' ? content : '';
}

/**
 * 调用户自己的厂商模型做一轮非流式记忆抽取（契约 3/4）。
 * 失败一律 throw（memory 层 warn 跳过，不回落官方）；消息经 redactSecrets，不含明文 key。
 * 出站统一走 pinned 传输（DNS 钉扎 + 逐地址校验 + 不跟随重定向）；
 * `fetchImpl` 仅为兼容旧 探针脚本保留，生产路径必须注入 transport。
 * @param {{
 *   secret: {provider?:string, protocol:'openai'|'anthropic', model:string, baseUrl:string, apiKey:string},
 *   prompt: string, transport?: {readText: Function}, fetchImpl?: typeof fetch,
 *   timeoutMs?: number, maxTokens?: number,
 *   logger?: object|null, assertRequestUrl?: ((url:string)=>Promise<string>)|null,
 * }} opts
 * @returns {Promise<string>}
 */
export async function extractViaByok({
  secret,
  prompt,
  transport = null,
  fetchImpl = null,
  timeoutMs,
  maxTokens,
  logger = console,
  assertRequestUrl = null,
} = {}) {
  if (!secret || typeof secret !== 'object') throw new Error('缺少自定义模型配置');
  // 优先 pinned 传输；fetchImpl 只是旧脚本兼容路径（非生产）。
  const outbound =
    transport && typeof transport.readText === 'function'
      ? transport
      : typeof fetchImpl === 'function'
        ? createFetchTransport(fetchImpl)
        : createPinnedTransport();
  const apiKey = typeof secret.apiKey === 'string' ? secret.apiKey : '';

  // 每次出站前重校验端点（由调用方注入，通常是 ctx.byok.assertRequestUrl）。
  if (typeof assertRequestUrl === 'function') {
    try {
      await assertRequestUrl(secret.baseUrl);
    } catch (error) {
      throw new Error(messageWithDetail('自定义模型端点解析到受限地址（已拒绝）', error, apiKey));
    }
  }

  let request;
  try {
    request = buildExtractRequest({
      protocol: secret.protocol,
      model: secret.model,
      baseUrl: secret.baseUrl,
      prompt,
      maxTokens,
      apiKey,
    });
  } catch (error) {
    throw new Error(messageWithDetail('自定义模型记忆抽取请求构造失败', error, apiKey));
  }

  const timeoutValue = positiveIntOr(timeoutMs, MEMORY_EXTRACT_DEFAULT_TIMEOUT_MS);
  let response;
  try {
    // 非流式 JSON：pinned 传输读完正文（超时/中止由传输层 destroy 并抛错）。
    response = await outbound.readText({
      url: request.url,
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      timeoutMs: timeoutValue,
    });
  } catch (error) {
    const name = error?.name ?? '';
    const timedOut =
      name === 'TimeoutError' || name === 'AbortError' || error?.code === 'BYOK_TIMEOUT';
    throw new Error(
      timedOut
        ? `自定义模型记忆抽取超时（>${timeoutValue}ms）`
        : messageWithDetail('自定义模型记忆抽取网络失败', error, apiKey),
    );
  }

  if (!response || typeof response.statusCode !== 'number') {
    throw new Error('自定义模型记忆抽取返回了无法识别的响应');
  }
  const status = response.statusCode;
  if (status < 200 || status >= 300) {
    const detail = String(response.text ?? '').slice(0, MAX_ERROR_DETAIL_CHARS);
    const suffix = detail ? `：${redactSecrets(detail, apiKey)}` : '';
    warn(logger, `抽取上游 HTTP ${status}（本轮跳过）`);
    throw new Error(`自定义模型记忆抽取失败（HTTP ${status}）${suffix}`);
  }

  // JSON 解析失败时与原实现一致：按空结果处理（memory 层跳过本轮）。
  const json = typeof response.json === 'function' ? response.json() : null;
  return parseExtractResponse(secret.protocol, json);
}

/**
 * 取「最新」用户记录：按用户作用域缓存的 memory.callModel 在作用域首次创建时闭包捕获 user 快照，
 * 若用户随后 PUT/DELETE BYOK 切换 modelSource，必须按 users.json 最新记录判定。
 * 读取失败时回退快照，不阻塞抽取。
 * @param {object} ctx
 * @returns {Promise<object|null>}
 */
async function latestUserFor(ctx) {
  try {
    if (ctx?.users && typeof ctx.users.get === 'function' && ctx.userId) {
      const latest = await ctx.users.get(ctx.userId);
      if (latest) return latest;
    }
  } catch {
    /* 读失败按快照处理 */
  }
  return ctx?.user ?? null;
}

/**
 * 构造注入 memory 服务的 callModel。
 * - 官方用户 / AUTH=off：直接走 officialCallModel（与现状一致；为 null 时抛错让 memory 层 warn 跳过）；
 * - BYOK 用户：extractViaByok 走用户自己的模型，失败 throw（不回落官方）。
 * @param {{ctx: object, officialCallModel?: Function|null, logger?: object|null}} opts
 * @returns {(prompt:string)=>Promise<string>}
 */
export function createMemoryExtractCaller({ ctx, officialCallModel = null, logger = ctx?.logger ?? console } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new Error('createMemoryExtractCaller 需要 ctx');
  return async function memoryExtractCallModel(prompt) {
    // 以最新用户记录判定 modelSource（缓存作用域快照可能早于用户切换 BYOK）。
    const user = await latestUserFor(ctx);
    const source = await resolveChatModelSource({ ...ctx, user });
    if (source.kind !== 'byok') {
      if (typeof officialCallModel !== 'function') throw new Error('未配置抽取模型调用（非 mock 且无 API key）');
      return officialCallModel(prompt);
    }
    const config = ctx.config ?? {};
    return extractViaByok({
      secret: source,
      prompt,
      transport: ctx.byok?.transport ?? null,
      fetchImpl: ctx.fetchImpl,
      timeoutMs: positiveIntOr(config.memoryExtractTimeoutMs, MEMORY_EXTRACT_DEFAULT_TIMEOUT_MS),
      maxTokens: positiveIntOr(config.memoryExtractMaxTokens, MEMORY_EXTRACT_DEFAULT_MAX_TOKENS),
      logger: logger ?? ctx.logger,
      assertRequestUrl:
        typeof ctx.byok?.assertRequestUrl === 'function' ? (url) => ctx.byok.assertRequestUrl(url) : null,
    });
  };
}
