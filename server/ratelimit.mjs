// 按用户进程内限流（滑动 60s 窗口 + 并发计数；）。
//
// 契约（docs/briefs/m41-interface-contract.md 3.2）：
// - 每用户默认 20 次/分、2 并发；
// - `tryAcquire(userId)` 成功返回 `{ ok:true, release() }`（release 幂等），
//   失败返回 `{ ok:false, status:429, code:'RATE_LIMITED'|'CONCURRENCY_LIMITED', retryAfterSec }`；
// - 纯内存、无落盘（重启清零可接受）；管理员由调用方跳过（不传 role）；
// - `now` 可注入（毫秒时间戳或 Date），测试不得 sleep。
const WINDOW_MS_DEFAULT = 60_000;
const PER_MINUTE_DEFAULT = 20;
const CONCURRENCY_DEFAULT = 2;

function normalizePositiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function normalizeNow(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : now;
  } catch {
    value = undefined;
  }
  if (value instanceof Date) value = value.getTime();
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

/**
 * 创建限流器（每个进程一份，挂到 ctx.ratelimit；AUTH=on 时共享）。
 * @param {{perMinute?:number, concurrency?:number, now?:() => number|Date, windowMs?:number}} [options]
 * @returns {{tryAcquire:(userId:string) => ({ok:true, release:() => void}|{ok:false, status:429, code:'RATE_LIMITED'|'CONCURRENCY_LIMITED', retryAfterSec:number})}}
 */
export function createRateLimiter({
  perMinute = PER_MINUTE_DEFAULT,
  concurrency = CONCURRENCY_DEFAULT,
  now = () => Date.now(),
  windowMs = WINDOW_MS_DEFAULT,
} = {}) {
  const maxPerWindow = normalizePositiveInt(perMinute, PER_MINUTE_DEFAULT);
  const maxConcurrent = normalizePositiveInt(concurrency, CONCURRENCY_DEFAULT);
  const window = typeof windowMs === 'number' && Number.isFinite(windowMs) && windowMs > 0 ? windowMs : WINDOW_MS_DEFAULT;
  /** @type {Map<string, number[]>} userId → 窗口内的请求时间戳（升序） */
  const requestLog = new Map();
  /** @type {Map<string, number>} userId → 当前并发占用数 */
  const active = new Map();

  function pruneExpired(bucket, at) {
    let removed = 0;
    while (removed < bucket.length && bucket[removed] <= at - window) removed += 1;
    if (removed > 0) bucket.splice(0, removed);
  }

  /**
   * 尝试获取一个请求许可。
   * @param {string} userId
   */
  function tryAcquire(userId) {
    const uid = typeof userId === 'string' && userId.length > 0 ? userId : '';
    const at = normalizeNow(now);

    // 1) 滑动窗口频次（先做便宜的判定：超频直接拒绝，不占用并发槽）。
    let bucket = requestLog.get(uid);
    if (bucket) {
      pruneExpired(bucket, at);
      if (bucket.length === 0) {
        requestLog.delete(uid);
        bucket = undefined;
      }
    }
    if (bucket && bucket.length >= maxPerWindow) {
      const retryAfterMs = bucket[0] + window - at;
      return {
        ok: false,
        status: 429,
        code: 'RATE_LIMITED',
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    // 2) 并发槽。
    const current = active.get(uid) ?? 0;
    if (current >= maxConcurrent) {
      return { ok: false, status: 429, code: 'CONCURRENCY_LIMITED', retryAfterSec: 1 };
    }

    // 3) 占位：记一次请求 + 一个并发槽。
    if (bucket) bucket.push(at);
    else requestLog.set(uid, [at]);
    active.set(uid, current + 1);

    let released = false;
    function release() {
      if (released) return;
      released = true;
      const remaining = (active.get(uid) ?? 1) - 1;
      if (remaining <= 0) active.delete(uid);
      else active.set(uid, remaining);
    }
    return { ok: true, release };
  }

  return { tryAcquire };
}

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  perMinute: PER_MINUTE_DEFAULT,
  concurrency: CONCURRENCY_DEFAULT,
  windowMs: WINDOW_MS_DEFAULT,
});
