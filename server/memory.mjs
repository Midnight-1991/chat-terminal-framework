// server/memory.mjs — 长期记忆引擎（开源框架子集 / 通用化改写版：隐私红线改为通用敏感内容过滤，语义不变）。
// v2 长期记忆：抽取（fire-and-forget）、去重/软失效、注入、管理接口。
// ~055：分级记忆 schema v2（core/trivia + category/source/editedAt）、按需注入、PATCH 编辑。
// 契约：docs/API-CONTRACT.md 6 / docs/DATA-CONTRACT.md 9。
import { readRequestBody, sendApiError, sendJson } from './http-utils.mjs';
import {
  ID_LOOKUP_RE,
  MEMORY_SIMILARITY,
  MEMORY_CATEGORY_PRIORITY,
  MEMORY_CORE_CATEGORIES,
  MEMORY_LEVELS,
  MEMORY_SOURCES,
} from './store.mjs';
import { AttachmentError, normalizeAttachments, parseAttachments, persistedAttachmentMeta } from './vision.mjs';
import { persistParsedImage, sweepStoreAttachments } from './attachments.mjs';
import { MEMORY_HEADING_SAFE } from './security.mjs';

export const MEMORY_KINDS = Object.freeze(['profile', 'fact', 'episode']);
export const MAX_EXTRACT_ITEMS = 2;
export const MAX_EXTRACT_CHARS = 80;
export const MAX_INJECT_PROFILE = 8;
export const MAX_INJECT_CHARS = 4_000;
export const MEMORY_HEADING = '## 你记得的关于对方的信息';
/** ~055：分级记忆 schema v2（从 store 转出，供 memory 路由/前端契约共用）。 */
export { MEMORY_CATEGORY_PRIORITY, MEMORY_CORE_CATEGORIES, MEMORY_LEVELS, MEMORY_SOURCES };
/** core 每轮注入上限、trivia 按需注入上限。 */
export const MAX_INJECT_CORE = 8;
export const MAX_INJECT_TRIVIA = 3;
/** trivia 与当轮用户消息的归一化字符/二元组覆盖率阈值（≥ 0.15 才注入）。 */
export const TRIVIA_RELEVANCE_MIN = 0.15;
/** trivia 抽取短句上限（琐事只记概括短句 ≤40 字符）。 */
export const MAX_TRIVIA_EXTRACT_CHARS = 40;
/** 回忆意图词：命中时 trivia 按需注入。 */
export const RECALL_INTENT_PATTERN = /记得|之前说|我说过|提过|上次|以前/;
export const MAX_MANUAL_MEMORY_CHARS = 200;
/** 带 1 个附件时手动记忆上限放宽到 800（用户文字 + 附件摘要，）。 */
export const MAX_MEMORY_CHARS_WITH_ATTACHMENT = 800;
/** POST /api/memories 请求体上限（1 张 ≤4MB 图片 base64 约 5.34MB + JSON 包装）。 */
const MEMORY_BODY_LIMIT = 8 * 1024 * 1024;
/** 抽取 prompt 里最多带几条最近对话（DATA-CONTRACT：最近 ≤6 条）。 */
export const MAX_EXTRACT_MESSAGES = 6;

/** 按 Unicode 码点计长度（中文按一个字算）。 */
export function runeLength(text) {
  return Array.from(String(text ?? '')).length;
}

