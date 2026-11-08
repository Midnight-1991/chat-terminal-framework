// rag/relevance.mjs — -B 检索相关度后处理层，零依赖。
//
// 背景（详见 reviews/retrieval-relevance-research.md）：纯 BM25 词面重叠会让通用教育长文档
// （ITGSE 等）在「写地理作业/教学模式」类查询里挤占 top5。调研结论：唯一能直接修复的是
// 「健康教育子库主题门控」（已落在 rag/index.mjs：retrieve(..., { sexEdGate: true })），
// 本层负责门控之后的确定性后处理：
//   1. 相对相关度下限：候选分 < top1 × relativeFloor（默认 0.45）丢弃，但至少保留 keepAtLeast 条；
//      无合格候选时允许返回空（不为了凑数放宽门控/阈值）。
//   2. 同文档上限：maxPerDoc（默认 2，与 rag/index.mjs 的 maxPerDoc 一致；合并候选后再次兜底）。
//   3. MMR 多样性（λ≈0.7）：零依赖中文 bigram Jaccard 相似度做贪心 MMR，只在候选集内
//      存在明显冗余（相似度 ≥ mmrRedundancyThreshold，默认 0.72）时才启用，避免影响常规
//      查询的排序稳定性；选完按原始 BM25 分数重排，保证与既有评测口径一致。
//
// 该层不改 createRetriever 默认行为（default sexEdGate=false），由 server/citations.mjs
// 与 检索评测脚本 的 heuristic 档共同调用，保证「线上路径 == 评测路径」。

import { cjkBigrams } from './tokenize.mjs';

/** 后处理默认参数（可通过 retrieveRelevant({ options }) 覆盖）。 */
export const RELEVANCE_DEFAULTS = Object.freeze({
  // 主题门控：默认开启（仅在调用方支持 sexEdGate 的 retriever 上生效；fake retriever 会忽略多余参数）
  sexEdGate: true,
  // 相对相关度下限：< top1 × 0.45 的候选丢弃
  relativeFloor: 0.45,
  // 至少保留条数（0/1 条的候选集保持原样；空候选允许空引用）
  keepAtLeast: 2,
  // 同一文档最多条数（检索器侧默认也是 2，这里对合并后的候选再兜底一次）
  maxPerDoc: 2,
  // MMR 参数
  mmrLambda: 0.7,
  mmrRedundancyThreshold: 0.72,
  mmrPoolSize: 24
});

function resolveOptions(options) {
  if (!options || typeof options !== 'object') return { ...RELEVANCE_DEFAULTS };
  return { ...RELEVANCE_DEFAULTS, ...options };
}

/**
 * 中文 bigram Jaccard 相似度（0–1）。
 * 纯文本函数、无状态，便于单测与 MMR 复用。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function textSimilarity(a, b) {
  const setA = new Set(cjkBigrams(String(a ?? '')));
  const setB = new Set(cjkBigrams(String(b ?? '')));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const bigram of setA) {
    if (setB.has(bigram)) intersection += 1;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * 候选集内部是否存在明显冗余（任意两条正文相似度 ≥ threshold）。
 * @param {Array<object>} hits
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function hasRedundancy(hits, threshold = RELEVANCE_DEFAULTS.mmrRedundancyThreshold) {
  if (!Array.isArray(hits) || hits.length < 2) return false;
  for (let i = 0; i < hits.length; i += 1) {
    for (let j = i + 1; j < hits.length; j += 1) {
      if (textSimilarity(hits[i]?.text, hits[j]?.text) >= threshold) return true;
    }
  }
  return false;
}

/**
 * 相对相关度下限：丢弃分数 < top1 × relativeFloor 的候选，但至少保留 keepAtLeast 条。
 * @param {Array<object>} hits 已按分数降序
 * @param {{relativeFloor?:number, keepAtLeast?:number}} [options]
 * @returns {Array<object>}
 */
export function applyRelativeFloor(hits, options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0) return [];
  const { relativeFloor, keepAtLeast } = resolveOptions(options);
  const topScore = Number(list[0]?.score) || 0;
  const threshold = topScore * relativeFloor;
  const kept = list.filter((hit) => (Number(hit?.score) || 0) >= threshold);
  const minimum = Math.max(1, Math.min(Math.floor(keepAtLeast), list.length));
  return kept.length >= minimum ? kept : list.slice(0, minimum);
}

/**
 * 同文档条数上限（保持原顺序）。
 * @param {Array<object>} hits
 * @param {number} [maxPerDoc]
 * @returns {Array<object>}
 */
export function capPerDoc(hits, maxPerDoc = RELEVANCE_DEFAULTS.maxPerDoc) {
  const limit = Math.max(1, Math.floor(maxPerDoc));
  const counts = new Map();
  const out = [];
  for (const hit of Array.isArray(hits) ? hits : []) {
    const docId = String(hit?.docId ?? '');
    const used = counts.get(docId) ?? 0;
    if (used >= limit) continue;
    counts.set(docId, used + 1);
    out.push(hit);
  }
  return out;
}

