// 记录导入、按日聚合存储与对话背景注入（-B /  ~ ）。
//
// 设计要点：
//   - POST /api/health-import 用独立请求头 X-Health-Token 鉴权（timing-safe 比较）；
//     未配置 token → 503；缺/错 token → 401；仅 POST；body ≤ 512KB。
//   - 数据落 DATA_DIR/health.json（version 1，0600，tmp+rename 原子写）：
//     只存按日聚合值（steps/sleepMinutes 求和、HR/HRV/体重平均、workouts 计数/时长/能量），
//     原始 samples 绝不落盘；保留 HEALTH_RETENTION_DAYS 天（默认 180），越界清理。
//   - 可选 at-rest 加密（键由 app 注入；缺省 null = 明文）。加密数据解不开 → fail-fast。
//   - 损坏文件按空数据启动并 warn（不打印内容、不崩溃）。
//   - chat 注入最近 7 天背景摘要（≤600 字符，仅背景参考、不做诊断）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

import { isAtRestError } from './at-rest.mjs';
import { HttpError, sendApiError, sendJson, readJsonBody } from './http-utils.mjs';

export const HEALTH_FILE_NAME = 'health.json';
export const HEALTH_FILE_VERSION = 1;
export const HEALTH_IMPORT_BODY_LIMIT = 512 * 1024;
export const HEALTH_INJECT_MAX_CHARS = 600;
export const HEALTH_RETENTION_DAYS_DEFAULT = 180;
export const HEALTH_INJECT_TITLE = '## 用户主动导入的记录（背景参考）';

/** 支持的指标（workouts 单独处理）。 */
export const HEALTH_METRIC_KEYS = Object.freeze([
  'steps',
  'sleepMinutes',
  'restingHeartRate',
  'hrvMs',
  'weightKg',
]);

/** samples 允许的 type（-A 调研：workouts 可选，单位按时长处理）。 */
export const HEALTH_SAMPLE_TYPES = Object.freeze([...HEALTH_METRIC_KEYS, 'workouts']);

/** samples unit 白名单（未知 unit 一律 400；count/min 是 bpm 的常见写法，作为别名接受）。 */
export const HEALTH_UNIT_WHITELIST = Object.freeze(['count', 'min', 'sec', 'hour', 'km', 'kcal', 'bpm', 'ms', 'kg']);

const HEALTH_UNIT_ALIASES = new Map([
  ['count', 'count'],
  ['min', 'min'],
  ['sec', 'sec'],
  ['hour', 'hour'],
  ['km', 'km'],
  ['kcal', 'kcal'],
  ['bpm', 'bpm'],
  ['count/min', 'bpm'],
  ['ms', 'ms'],
  ['kg', 'kg'],
  ['millisecond', 'ms'],
  ['milliseconds', 'ms'],
  ['second', 'sec'],
  ['seconds', 'sec'],
  ['minute', 'min'],
  ['minutes', 'min'],
  ['hour', 'hour'],
  ['hours', 'hour'],
]);

/** type → 允许的 unit；workouts 只接受时长单位（kcal 走 metrics.workouts）。 */
const HEALTH_TYPE_UNITS = Object.freeze({
  steps: ['count'],
  sleepMinutes: ['min', 'sec', 'hour'],
  restingHeartRate: ['bpm'],
  hrvMs: ['ms'],
  weightKg: ['kg'],
  workouts: ['min', 'sec', 'hour'],
});

const HEALTH_DEFAULT_UNIT = Object.freeze({
  steps: 'count',
  sleepMinutes: 'min',
  restingHeartRate: 'bpm',
  hrvMs: 'ms',
  weightKg: 'kg',
  workouts: 'min',
});

/** 逐日聚合口径：求和 / 平均（weightKg 例外：取当日最后一条）。 */
const HEALTH_SUM_KEYS = new Set(['steps', 'sleepMinutes']);
const HEALTH_AVG_KEYS = new Set(['restingHeartRate', 'hrvMs', 'weightKg']);

