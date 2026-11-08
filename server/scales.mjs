// server/scales.mjs — 通用自评问卷引擎（开源框架子集 / 通用化改写版）。
//
// 本文件替代原项目中的私有自评问卷实现（原文件分类为 open-clean：含自评问卷题目与领域文案，
// 不随框架发布）。改写原则：
//   1. 保留通用引擎能力：v1 schema 校验、band/factor 计分、反向题、档位校验、可选安全提示、
//      私有自评问卷注册、自评问卷历史路由；对外导出的名字与签名与原实现保持一致，
//      server/index.mjs / server/app.mjs / server/scales-private.mjs / bin/serve.mjs 无需改动。
//   2. 移除全部领域内容：不内置任何专业评估自评问卷题目、常模、领域分类与求助话术；
//      只保留 1 个自撰的演示自评问卷（demo-focus-6），用于演示「列表 → 单表 → 计分 → 历史」链路。
//   3. 原实现的常模自评问卷引擎（schemaVersion=2 / kind=norm）不在框架子集内：
//      遇到此类定义时明确报错，提示这是部署方需要自行扩展的能力（见 docs/EXTENDING.md）。
//
// 契约（与 API-CONTRACT 9 一致的公开字段）：自评问卷列表 / 单表 / 计分 / 历史四组接口。
// 计分纯内存完成，不落盘题面与原始答案；自评问卷历史只保存结果摘要（由 scales-history.mjs 负责）。

import { HttpError, readJsonBody, sendApiError, sendJson } from './http-utils.mjs';

/** 自评问卷数据版本（列表接口用于客户端缓存比对；部署方替换内置表后应同步更新）。 */
export const SCALES_UPDATED_AT = '2026-11-01T00:00:00.000Z';

/** 通用免责声明：随包只做「自我观察」定位，不做诊断。 */
export const SCALES_DISCLAIMER =
  '本自评问卷仅用于自我观察与记录，不构成任何医学或专业评估诊断；分数与档位不能替代医生、'
  + '专业人士的评估。如果近期状态明显影响生活，建议寻求专业帮助。';

/** 兼容导出名（原实现用于高危题目的安全提示）；框架子集保留导出以维持模块契约。 */
export const SAFETY_ADVISORY =
  '如果你最近常常出现伤害自己的想法，请把这件事告诉一位你信任的人，让对方陪在你身边；'
  + '也可以联系当地专业求助资源；如果此刻有立即危险，请马上拨打当地紧急电话（如 110 / 120）。'
  + '这个提示不针对具体分数做风险分级，也不替代专业评估。';

/** 内置通用分类（可随部署方替换；categoryId 必须来自本表）。 */
export const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'wellbeing', name: '状态自查', description: '与日常状态相关的自评工具' }),
  Object.freeze({ id: 'focus', name: '专注与效率', description: '与注意力、执行相关的自评工具' }),
  Object.freeze({ id: 'energy', name: '精力与恢复', description: '与精力、休息、恢复相关的自评工具' }),
]);

/** 分类 id 集合（buildScaleDefinition 校验用）。 */
export const CATEGORY_IDS = new Set(CATEGORIES.map((category) => category.id));

/** 支持的计分方式：band=总分档位；factor=因子分（band 可为空）。 */
export const SCALE_KINDS = Object.freeze(['band', 'factor']);

/** 原实现的常模自评问卷 schema 版本；框架子集不包含该引擎。 */
const NORM_SCALE_SCHEMA_VERSION = 2;

const DEMO_OPTIONS = [
  { value: 0, label: '几乎从不' },
  { value: 1, label: '偶尔' },
  { value: 2, label: '经常' },
  { value: 3, label: '几乎每天' },
];

/**
 * 内置演示自评问卷（自撰，非任何既有心态测量工具）。
 * 目的：让「自评问卷引擎 + API + 前端」链路在剥离包内可直接跑通；正式部署请替换/扩展。
 */
