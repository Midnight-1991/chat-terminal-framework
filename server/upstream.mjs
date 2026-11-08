// DeepSeek Messages（Anthropic 兼容）上游：构造请求体 + 解析 SSE 并回调转发。
// 契约：effort=off → thinking:{type:"disabled"} 且不发 output_config；
//       low|high|max → thinking:{type:"enabled"} + output_config:{effort}。
import { messagesUrl, resolveMaxTokens } from './config.mjs';
import { buildTurnText, formatAttachmentBlock } from './prompts.mjs';
import { parseSSEStream } from './sse.mjs';

export const ANTHROPIC_VERSION = '2023-06-01';

export class UpstreamFailure extends Error {
  constructor(message, { code = 'UPSTREAM', retryable = true, status = 0 } = {}) {
    super(message);
    this.name = 'UpstreamFailure';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/** 客户端主动断开时抛出，用于静默收尾（不再往已关闭的连接写 error 事件）。 */
export class ClientAbortError extends Error {
  constructor(message = '客户端已断开') {
    super(message);
    this.name = 'ClientAbortError';
  }
}

/**
 * 历史轮次 → 上游 messages 数组的前半部分（不含当轮）。
 * 唯一真源——历史里的用户消息若带附件元数据（只有摘要、无二进制），在此统一回放为附件块，
 * 保证多轮追问仍能引用早前上传的图片/文件内容。
 */
export function historyToMessages(history = []) {
  return history
    .map((message) => {
      const text =
        typeof message?.content === 'string'
          ? message.content
          : typeof message?.text === 'string'
            ? message.text
            : '';
      const attachmentBlock = formatAttachmentBlock(message?.attachments ?? []);
      const content = attachmentBlock ? (text ? `${text}\n\n${attachmentBlock}` : attachmentBlock) : text;
      return {
        role: message?.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'text', text: content }],
      };
    })
    .filter((message) => message.content[0].text !== '');
}

/** 构造上游 Messages 请求体（契约 5；附件摘要以附件块注入）。 */
export function buildUpstreamBody({
  config,
  system,
  citations = [],
  message,
  effort,
  history = [],
  attachments = [],
}) {
  const messages = historyToMessages(history);
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: buildTurnText(citations, message, attachments) }],
  });

  const body = {
    model: config.model,
    max_tokens: resolveMaxTokens(config, effort),
    stream: true,
    system,
    messages,
  };
  if (effort === 'off') {
    body.thinking = { type: 'disabled' };
  } else {
    body.thinking = { type: 'enabled' };
    body.output_config = { effort };
  }
  return body;
}

export function upstreamHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

function friendlyNetworkError(error) {
  const name = error?.name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError') return '上游请求被中止';
  return `无法连接上游服务（${error?.message ?? error}）`;
}

function friendlyStatusMessage(status) {
  if (status === 429) return '上游限流（HTTP 429），请稍后重试';
  if (status >= 500) return `上游服务错误（HTTP ${status}），请稍后重试`;
  if (status === 401 || status === 403) return `上游鉴权失败（HTTP ${status}），请检查 DEEPSEEK_API_KEY`;
  return `上游请求失败（HTTP ${status}）`;
}

/**
 * 调用上游并把 thinking/text 增量通过 onEvent 转发。
 * 正常结束（收到 message_stop）时返回汇总；异常抛 UpstreamFailure / ClientAbortError。
 *
 * @param {{
 *   fetchImpl: typeof fetch, config: object, system: string,
 *   citations: Array<object>, message: string, effort: string,
 *   history: Array<object>, signal: AbortSignal,
 *   onEvent: (event: string, data: object) => Promise<unknown>,
 *   logger?: Console,
 * }} opts
 * @returns {Promise<{stopReason:string,text:string,usage:{inputTokens:number,outputTokens:number,cacheReadInputTokens:number}}>}
 */
