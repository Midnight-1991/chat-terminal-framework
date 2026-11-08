// server/websearch.mjs — 联网搜索适配器（开源框架子集 / 通用化改写版：内置领域风险词表已移除，保留可配置门控与通用适配逻辑）。
// 联网搜索：DeepSeek 官方 Search & Fetch API 薄适配器。
//
// 设计原则（reviews/m33-websearch-solution.md 5）：
// - 默认关闭：WEBSEARCH=off（回滚即关闭），只有显式 webSearch:"on" 且服务端开启时才联网；
// - 本地 RAG 永远优先：联网只在检索之后做「补 1–2 条」，失败/超时/风险一律降级为空，
//   绝不 throw、绝不阻断 SSE、绝不影响回答；
// - 零 npm 依赖、依赖全部可注入（fetchImpl / logger / now），测试绝不发真实网络请求；
// - 不做次数限制（无每分钟/每日上限），费用由调用量自然产生，仅统计不阻断；
// - 隐私：只把脱敏 + 截断的查询词发给搜索服务（不发送会话/历史/附件/个人信息）；
//   日志只记 query hash 前缀、长度、条数、耗时、状态码，不记 query 原文与结果正文，不落盘。
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

/** DeepSeek Search 端点（与 /v1/messages 同一个 key，JSON 端点）。 */
export const WEBSEARCH_SEARCH_PATH = '/v1/tools/search';
export const WEBSEARCH_PROVIDER_DEFAULT = 'deepseek';
/** WEBSEARCH_MOCK_MODE 合法值：ok=确定性 3 条；fail=模拟失败降级；empty=模拟空结果。 */
export const WEBSEARCH_MOCK_MODES = Object.freeze(['ok', 'fail', 'empty']);
/** 查询词上限（DeepSeek Search：query 1–128 Unicode 字符）。 */
export const MAX_QUERY_CHARS = 128;
/** 单条联网摘要进入证据块前的截断上限（与 prompts.MAX_EVIDENCE_CHUNK_CHARS 对齐）。 */
export const MAX_WEB_SUMMARY_CHARS = 900;
/** 失败重试前的基础退避（报告 5.5：300–500ms，只重试 1 次）。 */
export const WEBSEARCH_RETRY_DELAY_MS = 300;

/**
 * 可配置的关键词门控：命中即跳过联网（安全优先）；默认空表，由部署方按自身场景配置。
 * 只做「跳过联网」的快速判定，不替代部署方自己的安全策略。
 */