const SCALE_DEFINITIONS = [
  {
    id: 'demo-focus-6',
    categoryId: 'focus',
    kind: 'band',
    name: '专注与节奏六题自查（演示自评问卷）',
    shortName: '专注自查',
    timeframe: '最近两周',
    purpose: '演示：自评最近两周的专注与节奏，仅用于展示自评问卷引擎链路',
    options: DEMO_OPTIONS,
    itemsText: [
      '我能连续专注工作或学习 25 分钟以上',
      '开始一项任务时，我能比较快地进入状态',
      '被打断后，我能较快回到原来的进度',
      '我会在开始前把任务拆成可完成的小步骤',
      '结束一天时，我清楚自己完成了什么',
      '我有固定的休息或恢复安排（散步、运动、放空等）',
    ],
    reverseItems: [],
    bands: [
      { key: 'low', label: '节奏偏松', min: 0, max: 6, note: '专注与节奏偏松；可以试试 25 分钟专注 + 5 分钟休息的节奏。' },
      { key: 'mid', label: '节奏稳定', min: 7, max: 12, note: '节奏较稳定；继续保留开始前拆步骤与固定休息的习惯。' },
      { key: 'high', label: '节奏良好', min: 13, max: 18, note: '专注与节奏良好；留意别把节奏拉得过满，保留恢复时间。' },
    ],
    source: {
      name: '通用对话终端框架演示自评问卷',
      url: 'https://example.com/open-chat-terminal-framework/scales',
      license: 'CC0-1.0',
      citation: '自撰演示自评问卷（非任何既有心态测量工具），仅用于演示自评问卷引擎与 API 链路。',
    },
  },
];

function assertNonEmptyString(value, field, scope) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${scope}：${field} 必须是非空字符串`);
  }
}

function assertIntegerInRange(value, min, max, field, scope) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${scope}：${field} 必须是 ${min}–${max} 之间的整数（当前 ${String(value)}）`);
  }
}

/**
 * 校验并归一化一份自评问卷定义（v1 schema）。
 * 返回带派生字段（items/minValue/maxValue/minScore/maxScore/optionValues）的内部定义。
 * @param {object} definition 自评问卷定义（内置或私有包提供）
 * @returns {object}
 */
