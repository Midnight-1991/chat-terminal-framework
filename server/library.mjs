// server/library.mjs — 文档库/书架聚合（开源框架子集 / 通用化改写版）。
// 与原实现的差异：保留通用书库能力（_manifest/_themes/_worksheets 聚合、分类展示、回退口径），
// 领域语料与分类数据由部署方自己的 corpus 元数据驱动，不随框架分发。
// 文档库入口数据：GET /api/library（契约：docs/API-CONTRACT.md 7）。
// 启动时读取 corpus/_taxonomy.json（两级分类：学科方向 → 主题）、
// corpus/_themes.json（旧主题分组，仅作 taxonomy 不可用时的回退路径）、
// corpus/_manifest.json（书籍元数据）、corpus/_worksheets.json（模板卡清单），并从 corpus
// 目录补齐公版/政府/国际组织/开放获取论文/行业规范单篇，构建一次后缓存（对象 + JSON 字符串）。
// 语料热更新后重启服务即刷新。分类数据校验失败一律回退旧 17 组（不 500）。
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const THEMES_FILE = '_themes.json';
export const MANIFEST_FILE = '_manifest.json';
export const WORKSHEETS_FILE = '_worksheets.json';
/** 两级分类数据文件（学科方向 → 主题，v1）。 */
export const TAXONOMY_FILE = '_taxonomy.json';

/** 主题分组不可用时附加在响应上的 warning 值（契约 7.2，起仅作常量兼容保留）。 */
export const THEMES_UNAVAILABLE = 'themes_unavailable';
/** 分类数据不可用（缺失/损坏/校验失败/覆盖不完整）时附加在响应上的 warning 值。 */
export const TAXONOMY_UNAVAILABLE = 'taxonomy_unavailable';

/** `_themes.json` 主题 id 规则（DATA-CONTRACT 14：唯一、kebab-case）。 */
const THEME_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 旧主题分组的显示名 / 说明长度上限（DATA-CONTRACT 14：desc ≤ 40 字）。 */
const MAX_THEME_NAME_CHARS = 20;
const MAX_THEME_DESC_CHARS = 40;
/** 话题（topic）显示名 / 说明的长度上限（DATA-CONTRACT 23：name ≤ 12 字、desc ≤ 40 字）。 */
const MAX_TOPIC_NAME_CHARS = 12;
const MAX_TOPIC_DESC_CHARS = 40;
/** 学科（discipline）显示名 / 说明的长度上限（DATA-CONTRACT 23：name ≤ 20 字、desc ≤ 60 字）。 */
const MAX_DISCIPLINE_NAME_CHARS = 20;
const MAX_DISCIPLINE_DESC_CHARS = 60;
/** 每个学科的主题数范围（每学科 2–6 个主题）。 */
const MIN_TOPICS_PER_DISCIPLINE = 2;
const MAX_TOPICS_PER_DISCIPLINE = 6;
/** `corpus/_taxonomy.json` 的 schema 版本。 */
const TAXONOMY_VERSION = 1;
/** 学科 / 主题 id 规则（与主题 id 相同：kebab-case）。 */
const TAXONOMY_ID_RE = THEME_ID_RE;

export const PUBLIC_DOMAIN_LICENSE = 'Public Domain';
export const GOVERNMENT_LICENSE = '政府公开';
/** 第 6 类许可：国际组织材料（通用示例），license 带版本与条款括注。 */
export const INTERNATIONAL_LICENSE_PREFIX = '政府间组织公开材料（';
/** 第 5 类许可：开放获取论文（CC BY / CC0 / 公有领域）。 */
export const PAPERS_LICENSE_PREFIX = '开放获取论文（';
/** 语料 v6 第 7 类许可：行业公开规范（公开发布），如中国主题学会规范守则。 */
export const SPECS_LICENSE_PREFIX = '行业公开规范（';

/** 同源多文档聚合项的 aggregate 标记（契约 7.3）。 */
export const SOURCE_AGGREGATE = 'source';

/**
 * 固定追加的六个集合组（契约 7.1 顺序：公版 → 政府 → 国际组织 → 开放获取论文 → 行业规范 → 模板卡）。
 * 前五组为从 corpus 目录读取的单篇 doc（按文件名前缀 + license 类别双重匹配，见下方
 * FIXED_DOC_GROUP_RULES），模板卡是一组集合。
 */
