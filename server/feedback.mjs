// 反馈服务与路由（接口契约  4）。
// 设计要点：
//   - 存储全局 DATA_DIR/feedback.json（**必须用 ctx.baseDataDir**，scoped ctx 的 dataDir 是用户目录）；
//   - 原子写：<file>.tmp（0600）→ rename；文件 0600；同进程写操作串行队列；
//   - 正文只存原文，服务端不做 HTML 转义、不做渲染（转义由前端渲染方负责）；body 1..2000 字符（Array.from 计）；
//   - conversationId 只存 id（不读对话正文/不校验会话存在）；allowContext 为布尔标记；
//   - 管理员只看元数据（userId/username、状态、时间、关联 id），不通过本服务读取对话内容。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { HttpError, readJsonBody, sendApiError, sendJson } from './http-utils.mjs';

export const FEEDBACK_STATUSES = Object.freeze(['open', 'resolved']);
export const FEEDBACK_MAX_CHARS = 2000;
export const FEEDBACK_FILE_NAME = 'feedback.json';

const FEEDBACK_ID_RE = /^f[0-9a-f]{8}$/;
// 关联会话 id 只允许安全字符（store 生成形如 c+hex / s+hex），拒绝路径分隔符与控制字符。
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_TOKEN_LIMIT = 64 * 1024;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

export function newFeedbackId() {
  return `f${crypto.randomBytes(4).toString('hex')}`;
}

function charsOf(text) {
  return Array.from(text).length;
}

function invalid(message) {
  return new HttpError(400, 'INVALID_INPUT', message);
}

function currentDate(now) {
  let value;
  try {
    value = now();
  } catch {
    value = null;
  }
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isIsoDateLike(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function cloneEntry(entry) {
  return { ...entry };
}

function isStatus(value) {
  return typeof value === 'string' && FEEDBACK_STATUSES.includes(value);
}

/** 校验单条反馈记录（启动加载时过滤脏数据；不合法条目丢弃并 warn）。 */
function isValidEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    FEEDBACK_ID_RE.test(entry.id) &&
    typeof entry.userId === 'string' &&
    entry.userId.length > 0 &&
    typeof entry.body === 'string' &&
    charsOf(entry.body) >= 1 &&
    charsOf(entry.body) <= FEEDBACK_MAX_CHARS &&
    (entry.conversationId === null ||
      (typeof entry.conversationId === 'string' && CONVERSATION_ID_RE.test(entry.conversationId))) &&
    typeof entry.allowContext === 'boolean' &&
    isStatus(entry.status) &&
    (entry.reply === null || typeof entry.reply === 'string') &&
    isIsoDateLike(entry.createdAt) &&
    isIsoDateLike(entry.updatedAt)
  );
}

function sortNewestFirst(entries) {
  return [...entries].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id),
  );
}

function normalizeListOptions({ status = null, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
  if (status !== null && status !== undefined && !isStatus(status)) {
    throw invalid(`反馈状态非法（需 ${FEEDBACK_STATUSES.join('|')}）`);
  }
  const safeLimit = limit === undefined || limit === null ? DEFAULT_LIST_LIMIT : limit;
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > MAX_LIST_LIMIT) {
    throw invalid(`limit 需为 1–${MAX_LIST_LIMIT} 的整数`);
  }
  const safeOffset = offset === undefined || offset === null ? 0 : offset;
  if (!Number.isInteger(safeOffset) || safeOffset < 0) throw invalid('offset 需为非负整数');
  return { status: status ?? null, limit: safeLimit, offset: safeOffset };
}

/**
 * 创建反馈服务（创建时同步加载磁盘数据；写操作串行落盘）。
 * add() 成功后可 fire-and-forget 通知 webhook（config.feedbackWebhookUrl 非空才发）。
 * @param {{
 *   dataDir: string,
 *   logger?: object,
 *   now?: () => Date,
 *   config?: object|null,
 *   fetchImpl?: Function|null,
 * }} opts
 */
