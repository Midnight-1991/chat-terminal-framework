// / 图片附件的服务器持久化与鉴权读取。
//
// 设计要点（docs/DATA-CONTRACT.md 20 / 24 / docs/API-CONTRACT.md 11）：
//   - 内容寻址：sha256(buffer) 前 24 位 hex → 附件 id=`a<24hex>`，文件 `DATA_DIR/attachments/<id>.<ext>`；
//     同内容天然去重（同 id 已存在直接复用，不重写）。
//   - 权限与原子写：目录 0700、文件 0600；先写 `<id>.<ext>.tmp` 再 rename（同目录，原子替换）。
//   - 可选 at-rest 加密（键由 app 注入；缺省 null = 明文）。写入前整段加密，读时解密后
//     按原 Content-Type/长度返回；附件 id 仍按**明文** sha256 计算（去重与引用不变）。
//   - 容量上限：ATTACHMENT_MAX_MB（默认 512MB）；超限时不写并 warn，返回 null（调用方降级为「只存摘要」）。
//   - 鉴权读取：仅 GET/HEAD `/api/attachments/{id}`；站点 Basic Auth 由 nginx 负责；未知/非法 id → 404。
//   - 清理：启动时与会话/记忆删除后 sweep 未被引用的文件与残留 `*.tmp`；失败只 warn 不阻塞主流程。
//   - 隐私：只持久化图片二进制；文本附件不落盘；日志只记数量/字节/错误原因，绝不记图片内容或 base64。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AT_REST_MAGIC, AT_REST_OVERHEAD_BYTES, isAtRestError } from './at-rest.mjs';
import { sendApiError } from './http-utils.mjs';

export const ATTACHMENT_DIR_NAME = 'attachments';
/** 附件 id：`a` + 24 位小写 hex（sha256 前 24 位）。 */
export const ATTACHMENT_ID_RE = /^a[0-9a-f]{24}$/;
export const DEFAULT_ATTACHMENT_MAX_MB = 512;
/** 图片是私有数据：允许浏览器缓存一周，但不得被共享缓存保存。 */
export const ATTACHMENT_CACHE_CONTROL = 'private, max-age=604800';

/** mime → 扩展名：仅 已按 magic bytes 校验过的四种图片格式。 */
export const ATTACHMENT_EXT_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

const MIME_BY_EXT = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
});

const FILE_NAME_RE = /^(a[0-9a-f]{24})\.(jpg|jpeg|png|webp|gif)$/;

/** 由图片字节算出内容寻址 id（同内容 → 同 id）。 */
export function attachmentIdFor(buffer) {
  return `a${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24)}`;
}

/** 公开读取地址（相对路径，前端按同源拼接；不是文件系统路径）。 */
export function attachmentPreviewUrl(id) {
  return `/api/attachments/${id}`;
}

/** 是否合法附件 id。 */
export function isAttachmentId(value) {
  return typeof value === 'string' && ATTACHMENT_ID_RE.test(value);
}

function isInsideDir(dir, filePath) {
  const relative = path.relative(dir, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function totalBytes(map) {
  let bytes = 0;
  for (const entry of map.values()) bytes += entry.size;
  return bytes;
}

/** 收集会话消息与记忆里引用到的附件 id（sweep 的保留集合）。 */
export function collectReferencedAttachmentIds({ conversations = [], memories = [] } = {}) {
  const ids = new Set();
  const addFromList = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      const attachments = item?.attachments;
      if (!Array.isArray(attachments)) continue;
      for (const attachment of attachments) {
        if (isAttachmentId(attachment?.id)) ids.add(attachment.id);
      }
    }
  };
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    // 兼容多种入参：完整会话记录（{messages}）、消息数组（[{attachments}]）或直接一条消息。
    if (Array.isArray(conversation)) addFromList(conversation);
    else if (Array.isArray(conversation?.messages)) addFromList(conversation.messages);
    else addFromList([conversation]);
  }
  addFromList(memories);
  return ids;
}

