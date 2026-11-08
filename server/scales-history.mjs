// 开源框架子集 / 通用化改写版：领域问卷术语替换为通用「自评问卷」表述，逻辑不变。
// 自评自评问卷历史存储与对话背景注入（服务端唯一实现）。
//
// 隐私红线：只保存**结果摘要**（自评问卷元信息/分数/档位/因子分/日期/性别），
// **绝不保存原始答案、题面（itemsText）、safetyAdvisory 或任何自由文本**；
// 不把具体分数写入日志。文件 `DATA_DIR/scales-history.json`（version 1，0600，tmp+rename 原子写；
// 损坏 JSON → warn + 备份 `.corrupt` + 空数据启动，不阻塞服务）。
// 可选 at-rest 加密（键由 app 注入；缺省 null = 明文）。加密数据解不开 → fail-fast。
//
// 生命周期：容量上限 500 条（超限丢最旧）、保留 730 天（`SCALE_HISTORY_RETENTION_DAYS`，读时过滤 + 写时清理）。
// 与 chat 的衔接：`buildSuffix()` 生成 ≤500 字符的「背景参考」段（最多 3 个不同自评问卷各取最近 1 条）。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { isAtRestError } from './at-rest.mjs';

export const SCALE_HISTORY_FILE_NAME = 'scales-history.json';
export const SCALE_HISTORY_FILE_VERSION = 1;
export const SCALE_HISTORY_MAX_ENTRIES = 500;
export const SCALE_HISTORY_RETENTION_DAYS_DEFAULT = 730;
export const SCALE_HISTORY_RETENTION_DAYS_MAX = 3_650;
export const SCALE_HISTORY_QUERY_LIMIT_DEFAULT = 30;
export const SCALE_HISTORY_QUERY_LIMIT_MAX = 100;
export const SCALE_HISTORY_INJECT_MAX_CHARS = 500;
export const SCALE_HISTORY_INJECT_MAX_SCALES = 3;
export const SCALE_HISTORY_INJECT_WINDOW_DAYS = 365;
export const SCALE_HISTORY_INJECT_LINE_MAX_CHARS = 100;
export const SCALE_HISTORY_INJECT_TITLE = '## 用户自评自评问卷历史（背景参考）';
export const SCALE_HISTORY_INJECT_FOOTER =
  '以上为对方过往自评结果，仅供参考，不构成评估；不要主动追问或据此下结论。';
export const SCALE_HISTORY_ENTRY_ID_RE = /^s[0-9a-f]{12}$/;
/** 摘要里的自评问卷形态：band=总分档位；factor=分因子；norm=常模换算（v2 私有自评问卷）。 */
export const SCALE_HISTORY_KINDS = Object.freeze(['band', 'factor', 'norm']);

const DAY_MS = 86_400_000;
const LOG_PREFIX = '[scale-history]';
const SEX_VALUES = new Set(['male', 'female']);

