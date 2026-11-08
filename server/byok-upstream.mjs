// ..BYOK 上游流式代理（两族协议：Anthropic Messages / OpenAI Chat Completions）。
//
// 职责：用 server/byok-providers.mjs 的纯函数构造请求、解析 SSE，把增量归一化为本仓现有
// `thinking_delta` / `text_delta` 事件；错误统一映射为 BYOK_UPSTREAM_* 并脱敏（契约 6）。
// 红线：不打印/不抛出明文 key；失败直接报错，不静默回落官方模型。
import { Readable } from 'node:stream';

import { ByokError, buildChatUrl, buildHeaders, buildRequestBody, extractUsage, parseStreamEvent } from './byok-providers.mjs';
import { redactSecrets } from './byok.mjs';
import { createFetchTransport, createPinnedTransport } from './pinned-http.mjs';
import { parseSSEStream } from './sse.mjs';
import { ClientAbortError } from './upstream.mjs';

export const BYOK_UPSTREAM_ERROR_CODES = Object.freeze([
  'BYOK_UPSTREAM_AUTH',
  'BYOK_UPSTREAM_TIMEOUT',
  'BYOK_UPSTREAM_RATE_LIMIT',
  'BYOK_UPSTREAM_ERROR',
]);

const MAX_UPSTREAM_DETAIL_CHARS = 300;

/** BYOK 上游失败：码值契约见 6，message 已脱敏，绝不携带明文 key。 */
export class ByokUpstreamFailure extends Error {
  constructor(code, message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.name = 'ByokUpstreamFailure';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function failForStatus(status) {
  if (status === 401 || status === 403) {
    return new ByokUpstreamFailure('BYOK_UPSTREAM_AUTH', '自定义模型鉴权失败，请检查 API key 是否有效', {
      retryable: false,
      status,
    });
  }
  if (status === 429) {
    return new ByokUpstreamFailure('BYOK_UPSTREAM_RATE_LIMIT', '自定义模型上游限流，请稍后重试', {
      retryable: true,
      status,
    });
  }
  if (status >= 500) {
    return new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', `自定义模型上游服务错误（HTTP ${status}），请稍后重试`, {
      retryable: true,
      status,
    });
  }
  if (status >= 300 && status < 400) {
    return new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', '自定义模型上游返回了重定向（已禁止），请检查 baseUrl', {
      retryable: false,
      status,
    });
  }
  return new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', `自定义模型上游请求被拒绝（HTTP ${status}）`, {
    retryable: false,
    status,
  });
}

function mergeUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return;
  if (Number.isFinite(usage.inputTokens)) target.inputTokens = usage.inputTokens;
  if (Number.isFinite(usage.outputTokens)) target.outputTokens = usage.outputTokens;
  if (Number.isFinite(usage.cacheReadInputTokens)) target.cacheReadInputTokens = usage.cacheReadInputTokens;
}

/**
 * 调 BYOK 上游并流式转发增量（契约 6）。
 * 出站统一走 pinned 传输（DNS 钉扎：一次解析 → 逐地址校验 → 只连已校验 IP；
 * 不跟随重定向）；`fetchImpl` 仅为兼容旧 探针脚本保留，生产路径必须注入 transport。
 * @param {{
 *   provider: string, protocol: string, model: string, baseUrl: string, apiKey: string,
 *   system: string,
 *   messages: Array<{role:string, content:string}>,
 *   maxTokens: number,
 *   transport?: {request: Function, readText?: Function},
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   onEvent: (event: string, data: object) => Promise<unknown>,
 *   logger?: object,
 *   timeoutMs?: number,
 *   assertRequestUrl?: ((url:string)=>Promise<string>)|null,
 * }} opts
 * @returns {Promise<{stopReason:string,text:string,usage:{inputTokens:number,outputTokens:number,cacheReadInputTokens:number}}>}
 */
