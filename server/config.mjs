// 服务配置：环境变量 → 配置对象。
// API key 只读加载（env 优先，缺省读 ~/.config/chat-terminal/credentials.yaml），绝不打印/写盘/提交。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { AUTH_MODES } from './auth.mjs';
import { WEBSEARCH_MOCK_MODES } from './websearch.mjs';

export const EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);

/**
 * 单轮输出上限：不再按 effort 分档设人工上限，统一请求模型允许的最大输出
 * 1,000,000（API 实测接受；实际长度由模型上下文窗口与模型自身 stop_reason 决定，思考+正文共用）。
 * 显式 MAX_TOKENS 仍可下调/覆盖，用于个别场景限制单轮成本。
 */
export const EFFORT_MAX_TOKENS = Object.freeze({
  off: 1_000_000,
  low: 1_000_000,
  high: 1_000_000,
  max: 1_000_000,
});

/**
 * 解析本次请求生效的 max_tokens：显式 MAX_TOKENS 覆盖一切档位；否则统一取模型上限。
 * @param {{maxTokens?: number|null}} config
 * @param {string} effort
 * @returns {number}
 */
export function resolveMaxTokens(config, effort) {
  const explicit = config?.maxTokens;
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return EFFORT_MAX_TOKENS[effort] ?? EFFORT_MAX_TOKENS.high;
}

export const RERANK_MODES = Object.freeze(['off', 'llm']);
export const QUERY_EXPAND_MODES = Object.freeze(['off', 'heuristic', 'llm']);