/** 归一化：去空白/标点/大小写，只留字母与数字（中文也归入字母）。 */
export function normalizeMemoryText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** 字符集合 Jaccard 相似度（归一化后比较；0–1）。 */
export function jaccardSimilarity(a, b) {
  const left = new Set(Array.from(normalizeMemoryText(a)));
  const right = new Set(Array.from(normalizeMemoryText(b)));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const char of left) if (right.has(char)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 归一化后相等，或字符 Jaccard ≥ 阈值，视为重复。 */
export function isDuplicateText(a, b, threshold = MEMORY_SIMILARITY.DUPLICATE) {
  const left = normalizeMemoryText(a);
  const right = normalizeMemoryText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return jaccardSimilarity(left, right) >= threshold;
}

/* ------------- 字符 bigram 相似度、事件标记与重叠判定 ------------- */

/**
 * 事件标记（具体事件/一次经历，）：命中即视为「具体事件」而非「稳定概括」。
 * 刻意不含「以前/想起」——用户概括条与事件条都含这两个词，含了就无法区分两类记忆。
 */
export const EVENT_MARKERS = /尤其|记得|那次|当时|当天|初中|高中|小学|那天|第一次|发生|检举|当众|今天|昨天|上周|上个月/;

/**
 * 事件降级/启动迁移的包含度阈值：实测用户 A/B 对 containment = 11/15 ≈ 0.7333。
 * 说明手算 0.857（12/14）基于不带「总是」的概括文本，与测试种子文本（含「总是」）不一致；
 * 取 0.7 以覆盖真实用户案例（阈值过高会导致  测试与存量迁移不触发）。
 */
const OVERLAP_CONTAINMENT_MIN = 0.7;

/** 文本是否含事件标记（具体事件/一次经历）。 */
export function hasEventMarkers(text) {
  return EVENT_MARKERS.test(String(text ?? ''));
}

/**
 * normalize 后连续二元组计数：返回 Map<二元组, 出现次数>。
 * 单字/空文本返回空 Map（normalize 已去空白、标点、大小写）。
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function charBigrams(text) {
  const chars = Array.from(normalizeMemoryText(text));
  const grams = new Map();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const gram = chars[index] + chars[index + 1];
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** charBigrams 结果或原始文本 → bigram 计数 Map（避免同一文本重复切分）。 */
function gramCountsOf(input) {
  return input instanceof Map ? input : charBigrams(input);
}

function totalGramCount(grams) {
  let total = 0;
  for (const count of grams.values()) total += count;
  return total;
}

/**
 * 多重集 Bigram Dice 系数：2×共享计数 /（两方总计数之和），0–1。
 * 共享计数按 min(计数) 求和；任一方无 bigram 时返回 0。
 * @param {string|Map<string, number>} a
 * @param {string|Map<string, number>} b
 */
export function diceCoefficient(a, b) {
  const left = gramCountsOf(a);
  const right = gramCountsOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  const leftTotal = totalGramCount(left);
  const rightTotal = totalGramCount(right);
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const [gram, count] of small) shared += Math.min(count, large.get(gram) ?? 0);
  const total = leftTotal + rightTotal;
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * 包含度：交集 bigram 计数 / 两方总计数较小方，0–1。
 * 用于判断「新条目是否只是既有条目的扩写」（较短一方被覆盖的比例）。
 * 公式本身对称；方向语义来自调用方式 containmentRatio(new, existing)。
 * @param {string|Map<string, number>} item 待判定新条目
 * @param {string|Map<string, number>} existing 既有记忆
 */
export function containmentRatio(item, existing) {
  const left = gramCountsOf(item);
  const right = gramCountsOf(existing);
  if (left.size === 0 || right.size === 0) return 0;
  const smallerTotal = Math.min(totalGramCount(left), totalGramCount(right));
  if (smallerTotal === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const [gram, count] of small) shared += Math.min(count, large.get(gram) ?? 0);
  return shared / smallerTotal;
}

/** 综合相似度（ 升级）：保留 字符集合 Jaccard 行为，叠加 bigram Dice 取较大者。 */
function overlapSimilarity(a, b) {
  return Math.max(jaccardSimilarity(a, b), diceCoefficient(a, b));
}

/** 记忆归一化 level（缺省 core，与 store 口径一致）。 */
function normalizedMemoryLevel(memory) {
  return memory?.level === 'trivia' ? 'trivia' : 'core';
}

/** 记忆归一化 category（trivia 固定 other；core 不在白名单归 other）。 */
function normalizedMemoryCategory(memory) {
  if (normalizedMemoryLevel(memory) === 'trivia') return 'other';
  return MEMORY_CORE_CATEGORIES.includes(memory?.category) ? memory.category : 'other';
}

/** 手动/编辑过的记忆（规则 5）：豁免自动降级与失效，只参与等价重复 skip。 */
function isManuallyCuratedMemory(memory) {
  return memory?.source !== 'auto' || Number.isFinite(memory?.editedAt);
}

/* ------------- 事件条文本裁剪（迁移与抽取共用） ------------- */

/** 子句切分：中英文标点与空白。 */
const CLAUSE_SEPARATOR = /[，,。.；;、！!？?：:\n\r\t ]+/;

/** 子句与概括条的包含度达到该阈值 → 视为在复述概括，从事件条中裁掉（，确定性裁剪）。 */
const TRIM_CONTAINMENT_MIN = 0.6;

/** 去首尾标点/空白（重建裁剪结果用）。 */
function stripOuterPunctuation(text) {
  return String(text ?? '')
    .replace(/^[\s，,。.；;、！!？?：:]+/u, '')
    .replace(/[\s，,。.；;、！!？?：:]+$/u, '');
}

/**
 * 事件条文本裁剪（纯函数）：按标点把事件条切成子句，
 * 丢弃与概括条包含度 ≥ TRIM_CONTAINMENT_MIN 的子句（即复述概括的部分），
 * 保留其余子句并按原顺序用「，」重建、去首尾标点。
 * 全部子句都被判为重叠、或没有任何子句被裁掉时返回原文（宁可不裁不丢信息）。
 * @param {string} eventText 事件条原文
 * @param {string} generalText 概括条文本
 * @returns {string}
 */
export function trimEventOverlap(eventText, generalText) {
  const source = String(eventText ?? '');
  const general = String(generalText ?? '');
  if (!source.trim() || !general.trim()) return source;
  const clauses = source.split(CLAUSE_SEPARATOR).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length === 0) return source;
  const kept = clauses.filter((clause) => containmentRatio(clause, general) < TRIM_CONTAINMENT_MIN);
  // 全部裁掉 → 保留原文；一条也没裁掉 → 原文不变。
  if (kept.length === 0 || kept.length === clauses.length) return source;
  return stripOuterPunctuation(kept.join('，'));
}

/**
 * 抽取结果重叠判定（纯函数；隐私过滤后、落库前逐条调用）。
 *
 * @param {{kind?:string, level?:string, category?:string, text:string}} item 待落库条目
 * @param {Array<object>} [existingMemories] store.listMemories()（含软失效条，用于防复活去重）
 * @returns {{
 *   action: 'skip'|'add',
 *   reason: 'duplicate'|'trivia-duplicate'|'new'|'event-demoted'|'contradiction'|'replaced-event',
 *   item: {kind:string, level:'core'|'trivia', category:string, text:string},
 *   duplicateOf?: string,
 *   invalidateIds: string[],
 *   demoteIds: string[],
 *   demoteText: Record<string, string>,
 * }}
 * 规则（ + ）：
 *  1. 等价重复：归一化相等或 Jaccard≥0.8（保留 ）/ 同 level bigram Dice≥0.9 / 包含度≥0.95 → skip；
 *  2. 事件降级：新条 core 且含事件标记，且是同 category 既有 active core 的扩写（包含度≥OVERLAP_CONTAINMENT_MIN）
 *     → 改存 trivia/other，并裁掉其中复述概括的子句（trimEventOverlap）；
 *  2b. 本身是 trivia 的事件条若与 active 概括 core 重叠 → 同样裁剪后落库；
 *  3. 矛盾/替代：同 level/category、综合相似度 [0.5,0.8)、旧条 auto 且未编辑 → 软失效旧条后新增；
 *     但对 core，若新条是更稳定的概括（无事件标记）而旧条含事件标记 → 新增 core 并把旧条降为 trivia，
 *     旧条文本裁剪结果放入 demoteText[id]，调用方随 updateMemory 写回；
 *  4. trivia 重复：降级/裁剪后的 trivia 与既有 trivia Dice≥0.9 → skip；
 *  5. 手动/编辑过的既有记忆不自动降级/失效，只参与等价重复 skip。
 */