export async function streamByokUpstream({
  provider,
  protocol,
  model,
  baseUrl,
  apiKey,
  system,
  messages,
  maxTokens,
  transport = null,
  fetchImpl = null,
  signal,
  onEvent,
  logger = console,
  timeoutMs = 120_000,
  assertRequestUrl = null,
}) {
  // 优先使用 pinned 传输；fetchImpl 只是旧脚本兼容路径（非生产）。
  const outbound =
    transport && typeof transport.request === 'function'
      ? transport
      : typeof fetchImpl === 'function'
        ? createFetchTransport(fetchImpl)
        : createPinnedTransport();

  let url;
  let headers;
  let body;
  try {
    url = buildChatUrl(protocol, baseUrl);
    headers = {
      ...buildHeaders(protocol, apiKey),
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    body = buildRequestBody({ protocol, model, system, messages, maxTokens });
  } catch (error) {
    throw new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', '自定义模型请求构造失败，请检查厂商与 baseUrl 配置', {
      retryable: false,
    });
  }

  // 每次出站前重校验端点（由调用方注入 ctx.byok.assertRequestUrl）。
  // 抛错统一映射 BYOK_UPSTREAM_ERROR（脱敏，不泄露内部细节、不发起请求）。
  if (typeof assertRequestUrl === 'function') {
    try {
      await assertRequestUrl(baseUrl);
    } catch {
      throw new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', '自定义模型端点解析到受限地址（已拒绝）', { status: 0 });
    }
  }

  if (signal?.aborted) throw new ClientAbortError();
  const timeoutValue = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;

  const state = {
    text: '',
    stopReason: 'end_turn',
    finished: false,
    sawDoneMarker: false,
    sawFinishReason: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  };

  let response = null;
  try {
    try {
      // 传输层同时负责连接与整条流的总超时（超时 destroy → ByokError BYOK_TIMEOUT）。
      response = await outbound.request({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeoutMs: timeoutValue,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new ClientAbortError();
      if (error?.code === 'BYOK_TIMEOUT' || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ByokUpstreamFailure('BYOK_UPSTREAM_TIMEOUT', `自定义模型响应超时（>${timeoutValue}ms）`, {
          retryable: true,
        });
      }
      if (error?.name === 'ByokError' || error instanceof ByokError) throw error;
      const detail = redactSecrets(error?.message ?? String(error), apiKey).slice(0, MAX_UPSTREAM_DETAIL_CHARS);
      throw new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', redactSecrets(`无法连接自定义模型服务（${detail}）`), {
        retryable: true,
      });
    }

    if (!response || typeof response.statusCode !== 'number') {
      throw new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', '自定义模型返回了无法识别的响应', { retryable: true });
    }
    // 不跟随重定向：3xx 也按失败处理（failForStatus 内映射）。
    if (response.statusCode < 200 || response.statusCode >= 300) {
      let detail = '';
      try {
        detail = (await readStreamText(response.stream, MAX_UPSTREAM_DETAIL_CHARS)).slice(0, MAX_UPSTREAM_DETAIL_CHARS);
      } catch {
        detail = '';
      }
      if (detail) {
        logger?.warn?.(
          `[byok-upstream] ${provider ?? 'custom'} HTTP ${response.statusCode}：${redactSecrets(detail, apiKey)}`,
        );
      }
      throw failForStatus(response.statusCode);
    }
    if (!response.stream) {
      throw new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', '自定义模型响应没有可读流', { retryable: true });
    }

    try {
      // http.IncomingMessage（Node Readable）→ Web ReadableStream，复用既有 SSE 解析器。
      for await (const event of parseSSEStream(Readable.toWeb(response.stream))) {
        if (signal?.aborted) throw new ClientAbortError();
        const data = event?.data;

        // OpenAI 兼容：[DONE] 标记（可能是字符串，也可能被解析为对象）。
        if (typeof data === 'string') {
          if (data.trim() === '[DONE]') {
            state.sawDoneMarker = true;
            state.finished = true;
            break;
          }
          continue;
        }
        if (!data || typeof data !== 'object') continue;

        // 上游错误帧（形状因厂商而异）：归一为 BYOK_UPSTREAM_* 并脱敏，不把原文抛给前端。
        if (data.error && typeof data.error === 'object') {
          throw normalizeErrorFrame(data.error, apiKey);
        }

        // 末帧 usage 可能和 finish_reason 同帧（DeepSeek 等）：先取 usage，再处理结束状态。
        mergeUsage(state.usage, safeExtractUsage(protocol, data, logger));

        const parsed = safeParseStreamEvent(protocol, data, logger);
        if (!parsed) continue;
        if (parsed.type === 'usage' && parsed.usage) mergeUsage(state.usage, parsed.usage);
        if (parsed.usage) mergeUsage(state.usage, parsed.usage);

        if (parsed.type === 'text' && typeof parsed.text === 'string' && parsed.text !== '') {
          state.text += parsed.text;
          await onEvent('text_delta', { text: parsed.text });
        } else if (parsed.type === 'thinking' && typeof parsed.text === 'string' && parsed.text !== '') {
          await onEvent('thinking_delta', { text: parsed.text });
        } else if (parsed.type === 'done') {
          state.finished = true;
          state.sawFinishReason = true;
          if (typeof parsed.stopReason === 'string' && parsed.stopReason) state.stopReason = parsed.stopReason;
          // 不立即 break：OpenAI include_usage 的 usage 帧通常跟在 finish_reason 之后，需继续读到 [DONE]。
          if (protocol !== 'openai') break;
        }
      }
    } catch (error) {
      if (error instanceof ByokUpstreamFailure || error instanceof ClientAbortError) throw error;
      if (signal?.aborted) throw new ClientAbortError();
      if (error?.code === 'BYOK_TIMEOUT' || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ByokUpstreamFailure('BYOK_UPSTREAM_TIMEOUT', `自定义模型响应超时（>${timeoutValue}ms）`, {
          retryable: true,
        });
      }
      const message = redactSecrets(error?.message ?? String(error), apiKey).slice(0, MAX_UPSTREAM_DETAIL_CHARS);
      throw new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', redactSecrets(`自定义模型流式响应中断（${message}）`), {
        retryable: true,
      });
    }
  } finally {
    // 主动结束/中断后释放底层 socket（避免 keep-alive 连接残留未读数据）。
    try {
      if (response?.stream && typeof response.stream.destroy === 'function' && !response.stream.destroyed) {
        response.stream.destroy();
      }
    } catch {
      /* ignore */
    }
  }

  if (signal?.aborted) throw new ClientAbortError();
  // Anthropic 以 message_stop 收尾；OpenAI 以 finish_reason/[DONE] 收尾。两者都没有视为断流。
  if (!state.finished) {
    throw new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', '自定义模型流在完成标记之前中断，请稍后重试', {
      retryable: true,
    });
  }

  return {
    stopReason: state.stopReason,
    text: state.text,
    usage: {
      inputTokens: state.usage.inputTokens,
      outputTokens: state.usage.outputTokens,
      cacheReadInputTokens: state.usage.cacheReadInputTokens,
    },
  };
}