/**
 * 创建附件存储（零依赖；所有方法失败均降级为 null/0，不抛错到主流程）。
 * @param {{
 *   dataDir: string,
 *   maxTotalMb?: number,
 *   logger?: object,
 *   enabled?: boolean,
 *   atRest?: object|null,
 * }} options
 */
export function createAttachmentStore({
  dataDir,
  maxTotalMb = DEFAULT_ATTACHMENT_MAX_MB,
  logger = console,
  enabled = true,
  atRest = null,
} = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createAttachmentStore 需要 dataDir');
  const rootDir = path.resolve(dataDir);
  const dir = path.join(rootDir, ATTACHMENT_DIR_NAME);
  const on = enabled !== false;
  const maxMb = Number.isFinite(Number(maxTotalMb)) && Number(maxTotalMb) >= 0
    ? Math.floor(Number(maxTotalMb))
    : DEFAULT_ATTACHMENT_MAX_MB;
  const maxBytes = maxMb * 1024 * 1024;
  /** @type {Map<string,{file:string,mime:string,size:number}>|null} 目录索引（懒加载，写/删时增量维护）。 */
  let index = null;

  const warn = (message) => {
    try {
      logger?.warn?.(`[attachments] ${message}`);
    } catch {
      /* logger 自身失败不影响主流程 */
    }
  };

  async function ensureDir() {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.chmod(dir, 0o700);
    } catch {
      /* 非 POSIX 或权限不足时忽略：不影响可用性 */
    }
  }

  /** 扫描磁盘建立索引（跳过非约定命名与 *.tmp）。 */
  async function scan() {
    const map = new Map();
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        index = map;
        return map;
      }
      throw error;
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) continue;
      const match = FILE_NAME_RE.exec(name);
      if (!match) continue;
      const filePath = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;
        map.set(match[1], {
          file: name,
          mime: MIME_BY_EXT[match[2]] ?? 'application/octet-stream',
          size: await readPlaintextSize(filePath, stat.size),
        });
      } catch {
        /* 单个文件不可读：跳过，不影响其它附件 */
      }
    }
    index = map;
    return map;
  }

  /**
   * 磁盘文件对应的明文长度（容量/摘要按明文计）：at-rest 密文 = 文件大小 - 固定额外字节；
   * 读取文件头魔数判断，兼容「同目录里的明文文件」（例如迁移前的旧文件）。
   */
  async function readPlaintextSize(filePath, diskSize) {
    if (!atRest?.enabled) return diskSize;
    try {
      const handle = await fs.promises.open(filePath, 'r');
      try {
        const header = Buffer.alloc(AT_REST_MAGIC.length);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (bytesRead === header.length && header.toString('latin1') === AT_REST_MAGIC) {
          return Math.max(0, diskSize - AT_REST_OVERHEAD_BYTES);
        }
      } finally {
        await handle.close();
      }
    } catch {
      /* 头部探测失败：退回磁盘大小（不影响可用性） */
    }
    return diskSize;
  }

  async function currentIndex() {
    return index ?? scan();
  }

  /**
   * 持久化一张图片（内容寻址 + 去重 + 容量上限）。
   * @param {{buffer: Buffer, mime: string}} input
   * @returns {Promise<{id:string, ext:string, mime:string, size:number}|null>} 失败/关闭/超限 → null
   */
  async function persistImage({ buffer, mime } = {}) {
    if (!on) return null;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const normalizedMime = typeof mime === 'string' ? mime.trim().toLowerCase() : '';
    const ext = ATTACHMENT_EXT_BY_MIME[normalizedMime];
    if (!ext) return null;
    const id = attachmentIdFor(buffer);
    const file = `${id}.${ext}`;
    const filePath = path.join(dir, file);
    try {
      const map = await currentIndex();
      const existing = map.get(id);
      if (existing) return { id, ext: path.extname(existing.file).slice(1), mime: existing.mime, size: existing.size };
      if (totalBytes(map) + buffer.length > maxBytes) {
        warn(`存储容量已达上限（${maxMb}MB），本次只保留解析摘要、不写入图片文件`);
        return null;
      }
      await ensureDir();
      const tmpPath = `${filePath}.tmp`;
      // at-rest 开启时图片二进制整段加密后落盘（文件名/扩展名不变）。
      const stored = atRest ? atRest.seal(filePath, buffer) : buffer;
      await fs.promises.writeFile(tmpPath, stored, { mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
      try {
        await fs.promises.chmod(filePath, 0o600);
      } catch {
        /* 同上：忽略 */
      }
      map.set(id, { file, mime: normalizedMime, size: buffer.length });
      return { id, ext, mime: normalizedMime, size: buffer.length };
    } catch (error) {
      warn(`写入附件失败（本次只保留解析摘要）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * 按 id 读取图片（先校验 id 格式，再 realpath 确保仍位于 attachments 目录内，防穿越/符号链接）。
   * @param {string} id
   * @returns {Promise<{buffer: Buffer, mime: string, size: number}|null>}
   */
  async function read(id) {
    if (!on || !isAttachmentId(id)) return null;
    try {
      const map = await currentIndex();
      const entry = map.get(id);
      if (!entry) return null;
      const realDir = await fs.promises.realpath(dir);
      const realFile = await fs.promises.realpath(path.join(dir, entry.file));
      if (!isInsideDir(realDir, realFile)) return null;
      let buffer = await fs.promises.readFile(realFile);
      // at-rest 开启时解密后返回原始字节（Content-Type/Length 仍按明文）。
      // AAD 用词法路径计算（与写盘时一致；realpath 可能经 /tmp → /private/tmp 符号链接改变相对路径）。
      if (atRest) buffer = atRest.unseal(path.join(dir, entry.file), buffer);
      return { buffer, mime: entry.mime, size: buffer.length };
    } catch (error) {
      if (isAtRestError(error)) {
        warn(`读取附件失败：密文校验失败（密钥不匹配或文件损坏）：${error?.message ?? error}`);
        return null;
      }
      if (error?.code !== 'ENOENT') warn(`读取附件失败：${error?.code ?? error?.message ?? error}`);
      return null;
    }
  }

  /**
   * 清理未被引用的附件文件与残留 *.tmp。
   * @param {{conversations?: Array<object>, memories?: Array<object>}} refs
   * @returns {Promise<{removed:number}>}
   */
  async function sweep({ conversations = [], memories = [] } = {}) {
    if (!on) return { removed: 0 };
    let removed = 0;
    try {
      const referenced = collectReferencedAttachmentIds({ conversations, memories });
      const map = await currentIndex();
      let names;
      try {
        names = await fs.promises.readdir(dir);
      } catch (error) {
        if (error?.code === 'ENOENT') return { removed: 0 };
        throw error;
      }
      for (const name of names) {
        const filePath = path.join(dir, name);
        if (name.endsWith('.tmp')) {
          try {
            await fs.promises.unlink(filePath);
            removed += 1;
          } catch {
            /* 并发删除等：忽略 */
          }
          continue;
        }
        const match = FILE_NAME_RE.exec(name);
        if (!match) continue;
        if (referenced.has(match[1])) continue;
        try {
          await fs.promises.unlink(filePath);
          map.delete(match[1]);
          removed += 1;
        } catch (error) {
          warn(`删除孤儿附件失败：${error?.code ?? error?.message ?? error}`);
        }
      }
    } catch (error) {
      warn(`清理孤儿附件失败（忽略）：${error?.message ?? error}`);
    }
    return { removed };
  }

  /**
   * 按保留天数清理附件（只删「未被引用 + mtime 超龄」的文件；.tmp 同样要求超龄）。
   * @param {{
   *   conversations?: Array<object>,
   *   memories?: Array<object>,
   *   referencedIds?: Set<string>|null,
   *   maxAgeDays?: number,
   *   now?: () => Date|Date,
   * }} refs
   * @returns {Promise<{removed:number, bytes:number}>}
   */
  async function sweepExpired({
    conversations = [],
    memories = [],
    referencedIds = null,
    maxAgeDays = 0,
    now = () => new Date(),
  } = {}) {
    if (!on) return { removed: 0, bytes: 0 };
    const days = Number.isFinite(Number(maxAgeDays)) ? Math.floor(Number(maxAgeDays)) : 0;
    if (days <= 0) return { removed: 0, bytes: 0 };
    let cutoffMs;
    try {
      const value = typeof now === 'function' ? now() : now;
      const date = value instanceof Date ? value : new Date(value ?? Date.now());
      cutoffMs = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
    } catch {
      cutoffMs = Date.now();
    }
    const cutoff = cutoffMs - days * 86_400_000;
    let removed = 0;
    let bytes = 0;
    try {
      const referenced =
        referencedIds instanceof Set
          ? referencedIds
          : collectReferencedAttachmentIds({ conversations, memories });
      const map = await currentIndex();
      let names;
      try {
        names = await fs.promises.readdir(dir);
      } catch (error) {
        if (error?.code === 'ENOENT') return { removed: 0, bytes: 0 };
        throw error;
      }
      for (const name of names) {
        const filePath = path.join(dir, name);
        const isTemp = name.endsWith('.tmp');
        const match = isTemp ? null : FILE_NAME_RE.exec(name);
        if (!isTemp && !match) continue;
        if (!isTemp && referenced.has(match[1])) continue;
        let stat;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          continue;
        }
        if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs >= cutoff) continue;
        try {
          await fs.promises.unlink(filePath);
          if (match) map.delete(match[1]);
          removed += 1;
          bytes += Number.isFinite(stat.size) ? stat.size : 0;
        } catch (error) {
          warn(`清理过期附件失败：${error?.code ?? error?.message ?? error}`);
        }
      }
    } catch (error) {
      warn(`清理过期附件失败（忽略）：${error?.message ?? error}`);
    }
    return { removed, bytes };
  }

  /** 统计（供启动日志/测试；不通过 HTTP 暴露给前端）。 */
  async function stats() {
    const empty = { enabled: on, dir, count: 0, bytes: 0, maxMb };
    if (!on) return empty;
    try {
      const map = await scan();
      return { enabled: true, dir, count: map.size, bytes: totalBytes(map), maxMb };
    } catch (error) {
      warn(`统计附件失败（忽略）：${error?.message ?? error}`);
      return empty;
    }
  }

  return { enabled: on, dir, persistImage, read, sweep, sweepExpired, stats };
}

/**
 * 收集 store 中会话/记忆的引用后 sweep（启动与删除后的统一入口）。
 * 失败只 warn、返回 {removed:0}，绝不影响主流程。
 * @param {{attachments?: object, store?: object, logger?: object}} options
 */
export async function sweepStoreAttachments({ attachments, store, logger = console } = {}) {
  if (!attachments || typeof attachments.sweep !== 'function') return { removed: 0 };
  try {
    const conversations = [];
    if (store && typeof store.listConversations === 'function') {
      for (const summary of store.listConversations()) {
        const detail =
          typeof store.getConversation === 'function' ? store.getConversation(summary?.id) : null;
        if (detail && Array.isArray(detail.messages)) conversations.push(detail);
      }
    }
    const memories = store && typeof store.listMemories === 'function' ? store.listMemories() : [];
    return await attachments.sweep({ conversations, memories });
  } catch (error) {
    try {
      logger?.warn?.(`[attachments] 清理孤儿附件失败（忽略）：${error?.message ?? error}`);
    } catch {
      /* ignore */
    }
    return { removed: 0 };
  }
}

/**
 * 附件保留期清理的统一入口（管理员维护端点与测试使用）。
 * 只删除「未被引用 + mtime 超过 maxAgeDays」的附件与 .tmp；失败只 warn、返回 {removed:0,bytes:0}。
 * @param {{
 *   attachments?: object,
 *   references?: {conversations?: Array<object>, memories?: Array<object>, referencedIds?: Set<string>},
 *   conversations?: Array<object>,
 *   memories?: Array<object>,
 *   maxAgeDays?: number,
 *   config?: object|null,
 *   logger?: object,
 *   now?: () => Date|Date,
 * }} options
 */
export async function cleanupExpiredAttachments({
  attachments,
  references = null,
  conversations = [],
  memories = [],
  maxAgeDays,
  config = null,
  logger = console,
  now = () => new Date(),
} = {}) {
  if (!attachments || typeof attachments.sweepExpired !== 'function') {
    return { removed: 0, bytes: 0 };
  }
  const configured =
    maxAgeDays ?? (config && typeof config === 'object' ? config.attachmentRetentionDays : 0);
  try {
    const refs = references && typeof references === 'object' ? references : {};
    const referencedIds = refs.referencedIds instanceof Set ? refs.referencedIds : null;
    const refConversations = Array.isArray(refs.conversations)
      ? refs.conversations
      : Array.isArray(conversations)
        ? conversations
        : [];
    const refMemories = Array.isArray(refs.memories)
      ? refs.memories
      : Array.isArray(memories)
        ? memories
        : [];
    const result = await attachments.sweepExpired({
      conversations: refConversations,
      memories: refMemories,
      referencedIds,
      maxAgeDays: configured,
      now,
    });
    return {
      removed: Number.isFinite(result?.removed) ? result.removed : 0,
      bytes: Number.isFinite(result?.bytes) ? result.bytes : 0,
    };
  } catch (error) {
    try {
      logger?.warn?.(`[attachments] 过期附件清理失败（忽略）：${error?.message ?? error}`);
    } catch {
      /* ignore */
    }
    return { removed: 0, bytes: 0 };
  }
}

/** 单条已解析附件：图片持久化成功则把 id 挂到元数据上（失败/文本附件原样返回）。 */
export async function persistParsedImage(parsed, source, attachmentStore, logger = console) {
  if (!parsed || source?.kind !== 'image' || !attachmentStore) return parsed;
  const dataBase64 = typeof source.dataBase64 === 'string' ? source.dataBase64 : '';
  if (!dataBase64) return parsed;
  try {
    const persisted = await attachmentStore.persistImage({
      buffer: Buffer.from(dataBase64, 'base64'),
      mime: source.mime,
    });
    if (!persisted?.id) return parsed;
    return { ...parsed, id: persisted.id };
  } catch (error) {
    try {
      logger?.warn?.(`[attachments] 图片持久化失败（本附件只保留摘要）：${error?.message ?? error}`);
    } catch {
      /* ignore */
    }
    return parsed;
  }
}

/** 批量版本（chat 多图）：返回与 parsedAttachments 等长的新数组。 */
export async function persistAttachmentImages({
  parsedAttachments = [],
  attachments = [],
  attachmentStore,
  logger = console,
} = {}) {
  const list = Array.isArray(parsedAttachments) ? parsedAttachments : [];
  const sources = Array.isArray(attachments) ? attachments : [];
  const persisted = [];
  for (let index = 0; index < list.length; index += 1) {
    persisted.push(await persistParsedImage(list[index], sources[index], attachmentStore, logger));
  }
  return persisted;
}

/**
 * 处理 GET/HEAD /api/attachments/{id}（二进制响应；未知/非法 id 404）。
 * 站点鉴权由 nginx Basic Auth 负责；安全头由 app 全局中间层统一附加。
 */
export async function handleAttachments(req, res, ctx, segments) {
  if (segments.length !== 3) {
    sendApiError(res, 404, 'NOT_FOUND', '附件不存在');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
    return;
  }
  let id;
  try {
    id = decodeURIComponent(segments[2] ?? '');
  } catch {
    id = '';
  }
  if (!isAttachmentId(id)) {
    sendApiError(res, 404, 'NOT_FOUND', '附件不存在');
    return;
  }
  const store = ctx?.attachments;
  const found = store ? await store.read(id) : null;
  if (!found) {
    sendApiError(res, 404, 'NOT_FOUND', '附件不存在');
    return;
  }
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(200, {
    'content-type': found.mime,
    'content-length': found.buffer.length,
    etag: `"${id}"`,
    'cache-control': ATTACHMENT_CACHE_CONTROL,
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(found.buffer);
}