export function applyOverlapRules(item, existingMemories = []) {
  const memories = Array.isArray(existingMemories) ? existingMemories.filter(Boolean) : [];
  let text = String(item?.text ?? '');
  let level = item?.level === 'trivia' ? 'trivia' : 'core';
  let category = level === 'trivia'
    ? 'other'
    : (MEMORY_CORE_CATEGORIES.includes(item?.category) ? item.category : 'other');
  const kind = MEMORY_KINDS.includes(item?.kind) ? item.kind : (level === 'core' ? 'profile' : 'fact');
  const makeItem = () => ({ kind, level, category, text });
  const skip = (reason, duplicateOf) => ({
    action: 'skip',
    reason,
    item: makeItem(),
    duplicateOf,
    invalidateIds: [],
    demoteIds: [],
    demoteText: {},
  });
  if (!text.trim()) return skip('duplicate', undefined);

  // 规则 1：等价重复（含软失效旧条 → 跳过，避免一次复述就复活/横跳）。
  for (const memory of memories) {
    const memoryText = String(memory?.text ?? '');
    if (!memoryText) continue;
    // 口径：归一化相等或字符 Jaccard≥0.8 视为重复（跨 level 也跳过，避免一事实两存）。
    if (isDuplicateText(text, memoryText)) return skip('duplicate', memory.id);
    // 同 level 的 bigram Dice≥0.9 或包含度≥0.95 视为等价重复。
    if (normalizedMemoryLevel(memory) === level
      && (diceCoefficient(text, memoryText) >= 0.9 || containmentRatio(text, memoryText) >= 0.95)) {
      return skip('duplicate', memory.id);
    }
  }

  let demotedFromCore = false;
  // 规则 2：事件降级 —— 新 core 是既有同类别 core 的「具体事件」扩写时，改为 trivia 落库（不丢内容）；
  // 降级的同时裁掉复述概括的子句，后续重复检查用裁剪后的文本。
  if (level === 'core' && hasEventMarkers(text)) {
    const expanded = memories.find((memory) => !memory.validTo
      && normalizedMemoryLevel(memory) === 'core'
      && normalizedMemoryCategory(memory) === category
      && containmentRatio(text, memory.text) >= OVERLAP_CONTAINMENT_MIN);
    if (expanded) {
      demotedFromCore = true;
      level = 'trivia';
      category = 'other';
      text = trimEventOverlap(text, expanded.text);
      // 规则 4：降级后与既有 trivia 近似重复 → skip（同一件事不重复落库）。
      const triviaDuplicate = memories.find((memory) => normalizedMemoryLevel(memory) === 'trivia'
        && diceCoefficient(text, memory.text) >= 0.9);
      if (triviaDuplicate) return skip('trivia-duplicate', triviaDuplicate.id);
    }
  }

  // 规则 2b：本身已是 trivia 的事件条，若与某 active 概括 core 重叠（包含度≥阈值），
  // 同样裁掉复述概括的子句（按最匹配的 core 裁剪），避免「降级但复述」的数据形态。
  if (level === 'trivia' && hasEventMarkers(text)) {
    const general = memories
      .filter((memory) => !memory.validTo
        && normalizedMemoryLevel(memory) === 'core'
        && !hasEventMarkers(memory.text))
      .map((memory) => ({ memory, overlap: containmentRatio(text, memory.text) }))
      .filter((candidate) => candidate.overlap >= OVERLAP_CONTAINMENT_MIN)
      .sort((left, right) => right.overlap - left.overlap)[0];
    if (general) {
      const trimmed = trimEventOverlap(text, general.memory.text);
      if (trimmed !== text) {
        text = trimmed;
        const triviaDuplicate = memories.find((memory) => normalizedMemoryLevel(memory) === 'trivia'
          && diceCoefficient(text, memory.text) >= 0.9);
        if (triviaDuplicate) return skip('trivia-duplicate', triviaDuplicate.id);
      }
    }
  }

  // 规则 3：矛盾/替代（保留既有 行为并升级为「概括条留 core、事件条降 trivia」）。
  const result = {
    action: 'add',
    reason: demotedFromCore ? 'event-demoted' : 'new',
    item: makeItem(),
    invalidateIds: [],
    demoteIds: [],
    demoteText: {},
  };
  for (const memory of memories) {
    if (memory.validTo) continue;
    if (normalizedMemoryLevel(memory) !== level || normalizedMemoryCategory(memory) !== category) continue;
    // 规则 5：手动/编辑过的旧条豁免降级与失效（只参与上面的等价重复 skip）。
    if (isManuallyCuratedMemory(memory)) continue;
    const similarity = overlapSimilarity(memory.text, text);
    // 子规则：新条是更稳定的概括（无事件标记）、旧 core 是具体事件（含事件标记）→ 新增 core，旧条降 trivia。
    // 触发用包含度（实测用户 A/B 对相似度 0.478 低于矛盾下限 0.5，单靠相似度区间无法覆盖真实案例），
    // 兼容原 相似度区间。
    const summaryReplacesEvent = level === 'core'
      && !hasEventMarkers(text)
      && hasEventMarkers(memory.text)
      && (containmentRatio(text, memory.text) >= OVERLAP_CONTAINMENT_MIN
        || (similarity >= MEMORY_SIMILARITY.CONTRADICTION_MIN && similarity < MEMORY_SIMILARITY.DUPLICATE));
    if (summaryReplacesEvent) {
      result.demoteIds.push(memory.id);
      // 旧事件条降 trivia 时一并裁掉复述概括的子句（调用方随 updateMemory 写回）。
      result.demoteText[memory.id] = trimEventOverlap(memory.text, text);
      result.reason = 'replaced-event';
      continue;
    }
    if (!(similarity >= MEMORY_SIMILARITY.CONTRADICTION_MIN && similarity < MEMORY_SIMILARITY.DUPLICATE)) continue;
    result.invalidateIds.push(memory.id);
    if (result.reason === 'new' || result.reason === 'event-demoted') result.reason = 'contradiction';
  }
  return result;
}

function tryJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 解析抽取模型输出（容错：```json 围栏、前后说明文字、纯字符串数组、对象数组）。
 * 输出统一为 [{kind, text}]，最多 MAX_EXTRACT_ITEMS 条，单条 ≤ MAX_EXTRACT_CHARS 字。
 * @param {string} raw
 * @returns {Array<{kind:string, text:string}>}
 */
/**
 * 解析抽取模型输出（容错：```json 围栏、前后说明文字、纯字符串数组、对象数组）。
 * v2：每条输出 `{kind, level, category, text}`；`level` ∈ core|trivia，缺省 trivia（兼容旧 prompt 输出），
 * core 的 `category` 必须属于白名单否则归 other；trivia 固定 category=other、单条 ≤40 字；core 单条 ≤80 字。
 * 最多 MAX_EXTRACT_ITEMS 条。
 * @param {string} raw
 * @returns {Array<{kind:string, level:'core'|'trivia', category:string, text:string}>}
 */
function normalizeExtractedItem(item) {
  let value = '';
  let level = 'trivia';
  let category = 'other';
  let kind = '';
  if (typeof item === 'string') {
    value = item;
  } else if (item && typeof item === 'object' && typeof item.text === 'string') {
    value = item.text;
    if (item.level === 'core' || item.level === 'trivia') level = item.level;
    if (level === 'core') {
      category = MEMORY_CORE_CATEGORIES.includes(item.category) ? item.category : 'other';
    }
    if (MEMORY_KINDS.includes(item.kind)) kind = item.kind;
  } else {
    return null;
  }
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  const limit = level === 'trivia' ? MAX_TRIVIA_EXTRACT_CHARS : MAX_EXTRACT_CHARS;
  const chars = Array.from(trimmed);
  const textValue = chars.length > limit ? chars.slice(0, limit).join('') : trimmed;
  return {
    kind: kind || (level === 'core' ? 'profile' : 'fact'),
    level,
    category: level === 'core' ? category : 'other',
    text: textValue,
  };
}

export function parseExtractOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let parsed = tryJsonParse(text);
  if (parsed === undefined) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) parsed = tryJsonParse(fenced[1].trim());
  }
  if (parsed === undefined) {
    const object = text.match(/\{[\s\S]*\}/);
    if (object) parsed = tryJsonParse(object[0]);
  }
  if (parsed === undefined) {
    const array = text.match(/\[[\s\S]*\]/);
    if (array) parsed = tryJsonParse(array[0]);
  }

  let list = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.memories)) list = parsed.memories;

  const results = [];
  for (const item of list) {
    const normalized = normalizeExtractedItem(item);
    if (!normalized) continue;
    if (results.some((entry) => isDuplicateText(entry.text, normalized.text))) continue;
    results.push(normalized);
    if (results.length >= MAX_EXTRACT_ITEMS) break;
  }
  return results;
}

/**
 * 运行时隐私过滤（API-CONTRACT 6）：抽取结果不得落库「评估、用药、敏感内容」类信息。
 * prompt 已要求模型不要抽这三类；模型仍可能违规，这里做最后一道语义闸门。返回 true 表示应丢弃。
 */
const PRIVATE_MEMORY_PATTERNS = [
  /评估|确诊|阳性|患病|病名|诊断类|持续心境|情绪波动|长期情绪|困难经历后反应|进食困扰|依赖|持续依赖/,
  /用药|吃药|服药|用药|剂量|处方|情绪类药物|安眠药|舍曲林|氟西汀|帕罗西汀|劳拉西泮|阿普唑仑|奥氮平|喹硫平/,
  /敏感内容|敏感内容|敏感内容|敏感内容|极端表述模式/,
];

export function isPrivateMemoryText(text) {
  const value = String(text ?? '');
  return PRIVATE_MEMORY_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * CHAT_MOCK=1 时的本地规则抽取（确定性，便于测试/截图）。
 * 返回分级结果，覆盖 core（general/family/academic）与 trivia，供测试  mock 路径验证。
 */
export function mockExtractMemories(message) {
  const text = String(message ?? '');
  const rules = [
    [/记住/, { kind: 'profile', level: 'core', category: 'general', text: '用户希望助手记住这件事' }],
    [/妈妈|妈|爸爸|爸|家人|父母/, { kind: 'profile', level: 'core', category: 'family', text: '用户在意和家人的关系' }],
    [/考试|学习|学业|考研|上课/, { kind: 'profile', level: 'core', category: 'academic', text: '用户在准备考试' }],
    [/我(?:习惯|总是|经常)|作息|周末/, { kind: 'fact', level: 'trivia', category: 'other', text: '用户有自己的日常习惯' }],
  ];
  for (const [pattern, memory] of rules) {
    if (pattern.test(text)) return [{ ...memory }];
  }
  return [];
}

/* ----------------------- 注入选择（，可单测纯函数） ----------------------- */

/** 归一化小写并去标点/空白（ 相关判据的输入口径）。 */
function normalizeTriviaText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, '');
}

function bigramSet(text) {
  const chars = Array.from(String(text ?? ''));
  const grams = new Set();
  for (let index = 0; index < chars.length - 1; index += 1) grams.add(chars[index] + chars[index + 1]);
  return grams;
}

/**
 * trivia 相关度（ 定死口径）：归一化文本的 2-gram 集合 Dice 系数（0–1）。
 * Dice = 2×|交集| / (|query| + |memory|)；≥ TRIVIA_RELEVANCE_MIN（0.15）视为相关。
 */
export function triviaRelevance(query, text) {
  const queryGrams = bigramSet(normalizeTriviaText(query));
  const memoryGrams = bigramSet(normalizeTriviaText(text));
  if (queryGrams.size === 0 || memoryGrams.size === 0) return 0;
  let shared = 0;
  for (const gram of queryGrams) if (memoryGrams.has(gram)) shared += 1;
  return (2 * shared) / (queryGrams.size + memoryGrams.size);
}

/** 是否包含回忆意图词（记得/之前说/我说过/提过/上次）。 */
export function hasRecallIntent(query) {
  return RECALL_INTENT_PATTERN.test(String(query ?? ''));
}