export const DEFAULTS = Object.freeze({
  PORT: 8787,
  HOST: '0.0.0.0',
  MODEL: 'deepseek-v4-pro',
  // null = auto：统一取模型输出上限（见 EFFORT_MAX_TOKENS）；显式 MAX_TOKENS 覆盖所有档位。
  MAX_TOKENS: null,
  BASE_URL: 'https://api.deepseek.com/anthropic',
  EFFORT: 'high',
  // 去输出上限后单轮可能更长，默认等待放宽到 10 分钟（env 可调到 60 分钟）。
  UPSTREAM_TIMEOUT_MS: 600_000,
  MOCK_DELAY_MS: 8,
  // 客户端断开（离页/切后台）后是否在后台继续生成；off 时行为与 完全一致。
  BACKGROUND_GENERATION: true,
  // v2：会话/记忆持久化
  DATA_DIR: './data',
  // DATA_DIR 静态数据加密（at-rest，见 at-rest.mjs）。
  // 二选一（FILE 优先）：DATA_ENCRYPTION_KEY（base64 32B）或 DATA_ENCRYPTION_KEY_FILE（600，建议放 DATA_DIR 之外）。
  // 都为空 = 不加密（明文 + 启动 WARN），既有行为不变。
  DATA_ENCRYPTION_KEY: '',
  DATA_ENCRYPTION_KEY_FILE: '',
  MEMORY: true,
  MEMORY_MAX: 20,
  MEMORY_EXTRACT_MODEL: '', // 空 = 同 MODEL
  MEMORY_EXTRACT_TIMEOUT_MS: 15_000,
  RERANK: 'off',
  QUERY_EXPAND: 'heuristic',
  // 附件解析走 deepseek-flash（多模态），正文仍由 MODEL（deepseek-v4-pro）生成。
  VISION_MODEL: 'deepseek-flash',
  VISION_TIMEOUT_MS: 30_000,
  VISION_MAX_TOKENS: 800,
  // 记录导入（iOS 快捷指令 → POST /api/health-import）与对话背景注入。
  HEALTH_IMPORT: true,
  HEALTH_INJECT: true,
  HEALTH_RETENTION_DAYS: 180,
  // 导入 token 只从环境读取；未配置时导入接口 503，绝不回显/日志。
  HEALTH_IMPORT_TOKEN: '',
  // 图片附件服务器持久化（DATA_DIR/attachments，内容寻址，见 attachments.mjs）。
  // 关闭后仅保留解析摘要，不写二进制文件（行为）；最大占用超限时同样只保留摘要。
  ATTACHMENT_STORAGE: true,
  ATTACHMENT_MAX_MB: 512,
  // 问卷历史（只存结果摘要，不存原始答案）与对话背景注入。
  // SCALE_HISTORY=0 关闭存储与注入；SCALE_HISTORY_INJECT=0 仅关闭注入；保留期默认 730 天。
  SCALE_HISTORY: true,
  SCALE_HISTORY_INJECT: true,
  SCALE_HISTORY_RETENTION_DAYS: 730,
  // 联网搜索（默认关闭；DeepSeek Search & Fetch 薄适配器，见 websearch.mjs）。
  // WEBSEARCH=0（默认）时请求体的 webSearch:"on" 也被忽略（off 即回滚）；开启后仍按请求显式开关工作。
  // 查询只发送脱敏 + ≤128 字的检索词；日志只记 hash/长度/条数/耗时；结果只进内存缓存，不落盘。
  WEBSEARCH: false,
  WEBSEARCH_PROVIDER: 'deepseek',
  WEBSEARCH_BASE_URL: 'https://api.deepseek.com',
  WEBSEARCH_TIMEOUT_MS: 4_000,
  WEBSEARCH_COUNT: 5,
  WEBSEARCH_MAX_CITATIONS: 2,
  WEBSEARCH_MIN_AUTHORITY: 2,
  WEBSEARCH_MAX_AGE_DAYS: 730,
  WEBSEARCH_CACHE_TTL_MS: 3_600_000,
  WEBSEARCH_CACHE_MAX: 200,
  // 联网搜索不限次数（原 WEBSEARCH_RATE_PER_MIN/DAY 已删除），费用由调用量自然产生，仅统计不阻断。
  // 仅 CHAT_MOCK=1 且 WEBSEARCH=1 时生效：ok=确定性 3 条；fail=模拟搜索失败降级；empty=模拟空结果。
  WEBSEARCH_MOCK_MODE: 'ok',
  // ..多用户与认证（默认 off = 单用户零回归）。
  AUTH: 'off',
  // Cookie 是否带 Secure（生产 HTTPS 必须 on；本地 http 联调可用 AUTH_COOKIE_SECURE=0 关）。
  AUTH_COOKIE_SECURE: true,
  AUTH_SESSION_TTL_DAYS: 7,
  ADMIN_USERNAME: 'admin',
  // 初始管理员密码文件（600；内容为明文密码，启动读取后不打印、不落盘）。
  ADMIN_INITIAL_PASSWORD_FILE: '',
  INVITE_ONLY: true,
  // 配额/限流/计费（ 消费；管理员豁免）。
  QUOTA_DAY_TOKENS: 200_000,
  QUOTA_MONTH_TOKENS: 2_000_000,
  RATE_PER_MINUTE: 20,
  RATE_CONCURRENCY: 2,
  USAGE_RETENTION_DAYS: 180,
  // 价格表（reviews/m40-metering-byok-research.md 1.1，peak 价 USD / 1M tokens）。
  PRICE_VERSION: '2026-11-06',
  PRICE_TABLE_JSON: '',
  ALLOWED_MODELS: 'deepseek-v4-pro,deepseek-v4-flash',
  FEEDBACK_MAX_CHARS: 2000,
  WEBSEARCH_PER_USER_PER_DAY: 100,
  // ..BYOK 多厂商自定义模型（默认 on；生产可在 admin 设置或 BYOK=0 关闭）。
  BYOK: true,
  // 仅测试/测试允许 http + 回环/私网 baseUrl（生产必须 off）。
  BYOK_ALLOW_LOOPBACK: false,
  BYOK_CHECK_PER_MINUTE: 3,
  BYOK_TIMEOUT_MS: 120_000,
  BYOK_MAX_KEY_CHARS: 512,
  BYOK_MAX_MODEL_CHARS: 128,
  BYOK_MAX_BASEURL_CHARS: 512,
  // at-rest 信封加密（KEK→DEK）。空/0/false/off = 关闭（保持  单密钥语义）。
  AT_REST_ENVELOPE: '',
  // BYOK 记忆抽取（用户模型非流式）的 max_tokens。
  MEMORY_EXTRACT_MAX_TOKENS: 1024,
  // ..合规、运营、可观测、BYOK 加固与备份。
  CONSENT_VERSION: '2026-11-01',
  FEEDBACK_WEBHOOK_URL: '',
  ATTACHMENT_RETENTION_DAYS: 0,
  BACKUP_DIR: '',
  BYOK_CHECK_ENABLED: true,
  BYOK_ALLOWED_MODELS: '',
  BYOK_ALLOWED_HOSTS: '',
  PEAK_MODEL_POLICY: 'off',
  PEAK_MODEL: 'deepseek-v4-flash',
  PEAK_HOURS_UTC: '01:00-04:00,06:00-10:00',
});