export const FIXED_GROUP_META = Object.freeze({
  'public-domain': Object.freeze({
    id: 'public-domain',
    name: '公版经典',
    desc: '中国古典文本（公版）',
  }),
  government: Object.freeze({
    id: 'government',
    name: '政府公开',
    desc: '公开信息与通用指引',
  }),
  international: Object.freeze({
    id: 'international',
    name: '国际组织公开材料',
    desc: '外部公开指南与建议',
  }),
  papers: Object.freeze({
    id: 'papers',
    name: '开放获取论文',
    desc: '同行评审 OA 论文（CC BY）',
  }),
  specs: Object.freeze({
    id: 'specs',
    name: '行业规范',
    desc: '行业学会公开守则与规范（非医疗建议）',
  }),
  worksheets: Object.freeze({
    id: 'worksheets',
    name: '模板卡',
    desc: '外部示例站点的公开模板（演示用）',
  }),
});

/** 固定组顺序（契约 7.1）：themes 之后按此顺序追加。 */
export const FIXED_GROUP_ORDER = Object.freeze([
  'public-domain',
  'government',
  'international',
  'papers',
  'specs',
  'worksheets',
]);

/**
 * 固定 doc 组的归类规则（契约 7.2：corpus 文件名前缀 + license 类别双重匹配）。
 * 行业规范语料统一用 `spec-` 前缀（DATA-CONTRACT 17），再按 license 归入三类：
 * `政府公开` → government、`政府间组织公开材料（` → international、`行业公开规范（` → specs。
 */
const FIXED_DOC_GROUP_RULES = Object.freeze({
  'public-domain': Object.freeze({ filePrefixes: Object.freeze(['pd-']), license: PUBLIC_DOMAIN_LICENSE }),
  government: Object.freeze({ filePrefixes: Object.freeze(['gov-', 'spec-']), license: GOVERNMENT_LICENSE }),
  international: Object.freeze({
    filePrefixes: Object.freeze(['igo-', 'spec-']),
    licensePrefix: INTERNATIONAL_LICENSE_PREFIX,
  }),
  papers: Object.freeze({ filePrefixes: Object.freeze(['paper-']), licensePrefix: PAPERS_LICENSE_PREFIX }),
  specs: Object.freeze({ filePrefixes: Object.freeze(['spec-']), licensePrefix: SPECS_LICENSE_PREFIX }),
});

/** 固定 doc 组顺序（契约 7.1：themes 之后按此顺序；模板卡集合在最后，不在本表）。 */
const FIXED_DOC_GROUP_IDS = Object.freeze(Object.keys(FIXED_DOC_GROUP_RULES));

/** 固定 doc 组可能用到的全部 corpus 文件名前缀（用于跳过书籍/模板卡等非固定组文件）。 */
const FIXED_DOC_FILE_PREFIXES = Object.freeze([
  ...new Set(FIXED_DOC_GROUP_IDS.flatMap((groupId) => FIXED_DOC_GROUP_RULES[groupId].filePrefixes)),
]);

/** _worksheets.json 里的 site 短名 → 契约要求的站点域名。 */
export const WORKSHEET_SITES = Object.freeze({
  siteA: 'example.com',
  siteB: 'example.org',
});

const WORKSHEETS_COLLECTION = Object.freeze({
  id: 'worksheets-all',
  note: '演示数据，非医疗建议',
});

/** 按 Unicode 码点计长度（中文按 1 个字计，与契约 chars 口径一致）。 */
function runeLength(text) {
  return Array.from(String(text ?? '')).length;
}