function memoryLevelOf(memory) {
  return memory?.level === 'trivia' ? 'trivia' : 'core';
}

/**
 * 注入选择纯函数：
 * - core：每轮注入，最多 8 条（调用方传入的 active 已按类别优先级+最近排序）；
 * - trivia：仅当 query 命中回忆意图词，或归一化文本 2-gram Dice ≥ 0.15 时注入，最多 3 条；
 * - 总数 ≤ max（MEMORY_MAX）；无 query（如纯函数直调）时不注入 trivia。
 * @param {Array<object>} active 有效记忆（getActiveMemories() 的顺序）
 * @param {{query?: string, max?: number}} [options]
 */
export function selectInjectable(active, { query = '', max = 20 } = {}) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (limit === 0) return [];
  const memories = Array.isArray(active) ? active : [];
  const core = memories.filter((memory) => memoryLevelOf(memory) === 'core').slice(0, MAX_INJECT_CORE);
  const triviaCandidates = memories.filter((memory) => memoryLevelOf(memory) === 'trivia');
  let trivia = [];
  if (hasRecallIntent(query)) {
    trivia = triviaCandidates.slice(0, MAX_INJECT_TRIVIA);
  } else if (String(query ?? '').trim()) {
    trivia = triviaCandidates
      .filter((memory) => triviaRelevance(query, memory.text) >= TRIVIA_RELEVANCE_MIN)
      .slice(0, MAX_INJECT_TRIVIA);
  }
  return [...core, ...trivia].slice(0, limit);
}

