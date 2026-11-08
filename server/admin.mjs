// 管理员 API（接口契约  5）+ 邀请码 / 管理员设置存储。
// 设计要点：
//   - handler 签名 handleAdmin(req, res, ctx, segments)；segments 兼容完整形态（含首元素 'api'）。
//   - 依赖注入：ctx.users（UserService）、ctx.usage（UsageService）、ctx.feedback（FeedbackService）、
//     ctx.user（当前管理员）、ctx.baseDataDir（全局 DATA_DIR）、ctx.config、ctx.logger。
//     不直接读 users.json / usage 文件；管理数据（邀请码/设置）落 ctx.baseDataDir。
//   - 安全：handler 兜底 401/403；禁自我封禁（SELF_FORBIDDEN）、禁降级/封禁最后一个管理员（LAST_ADMIN）；
//     reset-password 临时密码仅本次响应返回、不落日志/不落盘；审计日志只记 actor/target/变更字段，不含密码。
//   - 管理员只看元数据：反馈列表含正文（管理员处理反馈所需）+ username，不读对话正文。
//   - invites：导出 createInviteStore({ dataDir, now }) 供认证注册流程复用（契约 11.6 A 方案）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  HttpError,
  readRequestBody,
  sendApiError,
  sendJson,
} from './http-utils.mjs';
import {
  cleanupExpiredAttachments,
  collectReferencedAttachmentIds,
  createAttachmentStore,
} from './attachments.mjs';
import { createAtRest } from './at-rest.mjs';
import { FEEDBACK_MAX_CHARS, FEEDBACK_STATUSES } from './feedback.mjs';

export const INVITES_FILE_NAME = 'invites.json';
export const SETTINGS_FILE_NAME = 'settings.json';
export const ADMIN_ROLES = Object.freeze(['admin', 'user']);
// 注销用户 status='deleted'，管理员可按其过滤/展示（默认列表不隐藏，便于审计/复登排查）。
export const USER_STATUSES = Object.freeze(['active', 'banned', 'deleted']);
/** 管理端 PATCH 允许设置的状态：注销走 DELETE /api/me，避免管理端误删/绕过 LAST_ADMIN。 */
const USER_PATCH_STATUSES = Object.freeze(['active', 'banned']);
export const USAGE_GROUP_BYS = Object.freeze(['user', 'model', 'day']);
export const ADMIN_MAX_RANGE_DAYS = 90;
export const DEFAULT_OVERVIEW_DAYS = 30;
export const INVITE_CODE_RE = /^i[0-9a-f]{8}$/;

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const TEMP_PASSWORD_BYTES = 12; // base64url → 16 位
const BODY_LIMIT = 64 * 1024;
const DEFAULT_QUOTA = Object.freeze({ dayTokens: 200_000, monthTokens: 2_000_000 });
const DEFAULT_RATE_LIMIT = Object.freeze({ perMinute: 20, concurrency: 2 });
const MAX_INVITE_USES = 100;
const MAX_INVITE_EXPIRES_DAYS = 365;
const MAX_USER_PAGE = 500;
const DEFAULT_FEEDBACK_PAGE = 200;

function invalid(message) {
  return new HttpError(400, 'INVALID_INPUT', message);
}

/**
 * 邀请码业务错误（400）。继承 HttpError 使认证注册侧现有的
 * `error instanceof HttpError` 分支自动映射为 400 { code, message }，无需改动他人的 auth-routes。
 */
export class InviteError extends HttpError {
  constructor(code, message) {
    super(400, code, message);
    this.name = 'InviteError';
  }
}

function numberOr0(value) {
  return Number.isFinite(value) ? value : 0;
}

function emptyTotals() {
  return {
    requests: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    cacheHitRate: null,
    models: {},
  };
}

/* ------------------------------- BYOK 管理视图（ 7） ------------------------------- */

/** 用户 BYOK 标记的空值。 */
function emptyByokView() {
  return { configured: false, providerId: null, providerLabel: null, model: null };
}

function pickText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * 用户 BYOK 概览（契约 7）：只从 ctx.byok.getMeta(userId) 取元数据。
 * ctx.byok 缺失、getMeta 抛错、返回 null/configured:false 时降级为「未配置」，不影响用户列表。
 * 只输出白名单字段，不读取/不返回任何 key、baseUrl 路径或 query 等敏感信息。
 */
async function userByokView(ctx, userId) {
  const empty = emptyByokView();
  const byok = ctx?.byok;
  if (!byok || typeof byok.getMeta !== 'function' || !userId) return empty;
  try {
    const meta = await byok.getMeta(userId);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || meta.configured === false) return empty;
    const providerRaw = meta.provider;
    const providerObject =
      providerRaw && typeof providerRaw === 'object' && !Array.isArray(providerRaw) ? providerRaw : null;
    const providerId = pickText(
      meta.providerId,
      typeof providerRaw === 'string' ? providerRaw : null,
      providerObject?.id,
    );
    const providerLabel = pickText(meta.providerLabel, providerObject?.label);
    const model = pickText(meta.model);
    const configured = meta.configured === true || providerId !== null || model !== null;
    if (!configured) return empty;
    return { configured: true, providerId, providerLabel, model };
  } catch (error) {
    warn(ctx, `读取用户 ${userId} 的 BYOK 元数据失败：${error?.message ?? error}`);
    return empty;
  }
}

/** 概览成本只统计官方来源：有 bySource.official 时取之，否则回退旧的 costUsd 字段（字段向后兼容）。 */
function officialCost(totalsLike) {
  const official = totalsLike?.bySource?.official;
  if (official && typeof official === 'object' && !Array.isArray(official)) {
    return numberOr0(official.costUsd);
  }
  return numberOr0(totalsLike?.costUsd);
}

function safeLog(ctx, level, message) {
  try {
    const fn = ctx?.logger?.[level];
    if (typeof fn === 'function') fn.call(ctx.logger, message);
  } catch {
    /* logger 自身失败不影响主流程 */
  }
}

/** 审计 detail 白名单：只留标量/字符串数组（调用方不得传入密码、key、对话正文）。 */
function sanitizeAuditDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      out[key] = value.slice(0, 50);
    }
  }
  return out;
}

/**
 * 写操作审计。保留 `[admin] ...` 日志行（旧断言兼容）；
 * ctx.audit 缺失时静默跳过（从 ctx.audit 取、缺省不阻断操作），审计失败只 warn。
 */
async function recordAudit(ctx, { action, targetType = null, targetId = null, detail = null, message }) {
  if (typeof message === 'string' && message.length > 0) safeLog(ctx, 'info', `[admin] ${message}`);
  const sink = ctx?.audit;
  if (!sink || typeof sink.append !== 'function') return null;
  try {
    const actor = ctx?.user ?? {};
    return await sink.append({
      actorId: typeof actor.id === 'string' ? actor.id : null,
      actorUsername: typeof actor.username === 'string' ? actor.username : null,
      action,
      targetType,
      targetId: typeof targetId === 'string' ? targetId : null,
      detail: sanitizeAuditDetail(detail),
    });
  } catch (error) {
    warn(ctx, `写审计日志失败（不影响操作）：${error?.message ?? error}`);
    return null;
  }
}

function warn(ctx, message) {
  safeLog(ctx, 'warn', `[admin] ${message}`);
}

/* ------------------------------- 时间工具 ------------------------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const SHANGHAI_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 统一时钟读取：可注入 ctx.now/ctx.clock（返回 Date 或时间戳），默认真实时钟。 */
function resolveDate(reader) {
  let value;
  try {
    value = typeof reader === 'function' ? reader() : reader;
  } catch {
    value = null;
  }
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function currentDate(ctx) {
  const reader =
    typeof ctx?.now === 'function' ? ctx.now : typeof ctx?.clock === 'function' ? ctx.clock : null;
  return resolveDate(reader);
}

function partValue(parts, type) {
  return parts.find((part) => part.type === type)?.value ?? '';
}

/** Asia/Shanghai 本地日期（YYYY-MM-DD），与 usage 服务切日口径一致。 */
function shanghaiDateString(date) {
  const parts = SHANGHAI_DATE_FMT.formatToParts(date);
  return `${partValue(parts, 'year')}-${partValue(parts, 'month')}-${partValue(parts, 'day')}`;
}

function dateToMs(dayString) {
  return Date.parse(`${dayString}T00:00:00Z`);
}

function msToDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function shiftDate(dayString, deltaDays) {
  return msToDateString(dateToMs(dayString) + deltaDays * DAY_MS);
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const ms = dateToMs(value);
  return Number.isFinite(ms) && msToDateString(ms) === value;
}

function daysInclusive(from, to) {
  return Math.round((dateToMs(to) - dateToMs(from)) / DAY_MS) + 1;
}

/* ------------------------------- 请求/响应工具 ------------------------------- */

function normalizeSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  return list[0] === 'api' ? list.slice(1) : list;
}

