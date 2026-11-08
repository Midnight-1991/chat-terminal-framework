// 基础 HTTP 工具：JSON 响应、错误响应、请求体读取。
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function errorPayload(code, message) {
  return { error: { code, message } };
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

/** 直接发送已序列化的 JSON 文本（文档库等缓存响应，避免每次请求重复 stringify）。 */
export function sendJsonText(res, status, body, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendApiError(res, status, code, message) {
  sendJson(res, status, errorPayload(code, message));
}

export function sendText(res, status, text, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

const DEFAULT_BODY_LIMIT = 128 * 1024;

export async function readRequestBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      // 尽早丢弃剩余请求体，避免客户端继续阻塞。
      if (typeof req.resume === 'function') req.resume();
      throw new HttpError(400, 'INVALID_REQUEST', `请求体过大（上限 ${Math.floor(limit / 1024)}KB）`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req, opts = {}) {
  const buffer = await readRequestBody(req, opts);
  if (buffer.length === 0) throw new HttpError(400, 'INVALID_REQUEST', '请求体不能为空');
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', '请求体必须是合法 JSON');
  }
  return parsed;
}
