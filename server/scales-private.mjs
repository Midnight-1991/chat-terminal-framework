// 开源框架子集 / 通用化改写版：领域问卷术语替换为通用「自评问卷」表述，逻辑不变。
// 本地私有自评问卷包加载：
// 用户把受版权保护自评问卷的题面与计分规则放在本机 `<DATA_DIR>/scales-private/*.json`，
// 软件本身不携带、仓库不收录、不随部署分发；仅本机服务实例加载并计分。
//
// 每个 JSON 文件是一张自评问卷定义：v1（与内置 SCALE_DEFINITIONS 同构）或 v2（schemaVersion: 2，
// kind: "norm" 常模换算表，见 docs/API-CONTRACT.md 9.5、docs/scales.md 10.6）；完整校验复用
// `buildScaleDefinition`（内部按 schemaVersion 分派）；坏文件只记日志跳过，绝不崩溃、不打印题面内容。
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { BUILTIN_SCALE_IDS, CATEGORIES, buildScaleDefinition } from './scales.mjs';

/** 私有自评问卷目录名（位于 DATA_DIR 下；data/ 已在 .gitignore 中）。 */
export const PRIVATE_SCALES_DIR_NAME = 'scales-private';

const JSON_SUFFIX = '.json';
const BUILTIN_IDS = new Set(BUILTIN_SCALE_IDS);
const CATEGORY_IDS = new Set(CATEGORIES.map((category) => category.id));
const LOG_PREFIX = '[chat-terminal] 私有自评问卷';

/**
 * 解析私有自评问卷目录的绝对路径。
 * @param {string} dataDir 已解析的数据目录（DATA_DIR）
 * @returns {string}
 */
export function privateScalesDir(dataDir) {
  return path.join(dataDir, PRIVATE_SCALES_DIR_NAME);
}

/** 校验一张私有自评问卷定义（不打印题面）；校验通过返回原始定义，失败抛 Error（消息不含题面）。 */
function validatePrivateScale(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('文件内容必须是单个自评问卷 JSON 对象');
  }
  if (typeof definition.id !== 'string' || !definition.id.trim()) {
    throw new Error('缺少自评问卷 id');
  }
  if (BUILTIN_IDS.has(definition.id.trim())) {
    throw new Error(`id「${definition.id.trim()}」与内置自评问卷冲突`);
  }
  if (!CATEGORY_IDS.has(definition.categoryId)) {
    throw new Error(`categoryId「${String(definition.categoryId)}」不在现有分类内`);
  }
  const license = definition.source?.license;
  if (typeof license !== 'string' || !license.trim()) {
    throw new Error('source.license 必填（注明本机个人使用的授权/依据）');
  }
  // 完整 schema 校验（选项/题目/反向题/bands 或 factors/安全条目等）。
  buildScaleDefinition(definition);
  return definition;
}

/**
 * 加载 `<DATA_DIR>/scales-private/*.json` 中的本地私有自评问卷。
 * - 目录不存在 → 0 份（正常情况，与未启用私有自评问卷一致）；
 * - 文件不可读/JSON 解析失败/schema 非法/id 冲突或重复 → 记录 `errors` 并跳过；
 * - 返回按 id 排序的有效自评问卷（内置表不在返回值里，由调用方注册）。
 * @param {{dir?: string|null, logger?: {warn?: Function}}} [options]
 * @returns {Promise<{scales: object[], errors: {file: string, message: string}[], dir: string|null}>}
 */
export async function loadPrivateScalePacks({ dir = null, logger } = {}) {
  const errors = [];
  const scales = [];
  if (!dir) return { scales, errors, dir: null };

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { scales, errors, dir };
    // 权限/类型等异常不阻塞启动：记一条汇总警告后按 0 份处理。
    const message = `目录不可读（${error?.code ?? error?.message ?? '未知错误'}）`;
    errors.push({ file: dir, message });
    logger?.warn?.(`${LOG_PREFIX}跳过 ${dir}: ${message}`);
    return { scales, errors, dir };
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(JSON_SUFFIX))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const seen = new Set();
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const skip = (message) => {
      errors.push({ file, message });
      // 只打印文件名与原因；绝不打印题面/答案内容。
      logger?.warn?.(`${LOG_PREFIX}跳过 ${file}: ${message}`);
    };

    let raw;
    try {
      raw = await readFile(fullPath, 'utf8');
    } catch (error) {
      skip(`文件不可读（${error?.code ?? error?.message ?? '未知错误'}）`);
      continue;
    }

    let definition;
    try {
      definition = JSON.parse(raw);
    } catch {
      skip('JSON 解析失败');
      continue;
    }

    try {
      const validated = validatePrivateScale(definition);
      const id = validated.id.trim();
      if (seen.has(id)) throw new Error(`id「${id}」在私有自评问卷包中重复`);
      seen.add(id);
      scales.push(validated);
    } catch (error) {
      skip(error?.message ?? String(error));
    }
  }

  scales.sort((left, right) => left.id.localeCompare(right.id));
  return { scales, errors, dir };
}