/** 读取 Node Readable 的一定长度文本（用于非 2xx 的日志摘要；超长截断并丢弃剩余流）。 */
function readStreamText(stream, maxChars) {
  return new Promise((resolve) => {
    if (!stream || typeof stream.on !== 'function') {
      resolve('');
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8').slice(0, maxChars));
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = maxChars * 4 - size;
      if (room <= 0) {
        try {
          stream.destroy();
        } catch {
          /* ignore */
        }
        finish();
        return;
      }
      chunks.push(buffer.subarray(0, room));
      size += Math.min(buffer.length, room);
    });
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
}

/** 上游 error 帧 → 归一化失败（鉴权/限流/其他），message 已脱敏。 */
function normalizeErrorFrame(error, apiKey) {
  const detail = String(error?.message ?? error?.code ?? '').trim();
  const lower = detail.toLowerCase();
  const isAuth = /api[ _-]?key|unauthorized|authentication|invalid.*token|鉴权|认证/.test(lower);
  const isRate = /rate[ _-]?limit|too many requests|quota|限流|频率/.test(lower);
  const message = redactSecrets(`自定义模型上游返回错误${detail ? `：${detail.slice(0, 200)}` : ''}`, apiKey);
  if (isAuth) return new ByokUpstreamFailure('BYOK_UPSTREAM_AUTH', message, { retryable: false });
  if (isRate) return new ByokUpstreamFailure('BYOK_UPSTREAM_RATE_LIMIT', message, { retryable: true });
  return new ByokUpstreamFailure('BYOK_UPSTREAM_ERROR', message, { retryable: true });
}

function safeExtractUsage(protocol, data, logger) {
  try {
    return extractUsage(protocol, data);
  } catch (error) {
    warnThrottled(logger, `解析上游 usage 失败（忽略）：${redactSecrets(error?.message ?? String(error))}`);
    return null;
  }
}

function safeParseStreamEvent(protocol, data, logger) {
  try {
    return parseStreamEvent(protocol, data);
  } catch (error) {
    warnThrottled(logger, `解析上游流事件失败（忽略）：${redactSecrets(error?.message ?? String(error))}`);
    return null;
  }
}

const warnedMessages = new Set();
function warnThrottled(logger, message) {
  if (warnedMessages.has(message)) return;
  if (warnedMessages.size > 50) warnedMessages.clear();
  warnedMessages.add(message);
  try {
    logger?.warn?.(`[byok-upstream] ${message}`);
  } catch {
    /* 忽略 */
  }
}
