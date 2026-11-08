// effort.js — 推理等级映射：界面上「关/低/高/极深」↔ API 的 `off|low|high|max`。
// 纯函数，可在 node:test 中直接 import。

/** @typedef {'off'|'low'|'high'|'max'} EffortValue */

export const EFFORTS = Object.freeze([
  Object.freeze({ value: 'off', label: '关', note: '不请求思考过程' }),
  Object.freeze({ value: 'low', label: '低', note: '轻量推理' }),
  Object.freeze({ value: 'high', label: '高', note: '默认推理' }),
  Object.freeze({ value: 'max', label: '极深', note: '最深推理，较慢' }),
]);

export const DEFAULT_EFFORT = 'high';

/** 契约允许的取值。 */
export const EFFORT_VALUES = Object.freeze(EFFORTS.map((item) => item.value));

/** localStorage 键名（sessionId 在 app.js 里另有一个）。 */
export const EFFORT_STORAGE_KEY = 'ctf.effort';

/**
 * 非法/缺失值一律回退默认 `high`（API-CONTRACT 2 缺省值）。
 * @param {unknown} value
 * @returns {EffortValue}
 */
export function normalizeEffort(value) {
  return EFFORT_VALUES.includes(value) ? /** @type {EffortValue} */ (value) : DEFAULT_EFFORT;
}

/** 是否合法取值（不带回退）。 */
export function isValidEffort(value) {
  return EFFORT_VALUES.includes(value);
}

/**
 * 取值 → 界面标签。
 * @param {unknown} value
 * @returns {string}
 */
export function effortLabel(value) {
  const item = EFFORTS.find((entry) => entry.value === normalizeEffort(value));
  return item ? item.label : '高';
}

/**
 * 界面标签 → 取值；找不到返回 null（用于 UI 事件反解）。
 * @param {unknown} label
 * @returns {EffortValue|null}
 */
export function effortFromLabel(label) {
  const item = EFFORTS.find((entry) => entry.label === label);
  return item ? item.value : null;
}

/**
 * 循环切换：关→低→高→极深→关。用于快捷按钮。
 * @param {unknown} value
 * @returns {EffortValue}
 */
export function nextEffort(value) {
  const current = normalizeEffort(value);
  const index = EFFORT_VALUES.indexOf(current);
  return EFFORT_VALUES[(index + 1) % EFFORT_VALUES.length];
}

/**
 * 每个等级对应的说明文案。
 * @param {unknown} value
 * @returns {string}
 */
export function effortNote(value) {
  const item = EFFORTS.find((entry) => entry.value === normalizeEffort(value));
  return item ? item.note : '';
}

/**
 * 读取持久化等级（localStorage 可能不可用或被写脏）。
 * @param {{getItem:(key:string)=>string|null}|null|undefined} storage
 * @returns {EffortValue}
 */
export function loadEffort(storage) {
  try {
    const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(EFFORT_STORAGE_KEY) : null;
    return normalizeEffort(raw);
  } catch {
    return DEFAULT_EFFORT;
  }
}

/**
 * 持久化等级；写失败静默（隐私模式/配额满时界面照常工作）。
 * @param {{setItem:(key:string,value:string)=>void}|null|undefined} storage
 * @param {string} value
 * @returns {EffortValue}
 */
export function saveEffort(storage, value) {
  const normalized = normalizeEffort(value);
  try {
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(EFFORT_STORAGE_KEY, normalized);
    }
  } catch {
    /* 忽略：持久化不是可用性前提 */
  }
  return normalized;
}