/**
 * 贪心 MMR（maximal marginal relevance）：
 *   next = argmax(λ × rel(d) − (1−λ) × max_{s∈selected} sim(d, s))
 * @param {Array<object>} hits 候选（需含 score 与 text）
 * @param {{lambda?:number, limit?:number, similarity?:Function}} [options]
 * @returns {Array<object>} 按 MMR 选择顺序返回
 */
export function mmrSelect(hits, options = {}) {
  const list = Array.isArray(hits) ? hits.filter(Boolean) : [];
  const {
    lambda = RELEVANCE_DEFAULTS.mmrLambda,
    limit = list.length,
    similarity = textSimilarity
  } = options;
  const target = Math.max(0, Math.min(Math.floor(limit), list.length));
  const selected = [];
  const remaining = [...list];
  while (selected.length < target && remaining.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      let maxSim = 0;
      for (const chosen of selected) {
        const sim = similarity(remaining[index]?.text, chosen?.text);
        if (sim > maxSim) maxSim = sim;
      }
      const value = lambda * (Number(remaining[index]?.score) || 0) - (1 - lambda) * maxSim;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

/**
 * 对已排序候选做后处理：相对阈值 → 同 doc 上限；有明显冗余时再用更大候选池做 MMR。
 * @param {Array<object>} canonical 检索器返回的 topK 候选（已按相关度排序）
 * @param {{poolHits?: Array<object>, options?: object, limit?: number}} [input]
 * @returns {{hits: Array<object>, mmrApplied: boolean}}
 */
export function applyRelevance(canonical, { poolHits = null, options = {}, limit = 5 } = {}) {
  const opts = resolveOptions(options);
  const target = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  const hits = capPerDoc(applyRelativeFloor(canonical, opts), opts.maxPerDoc);
  if (!hasRedundancy(hits, opts.mmrRedundancyThreshold)) {
    return { hits: hits.slice(0, target), mmrApplied: false };
  }
  const pool = Array.isArray(poolHits) ? poolHits : [];
  const seen = new Set(hits.map((hit) => hit?.chunkId));
  const extras = pool
    .filter((hit) => hit && !seen.has(hit.chunkId))
    .slice()
    .sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
  const merged = capPerDoc(applyRelativeFloor([...hits, ...extras], opts), opts.maxPerDoc);
  // MMR 只挑 target 条（不是全部候选），否则退化成「按分数重排」、失去多样性意义。
  const selected = mmrSelect(merged, { lambda: opts.mmrLambda, limit: target });
  // MMR 选完按原始 BM25 分数重排，输出顺序与既有评测口径一致。
  selected.sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
  return { hits: selected, mmrApplied: true };
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 生产/评测共用的相关度检索入口：
 *   canonical 检索（保留伦理边界插入）→ 阈值/同 doc 上限 → 有冗余才补一次大候选池 + MMR。
 *
 * retriever 需支持 retrieve(query, topK, opts)；对不支持 sexEdGate 的注入式 fake retriever
 * 门控会被忽略（保持既有测试行为），但阈值/同 doc/MMR 仍按候选数生效。
 *
 * @param {object} input
 * @param {{retrieve:Function}} input.retriever
 * @param {string} input.query
 * @param {number} [input.topK]
 * @param {object} [input.retrieveOpts] 传给 retriever 的第三个参数（expand/rerank…）
 * @param {object} [input.options] 覆盖 RELEVANCE_DEFAULTS
 * @returns {Promise<Array<object>>}
 */
export async function retrieveRelevant({
  retriever,
  query,
  topK = 5,
  retrieveOpts = {},
  options = {}
} = {}) {
  if (!retriever || typeof retriever.retrieve !== 'function') return [];
  const opts = resolveOptions(options);
  const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5;
  const baseOpts = {
    ...(retrieveOpts && typeof retrieveOpts === 'object' ? retrieveOpts : {}),
    sexEdGate: opts.sexEdGate !== false
  };
  const canonical = toArray(await retriever.retrieve(String(query ?? ''), limit, baseOpts));
  if (canonical.length === 0) return [];
  const first = applyRelevance(canonical, { options: opts, limit });
  if (!first.mmrApplied) return first.hits.slice(0, limit);
  // 只有检测到明显冗余时才补一次大候选池（常规查询不增加检索成本）。
  let poolHits = [];
  try {
    poolHits = toArray(
      await retriever.retrieve(String(query ?? ''), Math.max(opts.mmrPoolSize, limit), {
        ...baseOpts,
        rerank: false
      })
    );
  } catch {
    poolHits = [];
  }
  const { hits } = applyRelevance(canonical, { poolHits, options: opts, limit });
  return hits.slice(0, limit);
}