/** 默认价格表：USD / 1M tokens；cacheReadPerM = 缓存命中输入价。 */
export const DEFAULT_PRICE_TABLE = Object.freeze({
  version: DEFAULTS.PRICE_VERSION,
  currency: 'USD',
  models: Object.freeze({
    'deepseek-v4-pro': Object.freeze({ inputPerM: 1.32, cacheReadPerM: 0.044, outputPerM: 3.96 }),
    'deepseek-flash': Object.freeze({ inputPerM: 0.3, cacheReadPerM: 0.006, outputPerM: 1.2 }),
    default: Object.freeze({ inputPerM: 1.32, cacheReadPerM: 0.044, outputPerM: 3.96 }),
  }),
});

function clonePriceTable(table) {
  const models = {};
  for (const [name, price] of Object.entries(table.models)) models[name] = { ...price };
  return { version: table.version, currency: table.currency, models };
}

function parseAllowedModels(value, fallback, { logger } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  const list = text
    ? text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  if (list.length === 0) {
    const fallbackList = fallback
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return fallbackList;
  }
  return [...new Set(list)];
}

function isPriceEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    Number.isFinite(entry.inputPerM) &&
    entry.inputPerM >= 0 &&
    Number.isFinite(entry.cacheReadPerM) &&
    entry.cacheReadPerM >= 0 &&
    Number.isFinite(entry.outputPerM) &&
    entry.outputPerM >= 0
  );
}

/** 解析 PRICE_TABLE_JSON（完整覆盖默认表；非法时 warn 并回退默认）。 */
function parsePriceTable(rawJson, priceVersion, { logger } = {}) {
  const text = typeof rawJson === 'string' ? rawJson.trim() : '';
  const fallback = clonePriceTable({ ...DEFAULT_PRICE_TABLE, version: priceVersion || DEFAULT_PRICE_TABLE.version });
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.models || typeof parsed.models !== 'object') {
      throw new Error('缺少 models');
    }
    const models = {};
    for (const [name, entry] of Object.entries(parsed.models)) {
      if (!isPriceEntry(entry)) throw new Error(`模型 ${name} 的价格字段非法`);
      models[name] = {
        inputPerM: entry.inputPerM,
        cacheReadPerM: entry.cacheReadPerM,
        outputPerM: entry.outputPerM,
      };
    }
    if (Object.keys(models).length === 0) throw new Error('models 为空');
    if (!models.default) {
      const first = Object.values(models)[0];
      models.default = { ...first };
    }
    return {
      version: stringFromEnv(parsed.version, priceVersion || DEFAULT_PRICE_TABLE.version),
      currency: stringFromEnv(parsed.currency, 'USD'),
      models,
    };
  } catch (error) {
    try {
      logger?.warn?.(`[config] PRICE_TABLE_JSON 非法（${error?.message ?? error}），回退默认价格表`);
    } catch {
      /* logger 自身失败不影响配置解析 */
    }
    return fallback;
  }
}

export function defaultCredentialPath() {
  return path.join(homedir(), '.config', 'chat-terminal', 'credentials.yaml');
}