/** 单篇 doc 的字符数：sections[].paragraphs[].text 按码点求和。 */
function docChars(doc) {
  let total = 0;
  for (const section of doc?.sections ?? []) {
    for (const paragraph of section?.paragraphs ?? []) total += runeLength(paragraph?.text);
  }
  return total;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeYear(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * 读取 JSON 元数据文件，缺失/损坏都返回结构化结果而不是抛错（api/library 不得 500）。
 * @returns {Promise<{ok:true, data:any}|{ok:false, missing:boolean, error:Error}>}
 */
async function readJsonFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return { ok: false, missing: error?.code === 'ENOENT', error };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

function readFailureText(fileName, result) {
  return result.missing ? `${fileName} 缺失` : `${fileName} 解析失败（${result.error?.message ?? '未知错误'}）`;
}

/** 校验 _manifest.json：只保留含非空 slug 的书籍条目。 */
function normalizeManifest(raw) {
  const books = Array.isArray(raw?.books) ? raw.books : [];
  return books.filter((book) => book && typeof book.slug === 'string' && book.slug.trim());
}

/**
 * 校验 _themes.json：结构、slug 存在性、不重复、且覆盖 manifest 全部书籍。
 * 任一不满足即视为「主题分组不可用」，由调用方降级为固定 6 组。
 */
function buildThemeGroups(raw, bookBySlug) {
  const themes = raw?.themes;
  if (!Array.isArray(themes) || themes.length === 0) return { error: 'themes 数组缺失或为空' };
  const seen = new Set();
  const seenIds = new Set();
  const groups = [];
  for (const theme of themes) {
    const id = asString(theme?.id).trim();
    const name = asString(theme?.name).trim();
    const desc = asString(theme?.desc).trim();
    const slugs = theme?.slugs;
    if (!id || !name || !Array.isArray(slugs) || slugs.length === 0) {
      return { error: `主题条目缺少 id/name/slugs：${JSON.stringify(theme)?.slice(0, 120)}` };
    }
    if (!THEME_ID_RE.test(id)) return { error: `主题 id 非法（需 kebab-case：小写字母/数字/连字符）：${id}` };
    if (seenIds.has(id)) return { error: `主题 id 重复：${id}` };
    seenIds.add(id);
    if ([...name].length > MAX_THEME_NAME_CHARS) return { error: `主题 ${id} 的 name 超过 ${MAX_THEME_NAME_CHARS} 字` };
    if ([...desc].length > MAX_THEME_DESC_CHARS) return { error: `主题 ${id} 的 desc 超过 ${MAX_THEME_DESC_CHARS} 字` };
    const books = [];
    for (const rawSlug of slugs) {
      const slug = asString(rawSlug).trim();
      const book = bookBySlug.get(slug);
      if (!book) return { error: `主题 ${id} 引用了未知书籍 slug：${slug || '(空)'}` };
      if (seen.has(slug)) return { error: `书籍 ${slug} 被多个主题重复分组` };
      seen.add(slug);
      books.push(book);
    }
    groups.push({ id, name, desc, books });
  }
  for (const slug of bookBySlug.keys()) {
    if (!seen.has(slug)) return { error: `书籍 ${slug} 未被任何主题覆盖` };
  }
  return { groups };
}

/**
 * 文档库条目池键：`book:<slug>` / `doc:<docId>` / `aggregate:<slug>` / `collection:<id>`。
 * 两级分类引用与「每条目恰好出现一次」覆盖校验都使用该键。
 */
export function libraryItemKey(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.kind === 'collection') return asString(item.id).trim() ? `collection:${asString(item.id).trim()}` : null;
  if (item.kind === 'book') {
    const slug = asString(item.slug).trim();
    if (!slug) return null;
    return item.aggregate === SOURCE_AGGREGATE ? `aggregate:${slug}` : `book:${slug}`;
  }
  if (item.kind === 'doc') return asString(item.docId).trim() ? `doc:${asString(item.docId).trim()}` : null;
  return null;
}

/** taxonomy 引用对象 → 条目池键；非法引用返回 null。 */
export function taxonomyReferenceKey(reference) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return null;
  const kind = asString(reference.kind).trim();
  if (kind === 'book' || kind === 'aggregate') {
    const slug = asString(reference.slug).trim();
    return slug ? `${kind}:${slug}` : null;
  }
  if (kind === 'doc') {
    const docId = asString(reference.docId).trim();
    return docId ? `doc:${docId}` : null;
  }
  if (kind === 'collection') {
    const id = asString(reference.id).trim();
    return id ? `collection:${id}` : null;
  }
  return null;
}

/** 按 Unicode 码点计长度（校验 name/desc 上限用）。 */
function textLengthOf(text) {
  return [...String(text ?? '')].length;
}

/**
 * 校验 `_taxonomy.json` 并组装两级 disciplines。
 *
 * 校验失败返回 `{ error }`，由调用方回退旧 17 组（契约 7.2：不得 500）。校验项：
 * version===1、学科非空且 id/name/desc 合法、id 全局唯一（学科、主题分别唯一）、
 * 每学科 2–6 个主题、主题 items 非空、引用必须命中条目池、每个条目恰好被引用一次。
 */
