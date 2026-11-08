// v2 持久化 store：DATA_DIR 下 index.json / conversations/<id>.json / memories.json。
// 设计要点（docs/DATA-CONTRACT.md 8–9、24）：
//   - 原子写：写 <file>.tmp 再 rename；同一文件/同一会话的写操作用串行队列排队。
//   - 启动加载：单个 JSON 损坏 → 跳过并 warn，不阻塞启动；目录不可写 → 降级内存模式。
//   - 可选 at-rest 加密（键由 app 注入；缺省 null = 明文，行为不变）。加密数据
//     解不开时必须 fail-fast 向上抛，绝不当作「损坏」静默跳过或覆盖。
//   - 上限：会话 200、单会话消息 200、记忆 200（超限删最旧）。
//   - 记忆矛盾：软失效（validTo 置时间），不物理删除；用户删除才真正删。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isAtRestError } from './at-rest.mjs';

/** 空白会话（0 条消息）在磁盘上的保留窗口：超过后启动时清理，不长期占用历史。 */
export const EMPTY_CONVERSATION_TTL_MS = 60 * 60 * 1000;

export const STORE_LIMITS = Object.freeze({
  MAX_CONVERSATIONS: 200,
  MAX_MESSAGES: 200,
  MAX_MEMORIES: 200,
  MAX_TITLE_CHARS: 60,
  DEFAULT_TITLE: '新对话',
});

/** 归一化/相似度阈值（记忆去重与矛盾判定）；供 memory.mjs 与测试共用。 */
export const MEMORY_SIMILARITY = Object.freeze({
  DUPLICATE: 0.8, // ≥ 0.8 视为重复，跳过
  CONTRADICTION_MIN: 0.5, // [0.5, 0.8) 且同主题 → 旧记忆软失效
});

/** 记忆分级 schema v2（store 与 memory 共用）。 */
export const MEMORY_FILE_VERSION = 2;
export const MEMORY_LEVELS = Object.freeze(['core', 'trivia']);
export const MEMORY_SOURCES = Object.freeze(['auto', 'manual', 'upload']);
/** core 类别（trivia 固定 other）；顺序即注入/展示优先级。 */
export const MEMORY_CORE_CATEGORIES = Object.freeze([
  'general',
  'demographics',
  'health',
  'family',
  'identity',
  'interpersonal',
  'academic',
  'upload',
  'other',
]);
export const MEMORY_CATEGORY_PRIORITY = Object.freeze(
  Object.fromEntries(MEMORY_CORE_CATEGORIES.map((category, index) => [category, index])),
);

/** 会话/记忆 id 格式（服务端生成；路由侧只做宽松校验，找不到统一 404）。 */
export const CONVERSATION_ID_RE = /^c[0-9a-f]{12}$/;
export const MEMORY_ID_RE = /^m[0-9a-f]{12}$/;
export const ID_LOOKUP_RE = /^[A-Za-z0-9_-]{1,64}$/;

function newConversationId() {
  return `c${crypto.randomBytes(6).toString('hex')}`;
}

function newMemoryId() {
  return `m${crypto.randomBytes(6).toString('hex')}`;
}

function nowMs() {
  return Date.now();
}

/** 自动标题：去换行、前 20 个字符（按 Unicode 码点），超长加 …（DATA-CONTRACT 5.6）。 */
export function deriveTitle(text) {
  const clean = String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(clean);
  if (chars.length <= 20) return clean;
  return `${chars.slice(0, 20).join('')}…`;
}

function summarize(record) {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    // 轮 = user 消息数（API-CONTRACT 5.1：一轮 = 一条 user + 一条 assistant）
    turnCount: record.messages.filter((m) => m.role === 'user').length,
  };
}

function truncateMessages(messages) {
  if (messages.length <= STORE_LIMITS.MAX_MESSAGES) return messages;
  // 超限时从尾部保留，并保证第一条是 user（丢掉落单的 assistant）。
  const kept = messages.slice(-STORE_LIMITS.MAX_MESSAGES);
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return kept;
}

function isValidConversationRecord(record, expectedId) {
  return (
    record &&
    typeof record === 'object' &&
    typeof record.id === 'string' &&
    (!expectedId || record.id === expectedId) &&
    typeof record.title === 'string' &&
    Number.isFinite(record.createdAt) &&
    Number.isFinite(record.updatedAt) &&
    Array.isArray(record.messages)
  );
}