/** 只读解析凭据文件中的 DEEPSEEK_API_KEY；读不到返回 null。 */
export function readApiKeyFromCredentials(credentialPath) {
  try {
    if (!credentialPath || !existsSync(credentialPath)) return null;
    const text = readFileSync(credentialPath, 'utf8');
    const match = text.match(/DEEPSEEK_API_KEY\s*:\s*(?:(["'])(.*?)\1|([^\s"'#]+))/);
    if (!match) return null;
    const value = (match[2] ?? match[3] ?? '').trim();
    return value || null;
  } catch {
    return null;
  }
}

/** 优先 process.env.DEEPSEEK_API_KEY；为空时回退读凭据文件。 */
export function resolveApiKey(env = process.env, { credentialPath = defaultCredentialPath() } = {}) {
  const fromEnv = typeof env.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : '';
  if (fromEnv) return { apiKey: fromEnv, source: 'env' };
  const fromFile = readApiKeyFromCredentials(credentialPath);
  if (fromFile) return { apiKey: fromFile, source: 'credentials' };
  return { apiKey: '', source: 'none' };
}

function intFromEnv(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function stringFromEnv(value, fallback) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || fallback;
}

/** 逗号分隔列表：去空、去重；未设置或空串返回 fallback（默认空数组）。 */
function listFromEnv(value, fallback = []) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return [...new Set(text.split(',').map((item) => item.trim()).filter(Boolean))];
}

/** 布尔开关：未设置时用 fallback；'0'/'false'/'off'/'no' 关闭，其余非空值视为开启。 */
function flagFromEnv(value, fallback = true) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(text)) return false;
  if (['1', 'true', 'on', 'yes'].includes(text)) return true;
  return fallback;
}

/** 枚举配置：非法值回退默认，避免拼错导致运行时行为不可预期。 */
function choiceFromEnv(value, allowed, fallback) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.includes(text) ? text : fallback;
}

/** 正整数配置：非法/越界时 warn 并回退默认（附件容量等需要可观测地发现配置错误）。 */
function positiveIntFromEnv(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}, { logger, name } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== text || parsed < min || parsed > max) {
    try {
      logger?.warn?.(`[config] ${name}=${JSON.stringify(text)} 非法（需 ${min}–${max} 的整数），回退默认 ${fallback}`);
    } catch {
      /* logger 自身失败不影响配置解析 */
    }
    return fallback;
  }
  return parsed;
}

export function isTruthyFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

/**
 * 从环境变量解析完整配置。
 * @param {NodeJS.ProcessEnv|Record<string,string>} env
 * @param {{credentialPath?: string, logger?: object}} [opts]
 */