/** 抽取输入：指令 + 最近对话（≤6 条）+ 现有记忆文本。 */
export function buildExtractPrompt({ extractPrompt, messages = [], memories = [] }) {
  const recent = messages
    .slice(-MAX_EXTRACT_MESSAGES)
    .map((message) => {
      const role = message?.role === 'assistant' ? '助手' : '用户';
      const content = String(message?.content ?? message?.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      return `- ${role}：${content}`;
    })
    .filter((line) => !line.endsWith('：'));
  const memoryLines = memories
    .slice(0, 40)
    .map((text) => `- ${String(text).replace(/\s+/g, ' ').trim()}`)
    .filter((line) => line !== '-');

  return [
    String(extractPrompt ?? '').trim(),
    '【最近对话】',
    recent.length > 0 ? recent.join('\n') : '（暂无）',
    '【现有记忆】',
    memoryLines.length > 0 ? memoryLines.join('\n') : '（暂无）',
  ].join('\n\n');
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`抽取模型调用超时（>${timeoutMs}ms）`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* -------------------- + 既有记忆重叠迁移（启动时幂等） -------------------- */

/**
 * 启动重叠迁移（ + 幂等，只用 store 公开方法、不删数据）：
 *  - 第一遍：同 category、与稳定概括 core 重叠（包含度≥OVERLAP_CONTAINMENT_MIN）的 auto core 事件条
 *    → 降为 trivia/other，并同时裁掉其中复述概括的子句（trimEventOverlap）；
 *  - 第二遍：已被  降级但未裁剪的 auto trivia 事件条（含生产存量）→ 若与某 active 概括 core
 *    包含度≥阈值则按内容重叠裁剪文本；本遍按内容判定，不按 editedAt 豁免（editedAt 可能来自迁移自身），
 *    source=manual 一律不动。
 * 幂等：第二次运行返回 {migrated:0, trimmed:0}。
 *
 * 说明：store.updateMemory 会写 editedAt（store.mjs 现状， 计划内不改）——之后该条会按「编辑过」
 * 豁免自动降级/失效，属于保守保留用户数据的行为，无害；精确语义待  优化。
 *
 * @param {object} store 记忆存储
 * @param {Console} [logger]
 * @returns {Promise<{migrated:number, trimmed:number}>} 本次降级条数 / 文本去重条数；再跑一次均为 0
 */
export async function migrateOverlaps(store, logger = console) {
  const result = { migrated: 0, trimmed: 0 };
  const warn = (message) => {
    try {
      logger?.warn?.(`[memory] ${message}`);
    } catch {
      /* ignore */
    }
  };
  try {
    if (!store || typeof store.getActiveMemories !== 'function' || typeof store.updateMemory !== 'function') {
      return result;
    }
    const activeMemories = store.getActiveMemories();
    const activeCores = activeMemories.filter((memory) => normalizedMemoryLevel(memory) === 'core');
    const migratedIds = new Set();
    // 第一遍：core 事件条降为 trivia/other，并裁掉复述概括的子句。
    for (const event of activeCores) {
      if (migratedIds.has(event.id)) continue;
      // 规则 5：手动/编辑过的记忆豁免自动迁移（本遍维持原行为）。
      if (isManuallyCuratedMemory(event)) continue;
      if (!hasEventMarkers(event.text)) continue;
      const general = activeCores.find((candidate) => candidate.id !== event.id
        && !migratedIds.has(candidate.id)
        && normalizedMemoryCategory(candidate) === normalizedMemoryCategory(event)
        && !hasEventMarkers(candidate.text)
        && containmentRatio(event.text, candidate.text) >= OVERLAP_CONTAINMENT_MIN);
      if (!general) continue;
      const trimmed = trimEventOverlap(event.text, general.text);
      const updated = await store.updateMemory(event.id, { level: 'trivia', category: 'other', text: trimmed });
      if (!updated) continue;
      migratedIds.add(event.id);
      result.migrated += 1;
    }
    // 第二遍：修复已被  降级、但未裁剪事件条文本的 auto trivia（含生产存量）。
    // 该遍按内容重叠判定，不按 editedAt 豁免（editedAt 可能来自迁移自身写入）；source=manual 不动。
    const activeAfter = store.getActiveMemories();
    const generalCores = activeAfter.filter((memory) => normalizedMemoryLevel(memory) === 'core'
      && !hasEventMarkers(memory.text));
    for (const trivia of activeAfter) {
      if (normalizedMemoryLevel(trivia) !== 'trivia') continue;
      if (trivia.source !== 'auto') continue;
      if (migratedIds.has(trivia.id)) continue; // 第一遍刚降级且已裁剪，不重复计数
      if (!hasEventMarkers(trivia.text)) continue;
      const general = generalCores
        .filter((candidate) => candidate.id !== trivia.id)
        .map((candidate) => ({ candidate, overlap: containmentRatio(trivia.text, candidate.text) }))
        .filter((entry) => entry.overlap >= OVERLAP_CONTAINMENT_MIN)
        .sort((left, right) => right.overlap - left.overlap)[0];
      if (!general) continue;
      const trimmed = trimEventOverlap(trivia.text, general.candidate.text);
      if (trimmed === trivia.text) continue; // 全部子句重叠时保留原文（宁可不裁不丢信息）
      const updated = await store.updateMemory(trivia.id, { level: 'trivia', category: 'other', text: trimmed });
      if (!updated) continue;
      result.trimmed += 1;
    }
  } catch (error) {
    // 启动迁移失败不能影响服务启动：只 warn。
    warn(`启动重叠迁移失败（忽略）：${error?.message ?? error}`);
  }
  const parts = [];
  if (result.migrated > 0) parts.push(`${result.migrated} 条事件记忆降为 trivia`);
  if (result.trimmed > 0) parts.push(`${result.trimmed} 条事件文本去重`);
  if (parts.length > 0) {
    try {
      logger?.log?.(`[memory] 启动重叠迁移：${parts.join('，')}`);
    } catch {
      /* ignore */
    }
  }
  return result;
}

/**
 * 构造记忆服务。
 * @param {{
 *   store: object, config: object, logger?: Console,
 *   callModel?: ((prompt:string)=>Promise<string>)|null,
 *   extractPrompt?: string,
 * }} opts
 */
export function createMemoryService({ store, config, logger = console, callModel = null, extractPrompt = '' }) {
  const warn = (message) => {
    try {
      logger?.warn?.(`[memory] ${message}`);
    } catch {
      /* ignore */
    }
  };
  const info = (message) => {
    try {
      logger?.log?.(`[memory] ${message}`);
    } catch {
      /* ignore */
    }
  };

  /** 本轮注入：core 每轮 + trivia 按需；见顶层 selectInjectable 纯函数。 */
  function selectInjectableFromActive({ query = '', max = config.memoryMax } = {}) {
    return selectInjectable(store.getActiveMemories(), { query, max });
  }

  function buildSystemSuffix({ query = '' } = {}) {
    if (!config.memory) return { text: '', count: 0 };
    const selected = selectInjectableFromActive({ query });
    if (selected.length === 0) return { text: '', count: 0 };
    const lines = selected.map((memory) => `- ${memory.text}`).join('\n');
    const suffix = `\n\n${MEMORY_HEADING_SAFE}\n${lines}`;
    const text = Array.from(suffix).length > MAX_INJECT_CHARS ? '' : suffix;
    return { text, count: text ? selected.length : 0 };
  }

  /** 抽取 + 去重 + 矛盾软失效；任何失败只 warn。 */
  async function extractAfterTurn({ conversationId, messages = [] } = {}) {
    if (!config.memory) return null;
    let items = [];
    if (config.mock) {
      const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
      items = mockExtractMemories(lastUser?.content ?? lastUser?.text ?? '');
    } else if (typeof callModel === 'function') {
      const prompt = buildExtractPrompt({
        extractPrompt,
        messages,
        memories: store.memoryTextList(),
      });
      try {
        const raw = await withTimeout(
          Promise.resolve().then(() => callModel(prompt)),
          config.memoryExtractTimeoutMs,
        );
        items = parseExtractOutput(raw);
      } catch (error) {
        warn(`抽取失败，本轮跳过：${error?.message ?? error}`);
        return { added: [], skipped: [], invalidated: [], demoted: [] };
      }
    } else {
      warn('未配置抽取模型调用（非 mock 且无 API key），跳过记忆抽取');
      return null;
    }
    if (items.length === 0) return { added: [], skipped: [], invalidated: [], demoted: [] };

    // 隐私红线（运行时兜底）：评估/用药/敏感内容类内容即使模型抽出来也不落库。
    const beforeFilter = items.length;
    items = items.filter((item) => {
      if (!isPrivateMemoryText(item.text)) return true;
      warn(`隐私过滤：丢弃疑似评估/用药/敏感内容类记忆（${runeLength(item.text)} 字）`);
      return false;
    });
    if (items.length === 0) {
      return { added: [], skipped: [], invalidated: [], demoted: [], filtered: beforeFilter };
    }

    const added = [];
    const skipped = [];
    const invalidated = [];
    const demoted = [];
    for (const item of items) {
      const existing = store.listMemories();
      const decision = applyOverlapRules(item, existing);
      if (decision.action === 'skip') {
        // 契约（DATA-CONTRACT 9）：归一化相等或 Jaccard≥0.8 视为重复，已存在则跳过。
        // 软失效的旧条也按重复跳过，不因一次复述就复活（避免矛盾信息反复横跳）。
        skipped.push({ text: item.text, reason: decision.reason, id: decision.duplicateOf });
        continue;
      }
      // 规则 3 既有的矛盾软失效（保留 ）：相似度落在 [0.5,0.8) 才失效旧条（不确定就不改）。
      for (const id of decision.invalidateIds) {
        await store.invalidateMemory(id);
        invalidated.push({ id, action: 'invalidated' });
      }
      // 新条是更稳定概括时，把旧 core 事件条降为 trivia（不删数据）。
      for (const id of decision.demoteIds) {
        if (typeof store.updateMemory !== 'function') {
          warn('store 不支持 updateMemory，跳过事件条降级');
          continue;
        }
        // 旧事件条降 trivia 时一并写回裁剪后的文本（去掉复述概括的子句）。
        const patch = { level: 'trivia', category: 'other' };
        const trimmed = decision.demoteText?.[id];
        if (typeof trimmed === 'string' && trimmed.trim()) patch.text = trimmed;
        const updated = await store.updateMemory(id, patch);
        if (updated) demoted.push({ id, action: 'demoted', text: patch.text });
      }
      const normalizedItem = decision.item;
      const memory = await store.addMemory({
        text: normalizedItem.text,
        kind: normalizedItem.kind,
        level: normalizedItem.level,
        category: normalizedItem.category,
        source: 'auto',
        sourceConversationId: conversationId,
      });
      added.push(memory);
    }
    if (added.length > 0 || invalidated.length > 0 || demoted.length > 0) {
      info(`新增 ${added.length} 条，失效 ${invalidated.length} 条，降级 ${demoted.length} 条（会话 ${conversationId ?? '-'}）`);
    }
    return { added, skipped, invalidated, demoted };
  }

  /** 服务方法：按当轮 query 选择注入（供测试/chat 调用点使用）。 */
  function selectInjectableForQuery(options = {}) {
    const query = typeof options === 'string' ? options : (options?.query ?? '');
    const max = Number.isFinite(options?.max) ? options.max : config.memoryMax;
    return selectInjectableFromActive({ query, max });
  }

  /**
   * 创建服务时即启动的幂等重叠迁移（core 事件条 → trivia），永不 reject（错误只 warn）。
   * app 启动时防御式 `await memory.ready` 即可保证首轮请求前迁移完成。
   * @type {Promise<void>}
   */
  const ready = Promise.resolve()
    .then(() => migrateOverlaps(store, logger))
    .then(() => undefined)
    .catch((error) => {
      warn(`启动迁移异常（忽略）：${error?.message ?? error}`);
    });

  return {
    buildSystemSuffix,
    extractAfterTurn,
    selectInjectable: selectInjectableForQuery,
    ready,
    migrateOverlaps: () => migrateOverlaps(store, logger),
  };
}

/* --------------------------- /api/memories 路由 --------------------------- */

async function readOptionalJson(req, { limit = 64 * 1024 } = {}) {
  const buffer = await readRequestBody(req, { limit });
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw { status: 400, code: 'INVALID_REQUEST', message: '请求体必须是合法 JSON' };
  }
}

function memoryRouteError(res, error) {
  if (error && Number.isInteger(error.status) && error.code) {
    sendApiError(res, error.status, error.code, error.message);
    return true;
  }
  return false;
}

/**
 * 处理 /api/memories 与 /api/memories/:id。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} ctx
 * @param {string[]} segments URL 分段（segments[0]='api'）
 */
export async function handleMemories(req, res, ctx, segments) {
  const store = ctx.store;
  if (!store) {
    sendApiError(res, 500, 'INTERNAL', '存储未初始化');
    return;
  }

  if (segments.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, { memories: store.listMemories() });
      return;
    }
    if (req.method === 'DELETE') {
      const cleared = await store.clearMemories();
      // 记忆删除后清理不再被引用的图片文件（失败只 warn，响应仍 200）。
      await sweepStoreAttachments({ attachments: ctx.attachments, store, logger: ctx.logger });
      sendJson(res, 200, { ok: true, cleared });
      return;
    }
    if (req.method === 'POST') {
      await handleCreateMemory(req, res, ctx);
      return;
    }
    sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
    return;
  }

  if (segments.length === 3) {
    const id = safeDecode(segments[2]);
    const validId = Boolean(id) && ID_LOOKUP_RE.test(id);
    if (req.method === 'PATCH') {
      if (!validId) {
        sendApiError(res, 404, 'NOT_FOUND', '记忆不存在');
        return;
      }
      await handleUpdateMemory(req, res, ctx, id);
      return;
    }
    if (req.method !== 'DELETE') {
      sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
      return;
    }
    if (!validId) {
      sendApiError(res, 404, 'NOT_FOUND', '记忆不存在');
      return;
    }
    const removed = await store.deleteMemory(id);
    if (!removed) {
      sendApiError(res, 404, 'NOT_FOUND', '记忆不存在');
      return;
    }
    // 删除记忆后清理不再被引用的图片文件（失败只 warn，响应仍 200）。
    await sweepStoreAttachments({ attachments: ctx.attachments, store, logger: ctx.logger });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
}

