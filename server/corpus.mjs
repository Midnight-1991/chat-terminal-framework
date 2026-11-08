// server/corpus.mjs — 语料单次加载：corpus/*.json 只读一次，共享给 docStore / library / retriever。
//
// 背景（plan.md ）：改造前 docStore、library（固定组）、retriever 各自读盘 + JSON.parse 一遍，
// 同一批语料在内存里被解析三次（~26MB 对象 + 重复解析耗时）。本模块把「读目录 + 解析」收敛为一次，
// 由 server/app.mjs 注入给三者；三者的对外行为/契约不变（DATA-CONTRACT 1 语料格式原样）。
//
// 契约：
//   loadCorpus({ docsDir, logger? }) -> { docsDir, docs, byId, files }
//   - docs:  按 corpus 文件名排序解析出的 doc 对象数组（跳过 `_` 开头的元数据文件）
//   - byId:  docId -> doc
//   - files: [{ name, doc }]（同 docs 顺序；library 固定组按文件名前缀筛选时复用）
// 容错：目录不可读 / 单文件坏 JSON / 缺 id 都 warn 并跳过（返回空/部分语料，绝不抛错），
//       与改造前 docStore 的降级行为一致；retriever 由注入路径获得同一批有效 doc。

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const CORPUS_META_PREFIX = '_';

/**
 * @param {{docsDir: string, logger?: Console}} options
 * @returns {Promise<{docsDir: string, docs: object[], byId: Map<string, object>, files: Array<{name: string, doc: object}>}>}
 */
export async function loadCorpus({ docsDir, logger = console } = {}) {
  const docs = [];
  const files = [];
  let names;
  try {
    names = (await readdir(docsDir))
      .filter((name) => name.endsWith('.json') && !name.startsWith(CORPUS_META_PREFIX))
      .sort();
  } catch (error) {
    logger?.warn?.(`[docs] 语料目录不可读（${docsDir}）：${error?.message ?? error}`);
    return { docsDir, docs, byId: new Map(), files };
  }

  for (const name of names) {
    let raw;
    try {
      raw = JSON.parse(await readFile(path.join(docsDir, name), 'utf8'));
    } catch (error) {
      logger?.warn?.(`[docs] 跳过无法解析的语料 ${name}：${error?.message ?? error}`);
      continue;
    }
    if (!raw || typeof raw.id !== 'string' || !raw.id) {
      logger?.warn?.(`[docs] 跳过缺少 id 的语料：${name}`);
      continue;
    }
    docs.push(raw);
    files.push({ name, doc: raw });
  }

  return { docsDir, docs, byId: new Map(docs.map((doc) => [doc.id, doc])), files };
}