export function buildScaleDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('自评问卷定义必须是对象');
  }
  assertNonEmptyString(definition.id, 'id', '自评问卷定义');
  const declaredVersion = definition.schemaVersion;
  if (declaredVersion === NORM_SCALE_SCHEMA_VERSION || definition.kind === 'norm') {
    throw new Error(
      `自评问卷 ${definition.id}：常模自评问卷引擎（schemaVersion=2 / kind=norm）不在框架子集内；`
      + '如需常模计分，请部署方自行扩展本文件（见 docs/EXTENDING.md「工具/自评问卷包」）。',
    );
  }
  if (declaredVersion !== undefined && declaredVersion !== 1) {
    throw new Error(`自评问卷 ${definition.id}：不支持的 schemaVersion（${String(declaredVersion)}），仅支持 1`);
  }
  const scope = `自评问卷 ${definition.id}`;
  assertNonEmptyString(definition.name, 'name', scope);
  assertNonEmptyString(definition.shortName, 'shortName', scope);
  assertNonEmptyString(definition.timeframe, 'timeframe', scope);
  assertNonEmptyString(definition.purpose, 'purpose', scope);

  if (!CATEGORY_IDS.has(definition.categoryId)) {
    throw new Error(`${scope}：categoryId 未知（${String(definition.categoryId)}）`);
  }
  const kind = definition.kind ?? 'band';
  if (!SCALE_KINDS.includes(kind)) {
    throw new Error(`${scope}：kind 必须是 ${SCALE_KINDS.join(' 或 ')}（当前 ${String(kind)}）`);
  }

  const { options } = definition;
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error(`${scope}：options 至少需要 2 个选项`);
  }
  const optionValues = options.map((option, index) => {
    if (!option || typeof option !== 'object') throw new Error(`${scope}：options[${index}] 必须是对象`);
    if (!Number.isInteger(option.value)) throw new Error(`${scope}：options[${index}].value 必须是整数`);
    assertNonEmptyString(option.label, `options[${index}].label`, scope);
    return option.value;
  });
  if (new Set(optionValues).size !== optionValues.length) throw new Error(`${scope}：选项值重复`);
  const minValue = Math.min(...optionValues);
  const maxValue = Math.max(...optionValues);

  const { itemsText } = definition;
  if (!Array.isArray(itemsText) || itemsText.length === 0) throw new Error(`${scope}：itemsText 必须是非空数组`);
  itemsText.forEach((text, index) => assertNonEmptyString(text, `itemsText[${index}]`, scope));
  const items = itemsText.length;
  const minScore = items * minValue;
  const maxScore = items * maxValue;

  const reverseItems = definition.reverseItems ?? [];
  if (!Array.isArray(reverseItems)) throw new Error(`${scope}：reverseItems 必须是数组`);
  const seenReverseItems = new Set();
  for (const item of reverseItems) {
    assertIntegerInRange(item, 1, items, 'reverseItems 题号', scope);
    if (seenReverseItems.has(item)) throw new Error(`${scope}：reverseItems 题号重复（${item}）`);
    seenReverseItems.add(item);
  }

  const { source } = definition;
  if (!source || typeof source !== 'object') throw new Error(`${scope}：缺少 source 来源登记`);
  for (const key of ['name', 'url', 'license', 'citation']) {
    assertNonEmptyString(source[key], `source.${key}`, scope);
  }

  let factors = null;
  if (kind === 'factor') {
    if (!Array.isArray(definition.factors) || definition.factors.length === 0) {
      throw new Error(`${scope}：kind=factor 时必须提供非空的 factors`);
    }
    const coveredBy = new Array(items).fill(null);
    const factorIds = new Set();
    factors = definition.factors.map((factor, index) => {
      if (!factor || typeof factor !== 'object') throw new Error(`${scope}：factors[${index}] 必须是对象`);
      assertNonEmptyString(factor.id, `factors[${index}].id`, scope);
      if (factorIds.has(factor.id)) throw new Error(`${scope}：因子 id 重复（${factor.id}）`);
      factorIds.add(factor.id);
      assertNonEmptyString(factor.name, `factors[${index}].name`, scope);
      if (!Array.isArray(factor.itemNumbers) || factor.itemNumbers.length === 0) {
        throw new Error(`${scope}：factors[${index}].itemNumbers 必须是非空数组`);
      }
      const itemNumbers = factor.itemNumbers.map((itemNumber) => {
        assertIntegerInRange(itemNumber, 1, items, `factors[${index}].itemNumbers`, scope);
        if (coveredBy[itemNumber - 1] !== null) {
          throw new Error(`${scope}：题号 ${itemNumber} 同时属于因子「${coveredBy[itemNumber - 1]}」与「${factor.id}」`);
        }
        coveredBy[itemNumber - 1] = factor.id;
        return itemNumber;
      });
      if (factor.description !== undefined) {
        assertNonEmptyString(factor.description, `factors[${index}].description`, scope);
      }
      const normalized = { id: factor.id, name: factor.name, itemNumbers };
      if (factor.description !== undefined) normalized.description = factor.description;
      return normalized;
    });
    const missing = [];
    for (let index = 0; index < items; index += 1) {
      if (coveredBy[index] === null) missing.push(index + 1);
    }
    if (missing.length > 0) throw new Error(`${scope}：factors 未覆盖全部题目（缺第 ${missing.join('、')} 题）`);
  } else if (definition.factors !== undefined) {
    throw new Error(`${scope}：kind=band 时不应提供 factors`);
  }

  let bands = [];
  if (definition.bands !== undefined) {
    if (!Array.isArray(definition.bands) || definition.bands.length === 0) {
      throw new Error(`${scope}：bands 必须是非空数组`);
    }
    bands = definition.bands.map((band, index) => {
      if (!band || typeof band !== 'object') throw new Error(`${scope}：bands[${index}] 必须是对象`);
      assertNonEmptyString(band.key, `bands[${index}].key`, scope);
      assertNonEmptyString(band.label, `bands[${index}].label`, scope);
      assertIntegerInRange(band.min, minScore, maxScore, `bands[${index}].min`, scope);
      assertIntegerInRange(band.max, minScore, maxScore, `bands[${index}].max`, scope);
      if (band.max < band.min) throw new Error(`${scope}：bands[${index}] 区间非法`);
      assertNonEmptyString(band.note, `bands[${index}].note`, scope);
      return { ...band };
    });
    let cursor = minScore;
    for (const band of bands) {
      if (band.min !== cursor) throw new Error(`${scope}：档位不连续`);
      cursor = band.max + 1;
    }
    if (cursor !== maxScore + 1) throw new Error(`${scope}：档位未覆盖满 ${minScore}–${maxScore}`);
  } else if (kind === 'band') {
    throw new Error(`${scope}：kind=band 时必须提供 bands（无总分档位请用 kind=factor）`);
  }

  let safetyItems = [];
  if (definition.safetyItems !== undefined) {
    if (!Array.isArray(definition.safetyItems)) throw new Error(`${scope}：safetyItems 必须是数组`);
    safetyItems = definition.safetyItems.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new Error(`${scope}：safetyItems[${index}] 必须是对象`);
      assertIntegerInRange(entry.itemNumber, 1, items, `safetyItems[${index}].itemNumber`, scope);
      assertIntegerInRange(entry.minValue, minValue, maxValue, `safetyItems[${index}].minValue`, scope);
      assertNonEmptyString(entry.advisory, `safetyItems[${index}].advisory`, scope);
      return { itemNumber: entry.itemNumber, minValue: entry.minValue, advisory: entry.advisory };
    });
  }

  return {
    ...definition,
    kind,
    items,
    minValue,
    maxValue,
    minScore,
    maxScore,
    optionValues,
    reverseItems: [...reverseItems],
    factors,
    bands,
    safetyItems,
  };
}

