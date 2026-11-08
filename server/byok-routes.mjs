//  / 契约 4：BYOK HTTP API（挂载于 /api/me/byok/*，由 app.mjs 在 AUTH=on 时分发完整 segments）。
//
// - GET    /api/me/byok        → {byok, presets}
// - PUT    /api/me/byok        → {byok, presets}（保存即校验 + 加密落盘，成功后更新 users.modelSource='byok'）
// - DELETE /api/me/byok        → {byok, presets}（幂等；删除后回官方模型）
// - POST   /api/me/byok/check  → {ok, latencyMs, modelCount, errorCode?}（3 次/分/用户）
//
// 中间件已保证：AUTH=on 且已登录（401）、写请求 CSRF（403）；AUTH=off 时 app.mjs 不挂载（404）。
// 红线：响应/日志永远不含明文 apiKey 或 baseUrl 路径。
import { HttpError, readJsonBody, sendApiError, sendJson } from './http-utils.mjs';
import { BYOK_PRESETS, ByokError } from './byok-providers.mjs';

const BYOK_BODY_LIMIT = 16 * 1024;
const LOG_PREFIX = '[byok-routes]';

const PRESETS_VIEW = BYOK_PRESETS.map((preset) => ({
  id: preset.id,
  label: preset.label,
  protocol: preset.protocol,
  ...(typeof preset.modelHint === 'string' ? { modelHint: preset.modelHint } : {}),
  requiresBaseUrl: preset.requiresBaseUrl === true,
}));

function normalizeSegments(segments) {
  const list = Array.isArray(segments) ? [...segments] : [];
  if (list[0] === 'api') list.shift();
  return list;
}

function emptyMeta() {
  return {
    configured: false,
    provider: null,
    model: null,
    keyHint: null,
    baseUrlOrigin: null,
    updatedAt: null,
  };
}

async function isByokEnabled(ctx) {
  try {
    if (typeof ctx?.getByokEnabled === 'function') return (await ctx.getByokEnabled()) === true;
  } catch (error) {
    ctx?.logger?.warn?.(`${LOG_PREFIX} 读取 BYOK 开关失败（按关闭处理）：${error?.message ?? error}`);
    return false;
  }
  if (ctx?.authMode !== 'on') return false;
  return ctx?.config?.byokEnabled !== false;
}

function viewOf(meta, enabled) {
  const safe = meta && typeof meta === 'object' ? meta : emptyMeta();
  return {
    enabled,
    configured: safe.configured === true,
    provider: safe.provider ?? null,
    model: safe.model ?? null,
    keyHint: safe.keyHint ?? null,
    baseUrlOrigin: safe.baseUrlOrigin ?? null,
    updatedAt: safe.updatedAt ?? null,
  };
}

function getByokService(ctx) {
  if (!ctx?.byok || typeof ctx.byok.getMeta !== 'function') {
    throw new HttpError(500, 'INTERNAL', '自定义模型服务不可用');
  }
  return ctx.byok;
}

function requireUserId(ctx) {
  if (typeof ctx?.userId !== 'string' || ctx.userId === '') {
    throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  }
  return ctx.userId;
}

async function readBody(req) {
  let body;
  try {
    body = await readJsonBody(req, { limit: BYOK_BODY_LIMIT });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_INPUT', '请求体必须是 JSON 对象');
  }
  return body;
}

async function setUserModelSource(ctx, userId, modelSource) {
  if (!ctx?.users || typeof ctx.users.update !== 'function') return;
  await ctx.users.update(userId, { modelSource });
}

async function handleGet(req, res, ctx) {
  const enabled = await isByokEnabled(ctx);
  const meta = await getByokService(ctx).getMeta(requireUserId(ctx));
  sendJson(res, 200, { byok: viewOf(meta, enabled), presets: PRESETS_VIEW });
}

