// 检索 → 引用列表（c1..cN 连续编号），供 meta.citations 与证据块共用。
//
// -B：新增可选的相关度层（rag/relevance.mjs）。生产路径（真实 rag
// retriever）走「主题门控 + 相对阈值 + 同 doc 上限 + 冗余时 MMR」，与 检索评测脚本 heuristic
// 档共用同一入口；注入式 fake retriever（单元测试）保持旧的直接检索行为，避免影响既有断言。
import { retrieveRelevant } from '../rag/relevance.mjs';

export const DEFAULT_TOP_K = 5;

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {{retriever?: {retrieve:Function}|null, message: string, topK?: number,
 *   retrieveOpts?: object, relevance?: boolean|object|null, logger?: Console}} opts
 * @returns {Promise<Array<{c:number,chunkId:string,docId:string,title:string,heading:string,
 *   anchor:string,para:number,sourceUrl:string,license:string,score:number,text:string}>>}
 */
export async function retrieveCitations({
  retriever,
  message,
  topK = DEFAULT_TOP_K,
  retrieveOpts = {},
  relevance = null,
  logger = console,
} = {}) {
  if (!retriever || typeof retriever.retrieve !== 'function') return [];
  let raw;
  try {
    if (relevance !== null && relevance !== false) {
      // -B：相关度层（门控 + 阈值 + 同 doc + 冗余时 MMR），与 eval heuristic 同一入口。
      raw = await retrieveRelevant({
        retriever,
        query: message,
        topK,
        retrieveOpts,
        options: relevance === true ? {} : relevance
      });
    } else {
      // v2：重排/查询扩展参数以第三个参数传给 rag（v1 retriever 会忽略多余参数）。
      raw = await retriever.retrieve(message, topK, retrieveOpts);
    }
  } catch (error) {
    logger?.warn?.(`[rag] 检索失败，本轮按无引用处理：${error?.message ?? error}`);
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, topK).map((item, index) => ({
    c: index + 1,
    chunkId: String(item?.chunkId ?? ''),
    docId: String(item?.docId ?? ''),
    title: String(item?.title ?? ''),
    heading: String(item?.heading ?? ''),
    anchor: String(item?.anchor ?? ''),
    para: toFiniteNumber(item?.para),
    sourceUrl: String(item?.sourceUrl ?? ''),
    license: String(item?.license ?? ''),
    score: toFiniteNumber(item?.score),
    text: String(item?.text ?? ''),
  }));
}

/** 去掉内部检索正文，得到契约规定的 meta.citations 结构。 */
export function publicCitations(citations) {
  return citations.map(({ text, ...rest }) => rest);
}
