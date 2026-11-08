// 按用户用量计量、配额检查与聚合查询（服务端唯一实现；）。
//
// 事实口径（docs/briefs/m41-interface-contract.md 3.1、DECISIONS ）：
// - 以 SSE `done.usage` 为唯一口径（message_start 不累加）；
// - token 总量 = input + output + cacheRead + cacheCreation；
// - 明细 `DATA_DIR/usage/<uid>/<YYYY-MM-DD>.jsonl`，每行 {ts,model,status,conversationId,usage}，
//   **绝不记录正文/标题/摘要/附件内容**；文件 0600、目录 0700、进程内串行追加；
// - 跨天按本地时区 Asia/Shanghai 切日；明细保留 180 天（prune 失败只 warn）；
// - 启动/首次访问懒加载近 90 天到内存；record() 永不对调用方 throw，失败只 warn；
// - 配额 = 日/月 token 总量（quota=null 表示不限，管理员由调用方传 null）；
// - 成本按注入的价格表估算（USD / 1M tokens，峰价），未知模型 priced:false。
//
// （BYOK 多厂商）增量（docs/briefs/m42-interface-contract.md 7）：
// - 每次记录可带来源 `source`（'official' 平台官方 / 'byok' 用户自带模型）与 `provider`；
//   旧 JSONL 行没有 source 时一律视为 official（不重写历史文件）；
// - 官方口径（totals/series/rows、配额、成本图表）只统计 official；BYOK 只进 `bySource.byok`
//   计数，永不进官方 costUsd / rows；byok 的 costUsd 恒为 null（用户自付上游费用）；
// - `checkQuota` 只统计非 byok 记录；调用方传 source:'byok' 时直接视为不占平台配额；
// - `bySource:{official:{requests,tokens,costUsd},byok:{requests,tokens,costUsd:null}}`
//   追加在 totals/summary（含每行）/userSummary/todayTotals 上。
//
// 隐私红线：日志不打印消息正文；conversationId 只存 id，不读正文；provider 只存厂商 id，不存 key/URL。
import fs from 'node:fs';
import path from 'node:path';

import { HttpError } from './http-utils.mjs';

export const USAGE_VERSION = '2026-11-06';
export const TOKEN_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
]);
/** 明细分日/查询聚合使用的本地时区（契约冻结：Asia/Shanghai）。 */
export const USAGE_TIME_ZONE = 'Asia/Shanghai';
/** 首次访问时加载到内存的最近天数。 */
export const USAGE_LOAD_DAYS = 90;
/** 明细保留天数（超过由 prune 删除）。 */
export const USAGE_RETENTION_DAYS = 180;
/** summary/totals 允许的最大查询跨度（含首尾，天）。 */
export const USAGE_SUMMARY_MAX_RANGE_DAYS = 90;
export const USAGE_STATUSES = Object.freeze(['ok', 'error', 'aborted']);
/** 用量来源：official=平台官方模型额度；byok=用户自带模型（不占平台配额）。 */
export const USAGE_SOURCES = Object.freeze(['official', 'byok']);
/** 缺省来源；旧 JSONL 行没有 source 字段时按此归一化。 */
export const DEFAULT_USAGE_SOURCE = 'official';
/** 未知模型在 totals.models 里的 key。 */
export const UNKNOWN_MODEL_KEY = 'unknown';

const DAY_MS = 86_400_000;
const LOG_PREFIX = '[usage]';
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_MODEL_CHARS = 100;
const MAX_CONVERSATION_ID_CHARS = 200;
const MAX_PROVIDER_CHARS = 64;

function warn(logger, message) {
  logger?.warn?.(`${LOG_PREFIX} ${message}`);
}