function safeDecode(raw) {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    return '';
  }
}

/**
 * PATCH /api/memories/:id：{text?, level?, category?}。
 * text trim 后 1–200 字符；level ∈ core|trivia；category 需白名单且仅 core 生效（trivia 自动 other）；
 * 成功置 editedAt；非法 400、不存在 404。
 */
async function handleUpdateMemory(req, res, ctx, id) {
  let payload;
  try {
    payload = await readOptionalJson(req, { limit: 64 * 1024 });
  } catch (error) {
    if (!memoryRouteError(res, error)) sendApiError(res, 400, 'INVALID_REQUEST', '请求体不合法');
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendApiError(res, 400, 'INVALID_REQUEST', '请求体必须是 JSON 对象');
    return;
  }
  const hasText = payload.text !== undefined;
  const hasLevel = payload.level !== undefined;
  const hasCategory = payload.category !== undefined;
  if (!hasText && !hasLevel && !hasCategory) {
    sendApiError(res, 400, 'INVALID_REQUEST', '至少需要提供 text、level、category 之一');
    return;
  }
  const patch = {};
  if (hasText) {
    if (typeof payload.text !== 'string') {
      sendApiError(res, 400, 'INVALID_REQUEST', 'text 必须是字符串');
      return;
    }
    const text = payload.text.trim();
    const length = runeLength(text);
    if (length === 0) {
      sendApiError(res, 400, 'INVALID_REQUEST', 'text 不能为空');
      return;
    }
    // 编辑上限用 800（兼容带附件长记忆；新建仍 200 / 带附件 800）
    if (length > MAX_MEMORY_CHARS_WITH_ATTACHMENT) {
      sendApiError(res, 400, 'INVALID_REQUEST', `text 长度不能超过 ${MAX_MEMORY_CHARS_WITH_ATTACHMENT} 字符`);
      return;
    }
    patch.text = text;
  }
  if (hasLevel) {
    if (!MEMORY_LEVELS.includes(payload.level)) {
      sendApiError(res, 400, 'INVALID_REQUEST', `level 必须是 ${MEMORY_LEVELS.join('|')} 之一`);
      return;
    }
    patch.level = payload.level;
  }
  if (hasCategory) {
    if (typeof payload.category !== 'string' || !MEMORY_CORE_CATEGORIES.includes(payload.category)) {
      sendApiError(
        res,
        400,
        'INVALID_REQUEST',
        `category 必须是 ${MEMORY_CORE_CATEGORIES.join('|')} 之一`,
      );
      return;
    }
    // 仅 core 生效：只提供 category 而未提供 level 时，交给 store 按现有 level 归一化（trivia→other）。
    patch.category = payload.category;
  }
  const memory = await ctx.store.updateMemory(id, patch);
  if (!memory) {
    sendApiError(res, 404, 'NOT_FOUND', '记忆不存在');
    return;
  }
  sendJson(res, 200, { memory });
}

