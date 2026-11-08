// 官方模型峰谷策略（PEAK_MODEL_POLICY=off|auto）。
//
// 语义（契约 5）：
// - policy !== 'auto'（含缺省/未知值）→ 始终 config.model，policy 返回 'off'；
// - policy === 'auto' 且 now 落在 peakHoursUtc（UTC 周一–五）→ config.peakModel，peak=true；
// - 否则 → config.model（谷段/周末），peak=false。
//
// 约束：
// - 只读 config 对象，不直接读 process.env（便于单测与管理员覆盖）；
// - 节假日无内置日历（文档已注明），按 UTC 周一–五判定；
// - 跨零点区间（如 23:00-01:00）不支持：配置任一区间非法即整体按 off 处理（保守回退）；
// - effort 参数保留在签名中（契约 5），当前峰谷策略与 effort 无关；
// - 官方记忆抽取不随峰谷（稳定人格，见 DECISIONS ）。
export const DEFAULT_PEAK_HOURS_UTC = '01:00-04:00,06:00-10:00';
export const PEAK_POLICY_VALUES = Object.freeze(['off', 'auto']);

const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * 解析 `HH:MM-HH:MM,HH:MM-HH:MM` 形式的 UTC 峰段配置。
 * @param {unknown} spec
 * @returns {Array<{start:number,end:number}>|null} 分钟区间（[start,end)）；非法返回 null
 */
export function parsePeakHours(spec) {
  const text = typeof spec === 'string' ? spec.trim() : '';
  if (text === '') return null;
  const ranges = [];
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (part === '') return null;
    const pieces = part.split('-');
    if (pieces.length !== 2) return null;
    const startMatch = CLOCK_RE.exec(pieces[0].trim());
    const endMatch = CLOCK_RE.exec(pieces[1].trim());
    if (!startMatch || !endMatch) return null;
    const start = Number(startMatch[1]) * 60 + Number(startMatch[2]);
    const end = Number(endMatch[1]) * 60 + Number(endMatch[2]);
    // 跨零点区间（start >= end）以及零长度区间均视为非法配置。
    if (start >= end) return null;
    ranges.push({ start, end });
  }
  return ranges.length > 0 ? ranges : null;
}

/**
 * 判断某一时刻是否落在峰段（UTC 周一–五）。
 * @param {Date} now
 * @param {Array<{start:number,end:number}>} ranges
 * @returns {boolean}
 */
export function isPeakTime(now, ranges) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  const weekday = now.getUTCDay(); // 0=周日 … 6=周六
  if (weekday === 0 || weekday === 6) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return ranges.some((range) => minutes >= range.start && minutes < range.end);
}

/**
 * 解析本轮官方对话应使用的模型（契约 5）。
 * @param {{config?: object, effort?: string|null, now?: Date|number}} [opts]
 * @returns {{model: string, peak: boolean, policy: 'off'|'auto'}}
 */
export function resolveOfficialModel({ config = {}, effort = null, now = new Date() } = {}) {
  void effort; // 保留签名兼容；峰谷策略与 effort 无关
  const source = config && typeof config === 'object' ? config : {};
  const baseModel = typeof source.model === 'string' ? source.model.trim() : '';
  const policyValue = PEAK_POLICY_VALUES.includes(source.peakModelPolicy) ? source.peakModelPolicy : 'off';
  const off = { model: baseModel, peak: false, policy: 'off' };
  if (policyValue !== 'auto') return off;

  const peakModel = typeof source.peakModel === 'string' ? source.peakModel.trim() : '';
  const hoursSpec =
    typeof source.peakHoursUtc === 'string' && source.peakHoursUtc.trim() !== ''
      ? source.peakHoursUtc
      : DEFAULT_PEAK_HOURS_UTC;
  const ranges = parsePeakHours(hoursSpec);
  // 未配置峰模型 / 峰段配置非法 → 整体按 off（保守回退到基础模型，不产生意外切换）。
  if (peakModel === '' || !ranges) return off;

  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return off;
  if (isPeakTime(date, ranges)) return { model: peakModel, peak: true, policy: 'auto' };
  return { model: baseModel, peak: false, policy: 'auto' };
}