function buildTaxonomy(raw, itemPool) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'taxonomy 不是 JSON 对象' };
  if (raw.version !== TAXONOMY_VERSION) {
    return { error: `version 必须为 ${TAXONOMY_VERSION}（实际：${JSON.stringify(raw.version)}）` };
  }
  const rawDisciplines = raw.disciplines;
  if (!Array.isArray(rawDisciplines) || rawDisciplines.length === 0) {
    return { error: 'disciplines 缺失或为空' };
  }
  const disciplineIds = new Set();
  const topicIds = new Set();
  const referenced = new Set();
  const disciplines = [];
  let topicCount = 0;
  for (const rawDiscipline of rawDisciplines) {
    const id = asString(rawDiscipline?.id).trim();
    const name = asString(rawDiscipline?.name).trim();
    const desc = asString(rawDiscipline?.desc).trim();
    if (!id || !name || !desc) {
      return { error: `学科条目缺少 id/name/desc：${JSON.stringify(rawDiscipline)?.slice(0, 120)}` };
    }
    if (!TAXONOMY_ID_RE.test(id)) return { error: `学科 id 非法（需 kebab-case：小写字母/数字/连字符）：${id}` };
    if (disciplineIds.has(id)) return { error: `学科 id 重复：${id}` };
    disciplineIds.add(id);
    if (textLengthOf(name) > MAX_DISCIPLINE_NAME_CHARS) {
      return { error: `学科 ${id} 的 name 超过 ${MAX_DISCIPLINE_NAME_CHARS} 字` };
    }
    if (textLengthOf(desc) > MAX_DISCIPLINE_DESC_CHARS) {
      return { error: `学科 ${id} 的 desc 超过 ${MAX_DISCIPLINE_DESC_CHARS} 字` };
    }
    const rawTopics = rawDiscipline?.topics;
    if (!Array.isArray(rawTopics)) return { error: `学科 ${id} 缺少 topics 数组` };
    if (rawTopics.length < MIN_TOPICS_PER_DISCIPLINE || rawTopics.length > MAX_TOPICS_PER_DISCIPLINE) {
      return {
        error: `学科 ${id} 的 topics 数量需在 ${MIN_TOPICS_PER_DISCIPLINE}–${MAX_TOPICS_PER_DISCIPLINE} 之间（实际：${rawTopics.length}）`,
      };
    }
    const topics = [];
    for (const rawTopic of rawTopics) {
      const topicId = asString(rawTopic?.id).trim();
      const topicName = asString(rawTopic?.name).trim();
      const topicDesc = asString(rawTopic?.desc).trim();
      if (!topicId || !topicName || !topicDesc) {
        return { error: `学科 ${id} 的主题缺少 id/name/desc：${JSON.stringify(rawTopic)?.slice(0, 120)}` };
      }
      if (!TAXONOMY_ID_RE.test(topicId)) {
        return { error: `主题 id 非法（需 kebab-case：小写字母/数字/连字符）：${topicId}` };
      }
      if (topicIds.has(topicId)) return { error: `主题 id 重复：${topicId}` };
      topicIds.add(topicId);
      if (textLengthOf(topicName) > MAX_TOPIC_NAME_CHARS) {
        return { error: `主题 ${topicId} 的 name 超过 ${MAX_TOPIC_NAME_CHARS} 字` };
      }
      if (textLengthOf(topicDesc) > MAX_TOPIC_DESC_CHARS) {
        return { error: `主题 ${topicId} 的 desc 超过 ${MAX_TOPIC_DESC_CHARS} 字` };
      }
      const references = rawTopic?.items;
      if (!Array.isArray(references) || references.length === 0) {
        return { error: `主题 ${topicId} 的 items 缺失或为空` };
      }
      const items = [];
      for (const reference of references) {
        const key = taxonomyReferenceKey(reference);
        if (!key) {
          return { error: `主题 ${topicId} 含非法条目引用：${JSON.stringify(reference)?.slice(0, 120)}` };
        }
        if (!itemPool.has(key)) return { error: `主题 ${topicId} 引用了未知条目：${key}` };
        if (referenced.has(key)) return { error: `条目被重复引用（每条目恰好一次）：${key}` };
        referenced.add(key);
        items.push(itemPool.get(key));
      }
      topics.push({ id: topicId, name: topicName, desc: topicDesc, items });
      topicCount += 1;
    }
    disciplines.push({ id, name, desc, topics });
  }
  const missing = [...itemPool.keys()].filter((key) => !referenced.has(key));
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).join('、');
    return { error: `条目未被分类覆盖：${shown}${missing.length > 3 ? ` 等 ${missing.length} 条` : ''}` };
  }
  return { disciplines, topicCount };
}

/**
 * 构建文档库条目池（ 条目池：49 书 + 45 单篇 doc + 13 同源聚合 + 1 模板卡集合 = 108）。
 * 返回 `pool`（键 → item）与 `bookItems`（book slug → item，回退主题分组复用同一批对象）。
 */