function parseUrl(req) {
  try {
    return new URL(String(req?.url ?? '/'), 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

async function readOptionalJsonBody(req, limit = BODY_LIMIT) {
  const buffer = await readRequestBody(req, { limit });
  if (buffer.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', '请求体必须是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('请求体必须是 JSON 对象');
  }
  return parsed;
}

function parseIntParam(raw, { min, max, defaultValue, name }) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return defaultValue;
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) throw invalid(`${name} 需为整数`);
  const value = Number.parseInt(text, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${name} 需为 ${min}–${max} 的整数`);
  }
  return value;
}

const PUBLIC_USER_FIELDS = Object.freeze([
  'id',
  'username',
  'displayName',
  'role',
  'status',
  'quota',
  'modelSource',
  'createdAt',
  'lastLoginAt',
]);

/** 管理员视图：只暴露 publicUser 字段，绝不带 passwordHash/salt/algo。 */
function toPublicUser(user) {
  if (!user || typeof user !== 'object') return null;
  const view = {};
  for (const field of PUBLIC_USER_FIELDS) view[field] = user[field] ?? null;
  return view;
}

function actorLabel(ctx) {
  const actor = ctx?.user ?? {};
  return String(actor.id ?? actor.username ?? 'admin');
}

/* ------------------------------- 校验工具 ------------------------------- */

function normalizeQuota(value, fieldName = 'quota') {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${fieldName} 必须是 {dayTokens,monthTokens} 对象或 null`);
  }
  const allowed = ['dayTokens', 'monthTokens'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`${fieldName} 不支持字段 ${key}`);
  }
  const result = {};
  for (const key of allowed) {
    const item = value[key];
    if (item === undefined || item === null) {
      result[key] = null;
      continue;
    }
    if (!Number.isInteger(item) || item < 1) throw invalid(`${fieldName}.${key} 需为正整数或 null`);
    result[key] = item;
  }
  return result;
}

function validatePassword(password) {
  if (typeof password !== 'string') throw invalid('密码必须是文本');
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) {
    throw invalid(`密码长度需为 ${PASSWORD_MIN}–${PASSWORD_MAX} 字符`);
  }
  return password;
}

function generateTempPassword() {
  return crypto.randomBytes(TEMP_PASSWORD_BYTES).toString('base64url'); // 16 位
}

function assertKnownKeys(body, allowed, name) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalid(`${name} 不支持字段 ${key}`);
  }
}

function requireUserService(ctx) {
  if (!ctx?.users || typeof ctx.users.get !== 'function' || typeof ctx.users.list !== 'function') {
    throw new HttpError(500, 'INTERNAL', '用户服务未初始化');
  }
  return ctx.users;
}

function requireUsageService(ctx) {
  if (!ctx?.usage || typeof ctx.usage.summary !== 'function') {
    throw new HttpError(500, 'INTERNAL', '用量服务未初始化');
  }
  return ctx.usage;
}

function requireFeedbackService(ctx) {
  if (!ctx?.feedback || typeof ctx.feedback.list !== 'function') {
    throw new HttpError(500, 'INTERNAL', '反馈服务未初始化');
  }
  return ctx.feedback;
}

/* ------------------------------- 邀请码存储 ------------------------------- */

function isValidInvite(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.code === 'string' &&
    INVITE_CODE_RE.test(entry.code) &&
    ADMIN_ROLES.includes(entry.role) &&
    Number.isInteger(entry.maxUses) &&
    entry.maxUses >= 1 &&
    Number.isInteger(entry.uses) &&
    entry.uses >= 0 &&
    (entry.createdBy === null || typeof entry.createdBy === 'string') &&
    (entry.note === null || typeof entry.note === 'string') &&
    (entry.disabled === undefined || typeof entry.disabled === 'boolean') &&
    (entry.lastUsedAt === undefined ||
      entry.lastUsedAt === null ||
      typeof entry.lastUsedAt === 'string') &&
    typeof entry.createdAt === 'string' &&
    typeof entry.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(entry.createdAt)) &&
    !Number.isNaN(Date.parse(entry.expiresAt))
  );
}

function cloneInvite(invite) {
  return { ...invite };
}

/** 兼容旧数据——补齐 disabled/lastUsedAt 默认值（旧 invite 视为启用、未使用）。 */
function normalizeInvite(invite) {
  return {
    ...invite,
    disabled: invite.disabled === true,
    lastUsedAt:
      typeof invite.lastUsedAt === 'string' && invite.lastUsedAt.length > 0 ? invite.lastUsedAt : null,
  };
}

