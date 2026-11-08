// rag/rerank.mjs — 可选 LLM 重排（T18b）。零依赖、不自行联网：callModel 由 server 注入。
//
// 用法（server 侧，T16b 接线）：
//   import { createReranker } from './rerank.mjs';
//   const reranker = createReranker({ callModel: <非流式上游调用> });
//   const top = await reranker.rerank(query, candidates, 5);
//
// 约定（docs/DATA-CONTRACT.md 3）：
//   - 输入 12–24 条候选（本地混合检索的 top 结果）。
//   - 让模型按「这段文字能否真的支持一次咨询回答」排序，只输出 JSON 数组。
//   - 解析容错：容忍 ```json 围栏、前后说明文字、对象数组 [{index:n}]、1-based 编号。
//   - 失败 / 超时（默认 8s）/ 无 callModel：原样返回前 topK 条并 warn，绝不让主流程失败。

export const DEFAULT_TIMEOUT_MS = 8000;
export const MIN_CANDIDATES = 12;
export const MAX_CANDIDATES = 24;

const SYSTEM_STYLE = [
  '你是一个支持问答系统的检索结果重排器。',
  '用户会为一段处境提问，系统会给出若干候选原文段落。',
  '你的任务是判断：哪一段文字最能真正支持一次温和、具体、不诊断、不说教的中文回答。'
].join('');

/**
 * 构造重排 prompt（纯函数，便于测试）。
 * @param {string} query
 * @param {Array<{docId?:string,title?:string,heading?:string,text?:string}>} candidates
 * @returns {string}
 */
export function buildRerankPrompt(query, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const lines = [];
  lines.push(SYSTEM_STYLE);
  lines.push('');
  lines.push('排序标准（从高到低）：');
  lines.push('1. 直接回应用户当前的处境与情绪，能作为回答依据；');
  lines.push('2. 解释机制、给出可操作方法，但不过度泛化；');
  lines.push('3. 主题相关但只是泛泛而谈；');
  lines.push('4. 无关、重复、纯目录/致谢/版权等噪声。');
  lines.push('');
  lines.push('用户问题：');
  lines.push(String(query ?? '').slice(0, 400));
  lines.push('');
  lines.push('候选段落：');
  list.slice(0, MAX_CANDIDATES).forEach((candidate, index) => {
    const title = String(candidate?.title ?? '').slice(0, 60);
    const heading = String(candidate?.heading ?? '').slice(0, 60);
    const text = String(candidate?.text ?? '').replace(/\s+/g, ' ').slice(0, 220);
    lines.push(`[${index}] 书名/标题：${title}｜小节：${heading}｜正文：${text}`);
  });
  lines.push('');
  lines.push(`请只输出一个 JSON 数组，包含按相关性从高到低排列的候选编号（0 到 ${Math.max(0, Math.min(list.length, MAX_CANDIDATES) - 1)}），`);
  lines.push('例如：[3,0,7,1]。不要输出解释、不要输出 markdown 代码块、不要输出其它文字。');
  return lines.join('\n');
}

/**
 * 从模型输出中解析重排顺序（0-based 索引数组）。
 * 容忍：```json 围栏、数组前后有说明文字、[{index:2},{i:0}]、1-based 编号。
 * @param {string} raw
 * @param {number} count 候选数量
 * @returns {number[]|null} 解析成功返回去重后的合法索引数组；失败返回 null
 */
export function parseRerankOutput(raw, count) {
  const size = Number.isInteger(count) && count > 0 ? count : 0;
  const text = String(raw ?? '').trim();
  if (!text || size === 0) return null;

  const candidates = [];
  // 优先找纯数字数组；其次找对象数组（含 index / i / id 字段）
  const arrayMatches = text.match(/\[[^\[\]]*\]/g) ?? [];
  for (const snippet of arrayMatches) {
    try {
      const parsed = JSON.parse(snippet);
      if (Array.isArray(parsed) && parsed.length > 0) candidates.push(parsed);
    } catch {
      /* 尝试下一个片段 */
    }
  }
  if (candidates.length === 0) {
    // 兜底：把全文里的数字按出现顺序抽出来（容忍不是严格 JSON 的情况）
    const numbers = text.match(/\d+/g);
    if (numbers) candidates.push(numbers.map((n) => Number(n)));
  }

  for (const parsed of candidates) {
    const rawIndices = parsed
      .map((item) => {
        if (typeof item === 'number') return item;
        if (typeof item === 'string') return Number.parseInt(item, 10);
        if (item && typeof item === 'object') {
          const value = item.index ?? item.i ?? item.id ?? item.rank;
          return Number(value);
        }
        return Number.NaN;
      })
      .filter((value) => Number.isInteger(value));

    if (rawIndices.length === 0) continue;
    const looksOneBased = rawIndices.every((value) => value >= 1 && value <= size) && !rawIndices.includes(0);
    const normalized = [];
    const seen = new Set();
    for (const value of rawIndices) {
      const index = looksOneBased ? value - 1 : value;
      if (index < 0 || index >= size || seen.has(index)) continue;
      seen.add(index);
      normalized.push(index);
    }
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function raceWithTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`rerank timeout after ${timeoutMs}ms`)), timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 创建重排器（默认导出也指向它）。
 * @param {object} opts
 * @param {(prompt: string) => Promise<string>} opts.callModel 上游非流式调用（由 server 注入）
 * @param {number} [opts.timeoutMs=8000]
 * @param {Console} [opts.logger=console]
 */
export function createReranker({ callModel, timeoutMs = DEFAULT_TIMEOUT_MS, logger = console } = {}) {
  const warn = (message) => {
    try {
      logger?.warn?.(`[rerank] ${message}`);
    } catch {
      /* logger 失败不影响主流程 */
    }
  };

  /**
   * @param {string} query
   * @param {Array<object>} candidates 本地检索结果（12–24 条）
   * @param {number} [topK=5]
   * @returns {Promise<Array<object>>} 重排后的 topK；任何异常都回退为原始顺序
   */
  async function rerank(query, candidates, topK = 5) {
    const list = Array.isArray(candidates) ? candidates.slice(0, MAX_CANDIDATES) : [];
    const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 5;
    if (list.length <= 1 || typeof callModel !== 'function') {
      if (typeof callModel !== 'function') warn('未注入 callModel，跳过重排，返回原序');
      return list.slice(0, limit);
    }
    if (list.length < MIN_CANDIDATES) {
      // 候选太少时重排收益有限，但契约允许 12–24；这里仍继续，只记录调试信息
      warn(`候选数 ${list.length} 少于推荐值 ${MIN_CANDIDATES}，仍执行重排`);
    }
    try {
      const prompt = buildRerankPrompt(query, list);
      const raw = await raceWithTimeout(Promise.resolve().then(() => callModel(prompt)), timeoutMs);
      const order = parseRerankOutput(raw, list.length);
      if (!order || order.length === 0) {
        warn('模型输出无法解析为排序数组，回退原序');
        return list.slice(0, limit);
      }
      const ranked = [];
      const used = new Set();
      for (const index of order) {
        if (used.has(index)) continue;
        used.add(index);
        ranked.push(list[index]);
        if (ranked.length >= limit) break;
      }
      // 模型只给了一部分编号时，用原序补齐
      for (let index = 0; index < list.length && ranked.length < limit; index += 1) {
        if (used.has(index)) continue;
        used.add(index);
        ranked.push(list[index]);
      }
      return ranked.slice(0, limit);
    } catch (error) {
      warn(`重排失败，回退原序：${error?.message ?? error}`);
      return list.slice(0, limit);
    }
  }

  return { rerank };
}

export default createReranker;
