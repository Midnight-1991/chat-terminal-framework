// rag/index.mjs — 通用零依赖检索引擎（开源框架子集 / 通用化改写版）。
//
// 替换原项目中的领域检索实现（原文件分类为 open-core，但内含领域主题门控与词表钩子，
// 不满足「框架不含领域特化」）。本通用版保留：
//   - 同样的导出契约：createRetriever({ docsDir, docs, ... }) → { retrieve(), stats() }，
//     供 server/rag.mjs 动态加载、server/citations.mjs / rag/relevance.mjs 调用；
//   - 同样的返回字段：{ chunkId, docId, title, heading, anchor, para, sourceUrl, license, score, text }；
//   - 零依赖、启动时从内存语料建索引（不落盘索引文件）、中文 bigram + 英文词 BM25 打分；
//   - maxPerDoc 同文档上限与相对阈值所需的原始分数。
// 移除：领域主题门控（sexEdGate 等）、领域文档 id 白名单、查询扩展/规则钩子。
// 需要领域增强时由部署方在自己的 rag 扩展里实现（见 docs/EXTENDING.md）。

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** 默认语料目录（相对本文件上一级的 corpus/）。 */
export const DEFAULT_DOCS_DIR = resolve(HERE, '..', 'corpus');

/** 索引格式版本（索引不落盘；此常量用于对外契约与兼容判断）。 */
export const INDEX_FORMAT_VERSION = 2;

/** 默认检索参数。 */
export const DEFAULT_OPTIONS = Object.freeze({
  topK: 5,
  maxPerDoc: 2,
  k1: 1.2,
  b: 0.75,
});

/** 中文/英文通用分词：英文数字词 + 中文单字/二元组。 */
function tokenize(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const tokens = [];
  const re = /[a-z0-9]+|[\u3400-\u9fff]/gu;
  let match;
  let run = [];
  const flush = () => {
    if (run.length === 1) tokens.push(run[0]);
    else {
      for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run[index] + run[index + 1]);
    }
    run = [];
  };
  while ((match = re.exec(normalized)) !== null) {
    const piece = match[0];
    if (/[\u3400-\u9fff]/u.test(piece)) run.push(piece);
    else {
      flush();
      tokens.push(piece);
    }
  }
  flush();
  return tokens;
}

function termFrequencies(tokens) {
  const map = new Map();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

function textLength(tokens) {
  return tokens.length;
}

/** 把语料文档切成段落级 chunk（id 稳定：`${docId}#${anchor}#${para}`）。 */
function buildChunks(docs = []) {
  const chunks = [];
  for (const doc of docs) {
    const docId = String(doc?.id ?? '');
    if (!docId) continue;
    const sections = Array.isArray(doc.sections) ? doc.sections : [];
    for (const section of sections) {
      const anchor = String(section?.anchor ?? '');
      const heading = String(section?.heading ?? '');
      const paragraphs = Array.isArray(section?.paragraphs) ? section.paragraphs : [];
      for (const paragraph of paragraphs) {
        const text = String(paragraph?.text ?? '');
        if (!text.trim()) continue;
        const para = Number(paragraph?.para ?? 0);
        chunks.push({
          chunkId: `${docId}#${anchor}#${para}`,
          docId,
          title: String(doc.title ?? docId),
          heading,
          anchor,
          para,
          sourceUrl: String(doc.sourceUrl ?? ''),
          license: String(doc.license ?? ''),
          text,
        });
      }
    }
  }
  return chunks;
}

async function loadDocsFromDir(docsDir) {
  const dir = docsDir || DEFAULT_DOCS_DIR;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const docs = [];
  for (const name of names.filter((item) => item.endsWith('.json') && !item.startsWith('_')).sort()) {
    try {
      docs.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
    } catch {
      /* 坏文件跳过：与 server/corpus.mjs 的容错口径一致 */
    }
  }
  return docs;
}

/**
 * 内存检索器：启动时建倒排/词频，retrieve() 做 BM25 + 同文档上限。
 * @param {{docsDir?: string, docs?: object[]|null, maxPerDoc?: number, logger?: Console}} [opts]
 * @returns {Promise<{retrieve: Function, stats: Function, buildSearchIndex: Function}>}
 */
export async function createRetriever(opts = {}) {
  const docs = Array.isArray(opts.docs) ? opts.docs : await loadDocsFromDir(opts.docsDir);
  const chunks = buildChunks(docs);
  const postings = new Map(); // token -> Map(chunkIndex, tf)
  const lengths = new Array(chunks.length).fill(0);
  chunks.forEach((chunk, index) => {
    const tokens = tokenize(`${chunk.title} ${chunk.heading} ${chunk.text}`);
    const tf = termFrequencies(tokens);
    lengths[index] = textLength(tokens);
    for (const [token, count] of tf) {
      if (!postings.has(token)) postings.set(token, new Map());
      postings.get(token).set(index, count);
    }
  });
  const avgLength = lengths.length > 0 ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0;
  const maxPerDoc = Number.isInteger(opts.maxPerDoc) ? opts.maxPerDoc : DEFAULT_OPTIONS.maxPerDoc;

  /**
   * @param {string} query
   * @param {number} [topK]
   * @returns {Promise<Array<object>>}
   */
  async function retrieve(query, topK = DEFAULT_OPTIONS.topK, retrieveOpts = {}) {
    const limit = Number.isInteger(topK) && topK > 0 ? topK : DEFAULT_OPTIONS.topK;
    const perDoc = Number.isInteger(retrieveOpts?.maxPerDoc) ? retrieveOpts.maxPerDoc : maxPerDoc;
    const total = chunks.length;
    if (total === 0) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const unique = [...new Set(queryTokens)];
    const scores = new Array(total).fill(0);
    const { k1, b } = DEFAULT_OPTIONS;
    for (const token of unique) {
      const posting = postings.get(token);
      if (!posting) continue;
      const df = posting.size;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      for (const [index, tf] of posting) {
        const length = lengths[index] || 1;
        const norm = 1 - b + b * (length / (avgLength || 1));
        scores[index] += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
      }
    }
    const ranked = scores
      .map((score, index) => ({ score, index }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const picked = [];
    const perDocCount = new Map();
    for (const item of ranked) {
      const chunk = chunks[item.index];
      const count = perDocCount.get(chunk.docId) ?? 0;
      if (count >= perDoc) continue;
      perDocCount.set(chunk.docId, count + 1);
      picked.push({ ...chunk, score: Number(item.score.toFixed(6)) });
      if (picked.length >= limit) break;
    }
    return picked;
  }

  function stats() {
    const docs = new Set(chunks.map((chunk) => chunk.docId));
    return { docs: docs.size, chunks: chunks.length, terms: postings.size };
  }

  function buildSearchIndex() {
    return { version: INDEX_FORMAT_VERSION, docs: new Set(chunks.map((chunk) => chunk.docId)).size, chunks: chunks.length };
  }

  return { retrieve, stats, buildSearchIndex };
}