export async function streamUpstream({
  fetchImpl,
  config,
  system,
  citations,
  message,
  effort,
  history,
  attachments = [],
  signal,
  onEvent,
  logger = console,
}) {
  const body = buildUpstreamBody({ config, system, citations, message, effort, history, attachments });
  const url = messagesUrl(config);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: upstreamHeaders(config.apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new ClientAbortError();
    throw new UpstreamFailure(friendlyNetworkError(error), { retryable: true });
  }

  if (!response || typeof response.ok !== 'boolean') {
    throw new UpstreamFailure('上游返回了无法识别的响应', { retryable: true });
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = '';
    }
    if (detail) logger?.warn?.(`[upstream] HTTP ${response.status}：${detail}`);
    throw new UpstreamFailure(friendlyStatusMessage(response.status), {
      code: response.status === 429 ? 'RATE_LIMIT' : 'UPSTREAM',
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
    });
  }

  if (!response.body) {
    throw new UpstreamFailure('上游响应没有可读流', { retryable: true });
  }

  const state = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    stopReason: 'end_turn',
    text: '',
    finished: false,
  };

  try {
    for await (const event of parseSSEStream(response.body)) {
      if (signal?.aborted) throw new ClientAbortError();
      const data = event.data;
      if (!data || typeof data !== 'object') continue;
      const type = data.type ?? event.event;

      switch (type) {
        case 'message_start': {
          const usage = data.message?.usage ?? data.usage ?? {};
          state.inputTokens = Number(usage.input_tokens) || 0;
          state.cacheReadInputTokens = Number(usage.cache_read_input_tokens) || 0;
          if (Number(usage.output_tokens)) state.outputTokens = Number(usage.output_tokens);
          break;
        }
        case 'content_block_start': {
          // 只用于判断块类型；增量本身由 content_block_delta 携带。
          break;
        }
        case 'content_block_delta': {
          const delta = data.delta;
          if (!delta) break;
          if (delta.type === 'thinking_delta') {
            const text = typeof delta.thinking === 'string' ? delta.thinking : '';
            if (text) await onEvent('thinking_delta', { text });
          } else if (delta.type === 'text_delta') {
            const text = typeof delta.text === 'string' ? delta.text : '';
            if (text) {
              state.text += text;
              await onEvent('text_delta', { text });
            }
          }
          break;
        }
        case 'message_delta': {
          if (data.delta && typeof data.delta.stop_reason === 'string' && data.delta.stop_reason) {
            state.stopReason = data.delta.stop_reason;
          }
          if (data.usage && Number(data.usage.output_tokens)) {
            state.outputTokens = Number(data.usage.output_tokens);
          }
          break;
        }
        case 'message_stop': {
          state.finished = true;
          break;
        }
        case 'error': {
          const upstreamError = data.error ?? {};
          throw new UpstreamFailure(
            `上游返回错误：${upstreamError.message ?? upstreamError.type ?? '未知错误'}`,
            { code: 'UPSTREAM', retryable: false },
          );
        }
        case 'ping':
        default:
          // ping / 未知事件：忽略，保持流继续。
          break;
      }
      if (state.finished) break;
    }
  } catch (error) {
    if (error instanceof UpstreamFailure || error instanceof ClientAbortError) throw error;
    if (signal?.aborted) throw new ClientAbortError();
    throw new UpstreamFailure(friendlyNetworkError(error), { retryable: true });
  }

  if (!state.finished) {
    if (signal?.aborted) throw new ClientAbortError();
    throw new UpstreamFailure('上游流在 message_stop 之前中断', { retryable: true });
  }

  return {
    stopReason: state.stopReason,
    text: state.text,
    usage: {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cacheReadInputTokens: state.cacheReadInputTokens,
    },
  };
}

/**
 * 构造「补全型」模型调用（非流式，thinking 关闭）：记忆抽取/LLM 重排共用。
 * 失败抛 UpstreamFailure（调用方自行决定是否降级）。
 *
 * @param {{fetchImpl: typeof fetch, config: object, logger?: Console, model?: string, maxTokens?: number}} opts
 * @returns {(prompt: string) => Promise<string>}
 */
export function createCallModel({ fetchImpl, config, logger = console, model, maxTokens = 1024 } = {}) {
  const resolvedModel = model || config.memoryExtractModel || config.model;
  return async function callModel(prompt) {
    const body = {
      model: resolvedModel,
      max_tokens: maxTokens,
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }] }],
      thinking: { type: 'disabled' },
    };
    const url = messagesUrl({ ...config, baseUrl: config.baseUrl });
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: upstreamHeaders(config.apiKey),
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new UpstreamFailure(`模型调用网络失败：${error?.message ?? error}`, { retryable: true });
    }
    if (!response || typeof response.ok !== 'boolean') {
      throw new UpstreamFailure('模型调用返回了无法识别的响应', { retryable: true });
    }
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        detail = '';
      }
      if (detail) logger?.warn?.(`[callModel] HTTP ${response.status}：${detail}`);
      throw new UpstreamFailure(friendlyStatusMessage(response.status), {
        code: response.status === 429 ? 'RATE_LIMIT' : 'UPSTREAM',
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
      });
    }
    let json;
    try {
      json = await response.json();
    } catch {
      throw new UpstreamFailure('模型调用返回的不是合法 JSON', { retryable: true });
    }
    const blocks = Array.isArray(json?.content) ? json.content : [];
    return blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  };
}
