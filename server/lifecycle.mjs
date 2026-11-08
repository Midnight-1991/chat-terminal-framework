//  /  / 契约 2：进程生命周期基元。
// - flush registry：各模块注册自己的 flush()（store/usage/health/marks/scales-history），
//   优雅关闭时由 bin/serve.mjs 统一 shutdown，按注册顺序等待落盘。
// - requestId：'r' + 16 hex（crypto.randomBytes(8)），供 HTTP 层写入 x-request-id。
// 零第三方依赖；本模块不读 env（超时由调用方显式传入）。
import crypto from 'node:crypto';

/** 默认 flush 总超时（与契约 2 一致）。 */
export const LIFECYCLE_DEFAULT_TIMEOUT_MS = 5000;

/** request id 形状（'r' + 16 位小写 hex）。 */
export const REQUEST_ID_PATTERN = /^r[0-9a-f]{16}$/;

/**
 * 创建生命周期管理器。
 * @param {{logger?: object, timeoutMs?: number}} [options]
 * @returns {{
 *   registerFlush(name: string, fn: () => unknown): () => void,
 *   shutdown(reason?: string): Promise<{ok:boolean, flushed:number, failed:number, elapsedMs:number}>,
 *   isShuttingDown(): boolean,
 *   newRequestId(): string,
 *   timeoutMs: number,
 * }}
 */
export function createLifecycle({ logger = console, timeoutMs = LIFECYCLE_DEFAULT_TIMEOUT_MS } = {}) {
  const normalizedTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : LIFECYCLE_DEFAULT_TIMEOUT_MS;

  /** @type {Map<string, {fn: () => unknown, token: symbol}>} 插入顺序即 flush 执行顺序。 */
  const flushes = new Map();
  let shuttingDown = false;
  /** @type {Promise<{ok:boolean, flushed:number, failed:number, elapsedMs:number}>|null} */
  let shutdownPromise = null;

  const warn = (message) => {
    try {
      logger?.warn?.(`[lifecycle] ${message}`);
    } catch {
      /* logger 自身失败不影响主流程 */
    }
  };

  /**
   * 注册一个 flush 函数；返回 unregister（重复注册同名会覆盖旧函数，旧 unregister 变 no-op）。
   * @param {string} name
   * @param {() => unknown} fn
   */
  function registerFlush(name, fn) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('registerFlush 需要非空 name');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('registerFlush 需要函数');
    }
    const token = Symbol(name);
    flushes.set(name, { fn, token });
    return function unregister() {
      const current = flushes.get(name);
      if (current && current.token === token) flushes.delete(name);
    };
  }

  /**
   * 优雅关闭：置 shutting=true → 按注册顺序 await 各 flush（单个失败只记录，不中断后续）
   * → 总超时 timeoutMs 到则返回 ok=false。幂等：重复调用返回同一个 promise 的结果。
   * @param {string} [reason]
   */
  function shutdown(reason = 'manual') {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = runShutdown(reason);
    return shutdownPromise;
  }

  async function runShutdown(reason) {
    const startedAt = Date.now();
    const entries = [...flushes.entries()].map(([name, item]) => ({ name, fn: item.fn }));
    if (entries.length === 0) {
      return { ok: true, flushed: 0, failed: 0, elapsedMs: Date.now() - startedAt };
    }

    let flushed = 0;
    let failed = 0;
    let timedOut = false;
    /** @type {NodeJS.Timeout|undefined} */
    let timer;

    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, normalizedTimeoutMs);
      // 超时计时器不应阻止进程退出（bin/serve 也会各自处理退出码）。
      timer.unref?.();
    });

    const work = (async () => {
      for (const entry of entries) {
        if (timedOut) return 'aborted';
        try {
          await entry.fn();
          flushed += 1;
        } catch (error) {
          failed += 1;
          warn(`flush 失败 name=${entry.name} err=${error?.message ?? error}`);
        }
      }
      return 'done';
    })();

    let outcome;
    try {
      outcome = await Promise.race([work, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const elapsedMs = Date.now() - startedAt;
    if (outcome === 'timeout') {
      warn(
        `shutdown(${reason}) 超时（>${normalizedTimeoutMs}ms）：已完成 flush ${flushed} 个，失败 ${failed} 个`,
      );
      return { ok: false, flushed, failed, elapsedMs };
    }
    return { ok: true, flushed, failed, elapsedMs };
  }

  function isShuttingDown() {
    return shuttingDown;
  }

  /** 生成请求 id：'r' + 16 hex。 */
  function newRequestId() {
    return `r${crypto.randomBytes(8).toString('hex')}`;
  }

  return {
    registerFlush,
    shutdown,
    isShuttingDown,
    newRequestId,
    timeoutMs: normalizedTimeoutMs,
  };
}
