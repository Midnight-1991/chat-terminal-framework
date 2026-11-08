// v2 会话持久化接口：/api/conversations 与 /api/conversations/:id。
// 契约：docs/API-CONTRACT.md 5 / docs/DATA-CONTRACT.md 8。
import { HttpError, readRequestBody, sendApiError, sendJson } from './http-utils.mjs';
import { sweepStoreAttachments } from './attachments.mjs';
import { ID_LOOKUP_RE, STORE_LIMITS } from './store.mjs';

export const MAX_TITLE_CHARS = STORE_LIMITS.MAX_TITLE_CHARS;

export function runeLength(text) {
  return Array.from(String(text ?? '')).length;
}

function safeDecode(raw) {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    return '';
  }
}

async function readOptionalJson(req) {
  const buffer = await readRequestBody(req, { limit: 64 * 1024 });
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', '请求体必须是合法 JSON');
  }
}

/** 校验标题：字符串、去空白后 1–60 字符。 */
export function validateTitle(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_REQUEST', 'title 必须是字符串');
  const trimmed = value.trim();
  if (trimmed === '') throw new HttpError(400, 'INVALID_REQUEST', 'title 不能为空');
  if (runeLength(trimmed) > MAX_TITLE_CHARS) {
    throw new HttpError(400, 'INVALID_REQUEST', `title 长度不能超过 ${MAX_TITLE_CHARS} 字符`);
  }
  return trimmed;
}

function conversationIdFromSegments(segments) {
  if (segments.length !== 3) return null;
  const id = safeDecode(segments[2]);
  if (!id || !ID_LOOKUP_RE.test(id)) return null;
  return id;
}

function sendRouteError(res, error) {
  if (error instanceof HttpError) {
    sendApiError(res, error.status, error.code, error.message);
    return true;
  }
  return false;
}

/**
 * 处理 /api/conversations 与 /api/conversations/:id。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} ctx
 * @param {string[]} segments URL 分段（segments[0]='api'）
 */
export async function handleConversations(req, res, ctx, segments) {
  const store = ctx.store;
  if (!store) {
    sendApiError(res, 500, 'INTERNAL', '存储未初始化');
    return;
  }

  // /api/conversations
  if (segments.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, { conversations: store.listConversations() });
      return;
    }
    if (req.method === 'POST') {
      await handleCreate(req, res, ctx);
      return;
    }
    sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
    return;
  }

  const id = conversationIdFromSegments(segments);
  if (!id) {
    sendApiError(res, 404, 'NOT_FOUND', '会话不存在');
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const detail = store.getConversation(id);
    if (!detail) {
      sendApiError(res, 404, 'NOT_FOUND', '会话不存在');
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  if (req.method === 'PATCH') {
    let payload;
    try {
      payload = await readOptionalJson(req);
    } catch (error) {
      if (!sendRouteError(res, error)) sendApiError(res, 400, 'INVALID_REQUEST', '请求体不合法');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendApiError(res, 400, 'INVALID_REQUEST', '请求体必须是 JSON 对象');
      return;
    }
    let title;
    try {
      title = validateTitle(payload.title);
    } catch (error) {
      sendRouteError(res, error);
      return;
    }
    const updated = await store.updateConversationTitle(id, title);
    if (!updated) {
      sendApiError(res, 404, 'NOT_FOUND', '会话不存在');
      return;
    }
    sendJson(res, 200, { conversation: updated });
    return;
  }

  if (req.method === 'DELETE') {
    const removed = await store.deleteConversation(id);
    if (!removed) {
      sendApiError(res, 404, 'NOT_FOUND', '会话不存在');
      return;
    }
    // 删除会话后清理不再被引用的图片文件（失败只 warn，响应仍 200）。
    await sweepStoreAttachments({ attachments: ctx.attachments, store, logger: ctx.logger });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
}

async function handleCreate(req, res, ctx) {
  let payload;
  try {
    payload = await readOptionalJson(req);
  } catch (error) {
    if (!sendRouteError(res, error)) sendApiError(res, 400, 'INVALID_REQUEST', '请求体不合法');
    return;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    sendApiError(res, 400, 'INVALID_REQUEST', '请求体必须是 JSON 对象');
    return;
  }
  let title;
  if (payload.title !== undefined) {
    try {
      title = validateTitle(payload.title);
    } catch (error) {
      sendRouteError(res, error);
      return;
    }
  }
  const conversation = await ctx.store.createConversation(title ? { title } : {});
  sendJson(res, 201, { conversation });
}