function info(logger, message) {
  logger?.info?.(`${LOG_PREFIX} ${message}`);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

// ---------------------------------------------------------------------------
// 纯函数：用量归一化 / 总量 / 缓存命中率 / 成本估算
// ---------------------------------------------------------------------------

/**
 * 归一化上游 usage：缺省 0，非法值（字符串/负数/NaN/Infinity）归 0，取整。
 * @param {unknown} usage
 * @returns {{inputTokens:number,outputTokens:number,cacheReadInputTokens:number,cacheCreationInputTokens:number}}
 */
export function normalizeUsage(usage) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const normalized = {};
  for (const field of TOKEN_FIELDS) {
    const value = source[field];
    normalized[field] = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  }
  return normalized;
}

/** token 总量 = input + output + cacheRead + cacheCreation。 */
export function usageTotalTokens(usage) {
  const normalized = normalizeUsage(usage);
  let total = 0;
  for (const field of TOKEN_FIELDS) total += normalized[field];
  return total;
}

/**
 * 缓存命中率 = cacheRead / (input + cacheRead)；分母 0 → null；保留 3 位小数。
 * @returns {number|null}
 */
export function cacheHitRate(usage) {
  const normalized = normalizeUsage(usage);
  const denominator = normalized.inputTokens + normalized.cacheReadInputTokens;
  if (denominator <= 0) return null;
  return roundTo(normalized.cacheReadInputTokens / denominator, 3);
}

function isPriceEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    ['inputPerM', 'cacheReadPerM', 'outputPerM'].some((field) => Number.isFinite(entry[field]))
  );
}

function normalizePriceTable(prices) {
  if (!prices || typeof prices !== 'object') return null;
  const models = prices.models;
  if (!models || typeof models !== 'object') return null;
  return {
    version: typeof prices.version === 'string' ? prices.version : null,
    currency: typeof prices.currency === 'string' ? prices.currency : 'USD',
    models,
  };
}

function priceEntryOf(table, model) {
  const name = typeof model === 'string' ? model : '';
  if (Object.prototype.hasOwnProperty.call(table.models, name) && isPriceEntry(table.models[name])) {
    return { entry: table.models[name], priced: true };
  }
  // 未知模型：优先用 default 行估算（priced:false 标识为估算价格），否则由调用方按 0 处理。
  if (isPriceEntry(table.models.default)) return { entry: table.models.default, priced: false };
  return null;
}

/**
 * 估算成本（USD）：input/1e6*inputPerM + cacheRead/1e6*cacheReadPerM + output/1e6*outputPerM。
 * cacheCreation 当前上游恒为 0 且无独立价格，不计费（ 口径）。
 * @param {{model?:string, usage?:object, prices?:object|null}} params
 * @returns {{costUsd:number, priced:boolean, priceVersion:string|null}}
 */
export function costOf({ model, usage, prices = null } = {}) {
  const table = normalizePriceTable(prices);
  if (!table) return { costUsd: 0, priced: false, priceVersion: null };
  const price = priceEntryOf(table, model);
  if (!price) return { costUsd: 0, priced: false, priceVersion: table.version };
  const normalized = normalizeUsage(usage);
  const perM = (tokens, pricePerM) => (tokens / 1_000_000) * (Number.isFinite(pricePerM) ? pricePerM : 0);
  const cost =
    perM(normalized.inputTokens, price.entry.inputPerM) +
    perM(normalized.cacheReadInputTokens, price.entry.cacheReadPerM) +
    perM(normalized.outputTokens, price.entry.outputPerM);
  return { costUsd: roundTo(cost, 6), priced: price.priced, priceVersion: table.version };
}

// ---------------------------------------------------------------------------
// 本地时区（Asia/Shanghai）日期键工具
// ---------------------------------------------------------------------------

