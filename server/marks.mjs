// 收藏片段：DATA_DIR/marks.json 持久化（DATA-CONTRACT 16 / 24 / API-CONTRACT 8）。
// 设计要点：
//   - 阅读器里用户主动保存的「收藏（doc 级）」与「摘录（段落级）」；不自动采集、不存对话内容。
//   - 原子写：<file>.tmp（0600）→ rename；文件 0600；同进程写操作串行队列。
//   - 可选 at-rest 加密（键由 app 注入；缺省 null = 明文，行为不变）。加密数据
//     解不开时必须 fail-fast 向上抛，绝不当作「解析失败」静默清空。
//   - 启动加载：文件缺失 → 空；解析失败 → warn + 空；目录不可写 → 内存降级 + warn。
//   - bookTitle / sectionHeading 不落盘，GET 时从 docStore 解析（语料更新后自动跟随）。
//   - 上限：excerpts / favorites 各 500，超限拒绝创建（429 TOO_MANY_MARKS，不淘汰旧数据）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isAtRestError } from './at-rest.mjs';
import { HttpError, readRequestBody, sendApiError, sendJson } from './http-utils.mjs';

export const MARKS_FILE_NAME = 'marks.json';
export const MARK_ID_RE = /^mk_[0-9a-f]{12}$/;
export const MARK_KINDS = Object.freeze(['excerpt', 'favorite']);
export const MARKS_LIMITS = Object.freeze({ MAX_EXCERPTS: 500, MAX_FAVORITES: 500 });

const BODY_LIMIT = 16 * 1024;

/** 收藏/摘录业务错误：携带 HTTP 语义码，路由层直接映射为 JSON 错误体。 */
export class MarksError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'MarksError';
    this.code = code;
    this.status = status;
  }
}