async function handleCreateMemory(req, res, ctx) {
  let payload;
  try {
    payload = await readOptionalJson(req, { limit: MEMORY_BODY_LIMIT });
  } catch (error) {
    if (!memoryRouteError(res, error)) sendApiError(res, 400, 'INVALID_REQUEST', '请求体不合法');
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendApiError(res, 400, 'INVALID_REQUEST', '请求体必须是 JSON 对象');
    return;
  }

  // 可选 1 个附件（图片或文本文件）；先校验（400），再解析（失败 422）。
  let attachments = [];
  try {
    attachments = normalizeAttachments(payload.attachments, { maxImages: 1, maxTexts: 1, maxTotal: 1 });
  } catch (error) {
    if (error instanceof AttachmentError) {
      sendApiError(res, error.status ?? 400, error.code ?? 'INVALID_REQUEST', error.message);
      return;
    }
    throw error;
  }
  const hasAttachment = attachments.length > 0;

  let parsed = null;
  if (hasAttachment) {
    const results = await parseAttachments({
      config: ctx.config,
      apiKey: ctx.config.apiKey,
      logger: ctx.logger,
      attachments,
      fetchImpl: ctx.fetchImpl,
    });
    parsed = results[0] ?? null;
    if (!parsed || parsed.error || !parsed.summary) {
      sendApiError(
        res,
        422,
        'ATTACHMENT_PARSE_FAILED',
        `附件解析失败：${parsed?.error ?? '没有可用的解析摘要'}`,
      );
      return;
    }
    // 解析成功的图片持久化到 DATA_DIR/attachments（失败只 warn，仍可存摘要）。
    parsed = await persistParsedImage(parsed, attachments[0], ctx.attachments, ctx.logger);
  }

  const { text, kind } = payload;
  // POST 可带 level/category（默认 core/other）；category 仅 core 生效。
  if (payload.level !== undefined && payload.level !== null && payload.level !== '') {
    if (!MEMORY_LEVELS.includes(payload.level)) {
      sendApiError(res, 400, 'INVALID_REQUEST', `level 必须是 ${MEMORY_LEVELS.join('|')} 之一`);
      return;
    }
  }
  if (payload.category !== undefined && payload.category !== null && payload.category !== '') {
    if (typeof payload.category !== 'string' || !MEMORY_CORE_CATEGORIES.includes(payload.category)) {
      sendApiError(
        res,
        400,
        'INVALID_REQUEST',
        `category 必须是 ${MEMORY_CORE_CATEGORIES.join('|')} 之一`,
      );
      return;
    }
  }
  const level = MEMORY_LEVELS.includes(payload.level) ? payload.level : 'core';
  const category = level === 'trivia'
    ? 'other'
    : (MEMORY_CORE_CATEGORIES.includes(payload.category) ? payload.category : 'other');
  const source = hasAttachment ? 'upload' : 'manual';
  let rawText = '';
  if (text !== undefined && text !== null) {
    if (typeof text !== 'string') {
      sendApiError(res, 400, 'INVALID_REQUEST', 'text 必须是字符串');
      return;
    }
    rawText = text.trim();
  }
  if (!hasAttachment && (text === undefined || text === null)) {
    sendApiError(res, 400, 'INVALID_REQUEST', 'text 必填，且必须是字符串');
    return;
  }

  // 有附件时 memory.text = 用户文字 +「（附件摘要：…）」；无文字则只存摘要。
  const summary = hasAttachment ? String(parsed.summary ?? '').trim() : '';
  const memoryText = hasAttachment
    ? rawText
      ? `${rawText}（附件摘要：${summary}）`
      : summary
    : rawText;

  const length = runeLength(memoryText);
  if (length === 0) {
    sendApiError(res, 400, 'INVALID_REQUEST', 'text 不能为空');
    return;
  }
  if (hasAttachment) {
    if (length > MAX_MEMORY_CHARS_WITH_ATTACHMENT) {
      sendApiError(
        res,
        400,
        'INVALID_REQUEST',
        `text 与附件摘要合计不能超过 ${MAX_MEMORY_CHARS_WITH_ATTACHMENT} 字符（当前 ${length}）`,
      );
      return;
    }
  } else if (length > MAX_MANUAL_MEMORY_CHARS) {
    sendApiError(res, 400, 'INVALID_REQUEST', `text 长度不能超过 ${MAX_MANUAL_MEMORY_CHARS} 字符`);
    return;
  }
  if (kind !== undefined && kind !== null && kind !== '' && !MEMORY_KINDS.includes(kind)) {
    sendApiError(res, 400, 'INVALID_REQUEST', `kind 必须是 ${MEMORY_KINDS.join('|')} 之一`);
    return;
  }
  const attachmentMeta = hasAttachment
    ? [persistedAttachmentMeta(parsed, attachments[0])]
    : [];
  const memory = await ctx.store.addMemory({
    text: memoryText,
    kind: MEMORY_KINDS.includes(kind) ? kind : 'fact',
    level,
    category,
    source,
    ...(attachmentMeta.length ? { attachments: attachmentMeta } : {}),
  });
  sendJson(res, 201, { memory });
}