export function createFeedbackService({
  dataDir,
  logger = console,
  now = () => new Date(),
  config = null,
  fetchImpl = null,
} = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createFeedbackService 需要 dataDir');
  const rootDir = path.resolve(dataDir);
  const filePath = path.join(rootDir, FEEDBACK_FILE_NAME);

  /** @type {Array<{id:string,userId:string,body:string,conversationId:string|null,allowContext:boolean,status:string,reply:string|null,createdAt:string,updatedAt:string}>} */
  let entries = [];
  let lastCreatedAtMs = 0;
  let degraded = false;
  let degradedWarned = false;
  let writeChain = Promise.resolve();

  const warn = (message) => {
    try {
      logger?.warn?.(`[feedback] ${message}`);
    } catch {
      /* logger 自身失败不影响主流程 */
    }
  };

  /* ------------------------------- 反馈 webhook ------------------------------- */

  const serviceConfig = config && typeof config === 'object' ? config : {};
  const injectedFetch = typeof fetchImpl === 'function' ? fetchImpl : null;
  const configuredWebhookUrl =
    typeof serviceConfig.feedbackWebhookUrl === 'string' ? serviceConfig.feedbackWebhookUrl.trim() : '';

  /**
   * 通知 webhook（fire-and-forget）：5s 超时、不重试、失败只 warn，绝不影响提交响应。
   * payload 固定为 { type, id, createdAt, username, bodyPreview(≤200 字) }，不发送正文全文以外的字段。
   */
  function fireWebhook(entry, options = {}) {
    const url =
      typeof options.webhookUrl === 'string' && options.webhookUrl.trim().length > 0
        ? options.webhookUrl.trim()
        : configuredWebhookUrl;
    if (!url) return;
    const doFetch =
      typeof options.fetchImpl === 'function'
        ? options.fetchImpl
        : injectedFetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
    if (!doFetch) {
      warn('反馈 webhook 已配置但无可用 fetch，跳过发送');
      return;
    }
    const body = typeof entry?.body === 'string' ? entry.body : '';
    const preview = charsOf(body) <= 200 ? body : Array.from(body).slice(0, 200).join('');
    const payload = {
      type: 'feedback',
      id: entry?.id ?? null,
      createdAt: entry?.createdAt ?? null,
      username: typeof options.username === 'string' && options.username.length > 0 ? options.username : null,
      bodyPreview: preview,
    };
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(5000)
          : undefined;
      const pending = doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      Promise.resolve(pending)
        .then((response) => {
          if (!response || response.ok === false) {
            warn(`反馈 webhook 响应异常（status=${response?.status ?? 'unknown'}），仅记录不重试`);
          }
        })
        .catch((error) => {
          warn(`反馈 webhook 发送失败（不影响提交）：${error?.message ?? error}`);
        });
    } catch (error) {
      warn(`反馈 webhook 发送失败（不影响提交）：${error?.message ?? error}`);
    }
  }

  function markDegraded(reason) {
    if (degraded) return;
    degraded = true;
    if (!degradedWarned) {
      degradedWarned = true;
      warn(`持久化不可写，降级为内存模式：${reason}`);
    }
  }

  /** createdAt 单调递增（同毫秒内连续提交也能稳定排序）。 */
  function nextCreatedAt() {
    const ms = Math.max(currentDate(now).getTime(), lastCreatedAtMs + 1);
    lastCreatedAtMs = ms;
    return new Date(ms).toISOString();
  }

  function noteCreatedAt(iso) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed) && parsed > lastCreatedAtMs) lastCreatedAtMs = parsed;
  }

  /* ------------------------------- 启动加载 ------------------------------- */

  function loadFromDisk() {
    try {
      fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      fs.accessSync(rootDir, fs.constants.W_OK);
    } catch (error) {
      markDegraded(`无法创建/访问数据目录 ${rootDir}：${error?.message ?? error}`);
      return;
    }

    let raw;
    try {
      raw = fs.readFileSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return; // 首次使用：空数据
      markDegraded(`读取 ${FEEDBACK_FILE_NAME} 失败：${error?.message ?? error}`);
      return;
    }

    let data;
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      warn(`${FEEDBACK_FILE_NAME} 解析失败，按空数据处理：${error?.message ?? error}`);
      return;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.feedback)) {
      warn(`${FEEDBACK_FILE_NAME} 结构不合法（缺少 feedback 数组），按空数据处理`);
      return;
    }
    entries = data.feedback.filter(isValidEntry);
    for (const entry of entries) noteCreatedAt(entry.createdAt);
    if (entries.length !== data.feedback.length) {
      warn(`${FEEDBACK_FILE_NAME} 含 ${data.feedback.length - entries.length} 条无效记录，已忽略`);
    }
  }

  loadFromDisk();

  /* ------------------------------- 持久化 ------------------------------- */

  function persist() {
    if (degraded) return Promise.resolve(false);
    writeChain = writeChain.then(async () => {
      try {
        await fs.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
        const payload = { version: 1, feedback: entries };
        const text = `${JSON.stringify(payload, null, 2)}\n`;
        const tmpPath = `${filePath}.tmp`;
        await fs.promises.writeFile(tmpPath, text, { encoding: 'utf8', mode: 0o600 });
        await fs.promises.rename(tmpPath, filePath);
        try {
          await fs.promises.chmod(filePath, 0o600);
        } catch {
          /* 非 POSIX 或权限不足时忽略 */
        }
        return true;
      } catch (error) {
        markDegraded(error?.message ?? String(error));
        return false;
      }
    });
    return writeChain;
  }

  /* ------------------------------- 业务方法 ------------------------------- */

  function normalizeAddInput({ userId, body, conversationId = null, allowContext = false } = {}) {
    if (typeof userId !== 'string' || userId.length === 0) throw invalid('缺少反馈用户');
    if (typeof body !== 'string') throw invalid('反馈内容必须是文本');
    const length = charsOf(body);
    if (length < 1) throw invalid('反馈内容不能为空');
    if (length > FEEDBACK_MAX_CHARS) throw invalid(`反馈内容超过 ${FEEDBACK_MAX_CHARS} 字上限`);
    let normalizedConversationId = conversationId ?? null;
    if (normalizedConversationId !== null) {
      if (
        typeof normalizedConversationId !== 'string' ||
        !CONVERSATION_ID_RE.test(normalizedConversationId)
      ) {
        throw invalid('conversationId 非法');
      }
    }
    if (allowContext !== undefined && allowContext !== null && typeof allowContext !== 'boolean') {
      throw invalid('allowContext 必须是布尔值');
    }
    return {
      userId,
      body,
      conversationId: normalizedConversationId,
      allowContext: allowContext === true,
    };
  }

  async function add(input = {}, options = {}) {
    const normalized = normalizeAddInput(input);
    const createdAt = nextCreatedAt();
    const entry = {
      id: newFeedbackId(),
      userId: normalized.userId,
      body: normalized.body, // 原样保存（不转义/不渲染，渲染方负责转义）
      conversationId: normalized.conversationId,
      allowContext: normalized.allowContext,
      status: 'open',
      reply: null,
      createdAt,
      updatedAt: createdAt,
    };
    entries.push(entry);
    await persist();
    const created = cloneEntry(entry);
    // add 成功后异步通知（不 await、不影响本次响应；失败只 warn）。
    fireWebhook(created, options);
    return created;
  }

  async function listByUser(userId) {
    if (typeof userId !== 'string' || userId.length === 0) throw invalid('缺少反馈用户');
    return sortNewestFirst(entries.filter((entry) => entry.userId === userId)).map(cloneEntry);
  }

  async function list(options = {}) {
    const { status, limit, offset } = normalizeListOptions(options);
    const filtered = status === null ? entries : entries.filter((entry) => entry.status === status);
    return sortNewestFirst(filtered)
      .slice(offset, offset + limit)
      .map(cloneEntry);
  }

  async function update(id, patch = {}) {
    if (typeof id !== 'string' || id.length === 0) throw invalid('缺少反馈 id');
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) throw new HttpError(404, 'NOT_FOUND', '反馈不存在');
    const hasStatus = Object.hasOwn(patch, 'status') && patch.status !== null;
    const hasReply = Object.hasOwn(patch, 'reply');
    if (!hasStatus && !hasReply) throw invalid('未提供要更新的字段');
    const entry = entries[index];
    const updated = { ...entry };
    if (hasStatus) {
      if (!isStatus(patch.status)) throw invalid(`反馈状态非法（需 ${FEEDBACK_STATUSES.join('|')}）`);
      updated.status = patch.status;
    }
    if (hasReply) {
      if (patch.reply !== null && typeof patch.reply !== 'string') {
        throw invalid('回复内容必须是文本或 null');
      }
      if (typeof patch.reply === 'string' && charsOf(patch.reply) > FEEDBACK_MAX_CHARS) {
        throw invalid(`回复内容超过 ${FEEDBACK_MAX_CHARS} 字上限`);
      }
      updated.reply = patch.reply;
    }
    updated.updatedAt = new Date(
      Math.max(currentDate(now).getTime(), Date.parse(updated.updatedAt) + 1),
    ).toISOString();
    entries[index] = updated;
    await persist();
    return cloneEntry(updated);
  }

  async function counts() {
    let open = 0;
    for (const entry of entries) if (entry.status === 'open') open += 1;
    return { open, total: entries.length };
  }

  /**
   *  / 合规注销（ DELETE /api/me 依赖）：删除某用户的全部反馈。
   * 原子落盘并同步清空内存缓存；userId 缺失/无效/无记录时返回 0（不落盘）。
   * @param {string} userId
   * @returns {Promise<number>} 删除条数
   */
  async function deleteByUser(userId) {
    if (typeof userId !== 'string' || userId.length === 0) return 0;
    const before = entries.length;
    const remaining = entries.filter((entry) => entry.userId !== userId);
    const removed = before - remaining.length;
    if (removed === 0) return 0;
    entries = remaining;
    await persist();
    return removed;
  }

  return { add, listByUser, list, update, counts, deleteByUser };
}

