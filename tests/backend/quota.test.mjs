// 配额服务 + 进程内限流单元测试（离线、零依赖、不 sleep）。
// 覆盖契约 3.1（checkQuota：日/月窗口、resetAt、边界、重启对账）
// 与 3.2（createRateLimiter：20 次/分、2 并发、滑动窗口、release 幂等、可注入 now）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUsageService } from '../../server/usage.mjs';
import { createRateLimiter, RATE_LIMIT_DEFAULTS } from '../../server/ratelimit.mjs';

const NOW_NOV6 = '2026-11-06T10:00:00.000Z'; // 本地 2026-11-06 18:00
const DAY_RESET_ISO = '2026-11-06T16:00:00.000Z'; // 本地 2026-11-07 00:00
const MONTH_RESET_ISO = '2026-11-30T16:00:00.000Z'; // 本地 2026-12-01 00:00

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Chat Terminal-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

function makeService(t, { nowIso = NOW_NOV6 } = {}) {
  let current = new Date(nowIso);
  const service = createUsageService({
    dataDir: tempDir(t),
    logger: silentLogger(),
    now: () => current,
  });
  return {
    service,
    setNow(iso) {
      current = new Date(iso);
    },
    get nowIso() {
      return current.toISOString();
    },
  };
}

async function recordTokens(service, userId, tokens) {
  await service.record({ userId, model: 'deepseek-flash', usage: { inputTokens: tokens } });
}

// ---------------------------------------------------------------------------
// checkQuota：日窗口
// ---------------------------------------------------------------------------

test('日配额：未超限 allowed，达到上限（>=）拒绝并返回 resetAt', async (t) => {
  const { service } = makeService(t);
  const quota = { dayTokens: 100, monthTokens: null };

  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota }), { allowed: true });

  await recordTokens(service, 'u1', 60);
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota }), { allowed: true });

  await recordTokens(service, 'u1', 40);
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota }), {
    allowed: false,
    code: 'QUOTA_EXCEEDED',
    window: 'day',
    limitTokens: 100,
    usedTokens: 100,
    resetAt: DAY_RESET_ISO,
  });
});

test('日配额：limit 0 立即拒绝（usedTokens 0）', async (t) => {
  const { service } = makeService(t);
  const verdict = await service.checkQuota({ userId: 'u1', quota: { dayTokens: 0 } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.window, 'day');
  assert.equal(verdict.limitTokens, 0);
  assert.equal(verdict.usedTokens, 0);
});

test('默认配额语义：日 200k / 月 2M tokens（total = in+out+cacheRead+cacheCreation）', async (t) => {
  const { service } = makeService(t);
  const quota = { dayTokens: 200_000, monthTokens: 2_000_000 };
  await recordTokens(service, 'u1', 199_999);
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota }), { allowed: true });

  await recordTokens(service, 'u1', 1);
  const dayVerdict = await service.checkQuota({ userId: 'u1', quota });
  assert.equal(dayVerdict.allowed, false);
  assert.equal(dayVerdict.window, 'day');
  assert.equal(dayVerdict.usedTokens, 200_000);

  // 月窗口：把日限放宽，累计到 2M 时按 month 拒绝。
  const looseDay = { dayTokens: 10_000_000, monthTokens: 2_000_000 };
  await recordTokens(service, 'u1', 2_000_000 - 200_000);
  const monthVerdict = await service.checkQuota({ userId: 'u1', quota: looseDay });
  assert.equal(monthVerdict.allowed, false);
  assert.equal(monthVerdict.window, 'month');
  assert.equal(monthVerdict.usedTokens, 2_000_000);
  assert.equal(monthVerdict.resetAt, MONTH_RESET_ISO);
});

test('月配额：跨天累计、按 month 拒绝、resetAt 为下月 1 日 00:00 本地', async (t) => {
  const { service, setNow } = makeService(t, { nowIso: '2026-11-01T10:00:00.000Z' });
  await recordTokens(service, 'u1', 60);
  setNow(NOW_NOV6);
  await recordTokens(service, 'u1', 60);

  const verdict = await service.checkQuota({ userId: 'u1', quota: { monthTokens: 100 } });
  assert.deepEqual(verdict, {
    allowed: false,
    code: 'QUOTA_EXCEEDED',
    window: 'month',
    limitTokens: 100,
    usedTokens: 120,
    resetAt: MONTH_RESET_ISO,
  });
});