/** 数值范围保护：拒绝明显不可能的值，避免脏数据进入注入文本。 */
const HEALTH_METRIC_LIMITS = Object.freeze({
  steps: { min: 0, max: 1_000_000 },
  sleepMinutes: { min: 0, max: 1_440 },
  restingHeartRate: { min: 1, max: 300 },
  hrvMs: { min: 0, max: 2_000 },
  weightKg: { min: 0.5, max: 500 },
});

const HEALTH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEALTH_MAX_SAMPLES = 5_000;
const HEALTH_MAX_WORKOUTS = 50;
const HEALTH_MAX_WORKOUT_TYPE_CHARS = 40;
const HEALTH_MAX_WORKOUT_MINUTES = 1_440;
/** 最近 7 天摘要窗口。 */
const HEALTH_SUMMARY_DAYS = 7;

function invalid(message) {
  return new HttpError(400, 'INVALID_HEALTH_PAYLOAD', message);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** 本地时区日期字符串（YYYY-MM-DD），与「按自然日聚合」的语义一致。 */
export function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateString(value) {
  if (typeof value !== 'string' || !HEALTH_DATE_RE.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return value;
}

/** 数值宽容：number 或数字字符串（快捷指令常把统计值拼成字符串）都接受。 */
function toFiniteNumber(value, label) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      const parsed = Number(text);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  throw invalid(`${label} 必须是数字`);
}

/** unit 白名单 + type 兼容性校验（缺省按 type 默认单位）。 */
function normalizeUnit(type, unit) {
  const allowed = HEALTH_TYPE_UNITS[type];
  const fallback = HEALTH_DEFAULT_UNIT[type];
  if (unit === undefined || unit === null || unit === '') return fallback;
  if (typeof unit !== 'string') throw invalid('samples[].unit 必须是字符串');
  const normalized = HEALTH_UNIT_ALIASES.get(unit.trim().toLowerCase());
  if (!normalized) {
    throw invalid(`不支持的 unit：${unit}（白名单 ${HEALTH_UNIT_WHITELIST.join('/')}）`);
  }
  if (!allowed.includes(normalized)) {
    throw invalid(`unit ${unit} 不适用于 type ${type}`);
  }
  return normalized;
}

/** 只把时长类单位换算成规范值：sleepMinutes/workouts 统一为分钟。 */
function convertToMetricValue(type, value, unit) {
  if (type === 'sleepMinutes' || type === 'workouts') {
    if (unit === 'sec') return round2(value / 60);
    if (unit === 'hour') return round2(value * 60);
  }
  return round2(value);
}

function requireMetricValue(key, value, label) {
  const limits = HEALTH_METRIC_LIMITS[key];
  const number = toFiniteNumber(value, label);
  if (number < limits.min || number > limits.max) {
    throw invalid(`${label} 超出允许范围（${limits.min}–${limits.max}）`);
  }
  return round2(number);
}

function normalizeWorkouts(value, label = 'metrics.workouts') {
  if (!Array.isArray(value)) throw invalid(`${label} 必须是数组`);
  if (value.length > HEALTH_MAX_WORKOUTS) {
    throw invalid(`${label} 单次最多 ${HEALTH_MAX_WORKOUTS} 条`);
  }
  return value.map((item, index) => {
    const prefix = `${label}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid(`${prefix} 必须是对象`);
    }
    const type = typeof item.type === 'string' ? item.type.trim() : '';
    if (!type) throw invalid(`${prefix}.type 必须是非空字符串`);
    if (Array.from(type).length > HEALTH_MAX_WORKOUT_TYPE_CHARS) {
      throw invalid(`${prefix}.type 过长（上限 ${HEALTH_MAX_WORKOUT_TYPE_CHARS} 字符）`);
    }
    const minutes = toFiniteNumber(item.minutes, `${prefix}.minutes`);
    if (minutes <= 0 || minutes > HEALTH_MAX_WORKOUT_MINUTES) {
      throw invalid(`${prefix}.minutes 超出允许范围（0–${HEALTH_MAX_WORKOUT_MINUTES}）`);
    }
    const workout = { type, minutes: round2(minutes) };
    if (item.kcal !== undefined) {
      const kcal = toFiniteNumber(item.kcal, `${prefix}.kcal`);
      if (kcal < 0) throw invalid(`${prefix}.kcal 必须是非负数字`);
      workout.kcal = round2(kcal);
    }
    return workout;
  });
}

/** 校验并归一化 metrics（当日预聚合）。 */
export function normalizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw invalid('metrics 必须是 JSON 对象');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'workouts') {
      normalized.workouts = normalizeWorkouts(value);
      continue;
    }
    if (!HEALTH_METRIC_KEYS.includes(key)) {
      throw invalid(`不支持的指标：${key}`);
    }
    normalized[key] = requireMetricValue(key, value, `metrics.${key}`);
  }
  if (Object.keys(normalized).length === 0) {
    throw invalid('metrics 不能为空');
  }
  return normalized;
}

/**
 * 校验并聚合 samples（原始样本，服务端按日聚合）。
 * - type 白名单：steps/sleepMinutes/restingHeartRate/hrvMs/weightKg/workouts；
 * - value 接受 number 或数字字符串；unit 走白名单并按 type 兼容性校验、时长单位换算成分钟；
 * - 日期优先取 payload.date，其次每条样本 start/end 的服务器本地日期；
 * - steps/sleepMinutes 求和、HR/HRV 平均、weightKg 取当日 start 最新一条、workouts 计数+时长。
 * 返回 Map<date, 当日聚合值>。
 */
export function aggregateSamples(samples, dateHint = null) {
  if (!Array.isArray(samples)) throw invalid('samples 必须是数组');
  if (samples.length === 0) throw invalid('samples 不能为空');
  if (samples.length > HEALTH_MAX_SAMPLES) {
    throw invalid(`samples 单次最多 ${HEALTH_MAX_SAMPLES} 条`);
  }
  const buckets = new Map();
  for (const [index, sample] of samples.entries()) {
    const prefix = `samples[${index}]`;
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
      throw invalid(`${prefix} 必须是对象`);
    }
    const type = typeof sample.type === 'string' ? sample.type.trim() : '';
    if (!HEALTH_SAMPLE_TYPES.includes(type)) {
      throw invalid(`${prefix}.type 不支持（可选 ${HEALTH_SAMPLE_TYPES.join('/')}）`);
    }
    const unit = normalizeUnit(type, sample.unit);
    const value = convertToMetricValue(
      type,
      toFiniteNumber(sample.value, `${prefix}.value`),
      unit,
    );
    if (type === 'workouts') {
      if (value <= 0 || value > HEALTH_MAX_WORKOUT_MINUTES) {
        throw invalid(`${prefix}.value 超出允许范围（0–${HEALTH_MAX_WORKOUT_MINUTES} 分钟）`);
      }
    } else {
      const limits = HEALTH_METRIC_LIMITS[type];
      if (value < limits.min || value > limits.max) {
        throw invalid(`${prefix}.value 超出允许范围（${limits.min}–${limits.max}）`);
      }
    }
    let date = dateHint;
    let timestamp = null;
    const rawTimestamp = sample.start ?? sample.end;
    if (rawTimestamp !== undefined) {
      const parsed = new Date(rawTimestamp);
      if (!Number.isFinite(parsed.getTime())) {
        throw invalid(`${prefix} 的 start/end 不是合法时间`);
      }
      timestamp = parsed.getTime();
      if (!date) date = formatLocalDate(parsed);
    }
    if (!date) {
      throw invalid('samples 缺少日期：请提供 date 字段或每条样本的 start/end');
    }
    let bucket = buckets.get(date);
    if (!bucket) {
      bucket = { sums: new Map(), counts: new Map(), workouts: [] };
      buckets.set(date, bucket);
    }
    if (type === 'workouts') {
      const rawName = typeof sample.name === 'string' ? sample.name.trim() : '';
      const name = rawName ? Array.from(rawName).slice(0, HEALTH_MAX_WORKOUT_TYPE_CHARS).join('') : '运动';
      bucket.workouts.push({ type: name, minutes: round2(value) });
      continue;
    }
    if (type === 'weightKg') {
      // 体重取当日 start 最新的一条（不是平均）。
      const candidate = { value: round2(value), timestamp, order: index };
      if (!bucket.weight || isLaterSample(candidate, bucket.weight)) bucket.weight = candidate;
      continue;
    }
    bucket.sums.set(type, (bucket.sums.get(type) ?? 0) + value);
    bucket.counts.set(type, (bucket.counts.get(type) ?? 0) + 1);
  }
  const days = new Map();
  for (const [date, bucket] of buckets) {
    const entry = {};
    for (const key of HEALTH_SUM_KEYS) {
      if (bucket.sums.has(key)) entry[key] = round2(bucket.sums.get(key));
    }
    for (const key of HEALTH_AVG_KEYS) {
      if (key === 'weightKg') continue;
      if (bucket.sums.has(key)) {
        entry[key] = round2(bucket.sums.get(key) / bucket.counts.get(key));
      }
    }
    if (bucket.weight) entry.weightKg = bucket.weight.value;
    if (bucket.workouts.length > 0) entry.workouts = bucket.workouts;
    if (Object.keys(entry).length > 0) days.set(date, entry);
  }
  return days;
}

/** 同一天内两条体重样本的先后：有 start 时间按时间，无时间按数组顺序。 */
function isLaterSample(candidate, current) {
  if (candidate.timestamp !== null && current.timestamp !== null) {
    return candidate.timestamp >= current.timestamp;
  }
  return candidate.order > current.order;
}

/**
 * 扁平字段兼容：iOS 快捷指令的「JSON 请求体」里逐字段填写比嵌套字典简单得多，
 * 因此允许把步骤/睡眠/心率等指标写在顶层，等同于 metrics。<metrics> 存在时优先。
 */
const FLAT_METRIC_KEYS = ['steps', 'sleepMinutes', 'restingHeartRate', 'hrvMs', 'weightKg'];

/** 由扁平字段 workoutsCount / workoutsMinutes 合成 workouts 数组（仅供快捷指令简化填写）。 */
function synthesizeWorkouts(countValue, minutesValue) {
  const count = countValue === undefined ? 0 : toFiniteNumber(countValue, 'workoutsCount');
  if (!Number.isInteger(count) || count < 0 || count > HEALTH_MAX_WORKOUTS) {
    throw invalid(`workoutsCount 必须是 0–${HEALTH_MAX_WORKOUTS} 的整数`);
  }
  const minutes = minutesValue === undefined ? 0 : toFiniteNumber(minutesValue, 'workoutsMinutes');
  if (minutes < 0 || minutes > HEALTH_MAX_WORKOUT_MINUTES) {
    throw invalid(`workoutsMinutes 超出允许范围（0–${HEALTH_MAX_WORKOUT_MINUTES}）`);
  }
  if (count === 0 && minutes === 0) return [];
  const total = count === 0 ? 1 : count;
  if (minutes <= 0) throw invalid('workoutsCount 大于 0 时需同时提供 workoutsMinutes');
  const per = round2(minutes / total);
  return Array.from({ length: total }, () => ({ type: '运动', minutes: per }));
}

/**
 * 解析导入 body：支持 metrics / samples 两形态（也可同时提供，metrics 覆盖同日样本聚合值）。
 * @returns {{dateHint: string|null, metrics: object|null, sampleDays: Map<string, object>|null}}
 */
export function parseHealthPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid('请求体必须是 JSON 对象');
  }
  let metricsInput = payload.metrics;
  if (metricsInput === undefined) {
    const flat = {};
    for (const key of FLAT_METRIC_KEYS) {
      if (payload[key] !== undefined) flat[key] = payload[key];
    }
    if (payload.workouts !== undefined) {
      flat.workouts = payload.workouts;
    } else if (payload.workoutsCount !== undefined || payload.workoutsMinutes !== undefined) {
      flat.workouts = synthesizeWorkouts(payload.workoutsCount, payload.workoutsMinutes);
    }
    if (Object.keys(flat).length > 0) metricsInput = flat;
  }
  const hasMetrics = metricsInput !== undefined;
  const hasSamples = payload.samples !== undefined;
  if (!hasMetrics && !hasSamples) {
    throw invalid('请求体必须包含 metrics 或 samples（也可直接使用 steps/sleepMinutes/restingHeartRate 等扁平字段）');
  }
  let dateHint = null;
  if (payload.date !== undefined) {
    dateHint = parseDateString(payload.date);
    if (!dateHint) throw invalid('date 必须是合法的 YYYY-MM-DD 日期');
  }
  // source 为可选来源标识（如 ios-shortcuts），仅做类型/长度校验、不落盘。
  if (payload.source !== undefined) {
    if (typeof payload.source !== 'string' || Array.from(payload.source).length > 60) {
      throw invalid('source 必须是不超过 60 字符的字符串');
    }
  }
  return {
    dateHint,
    metrics: hasMetrics ? normalizeMetrics(metricsInput) : null,
    sampleDays: hasSamples ? aggregateSamples(payload.samples, dateHint) : null,
  };
}

/** 最近 7 个自然日的日期集合（含今天）。 */
function recentDates(days = HEALTH_SUMMARY_DAYS) {
  const dates = [];
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    dates.push(formatLocalDate(date));
  }
  return dates;
}

function averageOf(values) {
  if (values.length === 0) return null;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** 最近 7 天摘要；无数据的字段为 null，workouts 为 0。 */
export function buildLast7Summary(days) {
  const dates = recentDates();
  const steps = [];
  const sleep = [];
  const restingHr = [];
  const hrv = [];
  const workoutCounts = [];
  const workoutMinutes = [];
  let weightKg = null;
  for (const date of dates) {
    const entry = days[date];
    if (!entry) continue;
    if (Number.isFinite(entry.steps)) steps.push(entry.steps);
    if (Number.isFinite(entry.sleepMinutes)) sleep.push(entry.sleepMinutes);
    if (Number.isFinite(entry.restingHeartRate)) restingHr.push(entry.restingHeartRate);
    if (Number.isFinite(entry.hrvMs)) hrv.push(entry.hrvMs);
    const workouts = Array.isArray(entry.workouts) ? entry.workouts : [];
    workoutCounts.push(workouts.length);
    workoutMinutes.push(workouts.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0));
    if (Number.isFinite(entry.weightKg)) weightKg = entry.weightKg;
  }
  return {
    last7: {
      stepsAvg: averageOf(steps),
      sleepAvgMinutes: averageOf(sleep),
      restingHrAvg: averageOf(restingHr),
      hrvAvgMs: averageOf(hrv),
      weightKg: weightKg === null ? null : round2(weightKg),
      workoutsCount: workoutCounts.reduce((sum, count) => sum + count, 0),
      workoutsMinutes: round2(workoutMinutes.reduce((sum, minutes) => sum + minutes, 0)),
    },
  };
}

function formatMetric(value, unit = '') {
  const rounded = Number.isInteger(value) ? String(value) : String(round2(value));
  return `${rounded}${unit}`;
}

/** 生成注入文本（≤600 字符）；无数据或注入关闭时 text=''、count=0。 */
export function buildInjectSuffix(days, { inject = true } = {}) {
  if (!inject) return { text: '', count: 0 };
  const { last7 } = buildLast7Summary(days);
  const items = [];
  if (last7.stepsAvg !== null) items.push(`日均步数 ${formatMetric(last7.stepsAvg)}`);
  if (last7.sleepAvgMinutes !== null) {
    items.push(`日均睡眠 ${formatMetric(round2(last7.sleepAvgMinutes / 60), ' 小时')}`);
  }
  if (last7.restingHrAvg !== null) items.push(`静息心率均值 ${formatMetric(last7.restingHrAvg, ' bpm')}`);
  if (last7.hrvAvgMs !== null) items.push(`HRV 均值 ${formatMetric(last7.hrvAvgMs, ' ms')}`);
  if (last7.weightKg !== null) items.push(`最近体重 ${formatMetric(last7.weightKg, ' kg')}`);
  if (last7.workoutsCount > 0) {
    items.push(`运动 ${last7.workoutsCount} 次共 ${formatMetric(last7.workoutsMinutes, ' 分钟')}`);
  }
  if (items.length === 0) return { text: '', count: 0 };
  const lines = items.join('；');
  let text = `\n\n${HEALTH_INJECT_TITLE}\n- 最近 7 天：${lines}。\n- 用户主动导入，仅作背景参考，不做诊断、不解释异常、不据数据下结论。`;
  const chars = Array.from(text);
  if (chars.length > HEALTH_INJECT_MAX_CHARS) {
    text = `${chars.slice(0, HEALTH_INJECT_MAX_CHARS - 1).join('')}…`;
  }
  return { text, count: items.length };
}

/** 恒定时间比较 token（先做定长摘要，避免长度差异泄漏）。 */
export function tokenMatches(configuredToken, providedToken) {
  if (typeof configuredToken !== 'string' || configuredToken === '') return false;
  if (typeof providedToken !== 'string' || providedToken === '') return false;
  const expected = createHash('sha256').update(configuredToken).digest();
  const actual = createHash('sha256').update(providedToken).digest();
  return timingSafeEqual(expected, actual);
}

function sanitizeDayEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = {};
  for (const key of HEALTH_METRIC_KEYS) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      entry[key] = round2(value);
    }
  }
  if (Array.isArray(raw.workouts)) {
    entry.workouts = raw.workouts
      .filter((item) => item && typeof item === 'object' && typeof item.type === 'string')
      .slice(0, HEALTH_MAX_WORKOUTS)
      .map((item) => {
        const workout = { type: item.type, minutes: round2(Number(item.minutes) || 0) };
        if (Number.isFinite(item.kcal)) workout.kcal = round2(item.kcal);
        return workout;
      });
  }
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) {
    entry.updatedAt = raw.updatedAt;
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

function normalizeLoadedState(parsed) {
  const state = {
    version: HEALTH_FILE_VERSION,
    updatedAt: null,
    lastImportedAt: null,
    days: {},
  };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return state;
  if (Number.isFinite(parsed.updatedAt)) state.updatedAt = parsed.updatedAt;
  if (Number.isFinite(parsed.lastImportedAt)) state.lastImportedAt = parsed.lastImportedAt;
  const source = parsed.days && typeof parsed.days === 'object' && !Array.isArray(parsed.days)
    ? parsed.days
    : {};
  for (const [date, raw] of Object.entries(source)) {
    if (!parseDateString(date)) continue;
    const entry = sanitizeDayEntry(raw);
    if (entry) state.days[date] = entry;
  }
  return state;
}

async function writeJsonAtomic(filePath, data, logger, atRest = null) {
  try {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.chmod(dir, 0o700);
    } catch {
      /* 非 POSIX 或权限不足时忽略 */
    }
    const tmpPath = `${filePath}.tmp`;
    // at-rest 开启时整份 JSON 加密后再落盘。
    const text = `${JSON.stringify(data, null, 2)}\n`;
    const payload = atRest ? atRest.seal(filePath, Buffer.from(text, 'utf8')) : text;
    await fs.promises.writeFile(tmpPath, payload, {
      encoding: typeof payload === 'string' ? 'utf8' : undefined,
      mode: 0o600,
    });
    await fs.promises.rename(tmpPath, filePath);
    try {
      await fs.promises.chmod(filePath, 0o600);
    } catch {
      /* 同上 */
    }
    return true;
  } catch (error) {
    logger?.warn?.(`[health] 写入 health.json 失败：${error?.message ?? error}`);
    return false;
  }
}

/**
 * 记录存储（按 DATA_DIR 单实例创建）。
 * @param {{dataDir: string, config: object, logger?: object, atRest?: object|null}} options
 */
export async function createHealthStore({ dataDir, config, logger = console, atRest = null } = {}) {
  const retentionDays =
    Number.isFinite(config?.healthRetentionDays) && config.healthRetentionDays > 0
      ? Math.min(Math.floor(config.healthRetentionDays), 3_650)
      : HEALTH_RETENTION_DAYS_DEFAULT;
  const filePath = path.join(dataDir, HEALTH_FILE_NAME);
  const state = {
    version: HEALTH_FILE_VERSION,
    updatedAt: null,
    lastImportedAt: null,
    days: {},
  };

  /** @type {Set<Promise<unknown>>} 挂起中的写盘 promise（优雅关闭 flush 用）。 */
  const pendingWrites = new Set();

  function persist() {
    const promise = writeJsonAtomic(
      filePath,
      {
        version: HEALTH_FILE_VERSION,
        updatedAt: state.updatedAt,
        lastImportedAt: state.lastImportedAt,
        days: state.days,
      },
      logger,
      atRest,
    );
    pendingWrites.add(promise);
    const cleanup = () => pendingWrites.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  }

  /** 等待挂起写盘完成（优雅关闭用；persist 自身从不 reject）。 */
  async function flush() {
    while (pendingWrites.size > 0) {
      await Promise.allSettled([...pendingWrites]);
    }
  }

  function pruneExpired() {
    const cutoff = formatLocalDate(new Date(Date.now() - (retentionDays - 1) * 86_400_000));
    let removed = 0;
    for (const date of Object.keys(state.days)) {
      if (date < cutoff) {
        delete state.days[date];
        removed += 1;
      }
    }
    return removed;
  }

  async function load() {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`[health] 读取 health.json 失败，按空数据启动：${error?.message ?? error}`);
      }
      return;
    }
    let text;
    try {
      // at-rest 开启时先解密；密钥错误/密文损坏必须 fail-fast（不能当损坏清空）。
      text = atRest ? atRest.unseal(filePath, raw).toString('utf8') : raw.toString('utf8');
    } catch (error) {
      if (isAtRestError(error)) throw error;
      logger?.warn?.(`[health] 解密 health.json 失败，按空数据启动：${error?.message ?? error}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 损坏文件：备份后按空数据重建；日志不打印文件内容。
      try {
        await fs.promises.rename(filePath, `${filePath}.corrupt`);
      } catch {
        /* 备份失败也继续以空数据运行 */
      }
      logger?.warn?.('[health] health.json 损坏，已按空数据重建（原文件备份为 health.json.corrupt）');
      return;
    }
    const loaded = normalizeLoadedState(parsed);
    state.updatedAt = loaded.updatedAt;
    state.lastImportedAt = loaded.lastImportedAt;
    state.days = loaded.days;
    if (pruneExpired() > 0) await persist();
  }

  await load();

  /** 对外摘要（GET /api/health 扩展字段 + 前端健康面板）。 */
  function summaryPayload() {
    const days = {};
    for (const date of Object.keys(state.days).sort()) days[date] = { ...state.days[date] };
    return {
      lastImportedAt: state.lastImportedAt,
      updatedAt: state.updatedAt,
      days,
      summary: buildLast7Summary(state.days),
    };
  }

  function healthMeta() {
    return {
      days: Object.keys(state.days).length,
      lastImportedAt: state.lastImportedAt,
      updatedAt: state.updatedAt,
    };
  }

  function mergeIntoDay(date, incoming) {
    const existing = state.days[date] ?? {};
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = value;
    }
    merged.updatedAt = Date.now();
    state.days[date] = merged;
  }

  /** 导入一份 payload：按日聚合、同日合并覆盖本次提供的字段，然后清理过期并原子写。 */
  async function importPayload(payload) {
    const { dateHint, metrics, sampleDays } = parseHealthPayload(payload);
    const incoming = new Map();
    let metricValues = 0;
    if (sampleDays) {
      for (const [date, entry] of sampleDays) {
        incoming.set(date, { ...(incoming.get(date) ?? {}), ...entry });
        metricValues += Object.keys(entry).length;
      }
    }
    if (metrics) {
      const date = dateHint ?? formatLocalDate(new Date());
      const { workouts, ...numeric } = metrics;
      const entry = { ...numeric, ...(workouts !== undefined ? { workouts } : {}) };
      incoming.set(date, { ...(incoming.get(date) ?? {}), ...entry });
      metricValues += Object.keys(entry).length;
    }
    const now = Date.now();
    for (const [date, entry] of incoming) mergeIntoDay(date, entry);
    state.lastImportedAt = now;
    state.updatedAt = now;
    pruneExpired();
    await persist();
    const dates = [...incoming.keys()].sort();
    const primaryDate = dateHint ?? dates[dates.length - 1] ?? formatLocalDate(new Date());
    return {
      ok: true,
      date: primaryDate,
      imported: { date: primaryDate, days: incoming.size, metrics: metricValues },
      health: healthMeta(),
    };
  }

  /** 清空全部记录（DELETE /api/health）。 */
  async function clear() {
    const cleared = Object.keys(state.days).length;
    state.days = {};
    state.updatedAt = Date.now();
    state.lastImportedAt = null;
    await persist();
    return { cleared };
  }

  /** chat 注入段（memory 注入之后追加）。 */
  function buildSuffix() {
    return buildInjectSuffix(state.days, {
      inject: config?.healthInject !== false && config?.healthImport !== false,
    });
  }

  return {
    filePath,
    retentionDays,
    summaryPayload,
    healthMeta,
    importPayload,
    clear,
    buildSuffix,
    flush,
    get days() {
      return state.days;
    },
  };
}