/** @type {Map<string, object>} 当前生效的自评问卷（内置 + 私有）。 */
const SCALE_MAP = new Map();
/** 内置自评问卷 id（固定；私有自评问卷不得与之冲突；供私有自评问卷加载器校验）。 */
export const BUILTIN_SCALE_IDS = Object.freeze(SCALE_DEFINITIONS.map((definition) => definition.id));
const BUILTIN_IDS = new Set(BUILTIN_SCALE_IDS);
/** 当前注册的私有自评问卷 id（每个服务实例按自己的 DATA_DIR 重新注册）。 */
const PRIVATE_IDS = new Set();

for (const definition of SCALE_DEFINITIONS) {
  if (SCALE_MAP.has(definition.id)) throw new Error(`自评问卷 id 重复：${definition.id}`);
  SCALE_MAP.set(definition.id, buildScaleDefinition(definition));
}

/** 公开结构（严格按 API-CONTRACT 9 字段，不暴露内部派生字段与 safetyItems 文案）。 */
function publicScale(scale) {
  const payload = {
    id: scale.id,
    categoryId: scale.categoryId,
    kind: scale.kind,
    name: scale.name,
    shortName: scale.shortName,
    items: scale.items,
    timeframe: scale.timeframe,
    purpose: scale.purpose,
    maxScore: scale.maxScore,
    options: scale.options.map((option) => ({ ...option })),
    bands: scale.bands.map((band) => ({ ...band })),
    itemsText: [...scale.itemsText],
    reverseItems: [...scale.reverseItems],
    source: { ...scale.source },
  };
  if (scale.factors) {
    payload.factors = scale.factors.map((factor) => ({
      id: factor.id,
      name: factor.name,
      itemNumbers: [...factor.itemNumbers],
      ...(factor.description !== undefined ? { description: factor.description } : {}),
    }));
  }
  // 私有自评问卷（用户本地文件加载）标记；内置表没有该字段。
  if (scale.private) payload.private = true;
  return payload;
}

