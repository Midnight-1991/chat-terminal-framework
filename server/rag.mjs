// 检索模块加载：rag/index.mjs 由 T2 提供；未就绪/加载失败时降级为空检索（不崩）。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {{
 *   repoRoot: string,
 *   docsDir?: string,
 *   docs?: object[]|null,
 *   retrieverOptions?: object,
 *   logger?: Console,
 * }} opts
 * @returns {Promise<{retrieve:Function, stats:Function}|null>}
 */
export async function loadRetriever({ repoRoot, docsDir, docs = null, retrieverOptions = {}, logger = console } = {}) {
  const entry = path.join(repoRoot, 'rag', 'index.mjs');
  if (!existsSync(entry)) {
    logger?.warn?.('[rag] rag/index.mjs 不存在，检索降级为空（T2 未就绪时属预期）');
    return null;
  }
  try {
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.createRetriever !== 'function') {
      throw new Error('rag/index.mjs 未导出 createRetriever()');
    }
    // v2：重排/查询扩展等参数透传（T2 的 createRetriever 可选支持）。
    // docs 为 server/corpus.mjs 单次加载的语料，注入后 retriever 不再重复读盘。
    const retriever = await module.createRetriever({
      docsDir,
      ...(Array.isArray(docs) ? { docs } : {}),
      ...(retrieverOptions && typeof retrieverOptions === 'object' ? retrieverOptions : {}),
    });
    if (!retriever || typeof retriever.retrieve !== 'function') {
      throw new Error('createRetriever() 返回值缺少 retrieve()');
    }
    return retriever;
  } catch (error) {
    logger?.warn?.(`[rag] 检索模块加载失败，降级为空检索：${error?.message ?? error}`);
    return null;
  }
}

/**
 * v2 可选重排器：rag/rerank.mjs（T18b 提供）→ createReranker({callModel, logger})。
 * 模块不存在或加载失败时返回 null（检索保持纯 BM25，不阻塞主链路）。
 */
export async function loadReranker({ repoRoot, callModel, logger = console } = {}) {
  const entry = path.join(repoRoot, 'rag', 'rerank.mjs');
  if (!existsSync(entry)) return null;
  try {
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.createReranker !== 'function') {
      throw new Error('rag/rerank.mjs 未导出 createReranker()');
    }
    const reranker = await module.createReranker({ callModel, logger });
    return reranker && typeof reranker.rerank === 'function' ? reranker : null;
  } catch (error) {
    logger?.warn?.(`[rag] 重排模块加载失败，跳过重排：${error?.message ?? error}`);
    return null;
  }
}

/** 安全读取检索统计（retriever 可能同步或异步返回）。 */
export async function readRetrieverStats(retriever) {
  if (!retriever || typeof retriever.stats !== 'function') return null;
  try {
    const stats = await retriever.stats();
    if (stats && Number.isFinite(stats.docs) && Number.isFinite(stats.chunks)) {
      return { docs: stats.docs, chunks: stats.chunks };
    }
  } catch {
    /* ignore */
  }
  return null;
}