test('日限优先于月限：同时超限时报 window=day', async (t) => {
  const { service } = makeService(t);
  await recordTokens(service, 'u1', 500);
  const verdict = await service.checkQuota({ userId: 'u1', quota: { dayTokens: 100, monthTokens: 100 } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.window, 'day');
});

test('配额豁免：admin/null 与非法配额值 → 不限（由调用方传 null 实现管理员豁免）', async (t) => {
  const { service } = makeService(t);
  await recordTokens(service, 'u1', 500_000);

  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota: null }), { allowed: true });
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota: undefined }), { allowed: true });
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota: {} }), { allowed: true });
  assert.deepEqual(
    await service.checkQuota({ userId: 'u1', quota: { dayTokens: null, monthTokens: null } }),
    { allowed: true },
  );
  // 非法值（字符串/负数/NaN）当未配置处理。
  assert.deepEqual(
    await service.checkQuota({ userId: 'u1', quota: { dayTokens: 'abc', monthTokens: -1 } }),
    { allowed: true },
  );
  // 未知用户、正额度 → allowed（没有记录即 0 已用）。
  assert.deepEqual(await service.checkQuota({ userId: 'u-nobody', quota: { dayTokens: 100 } }), { allowed: true });
});

test('配额跨日重置：本地 23:59:59.999 拒绝 → 本地次日 00:00 放行', async (t) => {
  const { service, setNow } = makeService(t, { nowIso: '2026-11-06T15:59:59.999Z' });
  const quota = { dayTokens: 100 };
  await recordTokens(service, 'u1', 100);
  const before = await service.checkQuota({ userId: 'u1', quota });
  assert.equal(before.allowed, false);
  assert.equal(before.resetAt, DAY_RESET_ISO);

  setNow('2026-11-06T16:00:00.000Z'); // 本地 2026-11-07 00:00
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota }), { allowed: true });
});

test('配额跨月重置：11-30 23:00 拒绝 → 12-01 00:30 放行', async (t) => {
  const { service, setNow } = makeService(t, { nowIso: '2026-11-30T15:00:00.000Z' });
  const quota = { dayTokens: null, monthTokens: 100 };
  await recordTokens(service, 'u1', 100);
  const before = await service.checkQuota({ userId: 'u1', quota });
  assert.equal(before.allowed, false);
  assert.equal(before.window, 'month');
  assert.equal(before.resetAt, MONTH_RESET_ISO);

  setNow('2026-11-30T16:30:00.000Z'); // 本地 2026-12-01 00:30
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota: { dayTokens: null, monthTokens: 100 } }), {
    allowed: true,
  });
});

test('配额按用户隔离；重启后从 JSONL 对账继续执行配额', async (t) => {
  const dataDir = tempDir(t);
  const first = createUsageService({ dataDir, logger: silentLogger(), now: () => new Date(NOW_NOV6) });
  await recordTokens(first, 'u1', 100);
  await recordTokens(first, 'u2', 10);

  const second = createUsageService({ dataDir, logger: silentLogger(), now: () => new Date(NOW_NOV6) });
  const u1Verdict = await second.checkQuota({ userId: 'u1', quota: { dayTokens: 100 } });
  assert.equal(u1Verdict.allowed, false);
  assert.equal(u1Verdict.usedTokens, 100);
  assert.deepEqual(await second.checkQuota({ userId: 'u2', quota: { dayTokens: 100 } }), { allowed: true });
});

// ---------------------------------------------------------------------------
// createRateLimiter：频次
// ---------------------------------------------------------------------------

test('限流默认值：20 次/分、2 并发（契约 3.2）', () => {
  assert.deepEqual(RATE_LIMIT_DEFAULTS, { perMinute: 20, concurrency: 2, windowMs: 60_000 });
  const limiter = createRateLimiter();
  assert.equal(typeof limiter.tryAcquire, 'function');
});

test('限流：每用户 20 次/分，第 21 次 429 RATE_LIMITED，retryAfterSec 提示窗口剩余', () => {
  let nowMs = 1_000;
  const limiter = createRateLimiter({ now: () => nowMs });
  for (let index = 0; index < 20; index += 1) {
    const result = limiter.tryAcquire('u1');
    assert.equal(result.ok, true, `第 ${index + 1} 次应放行`);
    result.release();
  }
  const limited = limiter.tryAcquire('u1');
  assert.equal(limited.ok, false);
  assert.equal(limited.status, 429);
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.equal(limited.retryAfterSec, 60);
});

