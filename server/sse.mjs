// SSE：响应头、事件写出、上游 SSE 流解析。
export const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
});

export function startSSE(res) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(200, { ...SSE_HEADERS, 'x-content-type-options': 'nosniff' });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function formatSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function drainOrClose(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
  });
}

/** 写一个 SSE 事件；返回 false 表示连接已不可写（客户端断开等）。 */
export async function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  const flushed = res.write(formatSSE(event, data));
  if (!flushed) await drainOrClose(res);
  return !(res.writableEnded || res.destroyed);
}

export function endSSE(res) {
  if (!res.writableEnded && !res.destroyed) res.end();
}

/**
 * 解析单个 SSE 事件块（已按空行切分）。
 * @returns {{event: string, data: any}|null}
 */
export function parseSSEBlock(raw) {
  if (!raw || raw.trim() === '') return null;
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return { event, data: null };
  const dataText = dataLines.join('\n');
  let data = dataText;
  try {
    data = JSON.parse(dataText);
  } catch {
    // 保留原始文本，由调用方决定如何处理。
  }
  return { event, data };
}

/** 把 upstream 的 ReadableStream 逐事件解析为 {event, data} 异步迭代器。 */
export async function* parseSSEStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const normalize = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = normalize(buffer + decoder.decode(value, { stream: true }));
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseSSEBlock(raw);
        if (parsed) yield parsed;
      }
    }
    buffer = normalize(buffer + decoder.decode());
    if (buffer.trim() !== '') {
      const parsed = parseSSEBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
