// 语料文档存储：启动时读取 corpus/*.json（DATA-CONTRACT 1），供 GET /api/docs/:docId。
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

function normalizeParagraph(paragraph) {
  const para = Number(paragraph?.para);
  const text = typeof paragraph?.text === 'string' ? paragraph.text : '';
  if (!text) return null;
  return { para: Number.isFinite(para) ? para : 0, text };
}

function normalizeSection(section) {
  return {
    anchor: String(section?.anchor ?? ''),
    heading: String(section?.heading ?? ''),
    paragraphs: Array.isArray(section?.paragraphs)
      ? section.paragraphs.map(normalizeParagraph).filter(Boolean)
      : [],
  };
}

/** 只暴露契约字段，避免把语料内部字段泄漏给前端。 */
function normalizeDoc(raw) {
  return {
    id: String(raw.id),
    title: String(raw.title ?? ''),
    author: String(raw.author ?? ''),
    year: String(raw.year ?? ''),
    sourceUrl: String(raw.sourceUrl ?? ''),
    license: String(raw.license ?? ''),
    licenseUrl: String(raw.licenseUrl ?? ''),
    sections: Array.isArray(raw.sections) ? raw.sections.map(normalizeSection) : [],
  };
}

/**
 * 文档存储（GET /api/docs/:docId 的唯一真源）。
 *
 * 可注入已加载的语料 `docs`（server/corpus.mjs 单次读盘），此时不再重复读盘；
 * 不注入时保持改造前行为（自行读目录 + JSON 解析，供测试 / 独立调用兼容）。
 *
 * @param {{docsDir: string, logger?: Console, docs?: object[]|null}} [options]
 * @returns {Promise<{get:(docId:string)=>object|null, ids:()=>string[], stats:()=>({docs:number,chunks:number})}>}
 */
export async function createDocStore({ docsDir, logger = console, docs: injectedDocs = null } = {}) {
  const docs = new Map();
  let fileCount = 0;
  if (Array.isArray(injectedDocs)) {
    // 注入路径：语料已由 loadCorpus() 读取并校验过 id，这里只做契约字段归一化，避免二次读盘。
    for (const raw of injectedDocs) {
      fileCount += 1;
      if (raw && typeof raw.id === 'string' && raw.id) docs.set(raw.id, normalizeDoc(raw));
      else logger?.warn?.('[docs] 跳过缺少 id 的语料（注入语料）');
    }
  } else {
    try {
      const entries = await readdir(docsDir, { withFileTypes: true });
      for (const entry of entries) {
        // 下划线开头的是元数据文件（如 _manifest.json），不是语料 doc。
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('_')) continue;
        fileCount += 1;
        try {
          const raw = JSON.parse(await readFile(path.join(docsDir, entry.name), 'utf8'));
          if (raw && typeof raw.id === 'string' && raw.id) docs.set(raw.id, normalizeDoc(raw));
          else logger?.warn?.(`[docs] 跳过缺少 id 的语料：${entry.name}`);
        } catch (error) {
          logger?.warn?.(`[docs] 跳过无法解析的语料 ${entry.name}：${error.message}`);
        }
      }
    } catch (error) {
      logger?.warn?.(`[docs] 语料目录不可读（${docsDir}）：${error.message}`);
    }
  }

  const chunkCount = () => {
    let count = 0;
    for (const doc of docs.values()) {
      for (const section of doc.sections) count += section.paragraphs.length;
    }
    return count;
  };

  return {
    get(docId) {
      return docs.get(docId) ?? null;
    },
    ids() {
      return [...docs.keys()];
    },
    has(docId) {
      return docs.has(docId);
    },
    stats() {
      return { docs: docs.size, chunks: chunkCount(), fileCount };
    },
  };
}