/** 当前公开自评问卷列表（内置在前，私有按 id 排序在后）。 */
let PUBLIC_SCALES = [];
/** 当前列表响应体（重建时保持导出引用可用）。 */
let LIST_PAYLOAD = null;
/** 自评问卷 id 列表（原地 mutation，已 import 的引用保持同步）。 */
export const SCALE_IDS = [];

function rebuildRegistry() {
  PUBLIC_SCALES = [...SCALE_MAP.values()].map((scale) => publicScale(scale));
  SCALE_IDS.length = 0;
  for (const scale of PUBLIC_SCALES) SCALE_IDS.push(scale.id);
  LIST_PAYLOAD = {
    ok: true,
    updatedAt: SCALES_UPDATED_AT,
    disclaimer: SCALES_DISCLAIMER,
    categories: CATEGORIES.map((category) => ({ ...category })),
    scales: PUBLIC_SCALES,
  };
}

rebuildRegistry();

/**
 * 注册本地私有自评问卷：替换上一次注册的私有自评问卷，内置自评问卷保持不变。
 * 定义须已通过 buildScaleDefinition 的 schema 校验（调用方自行跳过非法文件）。
 * @param {object[]} [definitions] 私有自评问卷定义数组
 * @returns {{ids: string[], count: number}}
 */
export function registerPrivateScales(definitions = []) {
  const list = Array.isArray(definitions) ? definitions : [];
  const built = [];
  const seen = new Set();
  for (const definition of list) {
    const scale = buildScaleDefinition(definition);
    if (BUILTIN_IDS.has(scale.id)) throw new Error(`私有自评问卷 id 与内置自评问卷冲突：${scale.id}`);
    if (seen.has(scale.id)) throw new Error(`私有自评问卷 id 重复：${scale.id}`);
    seen.add(scale.id);
    scale.private = true;
    built.push(scale);
  }
  built.sort((left, right) => left.id.localeCompare(right.id));

  for (const id of PRIVATE_IDS) SCALE_MAP.delete(id);
  PRIVATE_IDS.clear();
  for (const scale of built) {
    SCALE_MAP.set(scale.id, scale);
    PRIVATE_IDS.add(scale.id);
  }
  rebuildRegistry();
  return { ids: built.map((scale) => scale.id), count: built.length };
}

function scaleOf(scaleId) {
  const scale = SCALE_MAP.get(scaleId);
  if (!scale) throw new HttpError(404, 'SCALE_NOT_FOUND', `未找到自评问卷：${scaleId}`);
  return scale;
}

/** GET /api/scales 响应体。 */
export function listScalesPayload() {
  return LIST_PAYLOAD;
}

/** GET /api/scales/:id → 返回公开自评问卷；未知 id 抛 404 SCALE_NOT_FOUND。 */
export function getScalePayload(scaleId) {
  return publicScale(scaleOf(scaleId));
}

function invalid(message) {
  return new HttpError(400, 'INVALID_REQUEST', message);
}

/**
 * 校验并归一化答案：返回按题号（0-based）排列的原始作答数组。
 * @param {object} scale 内部自评问卷定义
 * @param {unknown} answers 请求体里的 answers（题号字符串 → 分值）
 * @returns {number[]}
 */