async function handlePut(req, res, ctx) {
  const userId = requireUserId(ctx);
  const enabled = await isByokEnabled(ctx);
  if (!enabled) throw new HttpError(403, 'BYOK_DISABLED', '管理员已关闭自定义模型功能');

  const body = await readBody(req);
  const service = getByokService(ctx);
  let meta;
  try {
    meta = await service.set(userId, {
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    });
  } catch (error) {
    if (error instanceof ByokError || error instanceof HttpError) throw error;
    ctx?.logger?.error?.(`${LOG_PREFIX} 保存自定义模型配置失败：${error?.name ?? 'Error'}`);
    throw new HttpError(500, 'INTERNAL', '保存自定义模型配置失败');
  }

  // 契约 7：保存成功即把用户模型来源切到 byok；失败则回滚已写配置，避免半状态。
  try {
    await setUserModelSource(ctx, userId, 'byok');
  } catch (error) {
    try {
      await service.remove(userId);
    } catch {
      /* 回滚失败只记录，主错误仍为 500 */
    }
    ctx?.logger?.error?.(`${LOG_PREFIX} 更新用户模型来源失败：${error?.message ?? error}`);
    throw new HttpError(500, 'INTERNAL', '保存自定义模型配置失败');
  }

  sendJson(res, 200, { byok: viewOf(meta, enabled), presets: PRESETS_VIEW });
}

async function handleDelete(req, res, ctx) {
  const userId = requireUserId(ctx);
  const enabled = await isByokEnabled(ctx);
  const service = getByokService(ctx);
  try {
    await service.remove(userId);
  } catch (error) {
    if (error instanceof ByokError || error instanceof HttpError) throw error;
    ctx?.logger?.warn?.(`${LOG_PREFIX} 删除自定义模型配置失败：${error?.message ?? error}`);
    throw new HttpError(500, 'INTERNAL', '删除自定义模型配置失败');
  }
  try {
    await setUserModelSource(ctx, userId, 'official');
  } catch (error) {
    ctx?.logger?.warn?.(`${LOG_PREFIX} 恢复用户模型来源失败：${error?.message ?? error}`);
  }
  sendJson(res, 200, { byok: viewOf(emptyMeta(), enabled), presets: PRESETS_VIEW });
}

async function handleCheck(req, res, ctx) {
  const userId = requireUserId(ctx);
  const enabled = await isByokEnabled(ctx);
  if (!enabled) throw new HttpError(403, 'BYOK_DISABLED', '管理员已关闭自定义模型功能');
  // 管理员可关闭探活（BYOK_CHECK_ENABLED=false），关闭时统一 403。
  if (ctx?.config?.byokCheckEnabled === false) {
    throw new HttpError(403, 'BYOK_CHECK_DISABLED', '管理员已关闭自定义模型探活');
  }
  const result = await getByokService(ctx).check(userId);
  sendJson(res, 200, {
    ok: result?.ok === true,
    latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : 0,
    modelCount: Number.isFinite(result?.modelCount) ? result.modelCount : 0,
    ...(result?.ok === true || !result?.errorCode ? {} : { errorCode: result.errorCode }),
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} ctx
 * @param {string[]} segments 完整路径分段（含首元素 'api'）
 */
export async function handleByok(req, res, ctx, segments) {
  try {
    const route = normalizeSegments(segments);
    if (route[0] !== 'me' || route[1] !== 'byok') {
      throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    }
    const method = String(req?.method ?? 'GET').toUpperCase();

    if (route.length === 2) {
      if (method === 'GET' || method === 'HEAD') return await handleGet(req, res, ctx);
      if (method === 'PUT') return await handlePut(req, res, ctx);
      if (method === 'DELETE') return await handleDelete(req, res, ctx);
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不允许');
    }
    if (route.length === 3 && route[2] === 'check') {
      if (method === 'POST') return await handleCheck(req, res, ctx);
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不允许');
    }
    throw new HttpError(404, 'NOT_FOUND', '接口不存在');
  } catch (error) {
    if (error instanceof HttpError) {
      sendApiError(res, error.status, error.code, error.message);
      return;
    }
    if (error instanceof ByokError) {
      const status = Number.isInteger(error.status) && error.status >= 400 ? error.status : 400;
      sendApiError(res, status, error.code, error.message);
      return;
    }
    ctx?.logger?.error?.(`${LOG_PREFIX} 未处理异常：${error?.name ?? 'Error'}`);
    sendApiError(res, 500, 'INTERNAL', '服务器内部错误');
  }
}