const ZONED_PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: USAGE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(date) {
  const parts = ZONED_PARTS_FORMATTER.formatToParts(date);
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** 本地时区日期键 YYYY-MM-DD（Asia/Shanghai 切日）。 */
export function localDateKey(date = new Date()) {
  const parts = zonedParts(date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date());
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function dateKeyToUtcMs(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function isValidDateKey(dateKey) {
  if (typeof dateKey !== 'string' || !DATE_KEY_RE.test(dateKey)) return false;
  const [year, month, day] = dateKey.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function addDaysToKey(dateKey, days) {
  const shifted = new Date(dateKeyToUtcMs(dateKey) + days * DAY_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function daysBetweenKeys(fromKey, toKey) {
  return Math.round((dateKeyToUtcMs(toKey) - dateKeyToUtcMs(fromKey)) / DAY_MS);
}

function compareKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 本地时区某日 00:00 对应的 UTC 毫秒（固定/无夏令时偏移下迭代收敛）。 */
function zonedMidnightUtcMs(dateKey) {
  const utcMidnight = dateKeyToUtcMs(dateKey);
  let guess = utcMidnight;
  for (let i = 0; i < 4; i += 1) {
    const parts = zonedParts(new Date(guess));
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const offsetMs = asUtc - Math.floor(guess / 1000) * 1000;
    const next = utcMidnight - offsetMs;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function zonedMidnightIso(dateKey) {
  return new Date(zonedMidnightUtcMs(dateKey)).toISOString();
}

function nextDayResetAt(dateKey) {
  return zonedMidnightIso(addDaysToKey(dateKey, 1));
}

function nextMonthResetAt(dateKey) {
  const [year, month] = dateKey.split('-').map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return zonedMidnightIso(`${nextYear}-${pad2(nextMonth)}-01`);
}

// ---------------------------------------------------------------------------
// 内部工具：id/字段清洗、范围解析、聚合
// ---------------------------------------------------------------------------

function normalizeUserId(userId) {
  return typeof userId === 'string' && USER_ID_RE.test(userId) ? userId : null;
}

function normalizeModel(model) {
  if (typeof model !== 'string') return '';
  return model.trim().slice(0, MAX_MODEL_CHARS);
}

function normalizeStatus(status) {
  return USAGE_STATUSES.includes(status) ? status : 'ok';
}

function normalizeConversationId(conversationId) {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return null;
  return conversationId.slice(0, MAX_CONVERSATION_ID_CHARS);
}

/** 来源归一化：只认 'byok'，其余一律 official（旧记录/非法值均视为 official）。 */
function normalizeSource(source) {
  return source === 'byok' ? 'byok' : DEFAULT_USAGE_SOURCE;
}

/** provider id 归一化：非字符串/空串 → null；trim + 截断 64 字符。 */
function normalizeProvider(provider) {
  if (typeof provider !== 'string') return null;
  const trimmed = provider.trim().slice(0, MAX_PROVIDER_CHARS);
  return trimmed.length > 0 ? trimmed : null;
}

function isByokRecord(record) {
  return record.source === 'byok';
}

function createEmptyBySource() {
  return {
    official: { requests: 0, tokens: 0, costUsd: 0 },
    byok: { requests: 0, tokens: 0, costUsd: null },
  };
}

function createEmptyTotals() {
  return {
    requests: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    cacheHitRate: null,
    //  2 / 真正联网的请求次数（行内 webSearch:true 才计；旧行不计）。
    webSearchRequests: 0,
    models: {},
    bySource: createEmptyBySource(),
  };
}

/** 去掉 bySource 的 totals 副本（series 逐日项保持 原字段，官方口径）。 */
function withoutBySource(totals) {
  const { bySource, ...rest } = totals;
  return rest;
}

/**
 * 聚合记录：顶层字段与 models 只统计 official（官方口径向后兼容）；
 * bySource 同时给出 official 与 byok 的 requests/tokens，byok 的 costUsd 恒为 null。
 */
function aggregateRecords(records, prices) {
  const totals = createEmptyTotals();
  const bySource = totals.bySource;
  for (const record of records) {
    const usage = record.usage;
    const recordTokens =
      usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    // 联网次数按「行内 webSearch:true」计（与官方/BYOK 来源无关，真实联网才会标）。
    if (record.webSearch === true) totals.webSearchRequests += 1;
    const sourceKey = isByokRecord(record) ? 'byok' : 'official';
    bySource[sourceKey].requests += 1;
    bySource[sourceKey].tokens += recordTokens;
    if (sourceKey === 'byok') continue; // BYOK 不进官方字段/成本/模型分组
    totals.requests += 1;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadInputTokens += usage.cacheReadInputTokens;
    totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    totals.tokens += recordTokens;
    const cost = costOf({ model: record.model, usage, prices });
    totals.costUsd += cost.costUsd;
    bySource.official.costUsd += cost.costUsd;
    const modelKey = record.model || UNKNOWN_MODEL_KEY;
    totals.models[modelKey] = (totals.models[modelKey] ?? 0) + cost.costUsd;
  }
  totals.costUsd = roundTo(totals.costUsd, 4);
  bySource.official.costUsd = roundTo(bySource.official.costUsd, 4);
  totals.cacheHitRate = cacheHitRate({
    inputTokens: totals.inputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens,
  });
  for (const modelKey of Object.keys(totals.models)) totals.models[modelKey] = roundTo(totals.models[modelKey], 4);
  return totals;
}

function parseDateParam(value, fallbackKey) {
  if (value === null || value === undefined || value === '') return fallbackKey;
  const candidate = value instanceof Date ? localDateKey(value) : String(value).trim().slice(0, 10);
  if (!isValidDateKey(candidate)) {
    throw new HttpError(400, 'INVALID_INPUT', 'from/to 必须是 YYYY-MM-DD 格式的合法日期');
  }
  return candidate;
}

/** 解析查询范围：缺省近 30 天；跨度（含首尾）> 90 天 → 400 RANGE_TOO_LARGE。 */
function resolveRange({ from = null, to = null, todayKey = null } = {}) {
  const today = todayKey ?? localDateKey(new Date());
  const toKey = parseDateParam(to, today);
  const fromKey = parseDateParam(from, addDaysToKey(toKey, -29));
  if (compareKeys(fromKey, toKey) > 0) {
    throw new HttpError(400, 'INVALID_INPUT', 'from 不能晚于 to');
  }
  const spanDays = daysBetweenKeys(fromKey, toKey) + 1;
  if (spanDays > USAGE_SUMMARY_MAX_RANGE_DAYS) {
    throw new HttpError(
      400,
      'RANGE_TOO_LARGE',
      `查询跨度不能超过 ${USAGE_SUMMARY_MAX_RANGE_DAYS} 天（当前 ${spanDays} 天）`,
    );
  }
  return { from: fromKey, to: toKey, spanDays };
}

// ---------------------------------------------------------------------------
// 串行追加（进程内 promise 队列，按文件隔离）
// ---------------------------------------------------------------------------

const APPEND_QUEUES = new Map();

function enqueueFileAppend(filePath, line) {
  const previous = APPEND_QUEUES.get(filePath) ?? Promise.resolve();
  const result = previous.then(async () => {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.chmod(dir, 0o700);
    } catch {
      /* 非 POSIX / 权限不足时忽略 */
    }
    await fs.promises.appendFile(filePath, line, { mode: 0o600 });
    try {
      await fs.promises.chmod(filePath, 0o600);
    } catch {
      /* 同上 */
    }
  });
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  APPEND_QUEUES.set(filePath, tail);
  tail.then(() => {
    if (APPEND_QUEUES.get(filePath) === tail) APPEND_QUEUES.delete(filePath);
  });
  return result;
}

// ---------------------------------------------------------------------------
// 服务工厂
// ---------------------------------------------------------------------------

/**
 * 创建用量服务（每个 DATA_DIR 一份；AUTH=on 时挂到 ctx.usage）。
 * @param {{dataDir:string, config?:object, logger?:object, now?:() => Date}} options
 */
export function createUsageService({ dataDir, config = {}, logger = console, now = () => new Date() } = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new Error('createUsageService: 必须提供 dataDir');
  }
  const usageRoot = path.join(dataDir, 'usage');
  const prices = config?.priceTable ?? null;
  // 保留期可由 config.usageRetentionDays 覆盖（11.6 冻结字段；缺省 180 天，钳到 1..3650）。
  const retentionDays = normalizeRetentionDays(config?.usageRetentionDays);
  /** @type {Map<string, Map<string, Array<object>>>} uid → 日期键 → 记录 */
  const byUser = new Map();
  let loadPromise = null;

  function nowDate() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  function todayKey() {
    return localDateKey(nowDate());
  }

  async function readUsageFile(filePath, dateKey) {
    let text;
    try {
      text = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      warn(logger, `读取明细失败（已跳过）file=${path.basename(filePath)} err=${error?.code ?? error?.message ?? error}`);
      return [];
    }
    const records = [];
    let corrupt = 0;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        corrupt += 1;
        continue;
      }
      if (!parsed || typeof parsed !== 'object') {
        corrupt += 1;
        continue;
      }
      records.push({
        dateKey,
        ts: typeof parsed.ts === 'string' ? parsed.ts : null,
        model: normalizeModel(parsed.model),
        status: normalizeStatus(parsed.status),
        conversationId: normalizeConversationId(parsed.conversationId),
        usage: normalizeUsage(parsed.usage),
        // 旧行没有 source/provider → 归一为 official/null（只在内存归一，不重写历史文件）。
        source: normalizeSource(parsed.source),
        provider: normalizeProvider(parsed.provider),
        // 旧行没有 webSearch → false（保持旧行兼容，不重写历史文件）。
        webSearch: parsed.webSearch === true,
      });
    }
    if (corrupt > 0) {
      warn(logger, `明细存在 ${corrupt} 行损坏记录（已跳过）file=${path.basename(filePath)}`);
    }
    return records;
  }

  /** 删除超过保留期的明细文件；失败只 warn（不阻塞服务）。 */
  async function pruneExpiredFiles() {
    const cutoffKey = addDaysToKey(todayKey(), -(retentionDays - 1));
    let entries;
    try {
      entries = await fs.promises.readdir(usageRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn(logger, `prune 扫描失败（已忽略）err=${error?.code ?? error?.message ?? error}`);
      }
      return;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !USER_ID_RE.test(entry.name)) continue;
      const userDir = path.join(usageRoot, entry.name);
      let files;
      try {
        files = await fs.promises.readdir(userDir);
      } catch {
        continue;
      }
      for (const file of files) {
        const match = FILE_NAME_RE.exec(file);
        if (!match || compareKeys(match[1], cutoffKey) >= 0) continue;
        try {
          await fs.promises.unlink(path.join(userDir, file));
          removed += 1;
        } catch (error) {
          warn(logger, `prune 删除失败（已忽略）file=${file} err=${error?.code ?? error?.message ?? error}`);
        }
      }
    }
    if (removed > 0) info(logger, `prune 清理 ${removed} 个超过 ${retentionDays} 天的明细文件`);
  }

  async function loadAll() {
    try {
      await pruneExpiredFiles();
    } catch (error) {
      warn(logger, `prune 失败（已忽略）err=${error?.message ?? error}`);
    }
    let userDirs;
    try {
      userDirs = await fs.promises.readdir(usageRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn(logger, `加载明细失败（以空数据继续）err=${error?.code ?? error?.message ?? error}`);
      }
      return;
    }
    const today = todayKey();
    const cutoffKey = addDaysToKey(today, -(USAGE_LOAD_DAYS - 1));
    for (const entry of userDirs) {
      if (!entry.isDirectory() || !USER_ID_RE.test(entry.name)) continue;
      const userDir = path.join(usageRoot, entry.name);
      let files;
      try {
        files = await fs.promises.readdir(userDir);
      } catch {
        continue;
      }
      const days = new Map();
      for (const file of files) {
        const match = FILE_NAME_RE.exec(file);
        if (!match) continue;
        const dateKey = match[1];
        if (compareKeys(dateKey, cutoffKey) < 0 || compareKeys(dateKey, today) > 0) continue;
        const records = await readUsageFile(path.join(userDir, file), dateKey);
        if (records.length > 0) days.set(dateKey, records);
      }
      if (days.size > 0) byUser.set(entry.name, days);
    }
  }

  function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = loadAll().catch((error) => {
        warn(logger, `加载明细异常（以空数据继续）err=${error?.message ?? error}`);
      });
    }
    return loadPromise;
  }

  function userDays(userId) {
    return byUser.get(userId) ?? null;
  }

  function appendRecord(uid, dateKey, record) {
    let days = byUser.get(uid);
    if (!days) {
      days = new Map();
      byUser.set(uid, days);
    }
    const dayRecords = days.get(dateKey);
    if (dayRecords) {
      dayRecords.push(record);
    } else {
      days.set(dateKey, [record]);
    }
  }

  /**
   * 记录一次请求用量；**永不 throw**（写盘/校验失败只 warn）。
   * @param {{userId:string, model:string, usage:object, status?:'ok'|'error'|'aborted',
   *   conversationId?:string|null, source?:'official'|'byok', provider?:string|null,
   *   webSearch?:boolean}} params
   * @returns {Promise<void>}
   */
  async function record({
    userId,
    model,
    usage,
    status = 'ok',
    conversationId = null,
    source = DEFAULT_USAGE_SOURCE,
    provider = null,
    webSearch = false,
  } = {}) {
    try {
      const uid = normalizeUserId(userId);
      if (!uid) {
        warn(logger, '跳过用量记录：userId 非法');
        return;
      }
      await ensureLoaded();
      const at = nowDate();
      const dateKey = localDateKey(at);
      const entry = {
        ts: at.toISOString(),
        model: normalizeModel(model),
        status: normalizeStatus(status),
        conversationId: normalizeConversationId(conversationId),
        usage: normalizeUsage(usage),
        // 来源与厂商 id（无正文/无 key/无 URL）。
        source: normalizeSource(source),
        provider: normalizeProvider(provider),
      };
      // 只有真正联网的轮次才落 webSearch:true（false 不写字段，保持旧行兼容）。
      if (webSearch === true) entry.webSearch = true;
      // 先更新内存（写盘失败也计入配额/聚合口径），再入队串行追加。
      appendRecord(uid, dateKey, entry);
      const filePath = path.join(usageRoot, uid, `${dateKey}.jsonl`);
      await enqueueFileAppend(filePath, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      warn(logger, `记录用量失败（已忽略）err=${error?.code ?? error?.message ?? error}`);
    }
  }

  /**
   * 配额检查：日/月 token 总量（total = in+out+cacheRead+cacheCreation），只统计 official 记录。
   * quota=null → 不限（管理员由调用方传 null）；本请求 source='byok' → 不占平台配额，直接允许。
   * @param {{userId:string, quota?:{dayTokens?:number|null,monthTokens?:number|null}|null,
   *   source?:'official'|'byok'}} params
   */
  async function checkQuota({ userId, quota = null, source = DEFAULT_USAGE_SOURCE } = {}) {
    // BYOK 请求不占平台配额（；chat 侧 gate 也会传 quotaExempt，双保险）。
    if (source === 'byok') return { allowed: true };
    if (!quota || typeof quota !== 'object') return { allowed: true };
    const dayLimit = finiteLimit(quota.dayTokens);
    const monthLimit = finiteLimit(quota.monthTokens);
    if (dayLimit === null && monthLimit === null) return { allowed: true };
    await ensureLoaded();
    const uid = normalizeUserId(userId);
    const today = todayKey();
    const days = uid ? userDays(uid) : null;
    if (dayLimit !== null) {
      const usedTokens = days ? totalOfficialTokensOf(days.get(today) ?? []) : 0;
      if (usedTokens >= dayLimit) {
        return {
          allowed: false,
          code: 'QUOTA_EXCEEDED',
          window: 'day',
          limitTokens: dayLimit,
          usedTokens,
          resetAt: nextDayResetAt(today),
        };
      }
    }
    if (monthLimit !== null) {
      const monthPrefix = today.slice(0, 7);
      let usedTokens = 0;
      for (const [dateKey, dayRecords] of days ?? []) {
        if (dateKey.slice(0, 7) !== monthPrefix) continue;
        usedTokens += totalOfficialTokensOf(dayRecords);
      }
      if (usedTokens >= monthLimit) {
        return {
          allowed: false,
          code: 'QUOTA_EXCEEDED',
          window: 'month',
          limitTokens: monthLimit,
          usedTokens,
          resetAt: nextMonthResetAt(today),
        };
      }
    }
    return { allowed: true };
  }

  /**
   * 联网配额检查（ 2 / ）：统计该用户今天真正联网（webSearch:true）的请求数。
   * limit 为空/0/负数 → 不限（allowed=true, limit=null）；跨零点时 resetAt 为次日 00:00（本地时区 ISO）。
   * @param {{userId?:string, limit?:number|null, now?:Date}} params
   * @returns {Promise<{allowed:boolean, used:number, limit:number|null, resetAt:string}>}
   */
  async function checkWebSearchQuota({ userId = null, limit = null, now: at = null } = {}) {
    await ensureLoaded();
    const uid = normalizeUserId(userId);
    const date = at instanceof Date ? at : at ? new Date(at) : nowDate();
    const dateKey = localDateKey(Number.isNaN(date.getTime()) ? nowDate() : date);
    const dayRecords = uid ? userDays(uid)?.get(dateKey) ?? [] : [];
    let used = 0;
    for (const record of dayRecords) {
      if (record.webSearch === true) used += 1;
    }
    const normalizedLimit = finiteLimit(limit);
    const unlimited = normalizedLimit === null || normalizedLimit === 0;
    const resetAt = nextDayResetAt(dateKey);
    if (unlimited) return { allowed: true, used, limit: null, resetAt };
    return { allowed: used < normalizedLimit, used, limit: normalizedLimit, resetAt };
  }

  /**
   * 等待明细追加队列清空（优雅关闭用）。
   * 只等待本 usageRoot 下的文件队列，避免跨 DATA_DIR 实例互相影响。
   */
  async function flush() {
    const prefix = `${usageRoot}${path.sep}`;
    for (let round = 0; round < 100; round += 1) {
      const pending = [...APPEND_QUEUES.entries()]
        .filter(([filePath]) => filePath.startsWith(prefix))
        .map(([, promise]) => promise);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /**
   * 当前用户近 N 天用量（series 按日补零，含 today；days 限制 1..90）。
   * @param {string} userId
   * @param {{days?:number}} [options]
   */
  async function userSummary(userId, { days = 30 } = {}) {
    await ensureLoaded();
    const uid = normalizeUserId(userId);
    const dayCount = normalizeDays(days);
    const today = todayKey();
    const fromKey = addDaysToKey(today, -(dayCount - 1));
    const days2 = uid ? userDays(uid) : null;
    const series = [];
    const allRecords = [];
    for (let offset = 0; offset < dayCount; offset += 1) {
      const dateKey = addDaysToKey(fromKey, offset);
      const dayRecords = days2?.get(dateKey) ?? [];
      // series 保持 原字段（官方口径，逐日补零）；bySource 在 totals/userSummary 顶层给出。
      series.push({ date: dateKey, ...withoutBySource(aggregateRecords(dayRecords, prices)) });
      allRecords.push(...dayRecords);
    }
    const totals = aggregateRecords(allRecords, prices);
    return { totals, series, bySource: totals.bySource };
  }

  /**
   * 管理员聚合：groupBy=user|model|day（rows 仅含出现过的桶，按 key 升序）。
   * @param {{from?:string|null, to?:string|null, groupBy?:'user'|'model'|'day'}} [options]
   */
  async function summary({ from = null, to = null, groupBy = 'day' } = {}) {
    if (!['user', 'model', 'day'].includes(groupBy)) {
      throw new HttpError(400, 'INVALID_INPUT', 'groupBy 必须是 user|model|day');
    }
    await ensureLoaded();
    const range = resolveRange({ from, to, todayKey: todayKey() });
    const groups = new Map();
    const allRecords = [];
    for (const [uid, days] of byUser) {
      for (const [dateKey, dayRecords] of days) {
        if (compareKeys(dateKey, range.from) < 0 || compareKeys(dateKey, range.to) > 0) continue;
        allRecords.push(...dayRecords);
        for (const record of dayRecords) {
          const key = groupBy === 'day' ? dateKey : groupBy === 'user' ? uid : record.model || UNKNOWN_MODEL_KEY;
          let bucket = groups.get(key);
          if (!bucket) {
            bucket = { records: [], hasOfficial: false };
            groups.set(key, bucket);
          }
          bucket.records.push(record);
          if (!isByokRecord(record)) bucket.hasOfficial = true;
        }
      }
    }
    // 官方图表只读 official：byok-only 的桶不进 rows（但记入 bySource 与 totals）。
    const rows = [...groups.entries()]
      .filter(([, bucket]) => bucket.hasOfficial)
      .map(([key, bucket]) => ({ key, ...aggregateRecords(bucket.records, prices) }))
      .sort((left, right) => compareKeys(left.key, right.key));
    const totals = aggregateRecords(allRecords, prices);
    return {
      groupBy,
      from: range.from,
      to: range.to,
      rows,
      totals,
      bySource: totals.bySource,
    };
  }

  /**
   * 全局区间总量（缺省近 30 天；跨度规则同 summary）。
   * @param {{from?:string|null, to?:string|null}} [options]
   */
  async function totals({ from = null, to = null } = {}) {
    await ensureLoaded();
    const range = resolveRange({ from, to, todayKey: todayKey() });
    const allRecords = [];
    for (const [, days] of byUser) {
      for (const [dateKey, dayRecords] of days) {
        if (compareKeys(dateKey, range.from) < 0 || compareKeys(dateKey, range.to) > 0) continue;
        allRecords.push(...dayRecords);
      }
    }
    return aggregateRecords(allRecords, prices);
  }

  /** 某用户今天（本地时区）的用量总量。 */
  async function todayTotals(userId) {
    await ensureLoaded();
    const uid = normalizeUserId(userId);
    const days = uid ? userDays(uid) : null;
    return aggregateRecords(days?.get(todayKey()) ?? [], prices);
  }

  return {
    record,
    checkQuota,
    checkWebSearchQuota,
    userSummary,
    summary,
    totals,
    todayTotals,
    flush,
  };
}

function finiteLimit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** config.usageRetentionDays 归一化：合法正整数取整，非法回落 180，上限 3650。 */
function normalizeRetentionDays(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return USAGE_RETENTION_DAYS;
  return Math.min(Math.floor(value), 3650);
}

function totalOfficialTokensOf(records) {
  let total = 0;
  for (const record of records) {
    if (isByokRecord(record)) continue; // BYOK 不占平台配额
    total += usageTotalTokens(record.usage);
  }
  return total;
}

function normalizeDays(days) {
  const value = Number(days);
  if (!Number.isFinite(value) || value < 1) return 30;
  return Math.min(Math.floor(value), USAGE_LOAD_DAYS);
}