export function normalizeAnswers(scale, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw invalid('缺少字段 answers（题号 → 分值）');
  }
  const values = new Array(scale.items).fill(null);
  for (const [key, raw] of Object.entries(answers)) {
    if (!/^[1-9]\d*$/.test(key)) throw invalid(`题号不合法：${key}`);
    const index = Number(key);
    if (index > scale.items) throw invalid(`题号超出范围：${key}（本自评问卷共 ${scale.items} 题）`);
    if (typeof raw !== 'number' || !Number.isInteger(raw)) throw invalid(`第 ${key} 题答案必须是整数`);
    if (raw < scale.minValue || raw > scale.maxValue) {
      throw invalid(`第 ${key} 题答案超出范围（可选 ${scale.minValue}–${scale.maxValue}）`);
    }
    values[index - 1] = raw;
  }
  const missing = [];
  for (let index = 0; index < scale.items; index += 1) {
    if (values[index] === null) missing.push(index + 1);
  }
  if (missing.length > 0) {
    const preview = missing.length <= 3 ? missing.join('、') : `${missing.slice(0, 3).join('、')} 等`;
    throw invalid(`还有 ${missing.length} 题未作答：第 ${preview} 题`);
  }
  return values;
}

/**
 * 纯函数计分：内部自评问卷定义 + answers → 响应体 result（不含 ok 包装）。
 * kind=factor 时追加 factors；safetyItems 命中时追加通用 safetyAdvisory（去重连接）。
 * @param {object} scale 内部自评问卷定义（buildScaleDefinition 的返回值）
 * @param {unknown} answers
 * @returns {object} result
 */
export function computeScaleResult(scale, answers) {
  const values = normalizeAnswers(scale, answers);
  const reversed = new Set(scale.reverseItems);
  const scored = values.map((value, index) => {
    if (reversed.has(index + 1)) return scale.maxValue + scale.minValue - value;
    return value;
  });
  let score = 0;
  for (const value of scored) score += value;

  let band = null;
  if (scale.bands.length > 0) {
    const found = scale.bands.find((candidate) => score >= candidate.min && score <= candidate.max);
    if (!found) throw new Error(`自评问卷 ${scale.id} 的分数 ${score} 不落在任何档位`);
    band = { ...found };
  }

  const result = {
    scaleId: scale.id,
    score,
    maxScore: scale.maxScore,
    band,
    answered: scale.items,
    complete: true,
    computedAt: new Date().toISOString(),
    disclaimer: SCALES_DISCLAIMER,
    sources: [{ name: scale.source.name, url: scale.source.url, license: scale.source.license }],
  };
  if (scale.factors) {
    result.factors = scale.factors.map((factor) => {
      let factorScore = 0;
      for (const itemNumber of factor.itemNumbers) factorScore += scored[itemNumber - 1];
      return {
        id: factor.id,
        name: factor.name,
        score: factorScore,
        maxScore: factor.itemNumbers.length * scale.maxValue,
      };
    });
  }
  const advisories = [];
  for (const entry of scale.safetyItems) {
    if (values[entry.itemNumber - 1] >= entry.minValue && !advisories.includes(entry.advisory)) {
      advisories.push(entry.advisory);
    }
  }
  if (advisories.length > 0) result.safetyAdvisory = advisories.join('\n');
  return result;
}

/**
 * 纯函数计分：POST /api/scales/score 的响应体。
 * @param {unknown} input 请求体
 * @returns {{ok: true, result: object}}
 */
export function scoreScale(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('请求体必须是 JSON 对象');
  const { scaleId, answers } = input;
  if (typeof scaleId !== 'string' || !scaleId.trim()) throw invalid('缺少字段 scaleId（自评问卷编号）');
  const scale = scaleOf(scaleId.trim());
  return { ok: true, result: computeScaleResult(scale, answers) };
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const CATEGORY_NAME_BY_ID = new Map(CATEGORIES.map((category) => [category.id, category.name]));

/**
 * 自评问卷历史摘要元信息（只含展示所需字段，不含题面/计分规则/答案）。
 * @param {string} scaleId
 * @returns {{scaleId: string, name: string, category: string, kind: string, maxScore: number|null}|null}
 */
export function getScaleHistoryMeta(scaleId) {
  let scale;
  try {
    scale = scaleOf(scaleId);
  } catch {
    return null;
  }
  return {
    scaleId: scale.id,
    name: scale.name,
    category: CATEGORY_NAME_BY_ID.get(scale.categoryId) ?? scale.categoryId ?? '',
    kind: scale.kind,
    maxScore: Number.isFinite(scale.maxScore) ? scale.maxScore : null,
  };
}

/** 读取 URL query 参数（路由只拿到 req.url；解析失败按缺省处理）。 */
function requestQuery(req, name) {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams.get(name);
  } catch {
    return null;
  }
}