function inviteIsExpired(invite, date) {
  const expiresAt = Date.parse(invite?.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= date.getTime();
}

function inviteIsExhausted(invite) {
  return Number.isInteger(invite?.uses) && Number.isInteger(invite?.maxUses) && invite.uses >= invite.maxUses;
}

/**
 * 邀请码存储（契约 2.4 / 11.6）：DATA_DIR/invites.json，原子写 0600 + 进程内写串行。
 * 供 admin 路由与  注册流程（auth/register）复用。
 * @param {{ dataDir: string, logger?: object, now?: () => Date }} opts
 */
export function createInviteStore({ dataDir, logger = console, now = () => new Date() } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createInviteStore 需要 dataDir');
  const rootDir = path.resolve(dataDir);
  const filePath = path.join(rootDir, INVITES_FILE_NAME);

  /** @type {Array<object>|null} */
  let invites = null;
  let loadPromise = null;
  let writeChain = Promise.resolve();

  const warnStore = (message) => {
    try {
      logger?.warn?.(`[invites] ${message}`);
    } catch {
      /* logger 自身失败不影响主流程 */
    }
  };

  const nowDate = () => resolveDate(now);

  async function loadFromDisk() {
    try {
      await fs.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      warnStore(`无法创建数据目录 ${rootDir}：${error?.message ?? error}`);
      return [];
    }
    let raw;
    try {
      raw = await fs.promises.readFile(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      warnStore(`读取 ${INVITES_FILE_NAME} 失败，按空数据处理：${error?.message ?? error}`);
      return [];
    }
    let data;
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      warnStore(`${INVITES_FILE_NAME} 解析失败，按空数据处理：${error?.message ?? error}`);
      return [];
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.invites)) {
      warnStore(`${INVITES_FILE_NAME} 结构不合法（缺少 invites 数组），按空数据处理`);
      return [];
    }
    const list = data.invites.filter(isValidInvite).map(normalizeInvite);
    if (list.length !== data.invites.length) {
      warnStore(`${INVITES_FILE_NAME} 含 ${data.invites.length - list.length} 条无效记录，已忽略`);
    }
    return list;
  }

  function ensureLoaded() {
    if (invites) return Promise.resolve();
    if (!loadPromise) {
      loadPromise = loadFromDisk().then((list) => {
        invites = list;
        return list;
      });
    }
    return loadPromise;
  }

  function persist() {
    writeChain = writeChain.then(async () => {
      try {
        await fs.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
        const payload = { version: 1, invites };
        const text = `${JSON.stringify(payload, null, 2)}\n`;
        const tmpPath = `${filePath}.tmp`;
        await fs.promises.writeFile(tmpPath, text, { encoding: 'utf8', mode: 0o600 });
        await fs.promises.rename(tmpPath, filePath);
        try {
          await fs.promises.chmod(filePath, 0o600);
        } catch {
          /* 非 POSIX 或权限不足时忽略 */
        }
      } catch (error) {
        warnStore(`写入 ${INVITES_FILE_NAME} 失败：${error?.message ?? error}`);
      }
    });
    return writeChain;
  }

  function sortedCopy() {
    // createdAt 降序；同一毫秒内按插入顺序倒序（新建在前），保证固定时钟下也确定。
    return invites
      .map((invite, index) => ({ invite, index }))
      .sort(
        (a, b) =>
          Date.parse(b.invite.createdAt) - Date.parse(a.invite.createdAt) || b.index - a.index,
      )
      .map((item) => item.invite);
  }

  function normalizeCreateInput({
    role = 'user',
    note = null,
    maxUses = 1,
    expiresInDays = 7,
    createdBy = null,
  } = {}) {
    if (!ADMIN_ROLES.includes(role)) throw invalid(`role 非法（需 ${ADMIN_ROLES.join('|')}）`);
    let normalizedNote = note ?? null;
    if (normalizedNote !== null) {
      if (typeof normalizedNote !== 'string') throw invalid('note 必须是文本或 null');
      if (Array.from(normalizedNote).length > 200) throw invalid('note 最多 200 字');
    }
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_INVITE_USES) {
      throw invalid(`maxUses 需为 1–${MAX_INVITE_USES} 的整数`);
    }
    if (
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > MAX_INVITE_EXPIRES_DAYS
    ) {
      throw invalid(`expiresInDays 需为 1–${MAX_INVITE_EXPIRES_DAYS} 的整数`);
    }
    if (createdBy !== null && typeof createdBy !== 'string') throw invalid('createdBy 必须是文本或 null');
    return { role, note: normalizedNote, maxUses, expiresInDays, createdBy };
  }

  return {
    /** 新建邀请码（同步落盘后返回）。 */
    async create(input = {}) {
      const normalized = normalizeCreateInput(input);
      await ensureLoaded();
      let code = '';
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = `i${crypto.randomBytes(4).toString('hex')}`;
        if (!invites.some((invite) => invite.code === candidate)) {
          code = candidate;
          break;
        }
      }
      if (!code) throw new HttpError(500, 'INTERNAL', '邀请码生成失败');
      const createdMs = nowDate().getTime();
      const invite = {
        code,
        role: normalized.role,
        maxUses: normalized.maxUses,
        uses: 0,
        createdBy: normalized.createdBy,
        note: normalized.note,
        createdAt: new Date(createdMs).toISOString(),
        expiresAt: new Date(createdMs + normalized.expiresInDays * DAY_MS).toISOString(),
        // 吊销用 disabled；lastUsedAt 在每次成功核销时更新。
        disabled: false,
        lastUsedAt: null,
      };
      invites.push(invite);
      await persist();
      return cloneInvite(invite);
    },

    /** 邀请码列表（新建在前）。默认只返回启用中的；includeDisabled=true 时含已吊销。 */
    async list({ includeDisabled = false } = {}) {
      await ensureLoaded();
      const rows = includeDisabled === true ? sortedCopy() : sortedCopy().filter((invite) => !invite.disabled);
      return rows.map(cloneInvite);
    },

    /**
     * 管理员编辑邀请码（允许字段 disabled/note/expiresAt/maxUses）。
     * @param {string} code
     * @param {{disabled?: boolean, note?: string|null, expiresAt?: string, maxUses?: number}} patch
     * @returns {Promise<object|null>} 更新后的邀请码；不存在返回 null
     */
    async update(code, patch = {}) {
      if (typeof code !== 'string' || code.length === 0) return null;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('邀请码更新必须是对象');
      const allowedKeys = ['disabled', 'note', 'expiresAt', 'maxUses'];
      const keys = Object.keys(patch);
      if (keys.length === 0) throw invalid('未提供要更新的字段');
      for (const key of keys) {
        if (!allowedKeys.includes(key)) throw invalid(`邀请码更新不支持字段 ${key}`);
      }
      await ensureLoaded();
      const invite = invites.find((item) => item.code === code);
      if (!invite) return null;
      const next = { ...invite };
      if ('disabled' in patch) {
        if (typeof patch.disabled !== 'boolean') throw invalid('disabled 必须是布尔值');
        next.disabled = patch.disabled;
      }
      if ('note' in patch) {
        if (patch.note !== null && typeof patch.note !== 'string') throw invalid('note 必须是文本或 null');
        if (typeof patch.note === 'string' && Array.from(patch.note).length > 200) {
          throw invalid('note 最多 200 字');
        }
        next.note = patch.note;
      }
      if ('maxUses' in patch) {
        if (!Number.isInteger(patch.maxUses) || patch.maxUses < 1 || patch.maxUses > MAX_INVITE_USES) {
          throw invalid(`maxUses 需为 1–${MAX_INVITE_USES} 的整数`);
        }
        next.maxUses = patch.maxUses;
      }
      if ('expiresAt' in patch) {
        if (typeof patch.expiresAt !== 'string' || Number.isNaN(Date.parse(patch.expiresAt))) {
          throw invalid('expiresAt 必须是合法的 ISO 时间字符串');
        }
        next.expiresAt = new Date(Date.parse(patch.expiresAt)).toISOString();
      }
      const index = invites.indexOf(invite);
      invites[index] = next;
      await persist();
      return cloneInvite(next);
    },

    /** 原样返回邀请码（含已过期/已用尽；用于区分 INVITE_* 错误码）。 */
    async get(code) {
      if (typeof code !== 'string' || code.length === 0) return null;
      await ensureLoaded();
      const found = invites.find((invite) => invite.code === code);
      return found ? cloneInvite(found) : null;
    },

    /** 存在且未吊销、未过期且 uses < maxUses 时返回邀请码，否则 null。 */
    async getValid(code) {
      if (typeof code !== 'string' || code.length === 0) return null;
      await ensureLoaded();
      const invite = invites.find((item) => item.code === code);
      if (!invite) return null;
      if (invite.disabled === true) return null;
      if (inviteIsExpired(invite, nowDate())) return null;
      if (inviteIsExhausted(invite)) return null;
      return cloneInvite(invite);
    },

    /**
     * 原子核销：有效则 uses+1、lastUsedAt=now 落盘并返回。
     * 已吊销抛 InviteError(INVITE_REVOKED)（注册侧可直接映射 400）；其余无效情况返回 null。
     */
    async redeem(code) {
      if (typeof code !== 'string' || code.length === 0) return null;
      await ensureLoaded();
      const invite = invites.find((item) => item.code === code);
      if (!invite) return null;
      if (invite.disabled === true) {
        throw new InviteError('INVITE_REVOKED', '邀请码已被吊销');
      }
      if (inviteIsExpired(invite, nowDate())) return null;
      if (inviteIsExhausted(invite)) return null;
      invite.uses += 1;
      invite.lastUsedAt = nowDate().toISOString();
      await persist();
      return cloneInvite(invite);
    },
  };
}

/* ------------------------------- 管理员设置存储 ------------------------------- */

/**
 * 管理员设置存储：DATA_DIR/settings.json `{version:1, ...}`，原子写 0600 + 写串行。
 * 仅存管理员可改的三个键（byokEnabled/defaultQuota/webSearchPerUserPerDay）；其余来自 config。
 * @param {{ dataDir: string, logger?: object, now?: () => Date }} opts
 */
export function createSettingsStore({ dataDir, logger = console, now = () => new Date() } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createSettingsStore 需要 dataDir');
  const rootDir = path.resolve(dataDir);
  const filePath = path.join(rootDir, SETTINGS_FILE_NAME);
  const SETTING_KEYS = Object.freeze(['byokEnabled', 'defaultQuota', 'webSearchPerUserPerDay']);

  /** @type {object|null} */
  let stored = null;
  let loadPromise = null;
  let writeChain = Promise.resolve();

  const warnStore = (message) => {
    try {
      logger?.warn?.(`[settings] ${message}`);
    } catch {
      /* logger 自身失败不影响主流程 */
    }
  };

  async function loadFromDisk() {
    try {
      await fs.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      warnStore(`无法创建数据目录 ${rootDir}：${error?.message ?? error}`);
      return {};
    }
    let raw;
    try {
      raw = await fs.promises.readFile(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      warnStore(`读取 ${SETTINGS_FILE_NAME} 失败，按默认处理：${error?.message ?? error}`);
      return {};
    }
    let data;
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      warnStore(`${SETTINGS_FILE_NAME} 解析失败，按默认处理：${error?.message ?? error}`);
      return {};
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      warnStore(`${SETTINGS_FILE_NAME} 结构不合法，按默认处理`);
      return {};
    }
    const clean = {};
    for (const key of SETTING_KEYS) {
      if (Object.hasOwn(data, key)) clean[key] = data[key];
    }
    if (typeof data.updatedAt === 'string') clean.updatedAt = data.updatedAt;
    if (typeof data.updatedBy === 'string') clean.updatedBy = data.updatedBy;
    return clean;
  }

  function ensureLoaded() {
    if (stored) return Promise.resolve();
    if (!loadPromise) {
      loadPromise = loadFromDisk().then((data) => {
        stored = data;
        return data;
      });
    }
    return loadPromise;
  }

  function persist() {
    writeChain = writeChain.then(async () => {
      try {
        await fs.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
        const payload = { version: 1, ...stored };
        const text = `${JSON.stringify(payload, null, 2)}\n`;
        const tmpPath = `${filePath}.tmp`;
        await fs.promises.writeFile(tmpPath, text, { encoding: 'utf8', mode: 0o600 });
        await fs.promises.rename(tmpPath, filePath);
        try {
          await fs.promises.chmod(filePath, 0o600);
        } catch {
          /* 非 POSIX 或权限不足时忽略 */
        }
      } catch (error) {
        warnStore(`写入 ${SETTINGS_FILE_NAME} 失败：${error?.message ?? error}`);
      }
    });
    return writeChain;
  }

  return {
    /** 已保存的管理员设置（未保存的键不出现）。 */
    async read() {
      await ensureLoaded();
      return { ...stored };
    },

    /** 合并写入（仅 byokEnabled/defaultQuota/webSearchPerUserPerDay），落盘后返回全量已存设置。 */
    async patch(patch = {}, { updatedBy = null } = {}) {
      await ensureLoaded();
      const next = { ...stored };
      for (const key of SETTING_KEYS) {
        if (Object.hasOwn(patch, key)) next[key] = patch[key];
      }
      next.updatedAt = resolveDate(now).toISOString();
      if (typeof updatedBy === 'string' && updatedBy.length > 0) next.updatedBy = updatedBy;
      stored = next;
      await persist();
      return { ...stored };
    },
  };
}