export function loadConfig(env = process.env, { credentialPath, logger = console } = {}) {
  const { apiKey, source } = resolveApiKey(env, { credentialPath });
  // WEBSEARCH_MOCK_MODE 非法值时 warn 并回退 ok（只在 CHAT_MOCK=1 的测试场景生效）。
  const websearchMockModeText =
    typeof env.WEBSEARCH_MOCK_MODE === 'string' ? env.WEBSEARCH_MOCK_MODE.trim().toLowerCase() : '';
  let websearchMockMode = DEFAULTS.WEBSEARCH_MOCK_MODE;
  if (websearchMockModeText) {
    if (WEBSEARCH_MOCK_MODES.includes(websearchMockModeText)) {
      websearchMockMode = websearchMockModeText;
    } else {
      try {
        logger?.warn?.(
          `[config] WEBSEARCH_MOCK_MODE=${JSON.stringify(websearchMockModeText)} 非法（需 ${WEBSEARCH_MOCK_MODES.join('|')}），回退默认 ${DEFAULTS.WEBSEARCH_MOCK_MODE}`,
        );
      } catch {
        /* logger 自身失败不影响配置解析 */
      }
    }
  }
  return {
    port: intFromEnv(env.PORT, DEFAULTS.PORT, { min: 0, max: 65535 }),
    host: stringFromEnv(env.HOST, DEFAULTS.HOST),
    model: stringFromEnv(env.MODEL, DEFAULTS.MODEL),
    maxTokens: intFromEnv(env.MAX_TOKENS, DEFAULTS.MAX_TOKENS, { min: 1, max: 1_000_000 }),
    baseUrl: stringFromEnv(env.DEEPSEEK_BASE_URL, DEFAULTS.BASE_URL).replace(/\/+$/, ''),
    apiKey,
    apiKeySource: source,
    mock: isTruthyFlag(env.CHAT_MOCK),
    defaultEffort: DEFAULTS.EFFORT,
    upstreamTimeoutMs: intFromEnv(env.UPSTREAM_TIMEOUT_MS, DEFAULTS.UPSTREAM_TIMEOUT_MS, {
      min: 10,
      max: 3_600_000,
    }),
    mockDelayMs: intFromEnv(env.MOCK_DELAY_MS, DEFAULTS.MOCK_DELAY_MS, { min: 0, max: 10_000 }),
    // 离页后台续跑（默认 on；'0'/'false'/'off'/'no' 关闭 → 行为：断开即 abort）。
    backgroundGeneration: flagFromEnv(env.BACKGROUND_GENERATION, DEFAULTS.BACKGROUND_GENERATION),
    // v2：持久化与长期记忆（相对路径由 createContext 按 repoRoot 解析）
    dataDir: stringFromEnv(env.DATA_DIR, DEFAULTS.DATA_DIR),
    // at-rest 密钥（只保存配置值，不打印；校验/加载由 at-rest.mjs 在启动时完成）。
    dataEncryptionKey: stringFromEnv(env.DATA_ENCRYPTION_KEY, DEFAULTS.DATA_ENCRYPTION_KEY),
    dataEncryptionKeyFile: stringFromEnv(env.DATA_ENCRYPTION_KEY_FILE, DEFAULTS.DATA_ENCRYPTION_KEY_FILE),
    memory: flagFromEnv(env.MEMORY, DEFAULTS.MEMORY),
    memoryMax: intFromEnv(env.MEMORY_MAX, DEFAULTS.MEMORY_MAX, { min: 1, max: 200 }),
    memoryExtractModel: stringFromEnv(env.MEMORY_EXTRACT_MODEL, DEFAULTS.MEMORY_EXTRACT_MODEL),
    memoryExtractTimeoutMs: intFromEnv(env.MEMORY_EXTRACT_TIMEOUT_MS, DEFAULTS.MEMORY_EXTRACT_TIMEOUT_MS, {
      min: 100,
      max: 120_000,
    }),
    rerank: choiceFromEnv(env.RERANK, RERANK_MODES, DEFAULTS.RERANK),
    queryExpand: choiceFromEnv(env.QUERY_EXPAND, QUERY_EXPAND_MODES, DEFAULTS.QUERY_EXPAND),
    // 附件解析（flash 多模态）：正文模型/effort 不受影响。
    visionModel: stringFromEnv(env.VISION_MODEL, DEFAULTS.VISION_MODEL),
    visionTimeoutMs: intFromEnv(env.VISION_TIMEOUT_MS, DEFAULTS.VISION_TIMEOUT_MS, { min: 100, max: 600_000 }),
    visionMaxTokens: intFromEnv(env.VISION_MAX_TOKENS, DEFAULTS.VISION_MAX_TOKENS, { min: 1, max: 8_192 }),
    // 记录：HEALTH_IMPORT（导入接口总开关）/ HEALTH_INJECT（对话注入开关）/
    // HEALTH_RETENTION_DAYS（保留天数）/ HEALTH_IMPORT_TOKEN（只读 token，不写日志）。
    healthImport: flagFromEnv(env.HEALTH_IMPORT, DEFAULTS.HEALTH_IMPORT),
    healthInject: flagFromEnv(env.HEALTH_INJECT, DEFAULTS.HEALTH_INJECT),
    healthRetentionDays: intFromEnv(env.HEALTH_RETENTION_DAYS, DEFAULTS.HEALTH_RETENTION_DAYS, {
      min: 1,
      max: 3_650,
    }),
    healthImportToken: stringFromEnv(env.HEALTH_IMPORT_TOKEN, DEFAULTS.HEALTH_IMPORT_TOKEN),
    // 图片附件持久化开关与容量上限（单位 MB，正整数；非法回落默认并 warn）。
    attachmentStorage: flagFromEnv(env.ATTACHMENT_STORAGE, DEFAULTS.ATTACHMENT_STORAGE),
    attachmentMaxMb: positiveIntFromEnv(
      env.ATTACHMENT_MAX_MB,
      DEFAULTS.ATTACHMENT_MAX_MB,
      { min: 1, max: 102_400 },
      { logger, name: 'ATTACHMENT_MAX_MB' },
    ),
    // 问卷历史存储与注入开关 + 保留天数（非法回落默认并 warn）。
    scaleHistory: flagFromEnv(env.SCALE_HISTORY, DEFAULTS.SCALE_HISTORY),
    scaleHistoryInject: flagFromEnv(env.SCALE_HISTORY_INJECT, DEFAULTS.SCALE_HISTORY_INJECT),
    scaleHistoryRetentionDays: positiveIntFromEnv(
      env.SCALE_HISTORY_RETENTION_DAYS,
      DEFAULTS.SCALE_HISTORY_RETENTION_DAYS,
      { min: 1, max: 3_650 },
      { logger, name: 'SCALE_HISTORY_RETENTION_DAYS' },
    ),
    // 联网搜索（默认关闭；数值非法回落默认并 warn，风格同 ATTACHMENT_*）。
    websearch: flagFromEnv(env.WEBSEARCH, DEFAULTS.WEBSEARCH),
    websearchProvider: stringFromEnv(env.WEBSEARCH_PROVIDER, DEFAULTS.WEBSEARCH_PROVIDER),
    websearchBaseUrl: stringFromEnv(env.WEBSEARCH_BASE_URL, DEFAULTS.WEBSEARCH_BASE_URL).replace(/\/+$/, ''),
    websearchTimeoutMs: positiveIntFromEnv(
      env.WEBSEARCH_TIMEOUT_MS,
      DEFAULTS.WEBSEARCH_TIMEOUT_MS,
      { min: 100, max: 60_000 },
      { logger, name: 'WEBSEARCH_TIMEOUT_MS' },
    ),
    websearchCount: positiveIntFromEnv(
      env.WEBSEARCH_COUNT,
      DEFAULTS.WEBSEARCH_COUNT,
      { min: 1, max: 50 },
      { logger, name: 'WEBSEARCH_COUNT' },
    ),
    websearchMaxCitations: positiveIntFromEnv(
      env.WEBSEARCH_MAX_CITATIONS,
      DEFAULTS.WEBSEARCH_MAX_CITATIONS,
      { min: 1, max: 5 },
      { logger, name: 'WEBSEARCH_MAX_CITATIONS' },
    ),
    websearchMinAuthority: positiveIntFromEnv(
      env.WEBSEARCH_MIN_AUTHORITY,
      DEFAULTS.WEBSEARCH_MIN_AUTHORITY,
      { min: 0, max: 4 },
      { logger, name: 'WEBSEARCH_MIN_AUTHORITY' },
    ),
    websearchMaxAgeDays: positiveIntFromEnv(
      env.WEBSEARCH_MAX_AGE_DAYS,
      DEFAULTS.WEBSEARCH_MAX_AGE_DAYS,
      { min: 1, max: 3_650 },
      { logger, name: 'WEBSEARCH_MAX_AGE_DAYS' },
    ),
    websearchCacheTtlMs: positiveIntFromEnv(
      env.WEBSEARCH_CACHE_TTL_MS,
      DEFAULTS.WEBSEARCH_CACHE_TTL_MS,
      { min: 1_000, max: 86_400_000 },
      { logger, name: 'WEBSEARCH_CACHE_TTL_MS' },
    ),
    websearchCacheMax: positiveIntFromEnv(
      env.WEBSEARCH_CACHE_MAX,
      DEFAULTS.WEBSEARCH_CACHE_MAX,
      { min: 1, max: 1_000 },
      { logger, name: 'WEBSEARCH_CACHE_MAX' },
    ),
    websearchMockMode,
    // 多用户/认证/配额/计费：字段名冻结（docs/briefs/m41-interface-contract.md 11.6）。
    auth: choiceFromEnv(env.AUTH, AUTH_MODES, DEFAULTS.AUTH),
    authCookieSecure: flagFromEnv(env.AUTH_COOKIE_SECURE, DEFAULTS.AUTH_COOKIE_SECURE),
    authSessionTtlDays: positiveIntFromEnv(
      env.AUTH_SESSION_TTL_DAYS,
      DEFAULTS.AUTH_SESSION_TTL_DAYS,
      { min: 1, max: 365 },
      { logger, name: 'AUTH_SESSION_TTL_DAYS' },
    ),
    adminUsername: stringFromEnv(env.ADMIN_USERNAME, DEFAULTS.ADMIN_USERNAME),
    adminInitialPasswordFile: stringFromEnv(env.ADMIN_INITIAL_PASSWORD_FILE, DEFAULTS.ADMIN_INITIAL_PASSWORD_FILE),
    inviteOnly: flagFromEnv(env.INVITE_ONLY, DEFAULTS.INVITE_ONLY),
    quota: {
      dayTokens: positiveIntFromEnv(
        env.QUOTA_DAY_TOKENS,
        DEFAULTS.QUOTA_DAY_TOKENS,
        { min: 1, max: 1_000_000_000 },
        { logger, name: 'QUOTA_DAY_TOKENS' },
      ),
      monthTokens: positiveIntFromEnv(
        env.QUOTA_MONTH_TOKENS,
        DEFAULTS.QUOTA_MONTH_TOKENS,
        { min: 1, max: 100_000_000_000 },
        { logger, name: 'QUOTA_MONTH_TOKENS' },
      ),
    },
    rateLimit: {
      perMinute: positiveIntFromEnv(
        env.RATE_PER_MINUTE,
        DEFAULTS.RATE_PER_MINUTE,
        { min: 1, max: 100_000 },
        { logger, name: 'RATE_PER_MINUTE' },
      ),
      concurrency: positiveIntFromEnv(
        env.RATE_CONCURRENCY,
        DEFAULTS.RATE_CONCURRENCY,
        { min: 1, max: 1_000 },
        { logger, name: 'RATE_CONCURRENCY' },
      ),
    },
    allowedModels: parseAllowedModels(env.ALLOWED_MODELS, DEFAULTS.ALLOWED_MODELS, { logger }),
    priceVersion: stringFromEnv(env.PRICE_VERSION, DEFAULTS.PRICE_VERSION),
    priceTable: parsePriceTable(env.PRICE_TABLE_JSON, stringFromEnv(env.PRICE_VERSION, DEFAULTS.PRICE_VERSION), {
      logger,
    }),
    usageRetentionDays: positiveIntFromEnv(
      env.USAGE_RETENTION_DAYS,
      DEFAULTS.USAGE_RETENTION_DAYS,
      { min: 1, max: 3_650 },
      { logger, name: 'USAGE_RETENTION_DAYS' },
    ),
    feedbackMaxChars: positiveIntFromEnv(
      env.FEEDBACK_MAX_CHARS,
      DEFAULTS.FEEDBACK_MAX_CHARS,
      { min: 1, max: 100_000 },
      { logger, name: 'FEEDBACK_MAX_CHARS' },
    ),
    webSearchPerUserPerDay: positiveIntFromEnv(
      env.WEBSEARCH_PER_USER_PER_DAY,
      DEFAULTS.WEBSEARCH_PER_USER_PER_DAY,
      { min: 1, max: 1_000_000 },
      { logger, name: 'WEBSEARCH_PER_USER_PER_DAY' },
    ),
    // ..BYOK（字段名冻结，docs/briefs/m42-interface-contract.md 8）。
    byokEnabled: flagFromEnv(env.BYOK, DEFAULTS.BYOK),
    byokAllowLoopback: flagFromEnv(env.BYOK_ALLOW_LOOPBACK, DEFAULTS.BYOK_ALLOW_LOOPBACK),
    byokCheckPerMinute: positiveIntFromEnv(
      env.BYOK_CHECK_PER_MINUTE,
      DEFAULTS.BYOK_CHECK_PER_MINUTE,
      { min: 1, max: 60 },
      { logger, name: 'BYOK_CHECK_PER_MINUTE' },
    ),
    byokTimeoutMs: positiveIntFromEnv(
      env.BYOK_TIMEOUT_MS,
      DEFAULTS.BYOK_TIMEOUT_MS,
      { min: 1_000, max: 600_000 },
      { logger, name: 'BYOK_TIMEOUT_MS' },
    ),
    byokMaxKeyChars: positiveIntFromEnv(
      env.BYOK_MAX_KEY_CHARS,
      DEFAULTS.BYOK_MAX_KEY_CHARS,
      { min: 8, max: 4_096 },
      { logger, name: 'BYOK_MAX_KEY_CHARS' },
    ),
    byokMaxModelChars: positiveIntFromEnv(
      env.BYOK_MAX_MODEL_CHARS,
      DEFAULTS.BYOK_MAX_MODEL_CHARS,
      { min: 8, max: 256 },
      { logger, name: 'BYOK_MAX_MODEL_CHARS' },
    ),
    byokMaxBaseUrlChars: positiveIntFromEnv(
      env.BYOK_MAX_BASEURL_CHARS,
      DEFAULTS.BYOK_MAX_BASEURL_CHARS,
      { min: 16, max: 2_048 },
      { logger, name: 'BYOK_MAX_BASEURL_CHARS' },
    ),
    // 信封加密开关（KEK→DEK）。默认 off，生产显式 on。
    atRestEnvelope: flagFromEnv(env.AT_REST_ENVELOPE, false),
    // BYOK 记忆抽取 max_tokens（非流式用户模型调用）。
    memoryExtractMaxTokens: positiveIntFromEnv(
      env.MEMORY_EXTRACT_MAX_TOKENS,
      DEFAULTS.MEMORY_EXTRACT_MAX_TOKENS,
      { min: 64, max: 8_192 },
      { logger, name: 'MEMORY_EXTRACT_MAX_TOKENS' },
    ),
    // 合规同意版本（server/consent.mjs 的 CONSENT_VERSION 应与此一致）。
    consentVersion: stringFromEnv(env.CONSENT_VERSION, DEFAULTS.CONSENT_VERSION),
    // 反馈 webhook（空=不发送；fire-and-forget、失败只 warn）。
    feedbackWebhookUrl: stringFromEnv(env.FEEDBACK_WEBHOOK_URL, DEFAULTS.FEEDBACK_WEBHOOK_URL),
    // 附件保留天数（0=不清理）与备份目录（管理台/备份脚本展示用）。
    attachmentRetentionDays: intFromEnv(
      env.ATTACHMENT_RETENTION_DAYS,
      DEFAULTS.ATTACHMENT_RETENTION_DAYS,
      { min: 0, max: 3650 },
    ),
    backupDir: stringFromEnv(env.BACKUP_DIR, DEFAULTS.BACKUP_DIR),
    // BYOK 加固（check 开关、模型/域名 allowlist、官方模型峰谷策略）。
    byokCheckEnabled: flagFromEnv(env.BYOK_CHECK_ENABLED, DEFAULTS.BYOK_CHECK_ENABLED),
    byokAllowedModels: listFromEnv(env.BYOK_ALLOWED_MODELS, []),
    byokAllowedHosts: listFromEnv(env.BYOK_ALLOWED_HOSTS, []),
    peakModelPolicy: choiceFromEnv(env.PEAK_MODEL_POLICY, ['off', 'auto'], DEFAULTS.PEAK_MODEL_POLICY),
    peakModel: stringFromEnv(env.PEAK_MODEL, DEFAULTS.PEAK_MODEL),
    peakHoursUtc: stringFromEnv(env.PEAK_HOURS_UTC, DEFAULTS.PEAK_HOURS_UTC),
  };
}

/** 上游 Messages 端点。DEEPSEEK_BASE_URL 默认 `https://api.deepseek.com/anthropic`。 */
export function messagesUrl(config) {
  return `${config.baseUrl}/v1/messages`;
}