/** POST /api/scales/score：计分成功后追加自评问卷历史保存（失败不阻断计分）。 */
async function handleScore(req, res, ctx) {
  const body = await readJsonBody(req);
  const payload = scoreScale(body);
  const history = ctx?.scaleHistory ?? null;
  let saved = false;
  let entryId;
  if (history?.enabled) {
    try {
      const meta = getScaleHistoryMeta(payload.result.scaleId);
      const sex = body && typeof body === 'object' ? body.sex : null;
      const outcome = await history.record(payload.result, { sex, scale: meta });
      saved = outcome.saved === true;
      if (saved && outcome.entry) entryId = outcome.entry.id;
    } catch (error) {
      // 保存失败绝不影响计分响应（saved:false），只记 warn。
      ctx?.logger?.warn?.(`[scales] 自评问卷历史保存失败（不阻断计分）：${error?.message ?? error}`);
    }
  }
  const response = { ...payload, saved };
  if (entryId) response.entryId = entryId;
  sendJson(res, 200, response);
}

/** GET/HEAD /api/scales/history?scaleId=&limit=：按自评问卷分组、时间升序；无数据 200 + scales:[]。 */
function handleHistoryList(req, res, ctx) {
  const history = ctx?.scaleHistory ?? null;
  const payload = history
    ? history.query({ scaleId: requestQuery(req, 'scaleId'), limit: requestQuery(req, 'limit') })
    : { updatedAt: null, total: 0, scales: [] };
  sendJson(res, 200, { ok: true, ...payload });
}

/**
 * 路由：GET /api/scales、GET /api/scales/:id、POST /api/scales/score，
 * 以及自评问卷历史：GET/DELETE /api/scales/history、DELETE /api/scales/history/:id。
 * `/history` 必须在 `GET /api/scales/:id` 之前特判，避免被当成 scaleId。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string[]} segments
 * @param {object} [ctx] createContext 的上下文（含 scaleHistory / logger）
 */
export async function handleScales(req, res, segments, ctx = null) {
  try {
    const history = ctx?.scaleHistory ?? null;
    if (segments.length === 2) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, listScalesPayload());
        return;
      }
      sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
      return;
    }
    if (segments.length === 4) {
      if (segments[2] !== 'history' || req.method !== 'DELETE') {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      const entryId = safeDecode(segments[3]);
      const removed = entryId && history ? await history.remove(entryId) : false;
      if (!removed) {
        sendApiError(res, 404, 'NOT_FOUND', '未找到自评问卷历史记录');
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (segments.length === 3) {
      if (segments[2] === 'score') {
        if (req.method !== 'POST') {
          sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
          return;
        }
        await handleScore(req, res, ctx);
        return;
      }
      if (segments[2] === 'history') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          handleHistoryList(req, res, ctx);
          return;
        }
        if (req.method === 'DELETE') {
          const removed = history ? await history.clear() : 0;
          sendJson(res, 200, { ok: true, removed });
          return;
        }
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      const scaleId = safeDecode(segments[2]);
      if (!scaleId) {
        sendApiError(res, 404, 'SCALE_NOT_FOUND', '未找到自评问卷');
        return;
      }
      sendJson(res, 200, { ok: true, scale: getScalePayload(scaleId) });
      return;
    }
    sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
  } catch (error) {
    if (error instanceof HttpError) {
      sendApiError(res, error.status, error.code, error.message);
      return;
    }
    sendApiError(res, 500, 'INTERNAL', '服务器内部错误');
  }
}