/** POST /api/health-import：独立 token 鉴权 + 512KB body + 聚合存储。 */
export async function handleHealthImport(req, res, ctx) {
  if (req.method !== 'POST') {
    res.setHeader?.('allow', 'POST');
    sendApiError(res, 405, 'METHOD_NOT_ALLOWED', '健康导入仅支持 POST');
    return;
  }
  const config = ctx.config;
  if (!config.healthImport || !config.healthImportToken) {
    sendApiError(
      res,
      503,
      'HEALTH_IMPORT_DISABLED',
      '健康导入未启用（需设置 HEALTH_IMPORT_TOKEN）',
    );
    return;
  }
  const provided = req.headers['x-health-token'];
  if (!provided) {
    sendApiError(res, 401, 'HEALTH_TOKEN_MISSING', '缺少 X-Health-Token 请求头');
    return;
  }
  if (!tokenMatches(config.healthImportToken, provided)) {
    sendApiError(res, 401, 'HEALTH_TOKEN_INVALID', 'X-Health-Token 不正确');
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(req, { limit: HEALTH_IMPORT_BODY_LIMIT });
  } catch (error) {
    if (error instanceof HttpError && String(error.message).includes('过大')) {
      sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', '请求体过大（上限 512KB）');
      return;
    }
    sendApiError(res, 400, 'INVALID_HEALTH_PAYLOAD', error?.message ?? '请求体不合法');
    return;
  }
  try {
    const result = await ctx.health.importPayload(payload);
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof HttpError) {
      sendApiError(res, error.status ?? 400, 'INVALID_HEALTH_PAYLOAD', error.message);
      return;
    }
    throw error;
  }
}