// 通用伤害意图门控（安全优先：命中即跳过联网）。只保留极小的通用意图词，
// 不是领域关键词表；部署方可通过配置扩展/替换为自己的安全策略。
export const CRISIS_KEYWORDS = Object.freeze(['负面念头', '不想活', '结束生命', '伤害自己', '极端想法']);

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ID_CARD_RE = /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g;
const MOBILE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const LANDLINE_RE = /(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/g;
const NAME_RE = /我叫[^\s，。,.!！?？、；;：:]{1,8}/g;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const LANG_SUFFIX = ' lang:zh';

function compactText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function describeError(error) {
  const message = String(error?.message ?? error ?? 'unknown');
  return message.length > 80 ? `${message.slice(0, 80)}…` : message;
}

/** 服务端总开关：WEBSEARCH=off（默认）时任何请求都不会联网。 */
export function enabled(config) {
  return config?.websearch === true;
}

/** 消息是否命中风险/身心困扰/医疗医疗建议关键词（命中则不联网）。 */
export function containsCrisisKeyword(message) {
  const text = compactText(message).toLowerCase();
  if (!text) return false;
  return CRISIS_KEYWORDS.some((keyword) => text.includes(keyword));
}

/** 是否允许本轮联网：请求显式 on + 未命中风险关键词。 */
export function shouldSearch({ webSearch, message } = {}) {
  if (webSearch !== 'on') return false;
  return !containsCrisisKeyword(message);
}

/** 查询词 hash（只用于日志/缓存 key，不可逆，不落盘）。 */
export function hashQuery(query) {
  return createHash('sha256').update(String(query ?? ''), 'utf8').digest('hex');
}

/**
 * 构造脱敏查询词（确定性规则，不额外调模型）：
 * 去掉换行/折叠空白 → 脱敏手机号/座机/身份证/邮箱/「我叫X」→ 截断 ≤128 → 中文追加 lang:zh。
 * @returns {{query: string, redacted: boolean, hash: string}}
 */
export function redactQuery(message) {
  const original = compactText(message);
  let text = original;
  text = text.replace(EMAIL_RE, '[邮箱]');
  text = text.replace(ID_CARD_RE, '[身份证]');
  text = text.replace(MOBILE_RE, '[手机号]');
  text = text.replace(LANDLINE_RE, '[电话]');
  text = text.replace(NAME_RE, '我叫[姓名]');
  const redacted = text !== original;

  // 中文查询带 lang:zh 提示，同时把后缀长度计入 128 字符预算。
  const hasCjk = CJK_RE.test(text);
  const limit = hasCjk ? MAX_QUERY_CHARS - Array.from(LANG_SUFFIX).length : MAX_QUERY_CHARS;
  const chars = Array.from(text);
  let query = chars.length > limit ? chars.slice(0, limit).join('') : text;
  if (hasCjk && !/\blang:zh\b/i.test(query)) query = `${query}${LANG_SUFFIX}`;
  return { query, redacted, hash: hashQuery(query) };
}

/**
 * CHAT_MOCK=1 时的确定性模拟结果（绝不触网）：固定 3 条，供测试断言 webSearchUsed。
 * 返回 DeepSeek Search 响应同形状的原始结果，交给 normalizeResults 统一过滤/映射。
 */
export function mockResults() {
  return Array.from({ length: 3 }, (_, index) => ({
    title: `模拟联网资料 ${index + 1}`,
    url: `https://example.com/web/${index + 1}`,
    site_name: 'example.com',
    date: '2026-11-04',
    summary: `这是第 ${index + 1} 条模拟联网摘要，用于测试`,
    authority: 3,
    rerank_score: 2,
  }));
}

/**
 * 过滤 + 映射 DeepSeek Search 结果为内部 citation 形状。
 * 过滤规则（报告 5.5）：authority<minAuthority、超龄（maxAgeDays）、空摘要、URL 去重；最多 maxCitations 条。
 * 映射：{c, title, heading: site_name, anchor: date, sourceUrl: url, text: summary.slice(0,900), source:'web'}。
 * c 由调用侧统一重排（chat 合流时本地 c1..ck 在前）。
 */
export function normalizeResults(raw, { maxCitations = 2, minAuthority = 2, maxAgeDays = 730, now = Date.now() } = {}) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.results)
      ? raw.results
      : [];
  const limit = positiveInt(maxCitations, 2, { min: 0, max: 5 });
  if (limit === 0 || list.length === 0) return [];
  const authorityFloor = Number.isFinite(Number(minAuthority)) ? Number(minAuthority) : 2;
  const ageDays = positiveInt(maxAgeDays, 730, { min: 1, max: 3650 });
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const seen = new Set();
  const citations = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || citations.length >= limit) continue;
    const authority = Number(item.authority);
    if (!Number.isFinite(authority) || authority < authorityFloor) continue;
    const summary = compactText(item.summary ?? item.snippet ?? '');
    if (!summary) continue;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!url || seen.has(url)) continue;
    const date = typeof item.date === 'string' ? item.date : '';
    const publishedAt = Date.parse(date);
    if (Number.isFinite(publishedAt) && nowMs - publishedAt > ageDays * 86_400_000) continue;
    seen.add(url);
    const text = Array.from(summary);
    citations.push({
      c: 0, // 占位；chat 合流时统一编号
      title: compactText(item.title ?? ''),
      heading: compactText(item.site_name ?? ''),
      anchor: date,
      sourceUrl: url,
      text:
        text.length > MAX_WEB_SUMMARY_CHARS
          ? `${text.slice(0, MAX_WEB_SUMMARY_CHARS).join('')}…`
          : text.join(''),
      source: 'web',
    });
  }
  return citations;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * 调 DeepSeek /v1/tools/search（一次搜索请求）：超时 + 可选重试，任何失败返回空数组并 warn。
 * @returns {Promise<{results: Array<object>, ms: number, status: number}>}
 */