function warn(logger, message) {
  logger?.warn?.(`${LOG_PREFIX} ${message}`);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cleanText(value, maxChars) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** 结果/自评问卷形态 → 摘要 kind（优先采用自评问卷元信息；缺失时按 result 形态推断）。 */
export function normalizeScaleHistoryKind(kind, result) {
  if (SCALE_HISTORY_KINDS.includes(kind)) return kind;
  if (result && typeof result === 'object') {
    if (typeof result.normType === 'string') return 'norm';
    if (Array.isArray(result.factors)) return 'factor';
  }
  return 'band';
}

/** 档位只保留 key/label（不存 note 等说明文本，保持最小化）。 */
function sanitizeBand(band) {
  if (!band || typeof band !== 'object' || Array.isArray(band)) return null;
  const key = cleanText(band.key, 40);
  const label = cleanText(band.label, 40);
  if (!key && !label) return null;
  return { key, label };
}

/** 因子分摘要：band/factor 表 {id,name,score,maxScore}；norm 表 {id,name,rawScore,factorScore?,normScore,normType?,normMissing?}。 */
function sanitizeFactors(factors, kind) {
  if (!Array.isArray(factors)) return [];
  const result = [];
  for (const raw of factors.slice(0, 24)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = cleanText(raw.id, 40);
    const name = cleanText(raw.name, 60);
    if (!id && !name) continue;
    if (kind === 'norm') {
      const entry = {
        id,
        name,
        rawScore: finiteNumber(raw.rawScore),
        factorScore: finiteNumber(raw.factorScore),
        normScore: finiteNumber(raw.normScore),
      };
      if (typeof raw.normType === 'string' && raw.normType) entry.normType = cleanText(raw.normType, 12);
      if (raw.normMissing === true) entry.normMissing = true;
      result.push(entry);
    } else {
      result.push({
        id,
        name,
        score: finiteNumber(raw.score),
        maxScore: finiteNumber(raw.maxScore),
      });
    }
  }
  return result;
}

/** 规范化为落盘/对外返回的 entry（白名单字段，多余字段一律丢弃）。 */
export function normalizeScaleHistoryEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' && SCALE_HISTORY_ENTRY_ID_RE.test(raw.id) ? raw.id : null;
  const scaleId = cleanText(raw.scaleId, 64);
  if (!id || !scaleId) return null;
  const at = typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
  if (!Number.isFinite(at)) return null;
  const kind = normalizeScaleHistoryKind(raw.kind, null);
  const score = finiteNumber(raw.score);
  const maxScore = finiteNumber(raw.maxScore);
  const sex = SEX_VALUES.has(raw.sex) ? raw.sex : null;
  return {
    id,
    scaleId,
    name: cleanText(raw.name, 100) || scaleId,
    category: cleanText(raw.category, 40),
    kind,
    at: new Date(at).toISOString(),
    score,
    maxScore,
    band: sanitizeBand(raw.band),
    factors: sanitizeFactors(raw.factors, kind),
    sex,
  };
}

/** 对外返回的单条历史（契约字段 + sex 可选；绝不带答案/题面等原始数据）。 */
function publicEntry(entry) {
  const payload = {
    id: entry.id,
    at: entry.at,
    score: entry.score,
    band: entry.band,
    factors: entry.factors,
  };
  if (entry.sex) payload.sex = entry.sex;
  return payload;
}

function normalizeLimit(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return SCALE_HISTORY_QUERY_LIMIT_DEFAULT;
  return Math.min(Math.floor(parsed), SCALE_HISTORY_QUERY_LIMIT_MAX);
}

function normalizeRetentionDays(config) {
  const value = Number(config?.scaleHistoryRetentionDays);
  if (!Number.isFinite(value) || value < 1) return SCALE_HISTORY_RETENTION_DAYS_DEFAULT;
  return Math.min(Math.floor(value), SCALE_HISTORY_RETENTION_DAYS_MAX);
}

/** 原子写（tmp+rename）、目录 0700、文件 0600；失败只 warn 并返回 false。 */
async function writeJsonAtomic(filePath, data, logger, atRest = null) {
  try {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.chmod(dir, 0o700);
    } catch {
      /* 非 POSIX / 权限不足时忽略 */
    }
    const tmpPath = `${filePath}.tmp`;
    // at-rest 开启时整份 JSON 加密后再落盘。
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
    warn(logger, `写入 ${path.basename(filePath)} 失败：${error?.message ?? error}`);
    return false;
  }
}

/**
 * 同一文件的写操作串行队列（模块内实现，不改变 store.mjs 语义）。
 * writeJsonAtomic 使用固定 `${file}.tmp`，并发写会互相踩踏（rename 后 tmp 已不存在 → ENOENT），
 * 因此所有 persist（record/remove/clear/启动清理）都经此队列排队执行；
 * 队列按 filePath 隔离，跨 test/store 实例也不会互相干扰。
 */