function buildItemPool({ books, docStore, docGroups, worksheets, warnings }) {
  const pool = new Map();
  const bookItems = new Map();
  for (const book of books) {
    const item = buildBookItem(book, docStore, warnings);
    if (!item) continue;
    bookItems.set(book.slug, item);
    pool.set(`book:${book.slug}`, item);
  }
  for (const groupId of FIXED_DOC_GROUP_IDS) {
    for (const item of docGroups.get(groupId).items) {
      const key = libraryItemKey(item);
      if (!key) {
        warnings.push(`固定组 ${groupId} 的条目缺少可识别键，已忽略`);
        continue;
      }
      if (pool.has(key)) {
        warnings.push(`文档库条目键重复（${key}），已保留首个`);
        continue;
      }
      pool.set(key, item);
    }
  }
  for (const item of worksheets.items) {
    const key = libraryItemKey(item);
    if (key) pool.set(key, item);
  }
  return { pool, bookItems };
}

/** 书籍的章节标题：优先 sections[0].heading，其次 doc.title，再次书名 / docId。 */
function chapterTitle(doc, book, docId) {
  const heading = String(doc?.sections?.[0]?.heading ?? '').trim();
  if (heading) return heading;
  const docTitle = String(doc?.title ?? '').trim();
  if (docTitle) return docTitle;
  const bookTitle = String(book?.title ?? '').trim();
  return bookTitle || docId;
}

/** 一本书 → 契约 7.1 的 book item。 */
function buildBookItem(book, docStore, warnings) {
  const docIds = Array.isArray(book.docIds) ? book.docIds.map((docId) => String(docId)).filter(Boolean) : [];
  const canCheck = typeof docStore?.get === 'function';
  const chapters = [];
  let missing = 0;
  for (const docId of docIds) {
    const doc = canCheck ? docStore.get(docId) ?? null : null;
    if (canCheck && !doc) {
      missing += 1;
      warnings.push(`书籍 ${book.slug} 的章节文档不存在，已跳过：${docId}`);
      continue;
    }
    chapters.push({ docId, title: chapterTitle(doc, book, docId) });
  }
  if (canCheck && chapters.length === 0) {
    warnings.push(`书籍 ${book.slug} 没有可打开的章节文档，已从文档库省略`);
    return null;
  }
  // manifest 一般已带 chars（各章正文之和）；章节缺失或图片/文档无 chars 时按现存章节重算。
  const chars = missing === 0 && Number.isFinite(book.chars)
    ? book.chars
    : chapters.reduce((total, chapter) => total + docChars(canCheck ? docStore.get(chapter.docId) : null), 0);
  const item = {
    kind: 'book',
    slug: book.slug,
    title: asString(book.title),
    author: asString(book.author),
    publisher: asString(book.publisher),
    year: normalizeYear(book.year),
    format: asString(book.format),
    ocr: Boolean(book.ocr),
    chars,
    docCount: chapters.length,
    chapters,
  };
  const translator = asString(book.translator).trim();
  if (translator) item.translator = translator;
  return item;
}

/** 从 corpus 的 doc.source.version 解析 4 位年份（19xx/20xx），取不到返回 null。 */
function parseSourceVersionYear(doc) {
  const version = asString(doc?.source?.version);
  if (!version) return null;
  const match = version.match(/(?<!\d)((?:19|20)\d{2})(?!\d)/);
  return match ? Number(match[1]) : null;
}

/** 单篇 doc 的首个 section heading（trim 后），缺失返回空串。 */
function firstSectionHeading(doc) {
  return asString(doc?.sections?.[0]?.heading).trim();
}

/** 同源多文档聚合为 book 项（契约 7.3）。entries 已按 corpus 文件名顺序排列。 */
function buildSourceAggregateItem(entries) {
  const first = entries[0];
  const item = {
    kind: 'book',
    aggregate: SOURCE_AGGREGATE,
    slug: `source-${first.docId.replace(/-\d+$/, '')}`,
    title: first.title,
    chars: entries.reduce((total, entry) => total + entry.chars, 0),
    docCount: entries.length,
    chapters: [],
  };
  const author = asString(first.doc?.author).trim() || asString(first.doc?.source?.provider).trim();
  if (author) item.author = author;
  const year = parseSourceVersionYear(first.doc);
  if (year) item.year = year;
  const usedTitles = new Set();
  entries.forEach((entry, index) => {
    const heading = firstSectionHeading(entry.doc);
    // 空标题或与组内前面章节重名时用「第 N 篇」，保证 chapters 内标题不重复。
    const chapterTitle = heading && !usedTitles.has(heading) ? heading : `第 ${index + 1} 篇`;
    usedTitles.add(chapterTitle);
    item.chapters.push({ docId: entry.docId, title: chapterTitle });
  });
  return item;
}

