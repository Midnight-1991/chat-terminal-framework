// 管理员操作审计日志（JSONL，DATA_DIR/audit.jsonl）。
//
// 设计要点（接口契约  4、DECISIONS ）：
//   - 仅追加；每行一个 JSON 对象，文件 0600、目录 0700；写操作串行（appendFile 顺序 + 进程内队列）。
//   - 保留 180 天：启动（首次使用）时按 ts 过滤重写一次；ts 非法/结构非法的行丢弃并 warn（不抛错）。
//   - entry 字段：{ id, ts, actorId, actorUsername, action, targetType, targetId, detail }；
//     detail 只允许字符串/数字/布尔/字符串数组（调用方保证不含密码/key/正文）。
//   - list({limit,cursor})：按时间倒序分页；cursor = 上一页最后一条 entry.id（不透明字符串）。
//   - 依赖注入 { dataDir, logger, now }；全部失败降级为 warn + 空结果，绝不影响主流程。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { HttpError } from './http-utils.mjs';

export const AUDIT_FILE_NAME = 'audit.jsonl';
export const AUDIT_RETENTION_DAYS = 180;
export const AUDIT_LIMIT_DEFAULT = 20;
export const AUDIT_LIMIT_MAX = 100;

const DAY_MS = 86_400_000;

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

function newAuditId() {
  return `a${crypto.randomBytes(4).toString('hex')}`;
}

function cloneDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  try {
    return JSON.parse(JSON.stringify(detail));
  } catch {
    return null;
  }
}

function cloneEntry(entry) {
  return { ...entry, detail: cloneDetail(entry.detail) };
}

/** 只保留可安全落盘的基础类型；数组仅接受字符串数组。 */
function sanitizeDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      out[key] = value.slice(0, 50);
    }
  }
  return out;
}

/**
 * 创建审计日志（懒加载；首次 append/list/flush 时加载并 prune 一次）。
 * @param {{ dataDir: string, logger?: object, now?: () => Date }} opts
 */
export function createAuditLog({ dataDir, logger = console, now = () => new Date() } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createAuditLog 需要 dataDir');
  const rootDir = path.resolve(dataDir);
  const filePath = path.join(rootDir, AUDIT_FILE_NAME);

  /** @type {Array<object>} 内存中的条目（按追加顺序，list 时再排序）。 */
  let entries = [];
  let readyPromise = null;
  let writeChain = Promise.resolve();

  const warn = (message) => {
    try {
      logger?.warn?.(`[audit] ${message}`);
    } catch {
      /* logger 自身失败不影响主流程 */
    }
  };

  const nowDate = () => resolveDate(now);

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'INVALID_INPUT', '审计条目必须是 JSON 对象');
    }
    const action = typeof raw.action === 'string' ? raw.action.trim() : '';
    if (action.length === 0) throw new HttpError(400, 'INVALID_INPUT', '审计条目缺少 action');
    const tsRaw = typeof raw.ts === 'string' ? raw.ts : nowDate().toISOString();
    const tsMs = Date.parse(tsRaw);
    const ts = Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : nowDate().toISOString();
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : newAuditId();
    return {
      id,
      ts,
      actorId: typeof raw.actorId === 'string' ? raw.actorId : null,
      actorUsername: typeof raw.actorUsername === 'string' ? raw.actorUsername : null,
      action,
      targetType: typeof raw.targetType === 'string' ? raw.targetType : null,
      targetId: typeof raw.targetId === 'string' ? raw.targetId : null,
      detail: sanitizeDetail(raw.detail),
    };
  }

  async function rewriteFile() {
    try {
      await fs.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
      const text = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
      const tmpPath = `${filePath}.tmp`;
      await fs.promises.writeFile(tmpPath, text, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
      try {
        await fs.promises.chmod(filePath, 0o600);
      } catch {
        /* 非 POSIX 或权限不足时忽略 */
      }
    } catch (error) {
      warn(`重写 ${AUDIT_FILE_NAME} 失败：${error?.message ?? error}`);
    }
  }

  async function loadAndPrune() {
    let raw = null;
    try {
      raw = await fs.promises.readFile(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`读取 ${AUDIT_FILE_NAME} 失败，按空数据处理：${error?.message ?? error}`);
      raw = null;
    }
    const loaded = [];
    if (raw !== null) {
      const lines = raw.toString('utf8').split('\n');
      let skipped = 0;
      for (const line of lines) {
        const text = line.trim();
        if (text.length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          skipped += 1;
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.action !== 'string') {
          skipped += 1;
          continue;
        }
        loaded.push(parsed);
      }
      if (skipped > 0) warn(`${AUDIT_FILE_NAME} 跳过 ${skipped} 行非法记录`);
    }
    // 启动 prune：保留最近 AUDIT_RETENTION_DAYS 天（ts 非法的行一并丢弃）。
    const cutoff = nowDate().getTime() - AUDIT_RETENTION_DAYS * DAY_MS;
    const kept = loaded.filter((entry) => {
      const tsMs = Date.parse(entry.ts);
      return Number.isFinite(tsMs) && tsMs >= cutoff;
    });
    entries = kept.map(cloneEntry);
    if (kept.length !== loaded.length) {
      writeChain = writeChain.then(() => rewriteFile());
      await writeChain;
    }
  }

  function ensureReady() {
    if (!readyPromise) {
      readyPromise = loadAndPrune().catch((error) => {
        warn(`初始化审计日志失败（按空数据处理）：${error?.message ?? error}`);
        entries = [];
      });
    }
    return readyPromise;
  }

  async function append(raw = {}) {
    await ensureReady();
    const entry = normalizeEntry(raw);
    entries.push(entry);
    writeChain = writeChain
      .then(async () => {
        try {
          await fs.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
          await fs.promises.appendFile(filePath, `${JSON.stringify(entry)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          });
          try {
            await fs.promises.chmod(filePath, 0o600);
          } catch {
            /* 非 POSIX 或权限不足时忽略 */
          }
        } catch (error) {
          warn(`追加 ${AUDIT_FILE_NAME} 失败：${error?.message ?? error}`);
        }
      })
      .catch(() => undefined);
    await writeChain;
    return cloneEntry(entry);
  }

  async function list(options = {}) {
    await ensureReady();
    const rawLimit = options?.limit;
    let limit = Number.isInteger(rawLimit) ? rawLimit : AUDIT_LIMIT_DEFAULT;
    if (limit < 1) limit = AUDIT_LIMIT_DEFAULT;
    if (limit > AUDIT_LIMIT_MAX) limit = AUDIT_LIMIT_MAX;
    const cursor = typeof options?.cursor === 'string' && options.cursor.length > 0 ? options.cursor : null;
    // 时间倒序；ts 相同按追加顺序倒序（最新在前）。
    const sorted = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const diff = Date.parse(b.entry.ts) - Date.parse(a.entry.ts);
        return diff !== 0 ? diff : b.index - a.index;
      })
      .map((item) => item.entry);
    let start = 0;
    if (cursor !== null) {
      const position = sorted.findIndex((entry) => entry.id === cursor);
      if (position === -1) throw new HttpError(400, 'INVALID_CURSOR', '审计游标无效');
      start = position + 1;
    }
    const page = sorted.slice(start, start + limit);
    const hasMore = start + limit < sorted.length;
    return {
      entries: page.map(cloneEntry),
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
    };
  }

  async function flush() {
    await ensureReady();
    await writeChain;
  }

  return { append, list, flush };
}