/* ------------------------------- store 实例缓存（按 dataDir 复用，保证写串行） ------------------------------- */

const INVITE_STORES = new Map();
const SETTINGS_STORES = new Map();

function getInviteStore(ctx) {
  // 测试可注入 ctx.inviteStore；集成链路用 createInviteStore 自行实例化。
  if (ctx?.inviteStore && typeof ctx.inviteStore.create === 'function') return ctx.inviteStore;
  const dataDir = ctx?.baseDataDir;
  if (!dataDir || typeof dataDir !== 'string') {
    throw new HttpError(500, 'INTERNAL', '缺少 baseDataDir');
  }
  let store = INVITE_STORES.get(dataDir);
  if (!store) {
    store = createInviteStore({
      dataDir,
      logger: ctx?.logger ?? console,
      now: () => currentDate(ctx),
    });
    INVITE_STORES.set(dataDir, store);
  }
  return store;
}

function getSettingsStore(ctx) {
  if (ctx?.settingsStore && typeof ctx.settingsStore.patch === 'function') return ctx.settingsStore;
  const dataDir = ctx?.baseDataDir;
  if (!dataDir || typeof dataDir !== 'string') {
    throw new HttpError(500, 'INTERNAL', '缺少 baseDataDir');
  }
  let store = SETTINGS_STORES.get(dataDir);
  if (!store) {
    store = createSettingsStore({
      dataDir,
      logger: ctx?.logger ?? console,
      now: () => currentDate(ctx),
    });
    SETTINGS_STORES.set(dataDir, store);
  }
  return store;
}

/* ------------------------------- 管理员设置视图 ------------------------------- */

function configOf(ctx) {
  return ctx?.config && typeof ctx.config === 'object' ? ctx.config : {};
}

/** 默认设置（来自冻结的 config 形状，契约 11.6.3）。 */
function defaultsFromConfig(ctx) {
  const config = configOf(ctx);
  const quotaConfig = config.quota && typeof config.quota === 'object' ? config.quota : DEFAULT_QUOTA;
  const defaultQuota = {
    dayTokens: Number.isInteger(quotaConfig.dayTokens) ? quotaConfig.dayTokens : DEFAULT_QUOTA.dayTokens,
    monthTokens: Number.isInteger(quotaConfig.monthTokens)
      ? quotaConfig.monthTokens
      : DEFAULT_QUOTA.monthTokens,
  };
  const rateConfig = config.rateLimit && typeof config.rateLimit === 'object' ? config.rateLimit : DEFAULT_RATE_LIMIT;
  const allowedModels = Array.isArray(config.allowedModels)
    ? config.allowedModels.filter((model) => typeof model === 'string' && model.length > 0)
    : [];
  const priceVersion =
    typeof config.priceVersion === 'string' && config.priceVersion.length > 0
      ? config.priceVersion
      : typeof config.priceTable?.version === 'string'
        ? config.priceTable.version
        : null;
  return {
    // 契约 7：settings.byokEnabled 生效值 = stored ?? config.byokEnabled（存储值在 readSettingsView 覆盖）。
    byokEnabled: typeof config.byokEnabled === 'boolean' ? config.byokEnabled : false,
    defaultQuota,
    allowedModels,
    rateLimit: {
      perMinute: Number.isInteger(rateConfig.perMinute) ? rateConfig.perMinute : DEFAULT_RATE_LIMIT.perMinute,
      concurrency: Number.isInteger(rateConfig.concurrency)
        ? rateConfig.concurrency
        : DEFAULT_RATE_LIMIT.concurrency,
    },
    priceVersion,
    webSearchPerUserPerDay: Number.isInteger(config.webSearchPerUserPerDay)
      ? config.webSearchPerUserPerDay
      : null,
  };
}

async function readSettingsView(ctx) {
  const base = defaultsFromConfig(ctx);
  const stored = await getSettingsStore(ctx).read();
  const storedQuota =
    stored.defaultQuota && typeof stored.defaultQuota === 'object' && !Array.isArray(stored.defaultQuota)
      ? stored.defaultQuota
      : null;
  const defaultQuota = storedQuota
    ? {
        dayTokens: storedQuota.dayTokens ?? null,
        monthTokens: storedQuota.monthTokens ?? null,
      }
    : base.defaultQuota;
  return {
    byokEnabled: typeof stored.byokEnabled === 'boolean' ? stored.byokEnabled : base.byokEnabled,
    defaultQuota,
    allowedModels: base.allowedModels,
    rateLimit: base.rateLimit,
    // 契约 5 settings 同时列出 defaultQuota 与 quota；quota 为生效默认配额的别名。
    quota: { ...defaultQuota },
    priceVersion: base.priceVersion,
    webSearchPerUserPerDay: Object.hasOwn(stored, 'webSearchPerUserPerDay')
      ? stored.webSearchPerUserPerDay
      : base.webSearchPerUserPerDay,
  };
}

/* ------------------------------- 聚合辅助 ------------------------------- */

function emptyUsage30d() {
  return { requests: 0, tokens: 0, costUsd: 0, cacheHitRate: null };
}

async function userUsage30d(ctx, userId) {
  if (!ctx?.usage || typeof ctx.usage.userSummary !== 'function') return emptyUsage30d();
  try {
    const summary = await ctx.usage.userSummary(userId, { days: 30 });
    const totals = summary?.totals ?? {};
    return {
      requests: numberOr0(totals.requests),
      tokens: numberOr0(totals.tokens),
      costUsd: numberOr0(totals.costUsd),
      cacheHitRate: totals.cacheHitRate ?? null,
    };
  } catch (error) {
    warn(ctx, `读取用户 ${userId} 近 30 天用量失败：${error?.message ?? error}`);
    return emptyUsage30d();
  }
}

async function usernameOf(ctx, userId) {
  if (!ctx?.users || typeof ctx.users.get !== 'function') return null;
  try {
    const user = await ctx.users.get(userId);
    return user?.username ?? null;
  } catch {
    return null;
  }
}

async function countAdmins(ctx) {
  const users = requireUserService(ctx);
  if (typeof users.count === 'function') {
    return users.count({ role: 'admin' });
  }
  const list = await users.list({});
  return (Array.isArray(list) ? list : []).filter((user) => user?.role === 'admin').length;
}

async function enrichFeedback(ctx, entry) {
  return { ...entry, username: await usernameOf(ctx, entry?.userId) };
}

/* ------------------------------- 各端点实现 ------------------------------- */

async function adminOverview(req, res, ctx) {
  const url = parseUrl(req);
  const days = parseIntParam(url.searchParams.get('days'), {
    min: 1,
    max: ADMIN_MAX_RANGE_DAYS,
    defaultValue: DEFAULT_OVERVIEW_DAYS,
    name: 'days',
  });
  const usage = requireUsageService(ctx);
  const users = requireUserService(ctx);
  const nowDate = currentDate(ctx);
  const today = shanghaiDateString(nowDate);
  const from = shiftDate(today, -(days - 1));

  const [todaySummary, rangeSummary, userList] = await Promise.all([
    usage.summary({ from: today, to: today, groupBy: 'day' }),
    usage.summary({ from, to: today, groupBy: 'day' }),
    users.list({}),
  ]);
  const todayTotals = todaySummary?.totals ?? emptyTotals();
  const rows = Array.isArray(rangeSummary?.rows) ? rangeSummary.rows : [];
  const series = rows.map((row) => ({
    date: String(row?.key ?? ''),
    requests: numberOr0(row?.requests),
    tokens: numberOr0(row?.tokens),
    //  7：官方成本估算排除 BYOK（byok costUsd=null），有 bySource 时只读 official。
    costUsd: officialCost(row),
  }));

  const allUsers = Array.isArray(userList) ? userList : [];
  let activeUsers = 0;
  for (const user of allUsers) {
    if (!user?.id) continue;
    if (typeof usage.userSummary !== 'function') break;
    try {
      const summary = await usage.userSummary(user.id, { days: 1 });
      if (numberOr0(summary?.totals?.requests) > 0) activeUsers += 1;
    } catch {
      /* 单用户用量读取失败不影响概览 */
    }
  }

  let feedbackCounts = { open: 0, total: 0 };
  if (ctx.feedback && typeof ctx.feedback.counts === 'function') {
    try {
      const counts = await ctx.feedback.counts();
      feedbackCounts = { open: numberOr0(counts?.open), total: numberOr0(counts?.total) };
    } catch (error) {
      warn(ctx, `读取反馈计数失败：${error?.message ?? error}`);
    }
  }

  sendJson(res, 200, {
    today: {
      requests: numberOr0(todayTotals.requests),
      tokens: numberOr0(todayTotals.tokens),
      //  7：概览成本只算 official；requests/tokens 等旧字段口径不变。
      costUsd: officialCost(todayTotals),
      cacheHitRate: todayTotals.cacheHitRate ?? null,
      activeUsers,
    },
    series,
    users: {
      total: allUsers.length,
      active: allUsers.filter((user) => user?.status === 'active').length,
      banned: allUsers.filter((user) => user?.status === 'banned').length,
    },
    feedback: feedbackCounts,
  });
}

