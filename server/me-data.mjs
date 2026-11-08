//  / 账号合规闭环 HTTP 层——同意补签、数据导出、账号注销。
// 挂载方式（Lead 在 app.mjs `/api/me` 分支接线）：
//   优先 `await handleMeData(req, res, scopedCtx, segments)`；返回 false 再交给 handleMeRoutes。
// segments 为完整路径分段（含首元素 'api'）；scopedCtx 为该用户 per-user scoped ctx
// （含 userId/user/dataDir/store/health/marks/scaleHistory/feedback/byok/usage）。
// 契约约束：导出 bundle 形状冻结（不含密码哈希/sid/apiKey/系统内部字段）；注销为软删除
// （status='deleted' + 清 passwordHash），DATA_DIR/users/<uid> 递归删除，usage 保留匿名统计。
import fs from 'node:fs/promises';
import path from 'node:path';

import { HttpError, readJsonBody, sendApiError, sendJson } from './http-utils.mjs';
import { CONSENT_VERSION, consentView } from './consent.mjs';
import { verifyPassword } from './users.mjs';
import { localDateKey } from './usage.mjs';

const ME_BODY_LIMIT = 64 * 1024;
export const EXPORT_VERSION = 'm44-1';
export const EXPORT_USAGE_DAYS = 90;

function normalizeSegments(segments) {
  const list = Array.isArray(segments) ? segments.map((part) => String(part)) : [];
  return list[0] === 'api' ? list.slice(1) : list;
}

async function readJsonObject(req) {
  const payload = await readJsonBody(req, { limit: ME_BODY_LIMIT });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'INVALID_INPUT', '请求体必须是 JSON 对象');
  }
  return payload;
}

function requireUserId(ctx) {
  const userId = typeof ctx?.userId === 'string' && ctx.userId
    ? ctx.userId
    : (typeof ctx?.user?.id === 'string' ? ctx.user.id : null);
  if (!userId) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  return userId;
}

function requireUserRecord(ctx, userId) {
  if (!ctx?.users || typeof ctx.users.get !== 'function') {
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', '用户服务未就绪');
  }
  return ctx.users.get(userId);
}

async function handleConsentPost(ctx, req, res) {
  const userId = requireUserId(ctx);
  const body = await readJsonObject(req);
  if (body.version !== CONSENT_VERSION) {
    throw new HttpError(400, 'CONSENT_VERSION_INVALID', '条款版本不匹配，请刷新页面后重试');
  }
  if (!ctx?.users || typeof ctx.users.setConsent !== 'function') {
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', '用户服务未就绪');
  }
  const at = new Date().toISOString();
  const updated = await ctx.users.setConsent(userId, { version: CONSENT_VERSION, at });
  sendJson(res, 200, { consent: consentView(updated) });
}

/** 导出 bundle 的 user 白名单字段（绝不含 passwordHash/salt/algo 等）。 */
function pickExportUser(record) {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName ?? null,
    role: record.role,
    createdAt: record.createdAt ?? null,
    lastLoginAt: record.lastLoginAt ?? null,
  };
}

/** BYOK 元数据只读视图（provider 收敛为 id；不含 apiKey/密文）。 */
async function pickByokMeta(ctx, userId) {
  if (!ctx?.byok || typeof ctx.byok.getMeta !== 'function') return null;
  const meta = await ctx.byok.getMeta(userId);
  if (!meta || meta.configured !== true) return null;
  return {
    configured: true,
    provider: meta.provider?.id ?? null,
    model: meta.model ?? null,
    keyHint: meta.keyHint ?? null,
    baseUrlOrigin: meta.baseUrlOrigin ?? null,
    updatedAt: meta.updatedAt ?? null,
  };
}

/** 近 N 天用量摘要（按 Asia/Shanghai 本地时区切日，与 usage.mjs 口径一致）。 */
async function pickUsageSummary(ctx, userId) {
  const empty = { from: null, to: null, totals: {}, bySource: null };
  if (!ctx?.usage || typeof ctx.usage.userSummary !== 'function') return empty;
  const summary = (await ctx.usage.userSummary(userId, { days: EXPORT_USAGE_DAYS })) ?? {};
  const now = new Date();
  const from = new Date(now.getTime() - (EXPORT_USAGE_DAYS - 1) * 24 * 60 * 60 * 1000);
  return {
    from: localDateKey(from),
    to: localDateKey(now),
    totals: summary.totals ?? {},
    bySource: summary.bySource ?? null,
  };
}

function pickConversations(ctx) {
  const store = ctx?.store;
  if (!store || typeof store.listConversations !== 'function') return [];
  const summaries = store.listConversations() ?? [];
  const list = [];
  for (const summary of summaries) {
    const detail = typeof store.getConversation === 'function' ? store.getConversation(summary.id) : null;
    list.push({
      id: summary.id,
      title: summary.title ?? null,
      createdAt: summary.createdAt ?? null,
      updatedAt: summary.updatedAt ?? null,
      messages: Array.isArray(detail?.messages) ? detail.messages.map((message) => ({ ...message })) : [],
    });
  }
  return list;
}

function pickMemories(ctx) {
  const store = ctx?.store;
  if (!store || typeof store.listMemories !== 'function') return [];
  return (store.listMemories() ?? []).map((memory) => ({ ...memory }));
}

function pickMarks(ctx) {
  const marks = ctx?.marks;
  if (!marks || typeof marks.list !== 'function') return { excerpts: [], favorites: [], stats: { excerpts: 0, favorites: 0 } };
  const view = marks.list() ?? {};
  return {
    excerpts: Array.isArray(view.excerpts) ? view.excerpts.map((item) => ({ ...item })) : [],
    favorites: Array.isArray(view.favorites) ? view.favorites.map((item) => ({ ...item })) : [],
    stats: view.stats ?? { excerpts: 0, favorites: 0 },
  };
}