export async function searchWeb({
  query,
  config = {},
  fetchImpl = globalThis.fetch,
  logger = console,
  signal = null,
  now = Date.now,
} = {}) {
  const startedAt = now();
  const empty = (status = 0) => ({ results: [], ms: Math.max(0, now() - startedAt), status });
  if (typeof fetchImpl !== 'function') {
    logger?.warn?.('[websearch] 无可用 fetch，联网搜索降级为空');
    return empty();
  }
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!apiKey) {
    // 不打印 key；只说明缺配置。
    logger?.warn?.('[websearch] 未配置 DEEPSEEK_API_KEY，联网搜索降级为空');
    return empty();
  }
  const baseUrl = String(config.websearchBaseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    logger?.warn?.('[websearch] WEBSEARCH_BASE_URL 为空，联网搜索降级为空');
    return empty();
  }
  const url = `${baseUrl}${WEBSEARCH_SEARCH_PATH}`;
  const timeoutMs = positiveInt(config.websearchTimeoutMs, 4_000, { min: 100, max: 60_000 });
  const count = positiveInt(config.websearchCount, 5, { min: 1, max: 50 });
  const body = JSON.stringify({ query, count, need_content: false });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) return empty();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error('websearch timeout'));
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      try {
        controller.abort(signal?.reason);
      } catch {
        /* ignore */
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      const ms = Math.max(0, now() - startedAt);
      const status = Number(response?.status ?? 0);
      if (!response?.ok) {
        const retryable = isRetryableStatus(status);
        logger?.warn?.(
          `[websearch] 搜索失败（status=${status}，attempt=${attempt + 1}）${retryable ? '，将重试' : '，不重试'}`,
        );
        if (retryable && attempt === 0) {
          await sleep(WEBSEARCH_RETRY_DELAY_MS);
          continue;
        }
        return { results: [], ms, status };
      }
      const payload = await response.json();
      const results = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.results)
          ? payload.results
          : [];
      return { results, ms, status };
    } catch (error) {
      const aborted = Boolean(controller.signal.aborted || signal?.aborted);
      logger?.warn?.(
        `[websearch] 搜索${aborted ? '超时/取消' : '异常'}（attempt=${attempt + 1}）：${describeError(error)}`,
      );
      if (!signal?.aborted && attempt === 0) {
        await sleep(WEBSEARCH_RETRY_DELAY_MS);
        continue;
      }
      return empty();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
    }
  }
  return empty();
}

/**
 * 创建联网搜索服务实例（缓存 + 统计只在内存，不落盘）。
 * 已移除每分钟/每日次数限流；原 rate 计数窗口与 stats.rateLimited 不再存在。
 * app.createContext 在启动时创建一个 ctx.webSearch；测试可直接用 mock config/fetchImpl 构造。
 * @returns {{enabled:()=>boolean, shouldSearch:Function, redactQuery:Function,
 *   normalizeResults:Function, mockResults:Function, search:Function, stats:Function, resetStats:Function}}
 */