async function adminUsersList(req, res, ctx) {
  const url = parseUrl(req);
  const users = requireUserService(ctx);
  const queryRaw = url.searchParams.get('query');
  const query = typeof queryRaw === 'string' && queryRaw.trim().length > 0 ? queryRaw.trim() : null;
  const statusRaw = url.searchParams.get('status');
  const status = typeof statusRaw === 'string' && statusRaw.trim().length > 0 ? statusRaw.trim() : null;
  if (status !== null && !USER_STATUSES.includes(status)) {
    throw invalid(`status 非法（需 ${USER_STATUSES.join('|')}）`);
  }
  // 可选分页（limit 1-100、offset>=0）。无 limit 时返回全部过滤结果（旧行为不变）。
  const limit = parseIntParam(url.searchParams.get('limit'), {
    min: 1,
    max: 100,
    defaultValue: null,
    name: 'limit',
  });
  const offset = parseIntParam(url.searchParams.get('offset'), {
    min: 0,
    max: 1_000_000,
    defaultValue: 0,
    name: 'offset',
  });
  const list = await users.list({ query, status });
  const all = Array.isArray(list) ? list : [];
  const total = all.length;
  const page = limit === null ? all : all.slice(offset, offset + limit);
  const rows = await Promise.all(
    page.map(async (user) => ({
      ...toPublicUser(user),
      usage30d: await userUsage30d(ctx, user?.id),
      //  7：BYOK 标记只给 provider/model 级元数据（来源 ctx.byok.getMeta，缺失/异常降级未配置）。
      byok: await userByokView(ctx, user?.id),
    })),
  );
  // total 恒为「过滤后总数」（query/status 先过滤再分页），供前端显示「共 N 位用户」。
  sendJson(res, 200, limit === null ? { users: rows, total } : { users: rows, total, limit, offset });
}

async function adminUserPatch(req, res, ctx, targetId) {
  const actor = ctx.user;
  const users = requireUserService(ctx);
  if (!targetId) throw invalid('缺少用户 id');
  const body = await readOptionalJsonBody(req);
  assertKnownKeys(body, ['status', 'role', 'quota', 'displayName'], '用户更新');
  if (Object.keys(body).length === 0) throw invalid('未提供要更新的字段');

  const target = await users.get(targetId);
  if (!target) throw new HttpError(404, 'NOT_FOUND', '用户不存在');

  const patch = {};
  if (Object.hasOwn(body, 'status')) {
    if (!USER_PATCH_STATUSES.includes(body.status)) {
      throw invalid(`status 非法（需 ${USER_PATCH_STATUSES.join('|')}）`);
    }
    patch.status = body.status;
  }
  if (Object.hasOwn(body, 'role')) {
    if (!ADMIN_ROLES.includes(body.role)) throw invalid(`role 非法（需 ${ADMIN_ROLES.join('|')}）`);
    patch.role = body.role;
  }
  if (Object.hasOwn(body, 'quota')) patch.quota = normalizeQuota(body.quota);
  if (Object.hasOwn(body, 'displayName')) {
    if (body.displayName !== null) {
      if (typeof body.displayName !== 'string') throw invalid('displayName 必须是文本或 null');
      const trimmed = body.displayName.trim();
      const length = Array.from(trimmed).length;
      if (length < 1 || length > 64) throw invalid('displayName 需为 1–64 字');
      patch.displayName = trimmed;
    } else {
      patch.displayName = null;
    }
  }

  let adminCount = null;
  const needAdminCount =
    (patch.status === 'banned' && target.role === 'admin') ||
    (patch.role !== undefined && target.role === 'admin' && patch.role !== 'admin');
  if (patch.status === 'banned' && target.id === actor.id) {
    throw new HttpError(400, 'SELF_FORBIDDEN', '不能封禁自己');
  }
  if (needAdminCount) adminCount = await countAdmins(ctx);
  if (patch.status === 'banned' && target.role === 'admin' && adminCount !== null && adminCount <= 1) {
    throw new HttpError(400, 'LAST_ADMIN', '不能封禁最后一个管理员');
  }
  if (
    patch.role !== undefined &&
    target.role === 'admin' &&
    patch.role !== 'admin' &&
    adminCount !== null &&
    adminCount <= 1
  ) {
    throw new HttpError(400, 'LAST_ADMIN', '不能降级最后一个管理员');
  }

  const updated = await users.update(targetId, patch);
  if (!updated) throw new HttpError(404, 'NOT_FOUND', '用户不存在');
  await recordAudit(ctx, {
    action: 'user.update',
    targetType: 'user',
    targetId,
    detail: { fields: Object.keys(patch) },
    message: `action=user.update actor=${actorLabel(ctx)} target=${targetId} fields=${Object.keys(patch).join(',')}`,
  });
  sendJson(res, 200, { user: toPublicUser(updated) });
}

async function adminUserResetPassword(req, res, ctx, targetId) {
  const users = requireUserService(ctx);
  if (!targetId) throw invalid('缺少用户 id');
  const target = await users.get(targetId);
  if (!target) throw new HttpError(404, 'NOT_FOUND', '用户不存在');

  const body = await readOptionalJsonBody(req);
  assertKnownKeys(body, ['password'], '重置密码');
  let providedPassword = null;
  if (Object.hasOwn(body, 'password')) providedPassword = validatePassword(body.password);
  const password = providedPassword ?? generateTempPassword();
  const updated = await users.setPassword(targetId, password);
  if (!updated) throw new HttpError(404, 'NOT_FOUND', '用户不存在');
  const mode = providedPassword === null ? 'generated' : 'provided';
  await recordAudit(ctx, {
    action: 'user.reset_password',
    targetType: 'user',
    targetId,
    detail: { mode },
    message: `action=user.resetPassword actor=${actorLabel(ctx)} target=${targetId} mode=${mode}`,
  });
  const payload = { user: toPublicUser(updated) };
  if (providedPassword === null) payload.tempPassword = password; // 仅本次返回，不落日志
  sendJson(res, 200, payload);
}

async function adminInvitesCreate(req, res, ctx) {
  const store = getInviteStore(ctx);
  const body = await readOptionalJsonBody(req);
  assertKnownKeys(body, ['role', 'note', 'maxUses', 'expiresInDays'], '邀请码创建');
  const invite = await store.create({
    role: Object.hasOwn(body, 'role') ? body.role : 'user',
    note: Object.hasOwn(body, 'note') ? body.note : null,
    maxUses: Object.hasOwn(body, 'maxUses') ? body.maxUses : 1,
    expiresInDays: Object.hasOwn(body, 'expiresInDays') ? body.expiresInDays : 7,
    createdBy: actorLabel(ctx),
  });
  await recordAudit(ctx, {
    action: 'invite.create',
    targetType: 'invite',
    targetId: invite.code,
    detail: { role: invite.role, maxUses: invite.maxUses },
    message: `action=invite.create actor=${actorLabel(ctx)} code=${invite.code} role=${invite.role} maxUses=${invite.maxUses}`,
  });
  sendJson(res, 201, { invite });
}

async function adminInvitesList(req, res, ctx) {
  const url = parseUrl(req);
  const includeRaw = url.searchParams.get('include');
  const include =
    typeof includeRaw === 'string' && includeRaw.trim().length > 0 ? includeRaw.trim() : 'active';
  //  / 4：默认只列启用中的；?include=all 含已吊销。
  if (!['all', 'active'].includes(include)) throw invalid('include 非法（需 all|active）');
  const store = getInviteStore(ctx);
  const invites = await store.list({ includeDisabled: include === 'all' });
  sendJson(res, 200, { invites });
}

const INVITE_UPDATE_FIELDS = Object.freeze(['disabled', 'note', 'expiresAt', 'maxUses']);

