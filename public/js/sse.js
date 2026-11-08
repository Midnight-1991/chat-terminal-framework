// sse.js — Server-Sent Events 解析（POST 流式响应专用；EventSource 只支持 GET）。
// 纯逻辑，无 DOM 依赖，可在 node:test 中直接 import，也可在浏览器里直接使用。
//
// 契约（API-CONTRACT 2）：每个事件形如
//   event: text_delta\n
//   data: {"text":"…"}\n
//   \n
// 帧之间用空行分隔；同一事件多行 data 用 \n 拼接；以 `:` 开头的行是注释（心跳）。

/** SSE data 不是合法 JSON 时抛出。 */
export class SSEParseError extends Error {
  constructor(message, raw, options) {
    super(message, options);
    this.name = 'SSEParseError';
    this.raw = raw;
  }
}

/**
 * 解析单个事件块（不含分隔空行）。
 * @param {string} block
 * @returns {{event:string, data:string}} 事件名（缺省 message）与 data 原文
 */
export function parseSSEBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // id / retry 字段本项目用不到，忽略。
  }
  return { event, data: dataLines.join('\n') };
}

const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

/**
 * 增量 SSE 解码器：喂任意切分的文本块，吐出完整事件。
 * 跨块半帧会留在内部缓冲区，直到补齐或 flush()。
 * @returns {{push:(chunk:string)=>Array<{event:string,data:string}>, flush:()=>Array<{event:string,data:string}>, buffered:()=>string}}
 */
export function createSSEDecoder() {
  let buffer = '';

  function drain() {
    const events = [];
    for (;;) {
      const match = FRAME_SEPARATOR.exec(buffer);
      if (!match) break;
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (raw.trim() === '') continue;
      events.push(parseSSEBlock(raw));
    }
    return events;
  }

  return {
    push(chunk) {
      buffer += chunk;
      return drain();
    },
    flush() {
      const events = drain();
      // 少数服务端最后一帧不带结尾空行，宽容处理。
      if (buffer.trim() !== '') {
        events.push(parseSSEBlock(buffer));
      }
      buffer = '';
      return events;
    },
    buffered() {
      return buffer;
    },
  };
}

/**
 * 把 ReadableStream（fetch 的 response.body）消费成事件回调。
 * - 处理 UTF-8 多字节字符跨 chunk 断裂（TextDecoder stream 模式）；
 * - 事件 data 为空（心跳/仅 event 行）时跳过；
 * - data 非 JSON 时抛 SSEParseError，由调用方转成终端风错误行。
 *
 * @param {ReadableStream<Uint8Array|string>} stream
 * @param {(event:string, payload:any)=>void} onEvent
 * @param {{signal?:AbortSignal}} [options]
 * @returns {Promise<void>}
 */
export async function consumeSSE(stream, onEvent, options = {}) {
  const { signal } = options;
  const decoder = createSSEDecoder();
  const textDecoder = new TextDecoder('utf-8');
  const reader = stream.getReader();

  const dispatch = (event) => {
    if (event.data === '') return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      throw new SSEParseError(`SSE data 不是合法 JSON：${event.data.slice(0, 80)}`, event.data, {
        cause: error,
      });
    }
    onEvent(event.event, payload);
  };

  try {
    for (;;) {
      if (signal && signal.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      const text =
        typeof value === 'string' ? value : textDecoder.decode(value, { stream: true });
      for (const event of decoder.push(text)) dispatch(event);
    }
    const tail = textDecoder.decode();
    if (tail !== '') for (const event of decoder.push(tail)) dispatch(event);
    for (const event of decoder.flush()) dispatch(event);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 流已释放 */
    }
  }
}