export function createWebSearch({
  fetchImpl = globalThis.fetch,
  config = {},
  logger = console,
  now = () => Date.now(),
} = {}) {
  const cache = new Map(); // sha256(redactedQuery) → { expiresAt, results }
  const counters = {
    searches: 0,
    requests: 0,
    cacheHits: 0,
    failures: 0,
    mockSearches: 0,
  };
  const cacheTtlMs = positiveInt(config.websearchCacheTtlMs, 3_600_000, { min: 1_000, max: 86_400_000 });
  const cacheMax = positiveInt(config.websearchCacheMax, 200, { min: 1, max: 1_000 });
  const maxCitations = positiveInt(config.websearchMaxCitations, 2, { min: 1, max: 5 });
  const minAuthority = positiveInt(config.websearchMinAuthority, 2, { min: 0, max: 4 });
  const maxAgeDays = positiveInt(config.websearchMaxAgeDays, 730, { min: 1, max: 3_650 });

  const normalize = (raw) => normalizeResults(raw, { maxCitations, minAuthority, maxAgeDays, now: now() });

  function readCache(hash, at) {
    const hit = cache.get(hash);
    if (!hit) return null;
    if (hit.expiresAt <= at) {
      cache.delete(hash);
      return null;
    }
    // LRU：命中后移到队尾。
    cache.delete(hash);
    cache.set(hash, hit);
    return hit.results;
  }

  function writeCache(hash, results, at) {
    cache.set(hash, { expiresAt: at + cacheTtlMs, results });
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function cloneResults(results) {
    return results.map((citation) => ({ ...citation }));
  }

  const api = {
    enabled: () => enabled(config),
    shouldSearch,
    redactQuery,
    normalizeResults: (raw) => normalize(raw),
    mockResults,
    stats() {
      return {
        searches: counters.searches,
        requests: counters.requests,
        cacheHits: counters.cacheHits,
        failures: counters.failures,
        mockSearches: counters.mockSearches,
        cacheSize: cache.size,
      };
    },
    resetStats() {
      for (const key of Object.keys(counters)) counters[key] = 0;
      cache.clear();
    },
    /**
     * 主入口：显式 webSearch=on 时尝试联网。任何异常都吞掉（返回空 citations），绝不 throw。
     * @returns {Promise<{used:boolean, citations:Array<object>, reason:string, ms:number, redacted?:boolean}>}
     */
    async search({ message, webSearch = 'on', signal = null } = {}) {
      const startedAt = now();
      if (!enabled(config)) return { used: false, citations: [], reason: 'disabled', ms: 0 };
      if (webSearch !== 'on') return { used: false, citations: [], reason: 'off', ms: 0 };
      if (typeof message !== 'string' || compactText(message) === '') {
        return { used: false, citations: [], reason: 'empty-message', ms: 0 };
      }
      if (!shouldSearch({ webSearch, message })) {
        return { used: true, citations: [], reason: 'crisis', ms: 0 };
      }
      counters.searches += 1;
      const { query, redacted, hash } = redactQuery(message);
      const cached = readCache(hash, startedAt);
      if (cached) {
        counters.cacheHits += 1;
        return {
          used: true,
          citations: cloneResults(cached),
          reason: 'cache',
          ms: Math.max(0, now() - startedAt),
          redacted,
        };
      }

      // CHAT_MOCK=1：绝不触网，走确定性 mock（WEBSEARCH_MOCK_MODE=ok|fail|empty）。
      if (config.mock) {
        counters.mockSearches += 1;
        const mode = WEBSEARCH_MOCK_MODES.includes(config.websearchMockMode) ? config.websearchMockMode : 'ok';
        if (mode === 'fail') {
          counters.failures += 1;
          logger?.warn?.(`[websearch] mock 失败模式：搜索降级为空（hash=${hash.slice(0, 8)}）`);
          return {
            used: true,
            citations: [],
            reason: 'mock-fail',
            ms: Math.max(0, now() - startedAt),
            redacted,
          };
        }
        const raw = mode === 'empty' ? [] : mockResults();
        const citations = normalize(raw);
        if (citations.length === 0) {
          logger?.info?.(`[websearch] mock 搜索无可用结果（hash=${hash.slice(0, 8)}）`);
          return {
            used: true,
            citations: [],
            reason: 'empty',
            ms: Math.max(0, now() - startedAt),
            redacted,
          };
        }
        writeCache(hash, citations, startedAt);
        logger?.info?.(
          `[websearch] mock 搜索 hash=${hash.slice(0, 8)} queryLen=${Array.from(query).length} results=${citations.length}`,
        );
        return {
          used: true,
          citations: cloneResults(citations),
          reason: 'mock',
          ms: Math.max(0, now() - startedAt),
          redacted,
        };
      }

      // 不做次数限制——不再有计数窗口/拒绝分支，搜索按请求直接发起（费用由调用量自然产生）。
      counters.requests += 1;
      const outcome = await searchWeb({ query, config, fetchImpl, logger, signal, now });
      const citations = normalize(outcome.results);
      if (citations.length === 0) {
        counters.failures += 1;
        return {
          used: true,
          citations: [],
          reason: 'failed',
          ms: outcome.ms,
          redacted,
        };
      }
      writeCache(hash, citations, startedAt);
      logger?.info?.(
        `[websearch] 搜索成功 hash=${hash.slice(0, 8)} queryLen=${Array.from(query).length} results=${citations.length} ms=${outcome.ms}`,
      );
      return {
        used: true,
        citations: cloneResults(citations),
        reason: 'ok',
        ms: outcome.ms,
        redacted,
      };
    },
  };
  return api;
}