/**  / 4：PATCH /api/admin/invites/:code —— 编辑邀请码（含吊销 disabled=true）。 */
async function adminInvitesPatch(req, res, ctx, code) {
  if (typeof code !== 'string' || code.length === 0) throw invalid('缺少邀请码');
  if (!INVITE_CODE_RE.test(code)) throw invalid('邀请码格式非法');
  const body = await readOptionalJsonBody(req);
  assertKnownKeys(body, INVITE_UPDATE_FIELDS, '邀请码更新');
  if (Object.keys(body).length === 0) throw invalid('未提供要更新的字段');
  const invite = await getInviteStore(ctx).update(code, body);
  if (!invite) throw new HttpError(404, 'INVITE_NOT_FOUND', '邀请码不存在');
  await recordAudit(ctx, {
    action: 'invite.update',
    targetType: 'invite',
    targetId: code,
    detail: { fields: Object.keys(body), disabled: invite.disabled === true },
    message: `action=invite.update actor=${actorLabel(ctx)} code=${code} fields=${Object.keys(body).join(',')} disabled=${invite.disabled === true}`,
  });
  sendJson(res, 200, { invite });
}

/**  / 4：DELETE /api/admin/invites/:code —— 吊销（= disabled:true，返回更新后的邀请码）。 */
async function adminInvitesDelete(req, res, ctx, code) {
  if (typeof code !== 'string' || code.length === 0) throw invalid('缺少邀请码');
  if (!INVITE_CODE_RE.test(code)) throw invalid('邀请码格式非法');
  const invite = await getInviteStore(ctx).update(code, { disabled: true });
  if (!invite) throw new HttpError(404, 'INVITE_NOT_FOUND', '邀请码不存在');
  await recordAudit(ctx, {
    action: 'invite.update',
    targetType: 'invite',
    targetId: code,
    detail: { revoked: true, disabled: true },
    message: `action=invite.update actor=${actorLabel(ctx)} code=${code} revoked=true`,
  });
  sendJson(res, 200, { invite });
}

/* ------------------------- 审计 / 系统状态 / 维护 ------------------------- */

const AUDIT_LIMIT_DEFAULT = 20;
const AUDIT_LIMIT_MAX = 100;
const DATA_METRICS_CACHE_MS = 60_000;
/** @type {Map<string, {at:number, value:{dirBytes:number,files:number,userCount:number}}>} */
const DATA_METRICS_CACHE = new Map();

/** GET /api/admin/audit?limit&cursor —— 时间倒序分页，cursor=上一页最后 entry.id。 */
async function adminAuditList(req, res, ctx) {
  const url = parseUrl(req);
  const limit = parseIntParam(url.searchParams.get('limit'), {
    min: 1,
    max: AUDIT_LIMIT_MAX,
    defaultValue: AUDIT_LIMIT_DEFAULT,
    name: 'limit',
  });
  const cursorRaw = url.searchParams.get('cursor');
  const cursor =
    typeof cursorRaw === 'string' && cursorRaw.trim().length > 0 ? cursorRaw.trim() : null;
  const sink = ctx?.audit;
  // ctx.audit 缺失时降级为空列表（Lead 在 app.mjs 接线；测试可注入 fake/真实 audit）。
  if (!sink || typeof sink.list !== 'function') {
    sendJson(res, 200, { entries: [], nextCursor: null });
    return;
  }
  const page = await sink.list({ limit, cursor });
  sendJson(res, 200, {
    entries: Array.isArray(page?.entries) ? page.entries : [],
    nextCursor: page?.nextCursor ?? null,
  });
}

/** 递归统计目录文件数与字节数（跳过符号链接；单文件失败跳过）。 */
async function measureDirMetrics(rootPath) {
  let files = 0;
  let dirBytes = 0;
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of entries) {
      const fullPath = path.join(current, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!dirent.isFile()) continue;
      files += 1;
      try {
        const stat = await fs.promises.stat(fullPath);
        if (Number.isFinite(stat.size)) dirBytes += stat.size;
      } catch {
        /* 单文件读取失败跳过 */
      }
    }
  }
  return { dirBytes, files };
}

/** data 指标（dirBytes/files/userCount）60s 进程内缓存，避免管理页高频扫描。 */
async function dataMetrics(ctx) {
  const baseDataDir =
    typeof ctx?.baseDataDir === 'string' && ctx.baseDataDir.length > 0
      ? path.resolve(ctx.baseDataDir)
      : null;
  if (!baseDataDir) return { dirBytes: 0, files: 0, userCount: 0 };
  const nowMs = currentDate(ctx).getTime();
  const cached = DATA_METRICS_CACHE.get(baseDataDir);
  if (cached && Number.isFinite(cached.at) && nowMs - cached.at >= 0 && nowMs - cached.at < DATA_METRICS_CACHE_MS) {
    return { ...cached.value };
  }
  let userCount = 0;
  try {
    if (ctx?.users && typeof ctx.users.count === 'function') {
      userCount = numberOr0(await ctx.users.count({}));
    } else if (ctx?.users && typeof ctx.users.list === 'function') {
      const list = await ctx.users.list({});
      userCount = Array.isArray(list) ? list.length : 0;
    }
  } catch (error) {
    warn(ctx, `统计用户数失败：${error?.message ?? error}`);
  }
  let measured = { dirBytes: 0, files: 0 };
  try {
    measured = await measureDirMetrics(baseDataDir);
  } catch (error) {
    warn(ctx, `统计数据目录大小失败：${error?.message ?? error}`);
  }
  const value = { dirBytes: measured.dirBytes, files: measured.files, userCount };
  DATA_METRICS_CACHE.set(baseDataDir, { at: nowMs, value });
  return { ...value };
}

/** 磁盘信息（statfs；失败返回 null，管理页显示「不可用」）。 */
function diskMetrics(ctx) {
  const target =
    typeof ctx?.baseDataDir === 'string' && ctx.baseDataDir.length > 0
      ? path.resolve(ctx.baseDataDir)
      : process.cwd();
  try {
    const stat = fs.statfsSync(target);
    const blockSize = numberOr0(stat.bsize);
    const totalBytes = blockSize * numberOr0(stat.blocks);
    const freeBytes = blockSize * numberOr0(stat.bavail);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
    return { path: target, totalBytes, freeBytes, usedBytes, usedPercent };
  } catch (error) {
    warn(ctx, `读取磁盘信息失败：${error?.message ?? error}`);
    return null;
  }
}

/** 备份状态（config.backupDir 下最近的 YYYYMMDD-* 目录；未配置时返回空对象字段）。 */
function backupInfo(ctx) {
  const config = ctx?.config ?? {};
  const dirRaw = typeof config.backupDir === 'string' ? config.backupDir.trim() : '';
  if (dirRaw.length === 0) return { dir: '', lastAt: null, lastPath: null, entries: 0 };
  const dir = path.resolve(dirRaw);
  let dirents = [];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    warn(ctx, `读取备份目录失败：${error?.message ?? error}`);
    return { dir, lastAt: null, lastPath: null, entries: 0 };
  }
  const names = dirents
    .filter((dirent) => dirent.isDirectory() && /^\d{8}-/.test(dirent.name))
    .map((dirent) => dirent.name)
    .sort((a, b) => b.localeCompare(a));
  if (names.length === 0) return { dir, lastAt: null, lastPath: null, entries: 0 };
  const lastPath = path.join(dir, names[0]);
  let lastAt = null;
  try {
    lastAt = fs.statSync(lastPath).mtime.toISOString();
  } catch {
    /* 备份目录读取失败则 lastAt 保持 null */
  }
  return { dir, lastAt, lastPath, entries: names.length };
}

/** effective（进程生效的模型/限流策略/白名单/配额等只读配置）。 */
function effectiveSettings(ctx) {
  const config = ctx?.config ?? {};
  const textList = (value) =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  return {
    model: typeof config.model === 'string' ? config.model : null,
    peakPolicy: typeof config.peakModelPolicy === 'string' ? config.peakModelPolicy : 'off',
    peakModel: typeof config.peakModel === 'string' ? config.peakModel : null,
    peakHours: typeof config.peakHoursUtc === 'string' ? config.peakHoursUtc : null,
    byokCheckEnabled:
      typeof config.byokCheckEnabled === 'boolean' ? config.byokCheckEnabled : true,
    allowlists: {
      models: textList(config.byokAllowedModels),
      hosts: textList(config.byokAllowedHosts),
    },
    webSearchPerUserPerDay: Number.isInteger(config.webSearchPerUserPerDay)
      ? config.webSearchPerUserPerDay
      : null,
    attachmentRetentionDays: Number.isInteger(config.attachmentRetentionDays)
      ? config.attachmentRetentionDays
      : 0,
  };
}