/** 该 corpus 文件名是否可能属于固定 doc 组（按文件名前缀粗筛，避免读取书籍/模板卡）。 */
function isFixedDocFile(name) {
  return FIXED_DOC_FILE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** license 是否匹配归类规则（精确 license 或 license 前缀，契约 7.2）。 */
function licenseMatches(rule, license) {
  if (rule.license !== undefined) return license === rule.license;
  if (rule.licensePrefix !== undefined) return license.startsWith(rule.licensePrefix);
  return true;
}

/**
 * 固定 doc 组归类（契约 7.2）：按规则顺序取第一个「文件名前缀 + license 类别」都匹配的组。
 * 无法归类时返回 null，调用方跳过并 warn（防止把 license 类别不符的语料混进组里）。
 */
function classifyFixedDoc(name, license) {
  for (const groupId of FIXED_DOC_GROUP_IDS) {
    const rule = FIXED_DOC_GROUP_RULES[groupId];
    if (!rule.filePrefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (!licenseMatches(rule, license)) continue;
    return groupId;
  }
  return null;
}

/** 同 title 多篇聚合或单篇 → 契约 7.1/7.3 的 items（entries 已按 corpus 文件名排序）。 */
function buildDocItems(entries) {
  // 按 title 分组；顺序 = 各组首个 doc 在文件名排序中的位置（Map 保留插入顺序）。
  const byTitle = new Map();
  for (const entry of entries) {
    // title 为空时不聚合（用 docId 作唯一键），避免把无关的无标题文档并成一组。
    const key = entry.title ? `title:${entry.title}` : `doc:${entry.docId}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(entry);
  }

  const items = [];
  for (const group of byTitle.values()) {
    if (group.length >= 2) {
      items.push(buildSourceAggregateItem(group));
      continue;
    }
    const entry = group[0];
    const item = {
      kind: 'doc',
      docId: entry.docId,
      title: entry.title,
      license: entry.license,
      chars: entry.chars,
    };
    if (entry.sourceUrl) item.sourceUrl = entry.sourceUrl;
    items.push(item);
  }
  return items;
}

/**
 * 公版 / 政府 / 国际组织 / OA 论文 / 行业规范组：单次扫描 corpus 目录，按契约 7.2 规则归类，
 * 各组内按 corpus 文件名排序后生成条目。
 *
 * 契约 7.2 单篇为 `kind:"doc"`；契约 7.3 当组内多篇 doc 的 title 相同时，聚合为一条
 * `kind:"book", aggregate:"source"` 来源条目（chapters 可逐篇打开），单篇标题唯一时保持 doc。
 * 传入 `corpus`（server/corpus.mjs 的单次加载结果）时复用其已解析 doc，不再重复读盘。
 * 返回 `Map<groupId, {items, docCount}>`：`docCount` 为有效 doc 篇数（stats 口径不变，聚合不影响计数）。
 */
async function buildDocGroups(docsDir, warnings, corpus = null) {
  const byGroup = new Map(FIXED_DOC_GROUP_IDS.map((groupId) => [groupId, { items: [], docCount: 0 }]));
  let candidateFiles;
  if (corpus && Array.isArray(corpus.files)) {
    // 共享语料路径：loadCorpus 已按文件名排序并校验 id；这里只按固定组前缀粗筛。
    candidateFiles = corpus.files.filter((entry) => isFixedDocFile(entry.name));
  } else {
    let names;
    try {
      const entries = await readdir(docsDir, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => name.endsWith('.json') && !name.startsWith('_') && isFixedDocFile(name))
        .sort();
    } catch (error) {
      warnings.push(`语料目录不可读（${docsDir}）：${error?.message ?? error}`);
      return byGroup;
    }
    candidateFiles = names.map((name) => ({ name }));
  }

  const entriesByGroup = new Map(FIXED_DOC_GROUP_IDS.map((groupId) => [groupId, []]));
  for (const entry of candidateFiles) {
    const { name } = entry;
    let doc = entry.doc;
    if (!doc) {
      const result = await readJsonFile(path.join(docsDir, name));
      if (!result.ok) {
        warnings.push(`跳过无法解析的固定组语料 ${name}：${result.missing ? '文件缺失' : result.error?.message}`);
        continue;
      }
      doc = result.data;
    }
    const docId = asString(doc?.id).trim();
    if (!docId) {
      warnings.push(`跳过缺少 id 的固定组语料：${name}`);
      continue;
    }
    const license = asString(doc.license).trim();
    const groupId = classifyFixedDoc(name, license);
    if (!groupId) {
      warnings.push(`跳过固定组语料 ${name}：license 不属于该文件名前缀对应的固定组类别「${license || '(空)'}」（不混组）`);
      continue;
    }
    entriesByGroup.get(groupId).push({
      name,
      doc,
      docId,
      title: asString(doc.title).trim(),
      license,
      chars: docChars(doc),
      sourceUrl: asString(doc.sourceUrl).trim(),
    });
  }

  for (const groupId of FIXED_DOC_GROUP_IDS) {
    const entries = entriesByGroup.get(groupId);
    byGroup.set(groupId, { items: buildDocItems(entries), docCount: entries.length });
  }
  return byGroup;
}

/** 模板卡集合：一个 collection item，内部按 _worksheets.json 顺序列出。 */
function buildWorksheetsGroup(raw, warnings) {
  const meta = FIXED_GROUP_META.worksheets;
  const items = [];
  if (!Array.isArray(raw?.worksheets)) {
    if (raw !== undefined) warnings.push('_worksheets.json 缺少 worksheets 数组');
  } else {
    for (const worksheet of raw.worksheets) {
      const docId = asString(worksheet?.docId).trim();
      if (!docId) {
        warnings.push('跳过缺少 docId 的模板卡条目');
        continue;
      }
      const site = WORKSHEET_SITES[asString(worksheet.site).trim()] ?? asString(worksheet.provider).trim();
      items.push({ docId, title: asString(worksheet.title), site });
    }
  }
  return {
    id: meta.id,
    name: meta.name,
    desc: meta.desc,
    items: [
      {
        kind: 'collection',
        id: WORKSHEETS_COLLECTION.id,
        title: `演示模板卡（${items.length} 份）`,
        count: items.length,
        note: WORKSHEETS_COLLECTION.note,
        items,
      },
    ],
  };
}

/**
 * 构建文档库数据（启动时调用一次）。
 *
 * 两级分类：读取 `corpus/_taxonomy.json`（v1，学科方向 → 主题），校验通过时返回
 * `{ok, generatedAt, stats, disciplines}`（无 warning）；文件缺失 / 损坏 / 校验失败 / 覆盖不完整时
 * 回退旧 17 组：`{ok, generatedAt, stats, disciplines: [], groups: <旧结构>, warning: "taxonomy_unavailable"}`，
 * 仍返回 200（不 500）。模板卡文件不可用时该组 count 为 0。
 *
 * @param {{
 *   docsDir: string,
 *   docStore?: {get:(docId:string)=>object|null, stats?:()=>{docs:number}},
 *   docsCount?: number,
 *   logger?: Console,
 *   corpus?: {files: Array<{name:string, doc:object}>}|null,
 * }} options
 */
export async function createLibrary({ docsDir, docStore = null, docsCount, logger = console, corpus = null } = {}) {
  const startedAt = Date.now();
  const warnings = [];

  const [themesRead, manifestRead, worksheetsRead, taxonomyRead] = await Promise.all([
    readJsonFile(path.join(docsDir, THEMES_FILE)),
    readJsonFile(path.join(docsDir, MANIFEST_FILE)),
    readJsonFile(path.join(docsDir, WORKSHEETS_FILE)),
    readJsonFile(path.join(docsDir, TAXONOMY_FILE)),
  ]);

  // 书籍元数据（两级分类与回退路径共用）。
  const books = manifestRead.ok ? normalizeManifest(manifestRead.data) : [];
  const bookBySlug = new Map(books.map((book) => [book.slug, book]));
  if (!manifestRead.ok) warnings.push(readFailureText(MANIFEST_FILE, manifestRead));
  if (!worksheetsRead.ok) warnings.push(readFailureText(WORKSHEETS_FILE, worksheetsRead));

  // 固定 doc 组（公版/政府/国际组织/OA 论文/行业规范）与模板卡集合：两级分类条目池的来源。
  const docGroups = await buildDocGroups(docsDir, warnings, corpus);
  const worksheets = buildWorksheetsGroup(worksheetsRead.ok ? worksheetsRead.data : undefined, warnings);

  // 条目池（108 条）：书籍 + 固定组单篇/同源聚合 + 模板卡集合，item 对象沿用旧契约。
  const { pool, bookItems } = buildItemPool({ books, docStore, docGroups, worksheets, warnings });

  // 成功/回退共用统计底座（契约 7.2：chars 只算书籍+五个固定 doc 组，不含模板卡）。
  const sumChars = (group) => group.items.reduce((total, item) => total + item.chars, 0);
  const countDocs = (group) => group.docCount ?? group.items.length;
  const docs = Number.isFinite(docsCount) ? docsCount : docStore?.stats?.().docs ?? 0;
  const fixedChars = FIXED_DOC_GROUP_IDS.reduce((total, id) => total + sumChars(docGroups.get(id)), 0);
  const worksheetCount = worksheets.items[0].count;

  let payload;
  let warning = null;
  let summaryLog = null;

  const taxonomy = taxonomyRead.ok
    ? buildTaxonomy(taxonomyRead.data, pool)
    : { error: readFailureText(TAXONOMY_FILE, taxonomyRead) };

  if (!taxonomy.error) {
    // 1) 成功路径（契约 7.1，）：学科方向 → 主题 → items。
    const { disciplines, topicCount } = taxonomy;
    const bookChars = [...bookItems.values()].reduce((total, item) => total + item.chars, 0);
    const stats = {
      docs,
      books: bookItems.size,
      chars: bookChars + fixedChars,
      publicDomain: countDocs(docGroups.get('public-domain')),
      government: countDocs(docGroups.get('government')),
      international: countDocs(docGroups.get('international')),
      papers: countDocs(docGroups.get('papers')),
      worksheets: worksheetCount,
      disciplines: disciplines.length,
      topics: topicCount,
    };
    payload = { ok: true, generatedAt: new Date().toISOString(), stats, disciplines };
    summaryLog = {
      level: 'log',
      text: `[library] 分类 v1：${disciplines.length} 个学科 / ${topicCount} 个主题 / ${pool.size} 个条目（build ${Date.now() - startedAt}ms）`,
    };
  } else {
    // 2) 回退路径：旧 17 组 + warning:"taxonomy_unavailable"，不得 500。
    warning = TAXONOMY_UNAVAILABLE;
    if (!themesRead.ok) warnings.push(readFailureText(THEMES_FILE, themesRead));
    let themeGroups = [];
    if (themesRead.ok && books.length > 0) {
      const built = buildThemeGroups(themesRead.data, bookBySlug);
      if (built.error) {
        warnings.push(`主题分组校验失败：${built.error}`);
      } else {
        themeGroups = built.groups.map((group) => ({
          id: group.id,
          name: group.name,
          desc: group.desc,
          items: group.books.map((book) => bookItems.get(book.slug)).filter(Boolean),
        }));
      }
    } else if (themesRead.ok && books.length === 0) {
      warnings.push(`${MANIFEST_FILE} 没有可用书籍`);
    }
    const groups = [
      ...themeGroups,
      ...FIXED_GROUP_ORDER.map((id) => {
        if (id === 'worksheets') return worksheets;
        return {
          id: FIXED_GROUP_META[id].id,
          name: FIXED_GROUP_META[id].name,
          desc: FIXED_GROUP_META[id].desc,
          items: docGroups.get(id).items,
        };
      }),
    ];
    const bookCount = themeGroups.reduce((total, group) => total + group.items.length, 0);
    const bookChars = themeGroups.reduce(
      (total, group) => total + group.items.reduce((sum, item) => sum + item.chars, 0),
      0,
    );
    const stats = {
      docs,
      books: bookCount,
      chars: bookChars + fixedChars,
      publicDomain: countDocs(docGroups.get('public-domain')),
      government: countDocs(docGroups.get('government')),
      international: countDocs(docGroups.get('international')),
      papers: countDocs(docGroups.get('papers')),
      worksheets: worksheetCount,
      disciplines: 0,
      topics: 0,
    };
    payload = { ok: true, generatedAt: new Date().toISOString(), stats, disciplines: [], groups };
    payload.warning = warning;
    summaryLog = {
      level: 'warn',
      text: `[library] taxonomy 不可用，回退旧 ${groups.length} 组：${taxonomy.error}`,
    };
  }

  const body = JSON.stringify(payload);
  for (const message of warnings) logger?.warn?.(`[library] ${message}`);
  if (summaryLog) logger?.[summaryLog.level]?.(summaryLog.text);

  return Object.freeze({
    docsDir,
    buildMs: Date.now() - startedAt,
    warning,
    /** 缓存的数据对象（只读使用）。 */
    get() {
      return payload;
    },
    /** 缓存的 JSON 字符串，路由直接发送避免重复序列化。 */
    json() {
      return body;
    },
    stats() {
      return payload.stats;
    },
    /** 启动日志用摘要（`groups` 在成功路径沿用旧日志字段，表示顶层学科数；详细分类见 disciplines/topics）。 */
    summary() {
      return warning
        ? { books: payload.stats.books, groups: payload.groups.length, warning }
        : {
            books: payload.stats.books,
            groups: payload.disciplines.length,
            disciplines: payload.stats.disciplines,
            topics: payload.stats.topics,
          };
    },
  });
}