test('限流：60s 滑动窗口边界（59999ms 拒绝 → 60000ms 放行），不 sleep', () => {
  let nowMs = 0;
  const limiter = createRateLimiter({ now: () => nowMs });
  for (let index = 0; index < 20; index += 1) {
    const result = limiter.tryAcquire('u1');
    result.release();
  }

  nowMs = 59_999;
  const justBefore = limiter.tryAcquire('u1');
  assert.equal(justBefore.ok, false);
  assert.equal(justBefore.retryAfterSec, 1);

  nowMs = 60_000;
  const atBoundary = limiter.tryAcquire('u1');
  assert.equal(atBoundary.ok, true);
  atBoundary.release();
});

test('限流：按用户隔离，互不占用额度', () => {
  const limiter = createRateLimiter({ now: () => 0 });
  for (let index = 0; index < 20; index += 1) {
    limiter.tryAcquire('u1').release();
  }
  assert.equal(limiter.tryAcquire('u1').ok, false);
  assert.equal(limiter.tryAcquire('u2').ok, true);
});

// ---------------------------------------------------------------------------
// createRateLimiter：并发
// ---------------------------------------------------------------------------

test('并发：默认 2 并发，第 3 个 429 CONCURRENCY_LIMITED，release 后释放槽位', () => {
  const limiter = createRateLimiter({ now: () => 0 });
  const first = limiter.tryAcquire('u1');
  const second = limiter.tryAcquire('u1');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const third = limiter.tryAcquire('u1');
  assert.equal(third.ok, false);
  assert.equal(third.status, 429);
  assert.equal(third.code, 'CONCURRENCY_LIMITED');
  assert.equal(third.retryAfterSec, 1);

  first.release();
  const fourth = limiter.tryAcquire('u1');
  assert.equal(fourth.ok, true);

  second.release();
  fourth.release();
  // 全部释放后恢复 2 并发。
  const a = limiter.tryAcquire('u1');
  const b = limiter.tryAcquire('u1');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  a.release();
  b.release();
});

test('并发：release 幂等（重复 release 不重复释放、不 throw）', () => {
  const limiter = createRateLimiter({ now: () => 0 });
  const first = limiter.tryAcquire('u1');
  const second = limiter.tryAcquire('u1');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  assert.doesNotThrow(() => {
    first.release();
    first.release();
    first.release();
  });

  // 只释放了 1 个槽位：还能再进 1 个，第 2 个应被并发限制。
  const third = limiter.tryAcquire('u1');
  assert.equal(third.ok, true);
  const fourth = limiter.tryAcquire('u1');
  assert.equal(fourth.ok, false);
  assert.equal(fourth.code, 'CONCURRENCY_LIMITED');
  second.release();
  third.release();
});

test('并发与频次顺序：窗口已满 + 并发已满时报 RATE_LIMITED（先频次后并发）', () => {
  const limiter = createRateLimiter({ now: () => 0 });
  for (let index = 0; index < 18; index += 1) {
    limiter.tryAcquire('u1').release();
  }
  const activeA = limiter.tryAcquire('u1');
  const activeB = limiter.tryAcquire('u1');
  assert.equal(activeA.ok, true);
  assert.equal(activeB.ok, true);

  const limited = limiter.tryAcquire('u1');
  assert.equal(limited.ok, false);
  assert.equal(limited.code, 'RATE_LIMITED');
  activeA.release();
  activeB.release();
});

test('限流：可自定义 perMinute/concurrency，非法值回落默认', () => {
  const limiter = createRateLimiter({ perMinute: 3, concurrency: 1, now: () => 0 });
  for (let index = 0; index < 3; index += 1) {
    limiter.tryAcquire('u1').release();
  }
  const limited = limiter.tryAcquire('u1');
  assert.equal(limited.code, 'RATE_LIMITED');

  const single = limiter.tryAcquire('other').ok;
  assert.equal(single, true);
  const busy = limiter.tryAcquire('other');
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'CONCURRENCY_LIMITED');

  const fallback = createRateLimiter({ perMinute: 0, concurrency: -1, now: () => 0 });
  const x = fallback.tryAcquire('u1');
  const y = fallback.tryAcquire('u1');
  assert.equal(x.ok, true);
  assert.equal(y.ok, true);
  const z = fallback.tryAcquire('u1');
  assert.equal(z.code, 'CONCURRENCY_LIMITED');
  x.release();
  y.release();
});

test('限流：now 可注入 Date；非法 userId 归一为空桶（不 throw）', () => {
  const limiter = createRateLimiter({ now: () => new Date(0) });
  const first = limiter.tryAcquire('u1');
  assert.equal(first.ok, true);
  first.release();
  // 空/非字符串 userId 不抛错（调用方应先做鉴权；这里只保证限流器健壮）。
  assert.doesNotThrow(() => limiter.tryAcquire(null));
  assert.doesNotThrow(() => limiter.tryAcquire(undefined));
});