function isValidMemory(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    typeof entry.text === 'string' &&
    entry.text.trim() !== '' &&
    Number.isFinite(entry.createdAt)
  );
}

/**
 * 创建 store（初始化会同步加载磁盘数据）。
 * @param {{dataDir: string, logger?: Console, atRest?: object|null}} opts
 */
export async function createStore({ dataDir, logger = console, atRest = null } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createStore 需要 dataDir');
  const rootDir = path.resolve(dataDir);
  const conversationsDir = path.join(rootDir, 'conversations');
  const indexFile = path.join(rootDir, 'index.json');
  const memoriesFile = path.join(rootDir, 'memories.json');

  /** @type {Map<string, {id:string,title:string,createdAt:number,updatedAt:number,messages:Array<object>}>} */
  const conversations = new Map();
  /** @type {Array<{id:string,kind:string,text:string,createdAt:number,validFrom:number,validTo:number|null,sourceConversationId?:string}>} */
  const memories = [];
  /** @type {Map<string, Promise<unknown>>} 串行队列：同一文件/会话的写操作排队。 */
  const queues = new Map();
  let degraded = false;
  let degradedWarned = false;
  /** 旧 schema（version 1 或缺 level/source/category）在启动时迁移为 v2，并异步回写一次。 */
  let memoriesMigrated = false;

  const warn = (message) => {
    try {
      logger?.warn?.(`[store] ${message}`);
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

  function enqueue(key, task) {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    // 队列尾部只保留最新 promise；完成后清理，避免 map 无限增长。
    queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * 等待写队列清空（优雅关闭用；测试/诊断同样可用）。
   * 队列在等待期间可能又被追加，循环到连续两次快照一致为止（正常关闭时为一次）。
   */
  async function flush() {
    for (let round = 0; round < 100; round += 1) {
      const pending = [...queues.values()];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
      const remaining = [...queues.values()];
      if (
        remaining.length === pending.length &&
        remaining.every((item, index) => item === pending[index])
      ) {
        return;
      }
    }
  }

  async function writeJsonAtomic(filePath, data) {
    if (degraded) return false;
    try {
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        await fs.promises.chmod(dir, 0o700);
      } catch {
        /* 非 POSIX 或权限不足时忽略：仍是可用状态 */
      }
      const tmpPath = `${filePath}.tmp`;
      // at-rest 开启时整份 JSON 加密后再落盘；关闭时写明文（既有行为不变）。
      const text = `${JSON.stringify(data, null, 2)}\n`;
      const payload = atRest ? atRest.seal(filePath, Buffer.from(text, 'utf8')) : text;
      await fs.promises.writeFile(tmpPath, payload, {
        encoding: typeof payload === 'string' ? 'utf8' : undefined,
        mode: 0o600,
      });
      await fs.promises.rename(tmpPath, filePath);
      try {
        await fs.promises.chmod(filePath, 0o600);
      } catch {
        /* 同上 */
      }
      return true;
    } catch (error) {
      markDegraded(`写入 ${path.relative(rootDir, filePath)} 失败：${error?.message ?? error}`);
      return false;
    }
  }

  function persistIndex() {
    return enqueue('index', () =>
      writeJsonAtomic(indexFile, { version: 1, conversations: sortedSummaries() }),
    );
  }

  function conversationFile(id) {
    return path.join(conversationsDir, `${id}.json`);
  }

  function persistConversation(record) {
    return enqueue(`conv:${record.id}`, () =>
      writeJsonAtomic(conversationFile(record.id), { version: 1, ...record }),
    );
  }

  function persistMemories() {
    return enqueue('memories', () => writeJsonAtomic(memoriesFile, { version: MEMORY_FILE_VERSION, memories }));
  }

  function sortedSummaries() {
    return [...conversations.values()]
      .map(summarize)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  /** 从消息对里保证 user 开头、按最近 200 条裁剪；返回新数组。 */
  function normalizeMessages(messages) {
    const filtered = messages.filter(
      (message) => message && (message.role === 'user' || message.role === 'assistant'),
    );
    return truncateMessages(filtered);
  }

  /* ------------------------------- 启动加载 ------------------------------- */

  const lockFile = path.join(rootDir, '.lock');

  /** 单实例锁：避免两个进程同时写同一个 DATA_DIR 造成数据错乱；崩溃遗留的死锁自动接管。 */
  function acquireInstanceLock() {
    try {
      // 首次启动（全新 DATA_DIR）没有锁文件属正常情况：ENOENT 视为「无锁」，继续创建；
      // 其它读取错误仍走降级告警。
      let existing = null;
      try {
        existing = Number(fs.readFileSync(lockFile, 'utf8').trim());
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (Number.isInteger(existing) && existing > 0 && existing !== process.pid) {
        try {
          process.kill(existing, 0);
          throw new Error(`DATA_DIR 已被运行中的进程（pid ${existing}）占用`);
        } catch (error) {
          if (error && error.code !== 'ESRCH') throw error;
          warn(`发现过期实例锁（pid ${existing} 已不在运行），接管数据目录`);
        }
      }
      fs.writeFileSync(lockFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
      process.once('exit', () => {
        try {
          if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockFile);
        } catch {
          /* 退出清理尽力而为 */
        }
      });
    } catch (error) {
      if (String(error?.message ?? '').includes('DATA_DIR 已被')) throw error;
      warn(`实例锁创建失败（继续以无锁模式运行）：${error?.message ?? error}`);
    }
  }

  /** 读 JSON 文件：at-rest 开启时先解密；加密数据解不开必须向上抛（fail-fast）。 */
  function readJsonFileSync(filePath) {
    const raw = fs.readFileSync(filePath);
    const text = atRest ? atRest.unseal(filePath, raw).toString('utf8') : raw.toString('utf8');
    return JSON.parse(text);
  }

  function loadFromDisk() {
    try {
      fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(rootDir, 0o700);
      } catch {
        /* 非 POSIX 时忽略 */
      }
      acquireInstanceLock();
      fs.mkdirSync(conversationsDir, { recursive: true, mode: 0o700 });
      fs.accessSync(rootDir, fs.constants.W_OK);
    } catch (error) {
      if (String(error?.message ?? '').includes('DATA_DIR 已被')) throw error;
      markDegraded(`无法创建/访问数据目录 ${rootDir}：${error?.message ?? error}`);
      return;
    }

    // 1) 完整会话文件是会话真源；index.json 只用于摘要（损坏可重建）。
    let names = [];
    try {
      names = fs.readdirSync(conversationsDir);
    } catch (error) {
      warn(`读取会话目录失败，按空历史启动：${error?.message ?? error}`);
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const filePath = path.join(conversationsDir, name);
      let record;
      try {
        record = readJsonFileSync(filePath);
      } catch (error) {
        if (isAtRestError(error)) throw error;
        warn(`会话文件损坏，已跳过 ${name}：${error?.message ?? error}`);
        continue;
      }
      const expectedId = name.replace(/\.json$/, '');
      if (!isValidConversationRecord(record, expectedId)) {
        warn(`会话文件结构不合法，已跳过 ${name}`);
        continue;
      }
      record.messages = normalizeMessages(record.messages);
      record.title = typeof record.title === 'string' && record.title ? record.title : STORE_LIMITS.DEFAULT_TITLE;
      conversations.set(record.id, record);
    }

    // 1.5) 空白会话（0 条消息）不保存：超过 EMPTY_CONVERSATION_TTL_MS 的启动时清理；
    //      最近的先保留，避免删掉「刚打开、还没发消息」的进行中会话。
    for (const [id, record] of conversations) {
      if (record.messages.length !== 0) continue;
      if (Date.now() - record.updatedAt <= EMPTY_CONVERSATION_TTL_MS) continue;
      conversations.delete(id);
      try {
        fs.rmSync(conversationFile(id), { force: true });
      } catch {
        /* ignore */
      }
    }

    // 2) 老 index.json 中记录了但文件已丢失的会话：跳过并提示（不阻塞启动）。
    try {
      const indexData = readJsonFileSync(indexFile);
      for (const summary of Array.isArray(indexData?.conversations) ? indexData.conversations : []) {
        if (summary && typeof summary.id === 'string' && !conversations.has(summary.id)) {
          warn(`index.json 中的会话 ${summary.id} 缺少消息文件，已忽略`);
        }
      }
    } catch (error) {
      if (isAtRestError(error)) throw error;
      if (error?.code !== 'ENOENT') warn(`index.json 损坏，将按会话文件重建：${error?.message ?? error}`);
    }

    // 3) 会话数量超限：删最旧（updatedAt 最小）。
    if (conversations.size > STORE_LIMITS.MAX_CONVERSATIONS) {
      const ordered = [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const record of ordered.slice(STORE_LIMITS.MAX_CONVERSATIONS)) {
        conversations.delete(record.id);
        try {
          fs.rmSync(conversationFile(record.id), { force: true });
        } catch {
          /* ignore */
        }
      }
    }

    // 4) 记忆文件（version 2 分级 schema；兼容并迁移 version 1）
    try {
      const data = readJsonFileSync(memoriesFile);
      const list = Array.isArray(data?.memories) ? data.memories : [];
      if (data?.version !== MEMORY_FILE_VERSION) memoriesMigrated = true;
      for (const entry of list) {
        if (!isValidMemory(entry)) continue;
        const { memory, migrated } = normalizeStoredMemory(entry);
        if (migrated) memoriesMigrated = true;
        memories.push(memory);
      }
      if (list.length !== memories.length) warn(`memories.json 中有 ${list.length - memories.length} 条损坏记录已跳过`);
    } catch (error) {
      if (isAtRestError(error)) throw error;
      if (error?.code !== 'ENOENT') warn(`memories.json 损坏，按空记忆启动：${error?.message ?? error}`);
    }
    if (memories.length > STORE_LIMITS.MAX_MEMORIES) {
      memories.sort((a, b) => a.createdAt - b.createdAt);
      memories.splice(0, memories.length - STORE_LIMITS.MAX_MEMORIES);
    }
  }

  loadFromDisk();

  /** 启动后收敛一次 index.json（会话文件才是真源）。 */
  if (!degraded) {
    void persistIndex().catch(() => {});
  }
  /** 旧记忆 schema 迁移后异步回写一次（失败不影响启动，下次启动重试）。 */
  if (!degraded && memoriesMigrated) {
    void persistMemories().catch(() => {});
  }

  /* ------------------------------- 会话 API ------------------------------- */

  function getConversationRecord(id) {
    const record = conversations.get(String(id ?? ''));
    return record ?? null;
  }

  async function createConversation({ title } = {}) {
    const now = nowMs();
    let id = newConversationId();
    while (conversations.has(id)) id = newConversationId();
    const record = {
      id,
      title: typeof title === 'string' && title.trim() ? title.trim() : STORE_LIMITS.DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    conversations.set(id, record);
    if (conversations.size > STORE_LIMITS.MAX_CONVERSATIONS) {
      const ordered = [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const stale of ordered.slice(STORE_LIMITS.MAX_CONVERSATIONS)) {
        conversations.delete(stale.id);
        try {
          fs.rmSync(conversationFile(stale.id), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    await persistConversation(record);
    await persistIndex();
    return summarize(record);
  }

  function listConversations() {
    // 空白会话（尚未发出任何消息）不进入历史：用户要求「无信息发送的空白对话不需要保存」。
    return sortedSummaries().filter((summary) => summary.turnCount > 0);
  }

  /** 详情：不含 turnCount（契约 5.3）。 */
  function getConversation(id) {
    const record = conversations.get(String(id ?? ''));
    if (!record) return null;
    return {
      conversation: {
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      messages: record.messages.map((message) => ({ ...message })),
    };
  }

  async function updateConversationTitle(id, title) {
    const record = conversations.get(String(id ?? ''));
    if (!record) return null;
    record.title = String(title).trim();
    await persistConversation(record);
    await persistIndex();
    return summarize(record);
  }

  /**
   * 追加一条消息；首条 user 消息若标题仍是「新对话」则自动取前 20 字作为标题。
   * @returns {Promise<{summary: object, autoTitled: boolean}|null>}
   */
  async function appendMessage(id, message) {
    const record = conversations.get(String(id ?? ''));
    if (!record || !message || typeof message !== 'object') return null;
    let autoTitled = false;
    if (
      message.role === 'user' &&
      record.title === STORE_LIMITS.DEFAULT_TITLE &&
      !record.messages.some((item) => item.role === 'user')
    ) {
      const derived = deriveTitle(message.text);
      if (derived) {
        record.title = derived;
        autoTitled = true;
      }
    }
    record.messages.push({ ...message });
    record.messages = normalizeMessages(record.messages);
    record.updatedAt = nowMs();
    await persistConversation(record);
    await persistIndex();
    return { summary: summarize(record), autoTitled };
  }

  async function deleteConversation(id) {
    const record = conversations.get(String(id ?? ''));
    if (!record) return false;
    conversations.delete(record.id);
    try {
      fs.rmSync(conversationFile(record.id), { force: true });
    } catch {
      /* ignore */
    }
    await persistIndex();
    return true;
  }

  /* ------------------------------- 记忆 API ------------------------------- */

  function orderedMemories() {
    // core 在前（按 general→demographics→health→family→identity→interpersonal→
    // academic→upload→other 类别优先级，同类最近优先），trivia 在后（最近优先）；
    // createdAt 相同时按插入顺序，后插入视为更新（保证排序确定，避免同毫秒写入不稳定）。
    return memories
      .map((memory, index) => {
        const level = memory.level === 'trivia' ? 'trivia' : 'core';
        const category = level === 'trivia'
          ? 'other'
          : (MEMORY_CORE_CATEGORIES.includes(memory.category) ? memory.category : 'other');
        return { memory, index, level, category };
      })
      .sort((a, b) => {
        if (a.level !== b.level) return a.level === 'core' ? -1 : 1;
        if (a.level === 'core') {
          const leftPriority = MEMORY_CATEGORY_PRIORITY[a.category] ?? MEMORY_CATEGORY_PRIORITY.other;
          const rightPriority = MEMORY_CATEGORY_PRIORITY[b.category] ?? MEMORY_CATEGORY_PRIORITY.other;
          if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        }
        if (a.memory.createdAt !== b.memory.createdAt) return b.memory.createdAt - a.memory.createdAt;
        return b.index - a.index;
      })
      .map((entry) => entry.memory);
  }

  function listMemories() {
    return orderedMemories().map((memory) => ({ ...memory }));
  }

  function getActiveMemories() {
    return orderedMemories()
      .filter((memory) => !memory.validTo)
      .map((memory) => ({ ...memory }));
  }

  function memoryTextList() {
    return memories.map((memory) => memory.text);
  }

  /** 记忆附件元数据白名单：只留摘要等元数据，绝不保留 base64/原始字节/本地路径。 */
  function normalizeAttachmentMeta(attachments) {
    if (!Array.isArray(attachments)) return [];
    return attachments
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
        ...(entry.kind === 'image' || entry.kind === 'text' ? { kind: entry.kind } : {}),
        ...(typeof entry.mime === 'string' ? { mime: entry.mime } : {}),
        ...(Number.isFinite(entry.size) ? { size: entry.size } : {}),
        ...(typeof entry.summary === 'string' ? { summary: entry.summary } : {}),
        // 图片二进制在 DATA_DIR/attachments 内容寻址存储；元数据只留只读引用
        // （id + 相对 previewUrl），重启后历史回显仍可读取；绝不写路径/字节。
        ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
        ...(typeof entry.previewUrl === 'string' ? { previewUrl: entry.previewUrl } : {}),
      }))
      .filter((entry) => Object.keys(entry).length > 0);
  }

  /** 磁盘记录归一化为 schema v2（旧记录 level=core、category=other、source=attachments?upload:auto）。 */
  function normalizeStoredMemory(entry) {
    const level = MEMORY_LEVELS.includes(entry.level) ? entry.level : 'core';
    const category = level === 'trivia'
      ? 'other'
      : (MEMORY_CORE_CATEGORIES.includes(entry.category) ? entry.category : 'other');
    const attachmentMeta = normalizeAttachmentMeta(entry.attachments);
    const source = MEMORY_SOURCES.includes(entry.source) ? entry.source : (attachmentMeta.length ? 'upload' : 'auto');
    const migrated = !MEMORY_LEVELS.includes(entry.level)
      || !MEMORY_SOURCES.includes(entry.source)
      || !MEMORY_CORE_CATEGORIES.includes(entry.category);
    return {
      migrated,
      memory: {
        id: entry.id,
        kind: ['profile', 'fact', 'episode'].includes(entry.kind) ? entry.kind : 'fact',
        level,
        category,
        source,
        text: entry.text,
        createdAt: entry.createdAt,
        validFrom: Number.isFinite(entry.validFrom) ? entry.validFrom : entry.createdAt,
        validTo: Number.isFinite(entry.validTo) ? entry.validTo : null,
        ...(typeof entry.sourceConversationId === 'string'
          ? { sourceConversationId: entry.sourceConversationId }
          : {}),
        ...(attachmentMeta.length ? { attachments: attachmentMeta } : {}),
        ...(Number.isFinite(entry.editedAt) ? { editedAt: entry.editedAt } : {}),
      },
    };
  }

  async function addMemory({ text, kind = 'fact', level = 'core', category = 'other', source = 'manual', sourceConversationId, attachments } = {}) {
    const created = nowMs();
    const attachmentMeta = normalizeAttachmentMeta(attachments);
    const normalizedLevel = MEMORY_LEVELS.includes(level) ? level : 'core';
    const normalizedCategory = normalizedLevel === 'trivia'
      ? 'other'
      : (MEMORY_CORE_CATEGORIES.includes(category) ? category : 'other');
    const normalizedSource = MEMORY_SOURCES.includes(source) ? source : (attachmentMeta.length ? 'upload' : 'manual');
    const memory = {
      id: newMemoryId(),
      kind: ['profile', 'fact', 'episode'].includes(kind) ? kind : 'fact',
      level: normalizedLevel,
      category: normalizedCategory,
      source: normalizedSource,
      text: String(text).trim(),
      createdAt: created,
      validFrom: created,
      validTo: null,
      ...(sourceConversationId ? { sourceConversationId: String(sourceConversationId) } : {}),
      ...(attachmentMeta.length ? { attachments: attachmentMeta } : {}),
    };
    memories.push(memory);
    if (memories.length > STORE_LIMITS.MAX_MEMORIES) {
      const ordered = [...memories].sort((a, b) => a.createdAt - b.createdAt);
      const stale = ordered.slice(0, memories.length - STORE_LIMITS.MAX_MEMORIES);
      for (const entry of stale) {
        const index = memories.findIndex((memory) => memory.id === entry.id);
        if (index >= 0) memories.splice(index, 1);
      }
    }
    await persistMemories();
    return { ...memory };
  }

  /** 用户编辑（text/level/category），置 editedAt；由路由层先做校验。 */
  async function updateMemory(id, patch = {}) {
    const memory = memories.find((entry) => entry.id === String(id ?? ''));
    if (!memory) return null;
    if (Object.prototype.hasOwnProperty.call(patch, 'text')) memory.text = String(patch.text).trim();
    if (Object.prototype.hasOwnProperty.call(patch, 'level')) {
      memory.level = MEMORY_LEVELS.includes(patch.level) ? patch.level : memory.level;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'category')) {
      memory.category = MEMORY_CORE_CATEGORIES.includes(patch.category) ? patch.category : memory.category;
    }
    if (memory.level === 'trivia') memory.category = 'other';
    memory.editedAt = nowMs();
    await persistMemories();
    return { ...memory };
  }

  async function deleteMemory(id) {
    const index = memories.findIndex((memory) => memory.id === String(id ?? ''));
    if (index < 0) return false;
    memories.splice(index, 1);
    await persistMemories();
    return true;
  }

  /** 矛盾软失效：validTo 置当前时间（不物理删除，注入时跳过）。 */
  async function invalidateMemory(id, at = nowMs()) {
    const memory = memories.find((entry) => entry.id === String(id ?? ''));
    if (!memory) return false;
    memory.validTo = Number.isFinite(at) ? at : nowMs();
    await persistMemories();
    return true;
  }

  /** 再次说到已失效的同一事实：复活该条（validTo 清空、validFrom 重置）。 */
  async function reactivateMemory(id, at = nowMs()) {
    const memory = memories.find((entry) => entry.id === String(id ?? ''));
    if (!memory) return false;
    memory.validTo = null;
    memory.validFrom = Number.isFinite(at) ? at : nowMs();
    await persistMemories();
    return true;
  }

  async function clearMemories() {
    const cleared = memories.length;
    memories.length = 0;
    await persistMemories();
    return cleared;
  }

  function health() {
    // 只统计数据里真正保存的对话（空白会话不算）。
    return { ok: !degraded, conversations: listConversations().length, memories: memories.length };
  }

  return {
    dataDir: rootDir,
    degraded: () => degraded,
    health,
    flush,
    // 会话
    createConversation,
    listConversations,
    getConversation,
    getConversationRecord,
    updateConversationTitle,
    appendMessage,
    deleteConversation,
    // 记忆
    listMemories,
    getActiveMemories,
    memoryTextList,
    addMemory,
    updateMemory,
    deleteMemory,
    invalidateMemory,
    reactivateMemory,
    clearMemories,
    // 内部（测试/诊断用）
    limits: STORE_LIMITS,
  };
}