/* ------------------------------- 路由 ------------------------------- */

/** segments 归一化：兼容 ['api','feedback'] 与 ['feedback'] 两种入口（契约 11.6）。 */
function normalizeSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  return list[0] === 'api' ? list.slice(1) : list;
}

function currentUserId(ctx) {
  const user = ctx?.user ?? null;
  const id = user?.id ?? ctx?.userId ?? null;
  if (typeof id !== 'string' || id.length === 0) {
    throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  }
  return id;
}

/**
 * 反馈路由 handler（契约 0/4）：
 *   POST /api/feedback             { body, conversationId?, allowContext? } → 201 { feedback }
 *   GET  /api/feedback             → 200 { feedback: entry[] }（仅本人）
 *   GET  /api/me/feedback          → 200 { feedback: entry[] }（仅本人）
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} ctx 基础 ctx（含 ctx.user/ctx.userId 与 ctx.feedback）
 * @param {string[]} segments 完整 segments（含首元素 'api'）或已归一化 segments
 */
export async function handleFeedback(req, res, ctx, segments) {
  try {
    const route = normalizeSegments(segments);
    const method = String(req.method ?? 'GET').toUpperCase();

    if (route[0] === 'feedback' && route.length === 1) {
      if (method === 'POST') {
        currentUserId(ctx);
        if (!ctx.feedback || typeof ctx.feedback.add !== 'function') {
          throw new HttpError(500, 'INTERNAL', '反馈服务未初始化');
        }
        const payload = await readJsonBody(req, { limit: SESSION_TOKEN_LIMIT });
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw invalid('请求体必须是 JSON 对象');
        }
        const entry = await ctx.feedback.add(
          {
            userId: currentUserId(ctx),
            body: payload.body,
            conversationId: payload.conversationId ?? null,
            allowContext: payload.allowContext ?? false,
          },
          // webhook 通知（服务内部 fire-and-forget；配置为空则忽略）。
          {
            webhookUrl: ctx.config?.feedbackWebhookUrl,
            fetchImpl: ctx.fetchImpl,
            username: ctx.user?.username ?? null,
          },
        );
        sendJson(res, 201, { feedback: entry });
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        const userId = currentUserId(ctx);
        if (!ctx.feedback || typeof ctx.feedback.listByUser !== 'function') {
          throw new HttpError(500, 'INTERNAL', '反馈服务未初始化');
        }
        const feedback = await ctx.feedback.listByUser(userId);
        sendJson(res, 200, { feedback });
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    }

    if (route[0] === 'me' && route[1] === 'feedback' && route.length === 2) {
      if (method === 'GET' || method === 'HEAD') {
        const userId = currentUserId(ctx);
        if (!ctx.feedback || typeof ctx.feedback.listByUser !== 'function') {
          throw new HttpError(500, 'INTERNAL', '反馈服务未初始化');
        }
        const feedback = await ctx.feedback.listByUser(userId);
        sendJson(res, 200, { feedback });
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