/** GET /api/admin/system —— 系统状态（版本/运行时长/磁盘/内存/数据/备份/生效配置）。 */
async function adminSystem(req, res, ctx) {
  const memory = process.memoryUsage();
  const startedAtMs = Number.isFinite(ctx?.startedAt) ? ctx.startedAt : null;
  const nowMs = currentDate(ctx).getTime();
  const uptimeSec =
    startedAtMs !== null
      ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
      : Math.floor(process.uptime());
  const versionValue = ctx?.version;
  const version =
    typeof versionValue === 'string'
      ? versionValue
      : typeof versionValue?.version === 'string'
        ? versionValue.version
        : null;
  sendJson(res, 200, {
    version,
    startedAt: startedAtMs !== null ? new Date(startedAtMs).toISOString() : null,
    uptimeSec,
    node: process.version,
    platform: process.platform,
    disk: diskMetrics(ctx),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
    },
    data: await dataMetrics(ctx),
    backup: backupInfo(ctx),
    effective: effectiveSettings(ctx),
  });
}

/** 读取单个 JSON 数据文件（at-rest 开启时先解密；ENOENT/损坏返回 null 并 warn）。 */
async function readJsonDataFile(ctx, filePath, atRest) {
  let raw;
  try {
    raw = await fs.promises.readFile(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(ctx, `读取 ${filePath} 失败：${error?.code ?? error?.message ?? error}`);
    return null;
  }
  try {
    const plain = atRest ? atRest.unseal(filePath, raw) : raw;
    return JSON.parse(plain.toString('utf8'));
  } catch (error) {
    warn(ctx, `解析 ${filePath} 失败（跳过）：${error?.message ?? error}`);
    return null;
  }
}

/**
 * 收集整个 DATA_DIR（基础目录 + 每个用户目录）中会话/记忆引用的附件 id。
 * 直接读文件而不 createStore：避免实例锁与 exit 监听器泄漏；at-rest 时用 createAtRest 解密。
 */
async function collectAllAttachmentReferences(ctx, userList) {
  const references = { conversations: [], memories: [] };
  const baseDataDir =
    typeof ctx?.baseDataDir === 'string' && ctx.baseDataDir.length > 0
      ? path.resolve(ctx.baseDataDir)
      : null;
  const dirs = [];
  if (baseDataDir) dirs.push(baseDataDir);
  for (const user of Array.isArray(userList) ? userList : []) {
    if (!user || typeof user.id !== 'string' || user.id.length === 0) continue;
    if (baseDataDir) dirs.push(path.join(baseDataDir, 'users', user.id));
  }
  const seen = new Set();
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let atRest = null;
    const key = ctx?.atRestKey;
    if (Buffer.isBuffer(key) && key.length === 32) {
      try {
        atRest = createAtRest({ key, dataDir: resolved, logger: ctx?.logger ?? console });
      } catch {
        atRest = null;
      }
    }
    const conversationsDir = path.join(resolved, 'conversations');
    let names = [];
    try {
      names = await fs.promises.readdir(conversationsDir);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        warn(ctx, `读取 ${conversationsDir} 失败：${error?.code ?? error?.message ?? error}`);
      }
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const record = await readJsonDataFile(ctx, path.join(conversationsDir, name), atRest);
      if (record && Array.isArray(record.messages)) references.conversations.push(record);
    }
    const memoriesData = await readJsonDataFile(ctx, path.join(resolved, 'memories.json'), atRest);
    if (memoriesData && Array.isArray(memoriesData.memories)) {
      references.memories.push(...memoriesData.memories);
    }
  }
  return references;
}

/**
 * POST /api/admin/maintenance/sweep-attachments
 * body {maxAgeDays?}；默认 config.attachmentRetentionDays（0 → 400 MAINTENANCE_DISABLED）。
 * 只删除「全库无引用 + mtime 超龄」附件；返回 {removed,bytes} 并写审计。
 */
async function adminMaintenanceSweepAttachments(req, res, ctx) {
  const body = await readOptionalJsonBody(req);
  assertKnownKeys(body, ['maxAgeDays'], '附件清理');
  const config = ctx?.config ?? {};
  let maxAgeDays;
  if (Object.hasOwn(body, 'maxAgeDays')) {
    const value = body.maxAgeDays;
    if (!Number.isInteger(value) || value < 0) throw invalid('maxAgeDays 需为非负整数');
    maxAgeDays = value;
  } else {
    maxAgeDays = Number.isInteger(config.attachmentRetentionDays)
      ? config.attachmentRetentionDays
      : 0;
  }
  if (maxAgeDays <= 0) {
    throw new HttpError(
      400,
      'MAINTENANCE_DISABLED',
      '未启用附件保留期清理（attachmentRetentionDays=0 且未提供 maxAgeDays）',
    );
  }
  let userList = [];
  try {
    if (ctx?.users && typeof ctx.users.list === 'function') userList = await ctx.users.list({});
  } catch (error) {
    warn(ctx, `读取用户列表失败（仅清理基础目录）：${error?.message ?? error}`);
  }
  const references = await collectAllAttachmentReferences(ctx, userList);
  const referencedIds = collectReferencedAttachmentIds(references);
  const baseDataDir =
    typeof ctx?.baseDataDir === 'string' && ctx.baseDataDir.length > 0
      ? path.resolve(ctx.baseDataDir)
      : null;
  const scopeDirs = [];
  if (baseDataDir) scopeDirs.push(baseDataDir);
  for (const user of Array.isArray(userList) ? userList : []) {
    if (!user || typeof user.id !== 'string' || user.id.length === 0) continue;
    if (baseDataDir) scopeDirs.push(path.join(baseDataDir, 'users', user.id));
  }
  const logger = ctx?.logger ?? console;
  const now = () => currentDate(ctx);
  let removed = 0;
  let bytes = 0;
  const visited = new Set();
  for (const rawDir of scopeDirs) {
    const dir = path.resolve(rawDir);
    if (visited.has(dir)) continue;
    visited.add(dir);
    let attachments = dir === baseDataDir ? ctx?.attachments : null;
    if (!attachments || typeof attachments.sweepExpired !== 'function') {
      try {
        if (!fs.existsSync(path.join(dir, 'attachments'))) continue;
        attachments = createAttachmentStore({ dataDir: dir, logger });
      } catch {
        continue;
      }
    }
    const result = await cleanupExpiredAttachments({
      attachments,
      references,
      referencedIds,
      conversations: references.conversations,
      memories: references.memories,
      maxAgeDays,
      config,
      logger,
      now,
    });
    removed += numberOr0(result?.removed);
    bytes += numberOr0(result?.bytes);
  }
  await recordAudit(ctx, {
    action: 'maintenance.attachments_sweep',
    targetType: 'attachments',
    detail: { maxAgeDays, removed, bytes },
    message: `action=attachments.sweep actor=${actorLabel(ctx)} maxAgeDays=${maxAgeDays} removed=${removed} bytes=${bytes}`,
  });
  sendJson(res, 200, { removed, bytes });
}

async function adminUsageSummary(req, res, ctx) {
  const usage = requireUsageService(ctx);
  const url = parseUrl(req);
  const groupByRaw = url.searchParams.get('groupBy');
  const groupBy =
    typeof groupByRaw === 'string' && groupByRaw.trim().length > 0 ? groupByRaw.trim() : 'day';
  if (!USAGE_GROUP_BYS.includes(groupBy)) {
    throw invalid(`groupBy 非法（需 ${USAGE_GROUP_BYS.join('|')}）`);
  }
  const nowDate = currentDate(ctx);
  const today = shanghaiDateString(nowDate);
  const to = url.searchParams.get('to') ?? today;
  const from = url.searchParams.get('from') ?? shiftDate(to, -29);
  if (!isValidDateString(from)) throw invalid('from 非法（需 YYYY-MM-DD）');
  if (!isValidDateString(to)) throw invalid('to 非法（需 YYYY-MM-DD）');
  if (dateToMs(from) > dateToMs(to)) throw invalid('from 不能晚于 to');
  if (daysInclusive(from, to) > ADMIN_MAX_RANGE_DAYS) {
    throw new HttpError(400, 'RANGE_TOO_LARGE', `查询跨度不能超过 ${ADMIN_MAX_RANGE_DAYS} 天`);
  }
  const summary = await usage.summary({ from, to, groupBy });
  sendJson(res, 200, {
    groupBy: summary?.groupBy ?? groupBy,
    from: summary?.from ?? from,
    to: summary?.to ?? to,
    rows: Array.isArray(summary?.rows) ? summary.rows : [],
    totals: summary?.totals ?? emptyTotals(),
    //  7：透传 usage.summary 的 bySource（ 提供；未提供时为 null，旧字段不变）。
    bySource: summary?.bySource ?? null,
  });
}