const FILE_WRITE_QUEUES = new Map();

function enqueueFileWrite(filePath, task) {
  const previous = FILE_WRITE_QUEUES.get(filePath) ?? Promise.resolve();
  const result = previous.then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  FILE_WRITE_QUEUES.set(filePath, tail);
  tail.then(() => {
    if (FILE_WRITE_QUEUES.get(filePath) === tail) FILE_WRITE_QUEUES.delete(filePath);
  });
  return result;
}

function dedupeById(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

function sortByAtAscending(entries) {
  return entries.sort((left, right) => {
    if (left.at === right.at) return left.id.localeCompare(right.id);
    return left.at < right.at ? -1 : 1;
  });
}

/**
 * 创建自评问卷历史存储（每个 DATA_DIR 一份；启动时加载并清理过期/超量数据）。
 * @param {{dataDir: string, config: object, logger?: object, atRest?: object|null}} options
 */
export async function createScaleHistoryStore({ dataDir, config, logger = console, atRest = null } = {}) {
  const filePath = path.join(dataDir, SCALE_HISTORY_FILE_NAME);
  const enabled = config?.scaleHistory !== false;
  const inject = config?.scaleHistoryInject !== false;
  const retentionDays = normalizeRetentionDays(config);
  const state = { version: SCALE_HISTORY_FILE_VERSION, updatedAt: null, entries: [] };

  function persist() {
    state.updatedAt = Date.now();
    // 入队时对状态做快照：写盘顺序与操作顺序一致，最终文件 = 最后一次操作后的完整状态。
    const payload = {
      version: SCALE_HISTORY_FILE_VERSION,
      updatedAt: state.updatedAt,
      entries: state.entries.slice(),
    };
    return enqueueFileWrite(filePath, () => writeJsonAtomic(filePath, payload, logger, atRest));
  }

  /** 等待本文件的写队列清空（优雅关闭用；writeJsonAtomic 自身永不 reject）。 */
  async function flush() {
    for (let round = 0; round < 100; round += 1) {
      const pending = FILE_WRITE_QUEUES.get(filePath);
      if (!pending) return;
      await pending;
    }
  }

  /** 清理超过保留期的条目，返回删除数（不写盘，由调用方决定何时 persist）。 */
  function pruneExpired(now = Date.now()) {
    const cutoff = now - retentionDays * DAY_MS;
    const before = state.entries.length;
    state.entries = state.entries.filter((entry) => Date.parse(entry.at) >= cutoff);
    return before - state.entries.length;
  }

  /** 容量上限：按 at 升序丢最旧，返回删除数。 */
  function enforceCapacity() {
    let removed = 0;
    while (state.entries.length > SCALE_HISTORY_MAX_ENTRIES) {
      state.entries.shift();
      removed += 1;
    }
    return removed;
  }

  // 启动加载：损坏 → 备份 .corrupt + 空数据（不打印文件内容）；同时做保留期/容量清理。
  let needsPersist = false;
  try {
    const raw = await fs.promises.readFile(filePath);
    // at-rest 开启时先解密；密钥错误/密文损坏必须 fail-fast（不能当损坏清空）。
    const text = atRest ? atRest.unseal(filePath, raw).toString('utf8') : raw.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      try {
        await fs.promises.rename(filePath, `${filePath}.corrupt`);
      } catch {
        /* 备份失败也继续以空数据运行 */
      }
      warn(logger, `${SCALE_HISTORY_FILE_NAME} 损坏，已按空数据重建（原文件备份为 .corrupt）`);
      needsPersist = false;
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (Number.isFinite(parsed.updatedAt)) state.updatedAt = parsed.updatedAt;
      const loaded = Array.isArray(parsed.entries)
        ? dedupeById(parsed.entries.map(normalizeScaleHistoryEntry).filter(Boolean))
        : [];
      state.entries = sortByAtAscending(loaded);
      if (pruneExpired() > 0 || enforceCapacity() > 0) needsPersist = true;
    }
  } catch (error) {
    if (isAtRestError(error)) throw error;
    if (error?.code !== 'ENOENT') {
      warn(logger, `读取 ${SCALE_HISTORY_FILE_NAME} 失败，按空数据启动：${error?.message ?? error}`);
    }
  }
  if (needsPersist && enabled) await persist();

  /**
   * 记录一次计分结果摘要（只提取白名单字段，绝不落盘原始答案/题面）。
   * @param {object} result computeScaleResult 的返回值
   * @param {{sex?: string|null, scale?: object|null}} [options] scale 提供 name/category/kind/maxScore
   * @returns {Promise<{saved: boolean, entry?: object, error?: string}>}
   */
  async function record(result, { sex = null, scale = null } = {}) {
    if (!enabled) return { saved: false, error: 'disabled' };
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { saved: false, error: 'invalid-result' };
    }
    const scaleId = cleanText(result.scaleId ?? scale?.id, 64);
    if (!scaleId) return { saved: false, error: 'invalid-result' };
    const kind = normalizeScaleHistoryKind(scale?.kind, result);
    const entry = {
      id: newId(),
      scaleId,
      name: cleanText(scale?.name, 100) || scaleId,
      category: cleanText(scale?.category, 40),
      kind,
      at: new Date().toISOString(),
      score: finiteNumber(result.score),
      maxScore: finiteNumber(result.maxScore) ?? finiteNumber(scale?.maxScore),
      band: sanitizeBand(result.band),
      factors: sanitizeFactors(result.factors, kind),
      sex: SEX_VALUES.has(sex) ? sex : null,
    };
    state.entries.push(entry);
    sortByAtAscending(state.entries);
    pruneExpired();
    enforceCapacity();
    const written = await persist();
    if (!written) return { saved: false, entry, error: 'write-failed' };
    return { saved: true, entry };
  }

  function newId() {
    for (;;) {
      const id = `s${randomBytes(6).toString('hex')}`;
      if (!state.entries.some((entry) => entry.id === id)) return id;
    }
  }

  /**
   * 按自评问卷分组查询：entries 按 at 升序；每个自评问卷返回最近 limit 条；无数据返回 scales:[]。
   * @param {{scaleId?: string|null, limit?: number|string}} [options]
   */
  function query({ scaleId = null, limit = SCALE_HISTORY_QUERY_LIMIT_DEFAULT } = {}) {
    // SCALE_HISTORY=0：不保存、不注入、GET 返回空（磁盘既有文件不删除，重新开启后复用）。
    if (!enabled) return { updatedAt: null, total: 0, scales: [] };
    const normalizedLimit = normalizeLimit(limit);
    const filterId = cleanText(scaleId, 64) || null;
    const matched = filterId ? state.entries.filter((entry) => entry.scaleId === filterId) : [...state.entries];
    const groups = new Map();
    for (const entry of matched) {
      if (!groups.has(entry.scaleId)) groups.set(entry.scaleId, []);
      groups.get(entry.scaleId).push(entry);
    }
    const scales = [...groups.entries()]
      .map(([id, entries]) => {
        const latest = entries[entries.length - 1];
        const visible = entries.slice(-normalizedLimit);
        return {
          scaleId: id,
          name: latest.name,
          category: latest.category,
          kind: latest.kind,
          maxScore: latest.maxScore,
          count: entries.length,
          entries: visible.map(publicEntry),
        };
      })
      .sort((left, right) => {
        const leftAt = left.entries[left.entries.length - 1]?.at ?? '';
        const rightAt = right.entries[right.entries.length - 1]?.at ?? '';
        if (leftAt === rightAt) return left.scaleId.localeCompare(right.scaleId);
        return leftAt < rightAt ? 1 : -1; // 最近有记录的自评问卷排前面
      });
    return { updatedAt: state.updatedAt, total: matched.length, scales };
  }

  /** 删除单条历史：返回 boolean。 */
  async function remove(id) {
    if (typeof id !== 'string' || !SCALE_HISTORY_ENTRY_ID_RE.test(id)) return false;
    const index = state.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    state.entries.splice(index, 1);
    await persist();
    return true;
  }

  /** 清空全部历史：返回删除条数。 */
  async function clear() {
    const removed = state.entries.length;
    state.entries = [];
    // 删除永远落盘（即使当前关闭存储，也保证磁盘上的历史被真正清掉）。
    await persist();
    return removed;
  }

  /** 单行注入格式（≤100 字符）：`- 名称（分类）：总分 x/y，档位，因子…；日期`。 */
  function formatInjectionLine(entry) {
    const parts = [];
    if (entry.score !== null) {
      parts.push(entry.maxScore !== null ? `总分 ${entry.score}/${entry.maxScore}` : `总分 ${entry.score}`);
    }
    if (entry.band?.label) parts.push(entry.band.label);
    if (entry.factors.length > 0 && entry.kind !== 'band') {
      const factorParts = entry.factors.slice(0, 2).map((factor) => {
        const value = factor.score ?? factor.normScore ?? factor.factorScore ?? factor.rawScore;
        if (value === null || value === undefined) return factor.name;
        return `${factor.name} ${value}`;
      });
      parts.push(factorParts.join('、'));
    }
    const category = entry.category ? `（${entry.category}）` : '';
    const detail = parts.length > 0 ? `：${parts.join('，')}` : '';
    const date = entry.at.slice(0, 10);
    const line = `- ${entry.name}${category}${detail}；${date}`;
    return line.length > SCALE_HISTORY_INJECT_LINE_MAX_CHARS
      ? `${line.slice(0, SCALE_HISTORY_INJECT_LINE_MAX_CHARS - 1)}…`
      : line;
  }

  /**
   * chat 注入段：近 365 天、最多 3 个不同自评问卷各取最近 1 条，总长 ≤500 字符；
   * 无数据 / SCALE_HISTORY_INJECT=0 / SCALE_HISTORY=0 → {text:'', count:0}。
   * @returns {{text: string, count: number}}
   */
  function buildSuffix() {
    if (!enabled || !inject) return { text: '', count: 0 };
    const cutoff = Date.now() - SCALE_HISTORY_INJECT_WINDOW_DAYS * DAY_MS;
    const latestByScale = new Map();
    for (const entry of state.entries) {
      if (Date.parse(entry.at) < cutoff) continue;
      latestByScale.set(entry.scaleId, entry); // 升序遍历 → 同自评问卷最后一条即最近
    }
    if (latestByScale.size === 0) return { text: '', count: 0 };
    const lines = [...latestByScale.values()]
      .sort((left, right) => (left.at < right.at ? 1 : -1))
      .slice(0, SCALE_HISTORY_INJECT_MAX_SCALES)
      .map(formatInjectionLine);
    for (;;) {
      if (lines.length === 0) return { text: '', count: 0 };
      const text = `\n\n${SCALE_HISTORY_INJECT_TITLE}\n${lines.join('\n')}\n${SCALE_HISTORY_INJECT_FOOTER}`;
      if (text.length <= SCALE_HISTORY_INJECT_MAX_CHARS) {
        return { text, count: lines.length };
      }
      lines.pop();
    }
  }

  /** 启动日志/测试观测用元信息（不含具体分数）。 */
  function meta() {
    return {
      enabled,
      inject,
      count: state.entries.length,
      retentionDays,
      updatedAt: state.updatedAt,
      filePath,
    };
  }

  return {
    filePath,
    enabled,
    inject,
    retentionDays,
    record,
    query,
    remove,
    clear,
    buildSuffix,
    meta,
    flush,
    get entries() {
      return state.entries;
    },
  };
}