export function newMarkId() {
  return `mk_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isIsoDateLike(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isValidExcerpt(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    MARK_ID_RE.test(entry.id) &&
    typeof entry.docId === 'string' &&
    entry.docId.length > 0 &&
    typeof entry.anchor === 'string' &&
    entry.anchor.length > 0 &&
    Number.isInteger(entry.para) &&
    entry.para >= 0 &&
    typeof entry.text === 'string' &&
    isIsoDateLike(entry.createdAt)
  );
}

function isValidFavorite(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    MARK_ID_RE.test(entry.id) &&
    typeof entry.docId === 'string' &&
    entry.docId.length > 0 &&
    isIsoDateLike(entry.createdAt)
  );
}

function sortByCreatedAtDesc(entries) {
  return [...entries].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id),
  );
}

/**
 * 创建收藏/摘录 store（创建时同步加载磁盘数据）。
 * @param {{
 *   dataDir: string,
 *   logger?: Console,
 *   docStore?: {get:(docId:string)=>object|null},
 *   maxExcerpts?: number,
 *   maxFavorites?: number,
 *   atRest?: object|null,
 * }} opts
 */
export async function createMarksStore({
  dataDir,
  logger = console,
  docStore = null,
  maxExcerpts,
  maxFavorites,
  atRest = null,
} = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createMarksStore 需要 dataDir');
  const rootDir = path.resolve(dataDir);
  const filePath = path.join(rootDir, MARKS_FILE_NAME);
  const limits = Object.freeze({
    MAX_EXCERPTS: Number.isInteger(maxExcerpts) && maxExcerpts > 0 ? maxExcerpts : MARKS_LIMITS.MAX_EXCERPTS,
    MAX_FAVORITES:
      Number.isInteger(maxFavorites) && maxFavorites > 0 ? maxFavorites : MARKS_LIMITS.MAX_FAVORITES,
  });

  /** @type {Array<{id:string,docId:string,anchor:string,para:number,text:string,createdAt:string}>} */
  let excerpts = [];
  /** @type {Array<{id:string,docId:string,createdAt:string}>} */
  let favorites = [];
  let lastCreatedAtMs = 0;
  let degraded = false;
  let degradedWarned = false;
  let writeChain = Promise.resolve();

  const warn = (message) => {
    try {
      logger?.warn?.(`[marks] ${message}`);
    } catch {
      /* logger 自身失败不影响主流程 */
    }
  };

  function markDegraded(reason) {
    if (degraded) return;
    degraded = true;
    if (!degradedWarned) {
      degradedWarned = true;
      warn(`持久化不可写，降级为内存模式：${reason}`);
    }
  }

  /** createdAt 单调递增（同毫秒内连续创建也能稳定排序）。 */
  function nextCreatedAt() {
    const ms = Math.max(Date.now(), lastCreatedAtMs + 1);
    lastCreatedAtMs = ms;
    return new Date(ms).toISOString();
  }

  function noteCreatedAt(iso) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed) && parsed > lastCreatedAtMs) lastCreatedAtMs = parsed;
  }

  function resolveDoc(docId) {
    try {
      return typeof docStore?.get === 'function' ? docStore.get(docId) : null;
    } catch {
      return null;
    }
  }

  function toExcerptView(entry) {
    const doc = resolveDoc(entry.docId);
    const section = doc ? (doc.sections ?? []).find((item) => item.anchor === entry.anchor) : null;
    return {
      id: entry.id,
      docId: entry.docId,
      bookTitle: doc?.title ?? '',
      sectionHeading: section?.heading ?? '',
      anchor: entry.anchor,
      para: entry.para,
      text: entry.text,
      createdAt: entry.createdAt,
    };
  }

  function toFavoriteView(entry) {
    const doc = resolveDoc(entry.docId);
    return {
      id: entry.id,
      docId: entry.docId,
      bookTitle: doc?.title ?? '',
      createdAt: entry.createdAt,
    };
  }

  /* ------------------------------- 启动加载 ------------------------------- */

  function loadFromDisk() {
    try {
      fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(rootDir, 0o700);
      } catch {
        /* 非 POSIX 或权限不足时忽略 */
      }
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
      markDegraded(`读取 ${MARKS_FILE_NAME} 失败：${error?.message ?? error}`);
      return;
    }

    let text;
    try {
      // at-rest 开启时先解密；解不开必须 fail-fast（不能清空用户数据）。
      text = atRest ? atRest.unseal(filePath, raw).toString('utf8') : raw.toString('utf8');
    } catch (error) {
      if (isAtRestError(error)) throw error;
      markDegraded(`解密 ${MARKS_FILE_NAME} 失败：${error?.message ?? error}`);
      return;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      warn(`${MARKS_FILE_NAME} 解析失败，按空数据处理：${error?.message ?? error}`);
      return;
    }
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray(data.excerpts) ||
      !Array.isArray(data.favorites)
    ) {
      warn(`${MARKS_FILE_NAME} 结构不合法（缺少 excerpts/favorites 数组），按空数据处理`);
      return;
    }

    excerpts = data.excerpts.filter(isValidExcerpt);
    favorites = data.favorites.filter(isValidFavorite);
    for (const entry of [...excerpts, ...favorites]) noteCreatedAt(entry.createdAt);
    if (excerpts.length !== data.excerpts.length || favorites.length !== data.favorites.length) {
      warn(`${MARKS_FILE_NAME} 含 ${data.excerpts.length - excerpts.length + data.favorites.length - favorites.length} 条无效记录，已忽略`);
    }
  }

  loadFromDisk();

  /* ------------------------------- 持久化 ------------------------------- */

  function persist() {
    if (degraded) return Promise.resolve(false);
    writeChain = writeChain.then(async () => {
      try {
        await fs.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
        const payload = { version: 1, updatedAt: nowIso(), excerpts, favorites };
        const tmpPath = `${filePath}.tmp`;
        // at-rest 开启时整份 JSON 加密后再落盘。
        const text = `${JSON.stringify(payload, null, 2)}\n`;
        const fileData = atRest ? atRest.seal(filePath, Buffer.from(text, 'utf8')) : text;
        await fs.promises.writeFile(tmpPath, fileData, {
          encoding: typeof fileData === 'string' ? 'utf8' : undefined,
          mode: 0o600,
        });
        await fs.promises.rename(tmpPath, filePath);
        try {
          await fs.promises.chmod(filePath, 0o600);
        } catch {
          /* 非 POSIX 时忽略 */
        }
        return true;
      } catch (error) {
        markDegraded(`写入 ${MARKS_FILE_NAME} 失败：${error?.message ?? error}`);
        return false;
      }
    });
    return writeChain;
  }

  /** 写盘失败：首次失败向上抛 500 STORE_ERROR；此前已降级则按内存模式继续。 */
  async function persistAfterMutation() {
    const wasDegraded = degraded;
    const ok = await persist();
    if (!ok && !wasDegraded) {
      throw new MarksError('STORE_ERROR', 500, '收藏/摘录写入磁盘失败');
    }
    return ok;
  }

  function assertDoc(docId) {
    const doc = resolveDoc(docId);
    if (!doc) throw new MarksError('DOC_NOT_FOUND', 404, '文档不存在');
    return doc;
  }

  /* --------------------------------- 方法 --------------------------------- */

  function stats() {
    return { excerpts: excerpts.length, favorites: favorites.length };
  }

  function list() {
    return {
      excerpts: sortByCreatedAtDesc(excerpts).map(toExcerptView),
      favorites: sortByCreatedAtDesc(favorites).map(toFavoriteView),
      stats: stats(),
    };
  }

  async function addExcerpt({ docId, anchor, para } = {}) {
    if (typeof docId !== 'string' || docId === '') {
      throw new MarksError('INVALID_REQUEST', 400, 'docId 必须是非空字符串');
    }
    if (typeof anchor !== 'string' || anchor === '') {
      throw new MarksError('INVALID_REQUEST', 400, 'anchor 必须是非空字符串');
    }
    if (!Number.isInteger(para) || para < 0) {
      throw new MarksError('INVALID_REQUEST', 400, 'para 必须是 ≥0 的整数');
    }
    const doc = assertDoc(docId);
    const section = (doc.sections ?? []).find((item) => item.anchor === anchor);
    const paragraph = section
      ? (section.paragraphs ?? []).find((item) => item.para === para)
      : null;
    if (!paragraph) throw new MarksError('PARA_NOT_FOUND', 404, '段落不存在');

    const existing = excerpts.find(
      (item) => item.docId === docId && item.anchor === anchor && item.para === para,
    );
    if (existing) return { item: toExcerptView(existing), duplicated: true };

    if (excerpts.length >= limits.MAX_EXCERPTS) {
      throw new MarksError('TOO_MANY_MARKS', 429, `摘录数量已达上限 ${limits.MAX_EXCERPTS} 条`);
    }

    // text 一律由服务端从语料取，忽略客户端传入内容。
    const entry = {
      id: newMarkId(),
      docId,
      anchor,
      para,
      text: paragraph.text,
      createdAt: nextCreatedAt(),
    };
    excerpts.push(entry);
    await persistAfterMutation();
    return { item: toExcerptView(entry), duplicated: false };
  }

  async function addFavorite({ docId } = {}) {
    if (typeof docId !== 'string' || docId === '') {
      throw new MarksError('INVALID_REQUEST', 400, 'docId 必须是非空字符串');
    }
    assertDoc(docId);
    const existing = favorites.find((item) => item.docId === docId);
    if (existing) return { item: toFavoriteView(existing), duplicated: true };

    if (favorites.length >= limits.MAX_FAVORITES) {
      throw new MarksError('TOO_MANY_MARKS', 429, `收藏数量已达上限 ${limits.MAX_FAVORITES} 条`);
    }

    const entry = { id: newMarkId(), docId, createdAt: nextCreatedAt() };
    favorites.push(entry);
    await persistAfterMutation();
    return { item: toFavoriteView(entry), duplicated: false };
  }

  async function remove(id) {
    if (typeof id !== 'string' || id === '') {
      throw new MarksError('NOT_FOUND', 404, '收藏/摘录不存在');
    }
    const excerptIndex = excerpts.findIndex((item) => item.id === id);
    if (excerptIndex >= 0) {
      excerpts.splice(excerptIndex, 1);
      await persistAfterMutation();
      return { ok: true, kind: 'excerpt' };
    }
    const favoriteIndex = favorites.findIndex((item) => item.id === id);
    if (favoriteIndex >= 0) {
      favorites.splice(favoriteIndex, 1);
      await persistAfterMutation();
      return { ok: true, kind: 'favorite' };
    }
    throw new MarksError('NOT_FOUND', 404, '收藏/摘录不存在');
  }

  /** 等待写队列清空（测试/优雅关闭用）。 */
  async function flush() {
    await writeChain;
  }

  return {
    filePath,
    limits,
    list,
    addExcerpt,
    addFavorite,
    remove,
    stats,
    flush,
    degraded() {
      return degraded;
    },
  };
}

/* ------------------------------- HTTP 路由 ------------------------------- */

function safeDecode(raw) {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    return '';
  }
}

async function readJsonObject(req) {
  const buffer = await readRequestBody(req, { limit: BODY_LIMIT });
  if (buffer.length === 0) return null;
  let data;
  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', '请求体必须是合法 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'INVALID_REQUEST', '请求体必须是 JSON 对象');
  }
  return data;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'INVALID_REQUEST', `${name} 必须是非空字符串`);
  }
  return value.trim();
}

function sendMarksError(res, error) {
  if (error instanceof HttpError) {
    sendApiError(res, error.status, error.code, error.message);
    return true;
  }
  if (error instanceof MarksError) {
    sendApiError(res, error.status, error.code, error.message);
    return true;
  }
  return false;
}

async function handleCreate(req, res, ctx) {
  let payload;
  try {
    payload = await readJsonObject(req);
  } catch (error) {
    if (!sendMarksError(res, error)) sendApiError(res, 400, 'INVALID_REQUEST', '请求体不合法');
    return;
  }
  if (payload === null) {
    sendApiError(res, 400, 'INVALID_REQUEST', '请求体不能为空');
    return;
  }

  try {
    if (payload.kind === 'excerpt') {
      const docId = requireString(payload.docId, 'docId');
      const anchor = requireString(payload.anchor, 'anchor');
      if (!Number.isInteger(payload.para) || payload.para < 0) {
        throw new HttpError(400, 'INVALID_REQUEST', 'para 必须是 ≥0 的整数');
      }
      // text 不接受客户端传入：只按 docId/anchor/para 从语料解析。
      const result = await ctx.marks.addExcerpt({ docId, anchor, para: payload.para });
      sendJson(res, result.duplicated ? 200 : 201, {
        item: result.item,
        duplicated: result.duplicated,
      });
      return;
    }
    if (payload.kind === 'favorite') {
      const docId = requireString(payload.docId, 'docId');
      const result = await ctx.marks.addFavorite({ docId });
      sendJson(res, result.duplicated ? 200 : 201, {
        item: result.item,
        duplicated: result.duplicated,
      });
      return;
    }
    throw new HttpError(400, 'INVALID_REQUEST', 'kind 必须是 excerpt 或 favorite');
  } catch (error) {
    if (sendMarksError(res, error)) return;
    ctx.logger?.error?.(`[marks] 未预期的错误：${error?.stack ?? error}`);
    sendApiError(res, 500, 'INTERNAL', '服务器内部错误');
  }
}

/**
 * 处理 /api/marks 与 /api/marks/:id。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} ctx
 * @param {string[]} segments
 */
export async function handleMarks(req, res, ctx, segments) {
  const store = ctx.marks;
  if (!store) {
    sendApiError(res, 500, 'INTERNAL', '收藏/摘录存储未初始化');
    return;
  }

  // /api/marks
  if (segments.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, store.list());
      return;
    }
    if (req.method === 'POST') {
      await handleCreate(req, res, ctx);
      return;
    }
    sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
    return;
  }

  // /api/marks/:id
  if (segments.length === 3 && req.method === 'DELETE') {
    const id = safeDecode(segments[2]);
    if (!id || !MARK_ID_RE.test(id)) {
      sendApiError(res, 404, 'NOT_FOUND', '收藏/摘录不存在');
      return;
    }
    try {
      await store.remove(id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      if (sendMarksError(res, error)) return;
      ctx.logger?.error?.(`[marks] 删除失败：${error?.stack ?? error}`);
      sendApiError(res, 500, 'INTERNAL', '服务器内部错误');
    }
    return;
  }

  sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
}