function pickHealth(ctx) {
  const health = ctx?.health;
  const meta = health && typeof health.healthMeta === 'function' ? health.healthMeta() : {};
  const days = health?.days && typeof health.days === 'object' ? { ...health.days } : {};
  return {
    lastImportedAt: meta?.lastImportedAt ?? null,
    updatedAt: meta?.updatedAt ?? null,
    days,
  };
}

function pickScaleHistory(ctx) {
  const scaleHistory = ctx?.scaleHistory;
  if (!scaleHistory) return [];
  let entries = [];
  try {
    entries = scaleHistory.entries;
  } catch {
    entries = [];
  }
  return Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : [];
}

async function pickFeedback(ctx, userId) {
  if (!ctx?.feedback || typeof ctx.feedback.listByUser !== 'function') return [];
  const list = await ctx.feedback.listByUser(userId);
  return Array.isArray(list) ? list.map((item) => ({ ...item })) : [];
}

async function handleExport(ctx, req, res) {
  const userId = requireUserId(ctx);
  const record = await requireUserRecord(ctx, userId);
  if (!record) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  const bundle = {
    exportedAt: new Date().toISOString(),
    version: EXPORT_VERSION,
    user: pickExportUser(record),
    consent: consentView(record),
    conversations: pickConversations(ctx),
    memories: pickMemories(ctx),
    marks: pickMarks(ctx),
    health: pickHealth(ctx),
    scalesHistory: pickScaleHistory(ctx),
    feedback: await pickFeedback(ctx, userId),
    byok: await pickByokMeta(ctx, userId),
    usage: await pickUsageSummary(ctx, userId),
  };
  const filename = `ctf-export-${record.username}-${localDateKey(new Date()).replace(/-/g, '')}.json`;
  sendJson(res, 200, bundle, {
    'content-disposition': `attachment; filename="${filename}"`,
  });
}

/** 用户目录（供注销删除）：优先 scoped ctx.userDir，否则 baseDataDir/users/<uid>；防路径越界。 */
function resolveUserDir(ctx, userId) {
  if (!/^u[0-9a-f]{12}$/.test(userId)) throw new HttpError(400, 'INVALID_INPUT', '用户标识不合法');
  const baseDir = ctx?.baseDataDir ?? null;
  const candidate = typeof ctx?.userDir === 'string' && ctx.userDir
    ? ctx.userDir
    : (baseDir ? path.join(baseDir, 'users', userId) : null);
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  if (baseDir) {
    const allowedRoot = path.resolve(baseDir, 'users');
    if (resolved !== path.join(allowedRoot, userId)) {
      throw new HttpError(500, 'INTERNAL', '用户数据目录不合法');
    }
  }
  return resolved;
}

async function handleDelete(ctx, req, res) {
  const userId = requireUserId(ctx);
  const body = await readJsonObject(req);
  const record = await requireUserRecord(ctx, userId);
  if (!record) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  if (!verifyPassword(typeof body.password === 'string' ? body.password : '', record)) {
    throw new HttpError(400, 'PASSWORD_INVALID', '密码错误');
  }
  // 最后一个 active admin 禁止注销（避免无人可管理）。
  if (record.role === 'admin' && record.status === 'active') {
    const activeAdmins = typeof ctx.users.count === 'function'
      ? await ctx.users.count({ role: 'admin', status: 'active' })
      : 0;
    if (activeAdmins <= 1) throw new HttpError(409, 'LAST_ADMIN', '最后一个管理员不能注销');
  }
  // 契约顺序：吊销全部会话 → 软删除并清密码凭据 → 删除用户数据目录 → 删除本人反馈。
  if (ctx.userSessions && typeof ctx.userSessions.revokeAll === 'function') {
    await ctx.userSessions.revokeAll(userId);
  }
  if (typeof ctx.users.markDeleted !== 'function') {
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', '用户服务未就绪');
  }
  await ctx.users.markDeleted(userId);
  const userDir = resolveUserDir(ctx, userId);
  if (userDir) {
    try {
      await fs.rm(userDir, { recursive: true, force: true });
    } catch (error) {
      ctx.logger?.warn?.(`[me-data] 删除用户数据目录失败（${userId}）：${error?.message ?? error}`);
      throw new HttpError(500, 'INTERNAL', '删除用户数据失败');
    }
  }
  if (ctx.feedback && typeof ctx.feedback.deleteByUser === 'function') {
    await ctx.feedback.deleteByUser(userId);
  } else {
    ctx.logger?.warn?.('[me-data] feedback 服务缺少 deleteByUser（ 接线前降级跳过）');
  }
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

/**
 * /api/me 合规扩展路由分发。
 * @returns {Promise<boolean>} true=已处理；false=不属于本模块（交回 handleMeRoutes）
 */
export async function handleMeData(req, res, ctx, segments) {
  const route = normalizeSegments(segments);
  if (route[0] !== 'me') return false;
  const method = String(req?.method ?? 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  try {
    if (route.length === 2 && route[1] === 'consent') {
      if (method !== 'POST') return false;
      await handleConsentPost(ctx, req, res);
      return true;
    }
    if (route.length === 2 && route[1] === 'export') {
      if (!isRead) return false;
      await handleExport(ctx, req, res);
      return true;
    }
    if (route.length === 1) {
      if (method !== 'DELETE') return false;
      await handleDelete(ctx, req, res);
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof HttpError) {
      sendApiError(res, error.status, error.code, error.message);
      return true;
    }
    throw error;
  }
}