async function adminFeedbackList(req, res, ctx) {
  const feedback = requireFeedbackService(ctx);
  const url = parseUrl(req);
  const statusRaw = url.searchParams.get('status');
  const status = typeof statusRaw === 'string' && statusRaw.trim().length > 0 ? statusRaw.trim() : null;
  if (status !== null && !FEEDBACK_STATUSES.includes(status)) {
    throw invalid(`status 非法（需 ${FEEDBACK_STATUSES.join('|')}）`);
  }
  const limit = parseIntParam(url.searchParams.get('limit'), {
    min: 1,
    max: MAX_USER_PAGE,
    defaultValue: DEFAULT_FEEDBACK_PAGE,
    name: 'limit',
  });
  const offset = parseIntParam(url.searchParams.get('offset'), {
    min: 0,
    max: 1_000_000,
    defaultValue: 0,
    name: 'offset',
  });
  const list = await feedback.list({ status, limit, offset });
  const rows = await Promise.all((Array.isArray(list) ? list : []).map((entry) => enrichFeedback(ctx, entry)));
  sendJson(res, 200, { feedback: rows });
}

async function adminFeedbackPatch(req, res, ctx, feedbackId) {
  const feedback = requireFeedbackService(ctx);
  if (!feedbackId) throw invalid('缺少反馈 id');
  const body = await readOptionalJsonBody(req);
  assertKnownKeys(body, ['status', 'reply'], '反馈更新');
  if (Object.keys(body).length === 0) throw invalid('未提供要更新的字段');
  const patch = {};
  if (Object.hasOwn(body, 'status')) {
    if (!FEEDBACK_STATUSES.includes(body.status)) {
      throw invalid(`反馈状态非法（需 ${FEEDBACK_STATUSES.join('|')}）`);
    }
    patch.status = body.status;
  }
  if (Object.hasOwn(body, 'reply')) {
    if (body.reply !== null) {
      if (typeof body.reply !== 'string') throw invalid('reply 必须是文本或 null');
      if (Array.from(body.reply).length > FEEDBACK_MAX_CHARS) {
        throw invalid(`reply 超过 ${FEEDBACK_MAX_CHARS} 字上限`);
      }
    }
    patch.reply = body.reply;
  }
  const updated = await feedback.update(feedbackId, patch);
  await recordAudit(ctx, {
    action: 'feedback.update',
    targetType: 'feedback',
    targetId: feedbackId,
    detail: { fields: Object.keys(patch) },
    message: `action=feedback.update actor=${actorLabel(ctx)} target=${feedbackId} fields=${Object.keys(patch).join(',')}`,
  });
  sendJson(res, 200, { feedback: await enrichFeedback(ctx, updated) });
}

async function adminSettingsGet(req, res, ctx) {
  sendJson(res, 200, { settings: await readSettingsView(ctx) });
}

async function adminSettingsPatch(req, res, ctx) {
  const body = await readOptionalJsonBody(req);
  assertKnownKeys(body, ['byokEnabled', 'defaultQuota', 'webSearchPerUserPerDay'], '设置更新');
  if (Object.keys(body).length === 0) throw invalid('未提供要更新的字段');
  const patch = {};
  if (Object.hasOwn(body, 'byokEnabled')) {
    if (typeof body.byokEnabled !== 'boolean') throw invalid('byokEnabled 必须是布尔值');
    patch.byokEnabled = body.byokEnabled;
  }
  if (Object.hasOwn(body, 'defaultQuota')) {
    if (!body.defaultQuota || typeof body.defaultQuota !== 'object' || Array.isArray(body.defaultQuota)) {
      throw invalid('defaultQuota 必须是 {dayTokens,monthTokens} 对象');
    }
    assertKnownKeys(body.defaultQuota, ['dayTokens', 'monthTokens'], 'defaultQuota');
    if (Object.keys(body.defaultQuota).length === 0) throw invalid('defaultQuota 未提供字段');
    const current = (await readSettingsView(ctx)).defaultQuota;
    const merged = { ...current, ...body.defaultQuota };
    patch.defaultQuota = normalizeQuota(merged, 'defaultQuota');
  }
  if (Object.hasOwn(body, 'webSearchPerUserPerDay')) {
    const value = body.webSearchPerUserPerDay;
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw invalid('webSearchPerUserPerDay 需为非负整数或 null');
    }
    patch.webSearchPerUserPerDay = value;
  }
  await getSettingsStore(ctx).patch(patch, { updatedBy: actorLabel(ctx) });
  await recordAudit(ctx, {
    action: 'settings.update',
    targetType: 'settings',
    detail: { fields: Object.keys(patch) },
    message: `action=settings.update actor=${actorLabel(ctx)} fields=${Object.keys(patch).join(',')}`,
  });
  sendJson(res, 200, { settings: await readSettingsView(ctx) });
}

/* ------------------------------- handler ------------------------------- */

/**
 * 管理员路由 handler（契约 5）：
 *   GET   /api/admin/overview?days=30
 *   GET   /api/admin/users?query=&status=
 *   PATCH /api/admin/users/:id {status?,role?,quota?,displayName?}
 *   POST  /api/admin/users/:id/reset-password {password?}
 *   POST  /api/admin/invites / GET /api/admin/invites
 *   GET   /api/admin/usage/summary?from&to&groupBy
 *   GET   /api/admin/feedback?status= / PATCH /api/admin/feedback/:id
 *   GET   /api/admin/settings / PATCH /api/admin/settings
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} ctx 基础 ctx（含 ctx.user/ctx.users/ctx.usage/ctx.feedback/ctx.baseDataDir/ctx.config）
 * @param {string[]} segments 完整 segments（含首元素 'api'）或已归一化 segments
 */
export async function handleAdmin(req, res, ctx, segments) {
  try {
    const actor = ctx?.user ?? null;
    if (!actor) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
    if (actor.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', '需要管理员权限');

    const route = normalizeSegments(segments);
    if (route[0] !== 'admin') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    const rest = route.slice(1);
    const method = String(req?.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';

    if (rest.length === 1 && rest[0] === 'overview') {
      if (!isRead) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminOverview(req, res, ctx);
      return;
    }
    if (rest.length === 1 && rest[0] === 'users') {
      if (!isRead) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminUsersList(req, res, ctx);
      return;
    }
    if (rest.length === 2 && rest[0] === 'users') {
      if (method !== 'PATCH') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminUserPatch(req, res, ctx, rest[1]);
      return;
    }
    if (rest.length === 3 && rest[0] === 'users' && rest[2] === 'reset-password') {
      if (method !== 'POST') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminUserResetPassword(req, res, ctx, rest[1]);
      return;
    }
    if (rest.length === 1 && rest[0] === 'invites') {
      if (isRead) {
        await adminInvitesList(req, res, ctx);
        return;
      }
      if (method === 'POST') {
        await adminInvitesCreate(req, res, ctx);
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    }
    //  / 4：邀请码编辑/吊销（:code）。
    if (rest.length === 2 && rest[0] === 'invites') {
      if (method === 'PATCH') {
        await adminInvitesPatch(req, res, ctx, rest[1]);
        return;
      }
      if (method === 'DELETE') {
        await adminInvitesDelete(req, res, ctx, rest[1]);
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    }
    // 审计日志（分页）。
    if (rest.length === 1 && rest[0] === 'audit') {
      if (!isRead) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminAuditList(req, res, ctx);
      return;
    }
    // 系统状态。
    if (rest.length === 1 && rest[0] === 'system') {
      if (!isRead) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminSystem(req, res, ctx);
      return;
    }
    // 附件保留期清理。
    if (rest.length === 2 && rest[0] === 'maintenance' && rest[1] === 'sweep-attachments') {
      if (method !== 'POST') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminMaintenanceSweepAttachments(req, res, ctx);
      return;
    }
    if (rest.length === 2 && rest[0] === 'usage' && rest[1] === 'summary') {
      if (!isRead) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminUsageSummary(req, res, ctx);
      return;
    }
    if (rest.length === 1 && rest[0] === 'feedback') {
      if (!isRead) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminFeedbackList(req, res, ctx);
      return;
    }
    if (rest.length === 2 && rest[0] === 'feedback') {
      if (method !== 'PATCH') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      await adminFeedbackPatch(req, res, ctx, rest[1]);
      return;
    }
    if (rest.length === 1 && rest[0] === 'settings') {
      if (isRead) {
        await adminSettingsGet(req, res, ctx);
        return;
      }
      if (method === 'PATCH') {
        await adminSettingsPatch(req, res, ctx);
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    }

    throw new HttpError(404, 'NOT_FOUND', '接口不存在');
  } catch (error) {
    if (error instanceof HttpError) {
      sendApiError(res, error.status, error.code, error.message);
      return;
    }
    throw error;
  }
}
