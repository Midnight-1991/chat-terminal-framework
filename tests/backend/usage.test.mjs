//  + server/usage.mjs 单元测试（离线、零依赖、不 sleep）。
// 覆盖契约  3.1 与  7：归一化/总量/命中率/成本、JSONL 落盘、本地时区切日、聚合查询、
// 配额边界、保留期与重启对账；增量：source/provider 落库、旧行兼容、bySource 分桶、
// checkQuota 只统计 official（BYOK 不占平台配额）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  USAGE_VERSION,
  TOKEN_FIELDS,
  USAGE_TIME_ZONE,
  USAGE_LOAD_DAYS,
  USAGE_RETENTION_DAYS,
  USAGE_SUMMARY_MAX_RANGE_DAYS,
  USAGE_STATUSES,
  USAGE_SOURCES,
  DEFAULT_USAGE_SOURCE,
  UNKNOWN_MODEL_KEY,
  normalizeUsage,
  usageTotalTokens,
  cacheHitRate,
  costOf,
  localDateKey,
  createUsageService,
} from '../../server/usage.mjs';

// 2026-11-06 官方价格（USD / 1M tokens，峰价，见 reviews/m40-metering-byok-research.md）。
const PRICES = Object.freeze({
  version: '2026-11-06',
  currency: 'USD',
  models: {
    'deepseek-flash': { inputPerM: 0.3, cacheReadPerM: 0.006, outputPerM: 1.2 },
    'deepseek-v4-pro': { inputPerM: 1.32, cacheReadPerM: 0.044, outputPerM: 3.96 },
    default: { inputPerM: 0.3, cacheReadPerM: 0.006, outputPerM: 1.2 },
  },
});

const NOW_NOV6_18 = '2026-11-06T10:00:00.000Z'; // 本地（Asia/Shanghai）2026-11-06 18:00

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Chat Terminal-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collectLogger() {
  const warnings = [];
  return {
    warnings,
    info() {},
    warn(message) {
      warnings.push(String(message));
    },
    error() {},
  };
}

function fixedNow(iso) {
  return () => new Date(iso);
}

function usageFile(dataDir, userId, dateKey) {
  return path.join(dataDir, 'usage', userId, `${dateKey}.jsonl`);
}

function readLines(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function fileMode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

test('常量与契约一致', () => {
  assert.equal(USAGE_VERSION, '2026-11-06');
  assert.deepEqual([...TOKEN_FIELDS], [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
  ]);
  assert.equal(USAGE_TIME_ZONE, 'Asia/Shanghai');
  assert.equal(USAGE_LOAD_DAYS, 90);
  assert.equal(USAGE_RETENTION_DAYS, 180);
  assert.equal(USAGE_SUMMARY_MAX_RANGE_DAYS, 90);
  assert.deepEqual([...USAGE_STATUSES], ['ok', 'error', 'aborted']);
  assert.equal(UNKNOWN_MODEL_KEY, 'unknown');
  assert.ok(Object.isFrozen(TOKEN_FIELDS));
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('normalizeUsage：缺省 0、非法值归 0、取整、忽略未知字段', () => {
  assert.deepEqual(normalizeUsage(undefined), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });
  assert.deepEqual(normalizeUsage(null), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });
  const normalized = normalizeUsage({
    inputTokens: 12.9,
    outputTokens: -5,
    cacheReadInputTokens: '100',
    cacheCreationInputTokens: Number.NaN,
    bogus: 999,
  });
  assert.deepEqual(normalized, {
    inputTokens: 12,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });
  assert.equal('bogus' in normalized, false);
  assert.equal(normalizeUsage({ inputTokens: Number.POSITIVE_INFINITY }).inputTokens, 0);
});

test('usageTotalTokens = input + output + cacheRead + cacheCreation', () => {
  assert.equal(usageTotalTokens({}), 0);
  assert.equal(
    usageTotalTokens({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 4,
    }),
    154,
  );
});

test('cacheHitRate：cacheRead/(input+cacheRead)，分母 0 → null，3 位小数', () => {
  assert.equal(cacheHitRate({}), null);
  assert.equal(cacheHitRate({ outputTokens: 100 }), null);
  assert.equal(cacheHitRate({ inputTokens: 100, cacheReadInputTokens: 0 }), 0);
  assert.equal(cacheHitRate({ inputTokens: 100, cacheReadInputTokens: 100 }), 0.5);
  assert.equal(cacheHitRate({ inputTokens: 3, cacheReadInputTokens: 1 }), 0.25);
  // total = 100，cacheRead = 100（input 0）→ 1。
  assert.equal(cacheHitRate({ cacheReadInputTokens: 100 }), 1);
});

test('costOf：已知模型按注入价格估算（USD/1M）', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadInputTokens: 2_000_000 };
  const result = costOf({ model: 'deepseek-flash', usage, prices: PRICES });
  // 0.3 + 0.6 + 0.012 = 0.912
  assert.equal(result.costUsd, 0.912);
  assert.equal(result.priced, true);
  assert.equal(result.priceVersion, '2026-11-06');

  const pro = costOf({ model: 'deepseek-v4-pro', usage: { inputTokens: 1_000_000 }, prices: PRICES });
  assert.equal(pro.costUsd, 1.32);
  assert.equal(pro.priced, true);
});

test('costOf：cacheCreation 不计价；未知模型用 default 估算且 priced:false；无表 → 0/false', () => {
  const onlyCacheCreation = costOf({
    model: 'deepseek-flash',
    usage: { cacheCreationInputTokens: 1_000_000 },
    prices: PRICES,
  });
  assert.equal(onlyCacheCreation.costUsd, 0);
  assert.equal(onlyCacheCreation.priced, true);

  const unknown = costOf({ model: 'deepseek-nebula', usage: { inputTokens: 1_000_000 }, prices: PRICES });
  assert.equal(unknown.costUsd, 0.3);
  assert.equal(unknown.priced, false);
  assert.equal(unknown.priceVersion, '2026-11-06');

  const withoutDefault = costOf({
    model: 'deepseek-nebula',
    usage: { inputTokens: 1_000_000 },
    prices: { version: 'v2', models: { 'deepseek-flash': PRICES.models['deepseek-flash'] } },
  });
  assert.equal(withoutDefault.costUsd, 0);
  assert.equal(withoutDefault.priced, false);
  assert.equal(withoutDefault.priceVersion, 'v2');

  const noTable = costOf({ model: 'deepseek-flash', usage: { inputTokens: 1_000_000 }, prices: null });
  assert.deepEqual(noTable, { costUsd: 0, priced: false, priceVersion: null });
});

test('localDateKey：Asia/Shanghai 本地切日（UTC 16:00 = 本地次日 00:00）', () => {
  assert.equal(localDateKey(new Date('2026-11-06T15:59:59.999Z')), '2026-11-06');
  assert.equal(localDateKey(new Date('2026-11-06T16:00:00.000Z')), '2026-11-07');
  assert.equal(localDateKey(new Date('2026-11-06T10:00:00.000Z')), '2026-11-06');
  assert.equal(localDateKey(new Date('2026-11-30T16:00:00.000Z')), '2026-12-01');
});

// ---------------------------------------------------------------------------
// record：JSONL 落盘
// ---------------------------------------------------------------------------

test('record：写入 DATA_DIR/usage/<uid>/<本地日期>.jsonl，行字段固定且无正文', async (t) => {
  const dataDir = tempDir(t);
  const logger = collectLogger();
  const service = createUsageService({ dataDir, config: { priceTable: PRICES }, logger, now: fixedNow(NOW_NOV6_18) });

  await service.record({
    userId: 'u0abc123def45',
    model: 'deepseek-flash',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 },
    status: 'ok',
    conversationId: 'c0abc123def45',
  });

  const filePath = usageFile(dataDir, 'u0abc123def45', '2026-11-06');
  assert.ok(fs.existsSync(filePath));
  assert.equal(fileMode(filePath), 0o600);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);

  const lines = readLines(filePath);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  // 行尾追加 source（来源）与 provider（厂商 id），均为白名单字段、无正文。
  assert.deepEqual(Object.keys(entry), [
    'ts',
    'model',
    'status',
    'conversationId',
    'usage',
    'source',
    'provider',
  ]);
  assert.equal(entry.ts, NOW_NOV6_18);
  assert.equal(entry.model, 'deepseek-flash');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.conversationId, 'c0abc123def45');
  assert.equal(entry.source, 'official');
  assert.equal(entry.provider, null);
  assert.deepEqual(entry.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 30,
    cacheCreationInputTokens: 0,
  });
});

test('record：连续追加 + 并发 25 次串行无丢行', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 1 } });
  await service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 2 } });

  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: index + 1 } }),
    ),
  );

  const filePath = usageFile(dataDir, 'u1', '2026-11-06');
  const lines = readLines(filePath);
  assert.equal(lines.length, 27);
  const entries = lines.map((line) => JSON.parse(line));
  assert.ok(entries.every((entry) => entry.model === 'deepseek-flash'));
  const requests = entries.reduce((sum, entry) => sum + entry.usage.inputTokens, 0);
  assert.equal(requests, 1 + 2 + (25 * 26) / 2);

  const totals = await service.todayTotals('u1');
  assert.equal(totals.requests, 27);
  assert.equal(totals.tokens, requests);
});

test('record：非法 userId 跳过且不 throw；status 归一化；conversationId 截断/归一', async (t) => {
  const dataDir = tempDir(t);
  const logger = collectLogger();
  const service = createUsageService({ dataDir, logger, now: fixedNow(NOW_NOV6_18) });

  await assert.doesNotReject(
    service.record({ userId: 'bad id!', model: 'deepseek-flash', usage: { inputTokens: 5 } }),
  );
  assert.equal(fs.existsSync(path.join(dataDir, 'usage')), false);
  assert.ok(logger.warnings.some((warning) => warning.includes('userId')));

  await service.record({
    userId: 'u1',
    model: '  deepseek-flash  ',
    usage: { inputTokens: 1 },
    status: 'weird-status',
    conversationId: 'x'.repeat(300),
  });
  const entry = JSON.parse(readLines(usageFile(dataDir, 'u1', '2026-11-06'))[0]);
  assert.equal(entry.status, 'ok');
  assert.equal(entry.model, 'deepseek-flash');
  assert.equal(entry.conversationId.length, 200);

  await service.record({ userId: 'u1', model: 'm', usage: {}, status: 'error', conversationId: 42 });
  const entries = readLines(usageFile(dataDir, 'u1', '2026-11-06')).map((line) => JSON.parse(line));
  assert.equal(entries[1].status, 'error');
  assert.equal(entries[1].conversationId, null);
});

test('record：本地时区跨日写入次日文件（UTC 17:30 → 本地次日 01:30）', async (t) => {
  const dataDir = tempDir(t);
  const nowIso = '2026-11-06T17:30:00.000Z';
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(nowIso) });
  await service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 7 } });

  assert.ok(fs.existsSync(usageFile(dataDir, 'u1', '2026-11-07')));
  assert.equal(fs.existsSync(usageFile(dataDir, 'u1', '2026-11-06')), false);
  const totals = await service.todayTotals('u1');
  assert.equal(totals.tokens, 7);
});

test('record 永不对调用方 throw：写盘失败时仍计入内存（配额照常生效）', async (t) => {
  const dataDir = tempDir(t);
  // 用同路径的普通文件占住 usage 目录，让 mkdir/append 失败。
  fs.writeFileSync(path.join(dataDir, 'usage'), 'not-a-directory');
  const logger = collectLogger();
  const service = createUsageService({ dataDir, logger, now: fixedNow(NOW_NOV6_18) });

  await assert.doesNotReject(
    service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 120 } }),
  );
  assert.ok(logger.warnings.length > 0);

  const totals = await service.todayTotals('u1');
  assert.equal(totals.tokens, 120);
  const verdict = await service.checkQuota({ userId: 'u1', quota: { dayTokens: 100 } });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.usedTokens, 120);
});

test('record 遇只读 usage 目录不抛（EACCES 仅 warn，内存仍计入配额）', async (t) => {
  const dataDir = tempDir(t);
  const usageDir = path.join(dataDir, 'usage');
  fs.mkdirSync(usageDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(usageDir, 0o500); // r-x：可读不可写，mkdir/append 均 EACCES
  try {
    const logger = collectLogger();
    const service = createUsageService({ dataDir, logger, now: fixedNow(NOW_NOV6_18) });

    await assert.doesNotReject(
      service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 9 } }),
    );
    assert.ok(logger.warnings.length > 0, '只读目录写入失败应记录 warn');

    const totals = await service.todayTotals('u1');
    assert.equal(totals.tokens, 9, '写盘失败仍应计入内存聚合');
    const verdict = await service.checkQuota({ userId: 'u1', quota: { dayTokens: 9 } });
    assert.equal(verdict.allowed, false, '内存口径必须照常参与配额判定');
  } finally {
    fs.chmodSync(usageDir, 0o700); // 恢复权限，供 t.after 清理临时目录
  }
});

test('损坏 JSONL 行跳过并 warn，不影响合法行', async (t) => {
  const dataDir = tempDir(t);
  const filePath = usageFile(dataDir, 'u1', '2026-11-06');
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ ts: NOW_NOV6_18, model: 'deepseek-flash', status: 'ok', conversationId: null, usage: { inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })}\n{broken-json\n`,
  );

  const logger = collectLogger();
  const service = createUsageService({ dataDir, logger, now: fixedNow(NOW_NOV6_18) });
  const totals = await service.todayTotals('u1');
  assert.equal(totals.requests, 1);
  assert.equal(totals.tokens, 5);
  assert.ok(logger.warnings.some((warning) => warning.includes('损坏')));
});

// ---------------------------------------------------------------------------
// 重启对账 / 懒加载
// ---------------------------------------------------------------------------

test('重启重建 service 后从 JSONL 对账（近 90 天加载，超 90 天不加载）', async (t) => {
  const dataDir = tempDir(t);
  const first = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await first.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 11, outputTokens: 2 } });
  await first.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 13, outputTokens: 3 } });

  // 手工放入一个 90 天前的文件（-90 → 不加载）与一个 88 天前的文件（-88 → 加载）。
  const outside = usageFile(dataDir, 'u1', '2026-08-08');
  const inside = usageFile(dataDir, 'u1', '2026-08-10');
  fs.mkdirSync(path.dirname(inside), { recursive: true, mode: 0o700 });
  const line = (tokens) =>
    `${JSON.stringify({ ts: '2026-08-10T00:00:00.000Z', model: 'deepseek-flash', status: 'ok', conversationId: null, usage: { inputTokens: tokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })}\n`;
  fs.writeFileSync(outside, line(1));
  fs.writeFileSync(inside, line(2));

  const second = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  const totals = await second.todayTotals('u1');
  assert.equal(totals.requests, 2);
  assert.equal(totals.tokens, 11 + 2 + 13 + 3);

  const ranged = await second.totals({ from: '2026-08-10', to: '2026-08-10' });
  assert.equal(ranged.requests, 1);
  assert.equal(ranged.tokens, 2);
  const outsideRange = await second.totals({ from: '2026-08-08', to: '2026-08-08' });
  assert.equal(outsideRange.requests, 0);
});

// ---------------------------------------------------------------------------
// prune：180 天保留期
// ---------------------------------------------------------------------------

test('prune：删除超过 180 天的文件、保留边界内文件，失败不阻塞', async (t) => {
  const dataDir = tempDir(t);
  const tooOld = usageFile(dataDir, 'u1', '2026-05-10'); // today - 180
  const boundary = usageFile(dataDir, 'u1', '2026-05-11'); // today - 179（保留边界）
  const recent = usageFile(dataDir, 'u1', '2026-11-01');
  fs.mkdirSync(path.dirname(tooOld), { recursive: true, mode: 0o700 });
  for (const file of [tooOld, boundary, recent]) fs.writeFileSync(file, '');

  const logger = collectLogger();
  const service = createUsageService({ dataDir, logger, now: fixedNow(NOW_NOV6_18) });
  await service.todayTotals('u1'); // 触发懒加载（含 prune）

  assert.equal(fs.existsSync(tooOld), false, '超过 180 天的文件应被删除');
  assert.equal(fs.existsSync(boundary), true, '保留边界（-179 天）内的文件不得删除');
  assert.equal(fs.existsSync(recent), true);
});

test('prune：保留期可由 config.usageRetentionDays 覆盖（11.6 冻结字段）', async (t) => {
  const dataDir = tempDir(t);
  const tooOld = usageFile(dataDir, 'u1', '2026-10-07'); // today - 30
  const boundary = usageFile(dataDir, 'u1', '2026-10-08'); // today - 29（30 天保留边界）
  fs.mkdirSync(path.dirname(tooOld), { recursive: true, mode: 0o700 });
  for (const file of [tooOld, boundary]) fs.writeFileSync(file, '');

  const service = createUsageService({
    dataDir,
    config: { usageRetentionDays: 30 },
    logger: collectLogger(),
    now: fixedNow(NOW_NOV6_18),
  });
  await service.todayTotals('u1');

  assert.equal(fs.existsSync(tooOld), false);
  assert.equal(fs.existsSync(boundary), true);
});

test('prune：删除失败仅 warn、不阻塞服务（过期项保留）', async (t) => {
  const dataDir = tempDir(t);
  // 用同名目录伪装过期明细文件：unlink 目录会失败，触发 warn-only 分支。
  const stalePath = usageFile(dataDir, 'u1', '2026-05-10');
  fs.mkdirSync(stalePath, { recursive: true, mode: 0o700 });

  const logger = collectLogger();
  const service = createUsageService({ dataDir, logger, now: fixedNow(NOW_NOV6_18) });
  const totals = await service.todayTotals('u1'); // 触发 prune；失败不得影响调用

  assert.equal(totals.requests, 0);
  assert.equal(fs.existsSync(stalePath), true, '删除失败的过期项应保留，不得导致崩溃');
  assert.ok(
    logger.warnings.some((warning) => warning.includes('prune 删除失败')),
    `应记录 prune 警告：${logger.warnings.join(' | ')}`,
  );
});

test('userSummary：series 按日补零含 today、totals 汇总、models 分组成本', async (t) => {
  const dataDir = tempDir(t);
  let nowValue = new Date('2026-11-06T10:00:00.000Z');
  const service = createUsageService({
    dataDir,
    config: { priceTable: PRICES },
    logger: collectLogger(),
    now: () => nowValue,
  });

  await service.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 100 },
  });
  nowValue = new Date('2026-11-07T10:00:00.000Z');
  await service.record({
    userId: 'u1',
    model: 'deepseek-v4-pro',
    usage: { inputTokens: 200, outputTokens: 10 },
  });
  nowValue = new Date('2026-11-08T10:00:00.000Z');

  const summary = await service.userSummary('u1', { days: 3 });
  assert.deepEqual(
    summary.series.map((row) => row.date),
    ['2026-11-06', '2026-11-07', '2026-11-08'],
  );
  assert.equal(summary.series[0].requests, 1);
  assert.equal(summary.series[1].requests, 1);
  assert.equal(summary.series[2].requests, 0);
  assert.equal(summary.series[2].tokens, 0);
  assert.equal(summary.totals.requests, 2);
  assert.equal(summary.totals.tokens, 100 + 50 + 100 + 200 + 10);
  assert.deepEqual(Object.keys(summary.totals.models).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(
    summary.totals.costUsd,
    Number(
      (
        (100 / 1e6) * 0.3 +
        (100 / 1e6) * 0.006 +
        (50 / 1e6) * 1.2 +
        (200 / 1e6) * 1.32 +
        (10 / 1e6) * 3.96
      ).toFixed(4),
    ),
  );
  // 命中率 = 100 / (300 + 100) = 0.25（v4-pro 行 cacheRead=0）。
  assert.equal(summary.totals.cacheHitRate, 0.25);

  // days 缺省 30、下限 1；超 90 clamp。
  const defaults = await service.userSummary('u1');
  assert.equal(defaults.series.length, 30);
  assert.equal((await service.userSummary('u1', { days: 0 })).series.length, 30);
  assert.equal((await service.userSummary('u1', { days: 500 })).series.length, USAGE_LOAD_DAYS);

  // 无记录用户：全零序列。
  const empty = await service.userSummary('u2', { days: 2 });
  assert.equal(empty.totals.requests, 0);
  assert.equal(empty.series.length, 2);
});

test('summary：groupBy=day|user|model，rows 按 key 升序，totals 汇总', async (t) => {
  const dataDir = tempDir(t);
  let nowValue = new Date('2026-11-06T10:00:00.000Z');
  const service = createUsageService({
    dataDir,
    config: { priceTable: PRICES },
    logger: collectLogger(),
    now: () => nowValue,
  });
  await service.record({ userId: 'u2', model: 'deepseek-flash', usage: { inputTokens: 10 } });
  await service.record({ userId: 'u1', model: 'deepseek-v4-pro', usage: { inputTokens: 20 } });
  nowValue = new Date('2026-11-07T10:00:00.000Z');
  await service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 30 } });

  const byDay = await service.summary({ from: '2026-11-06', to: '2026-11-07', groupBy: 'day' });
  assert.equal(byDay.groupBy, 'day');
  assert.equal(byDay.from, '2026-11-06');
  assert.equal(byDay.to, '2026-11-07');
  assert.deepEqual(
    byDay.rows.map((row) => [row.key, row.requests]),
    [
      ['2026-11-06', 2],
      ['2026-11-07', 1],
    ],
  );
  assert.equal(byDay.totals.requests, 3);
  assert.equal(byDay.totals.tokens, 60);

  const byUser = await service.summary({ from: '2026-11-01', to: '2026-11-07', groupBy: 'user' });
  assert.deepEqual(
    byUser.rows.map((row) => [row.key, row.requests]),
    [
      ['u1', 2],
      ['u2', 1],
    ],
  );

  const byModel = await service.summary({ from: '2026-11-01', to: '2026-11-07', groupBy: 'model' });
  assert.deepEqual(
    byModel.rows.map((row) => [row.key, row.requests]),
    [
      ['deepseek-flash', 2],
      ['deepseek-v4-pro', 1],
    ],
  );

  // 空区间：rows 为空、totals 全零。
  const empty = await service.summary({ from: '2026-10-01', to: '2026-10-02', groupBy: 'day' });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.totals.requests, 0);

  // 缺省近 30 天。
  const defaults = await service.summary({ groupBy: 'day' });
  assert.equal(defaults.from, '2026-10-09');
  assert.equal(defaults.to, '2026-11-07');
});

test('summary/totals：RANGE_TOO_LARGE、INVALID_INPUT 与默认区间', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 1 } });

  await assert.rejects(
    service.summary({ from: '2026-01-01', to: '2026-11-06', groupBy: 'day' }),
    (error) => error.status === 400 && error.code === 'RANGE_TOO_LARGE',
  );
  // 恰好 90 天（含首尾）允许通过。
  const boundary = await service.summary({ from: '2026-08-09', to: '2026-11-06', groupBy: 'day' });
  assert.equal(boundary.rows.length, 1);
  assert.equal(boundary.rows[0].key, '2026-11-06');

  await assert.rejects(
    service.summary({ from: '2026-11-06', to: '2026-11-01', groupBy: 'day' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    service.summary({ from: 'not-a-date', to: '2026-11-06' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    service.summary({ groupBy: 'hour' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );

  // totals 缺省近 30 天；取范围外记录 = 0。
  const dayTotals = await service.totals();
  assert.equal(dayTotals.requests, 1);

  // 手工补一条 40 天前记录（仍在 90 天加载窗口内），默认 totals 不含。
  const oldFile = usageFile(dataDir, 'u1', '2026-09-27');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    oldFile,
    `${JSON.stringify({ ts: '2026-09-27T00:00:00.000Z', model: 'deepseek-flash', status: 'ok', conversationId: null, usage: { inputTokens: 50, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })}\n`,
  );
  const restarted = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  const defaultTotals = await restarted.totals();
  assert.equal(defaultTotals.requests, 1);
  assert.equal(defaultTotals.tokens, 1);
  const oldRange = await restarted.totals({ from: '2026-09-27', to: '2026-09-27' });
  assert.equal(oldRange.requests, 1);
  assert.equal(oldRange.tokens, 50);
});

test('aggregate：未知模型成本走 default 估算并计入模型名分组', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({
    dataDir,
    config: { priceTable: PRICES },
    logger: collectLogger(),
    now: fixedNow(NOW_NOV6_18),
  });
  await service.record({ userId: 'u1', model: 'deepseek-nebula', usage: { inputTokens: 1_000_000 } });
  const totals = await service.todayTotals('u1');
  assert.deepEqual(totals.models, { 'deepseek-nebula': 0.3 });
  assert.equal(totals.costUsd, 0.3);
});

// ---------------------------------------------------------------------------
// 服务构造参数校验
// ---------------------------------------------------------------------------

test('createUsageService：缺少 dataDir 抛错（开发期配置错误应显式失败）', () => {
  assert.throws(() => createUsageService({}), /dataDir/);
});

test('checkQuota：非对象 quota 视为不限', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 10 } });
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota: null }), { allowed: true });
  assert.deepEqual(await service.checkQuota({ userId: 'u1' }), { allowed: true });
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota: {} }), { allowed: true });
});

test('文件与目录权限、JSONL 行内不含未授权字段', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await service.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 1 },
    // 调用方可能误传敏感字段；实现只白名单落库。
    secret: 'test-key-should-not-be-written',
  });
  const raw = fs.readFileSync(usageFile(dataDir, 'u1', '2026-11-06'), 'utf8');
  assert.equal(raw.includes('test-key-should-not-be-written'), false);
  assert.equal(raw.includes('secret'), false);
  assert.equal(fs.statSync(path.dirname(usageFile(dataDir, 'u1', '2026-11-06'))).mode & 0o777, 0o700);
});

// ---------------------------------------------------------------------------
//  / BYOK 来源（source/provider）与 bySource 分桶（契约 7 / ）
// ---------------------------------------------------------------------------

test('常量：USAGE_SOURCES/DEFAULT_USAGE_SOURCE 与契约一致', () => {
  assert.deepEqual([...USAGE_SOURCES], ['official', 'byok']);
  assert.equal(DEFAULT_USAGE_SOURCE, 'official');
});

test('record：source/provider 落库与清洗（非法 source 回 official，provider trim/截断/非法置 null）', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });

  await service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 1 } });
  await service.record({
    userId: 'u1',
    model: 'gpt-4o-mini',
    usage: { inputTokens: 2 },
    source: 'byok',
    provider: '  openai  ',
  });
  await service.record({ userId: 'u1', model: 'm', usage: { inputTokens: 3 }, source: 'weird-source', provider: 42 });
  await service.record({
    userId: 'u1',
    model: 'm',
    usage: { inputTokens: 4 },
    source: 'byok',
    provider: 'p'.repeat(100),
  });

  const entries = readLines(usageFile(dataDir, 'u1', '2026-11-06')).map((line) => JSON.parse(line));
  assert.equal(entries[0].source, 'official');
  assert.equal(entries[0].provider, null);
  assert.equal(entries[1].source, 'byok');
  assert.equal(entries[1].provider, 'openai');
  // 非法 source 归一为 official；非法 provider 置 null。
  assert.equal(entries[2].source, 'official');
  assert.equal(entries[2].provider, null);
  // provider 截断到 64 字符；无 key/URL 等字段落库。
  assert.equal(entries[3].provider, 'p'.repeat(64));
  const raw = fs.readFileSync(usageFile(dataDir, 'u1', '2026-11-06'), 'utf8');
  assert.equal(raw.includes('test-key-'), false);
  assert.equal(raw.includes('apiKey'), false);
});

test('旧 JSONL 行（无 source/provider）视为 official，不重写历史文件', async (t) => {
  const dataDir = tempDir(t);
  const dateKey = '2026-11-06';
  const userDir = path.join(dataDir, 'usage', 'u1');
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const legacyLine = JSON.stringify({
    ts: NOW_NOV6_18,
    model: 'deepseek-flash',
    status: 'ok',
    conversationId: 'c-legacy',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  });
  const filePath = path.join(userDir, `${dateKey}.jsonl`);
  fs.writeFileSync(filePath, `${legacyLine}\n`);
  const originalRaw = fs.readFileSync(filePath, 'utf8');

  const service = createUsageService({ dataDir, config: { priceTable: PRICES }, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  const totals = await service.todayTotals('u1');
  assert.equal(totals.requests, 1);
  assert.equal(totals.tokens, 15);
  assert.deepEqual(totals.bySource.official, { requests: 1, tokens: 15, costUsd: totals.costUsd });
  assert.deepEqual(totals.bySource.byok, { requests: 0, tokens: 0, costUsd: null });
  // 旧行照常计入配额（视为 official）。
  const quota = await service.checkQuota({ userId: 'u1', quota: { dayTokens: 15 } });
  assert.equal(quota.allowed, false);
  assert.equal(quota.usedTokens, 15);
  // 只读加载，不重写历史文件。
  assert.equal(fs.readFileSync(filePath, 'utf8'), originalRaw);
});

test('checkQuota：只统计 official 记录；source:byok 直接视为不占平台配额', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 10 } });
  await service.record({
    userId: 'u1',
    model: 'gpt-4o-mini',
    usage: { inputTokens: 100, outputTokens: 100 },
    source: 'byok',
    provider: 'custom',
  });

  // BYOK 的 200 tokens 不计入配额：官方 10 tokens < 50，允许。
  assert.deepEqual(await service.checkQuota({ userId: 'u1', quota: { dayTokens: 50 } }), { allowed: true });
  // 本请求是 BYOK：即使官方额度已超，也直接允许。
  assert.deepEqual(
    await service.checkQuota({ userId: 'u1', quota: { dayTokens: 1 }, source: 'byok' }),
    { allowed: true },
  );
  // 官方口径：再记 5 个 official token 后超限，usedTokens 只含 official。
  await service.record({ userId: 'u1', model: 'deepseek-flash', usage: { inputTokens: 5 } });
  const denied = await service.checkQuota({ userId: 'u1', quota: { dayTokens: 10 } });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'QUOTA_EXCEEDED');
  assert.equal(denied.window, 'day');
  assert.equal(denied.usedTokens, 15);
  assert.equal(denied.limitTokens, 10);
  assert.equal(denied.resetAt, '2026-11-06T16:00:00.000Z');
});

test('todayTotals/userSummary/totals/summary：bySource 分桶，官方字段与 rows 不含 BYOK', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, config: { priceTable: PRICES }, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await service.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10 },
  });
  await service.record({
    userId: 'u1',
    model: 'gpt-4o-mini',
    usage: { inputTokens: 10, outputTokens: 4 },
    source: 'byok',
    provider: 'openai',
  });

  const expectedBySource = {
    official: { requests: 1, tokens: 160, costUsd: 0.0001 },
    byok: { requests: 1, tokens: 14, costUsd: null },
  };
  const today = await service.todayTotals('u1');
  assert.equal(today.requests, 1);
  assert.equal(today.tokens, 160);
  assert.deepEqual(today.models, { 'deepseek-flash': 0.0001 });
  assert.deepEqual(today.bySource, expectedBySource);

  const userSummary = await service.userSummary('u1', { days: 1 });
  assert.deepEqual(userSummary.totals.bySource, expectedBySource);
  assert.deepEqual(userSummary.bySource, expectedBySource);
  // series 逐日项保持官方口径原字段（不带 bySource）。
  assert.equal(userSummary.series.length, 1);
  assert.equal(userSummary.series[0].requests, 1);
  assert.equal(userSummary.series[0].tokens, 160);
  assert.equal(Object.hasOwn(userSummary.series[0], 'bySource'), false);

  const range = await service.totals({ from: '2026-11-06', to: '2026-11-06' });
  assert.deepEqual(range.bySource, expectedBySource);
  assert.equal(range.requests, 1);
  assert.equal(range.tokens, 160);

  const byModel = await service.summary({ from: '2026-11-06', to: '2026-11-06', groupBy: 'model' });
  assert.deepEqual(byModel.bySource, expectedBySource);
  assert.deepEqual(byModel.totals.bySource, expectedBySource);
  // 官方图表：BYOK-only 模型桶不进 rows。
  assert.deepEqual(byModel.rows.map((row) => row.key), ['deepseek-flash']);
  assert.equal(byModel.rows[0].requests, 1);
  assert.equal(byModel.rows[0].tokens, 160);
  assert.deepEqual(byModel.rows[0].bySource.byok, { requests: 0, tokens: 0, costUsd: null });

  const byDay = await service.summary({ from: '2026-11-06', to: '2026-11-06', groupBy: 'day' });
  assert.equal(byDay.rows.length, 1);
  assert.equal(byDay.rows[0].requests, 1);
  // 混合桶的 row 也带 bySource，供管理端拆分展示。
  assert.deepEqual(byDay.rows[0].bySource, expectedBySource);
});

test('summary：byok-only 用户桶不进官方 rows，但计入 totals.bySource', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await service.record({ userId: 'u_mixed', model: 'deepseek-flash', usage: { inputTokens: 10 } });
  await service.record({
    userId: 'u_mixed',
    model: 'gpt-4o-mini',
    usage: { inputTokens: 1, outputTokens: 1 },
    source: 'byok',
    provider: 'openai',
  });
  await service.record({
    userId: 'u_byok_only',
    model: 'gpt-4o-mini',
    usage: { inputTokens: 2, outputTokens: 2 },
    source: 'byok',
    provider: 'openai',
  });

  const summary = await service.summary({ from: '2026-11-06', to: '2026-11-06', groupBy: 'user' });
  assert.deepEqual(summary.rows.map((row) => row.key), ['u_mixed']);
  assert.deepEqual(summary.bySource.byok, { requests: 2, tokens: 6, costUsd: null });
  assert.deepEqual(summary.bySource.official, { requests: 1, tokens: 10, costUsd: 0 });
});

test('重启对账：从 JSONL 重载后 bySource 与官方口径一致（含旧行兼容）', async (t) => {
  const dataDir = tempDir(t);
  const first = createUsageService({ dataDir, config: { priceTable: PRICES }, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await first.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 20, outputTokens: 5 },
  });
  await first.record({
    userId: 'u1',
    model: 'gpt-4o-mini',
    usage: { inputTokens: 3, outputTokens: 2 },
    source: 'byok',
    provider: 'openai',
  });

  const second = createUsageService({ dataDir, config: { priceTable: PRICES }, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  const totals = await second.todayTotals('u1');
  assert.equal(totals.requests, 1);
  assert.equal(totals.tokens, 25);
  assert.deepEqual(totals.bySource, {
    official: { requests: 1, tokens: 25, costUsd: totals.costUsd },
    byok: { requests: 1, tokens: 5, costUsd: null },
  });
});

// ---------------------------------------------------------------------------
//  / 联网次数（webSearch）、联网配额、flush（优雅关闭）
// ---------------------------------------------------------------------------

test('record({webSearch})：true 才写字段，false/缺省不写（旧行兼容）', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await service.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 1, outputTokens: 1 },
    webSearch: true,
  });
  await service.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 2, outputTokens: 2 },
    webSearch: false,
  });
  await service.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 3, outputTokens: 3 },
  });

  const lines = readLines(usageFile(dataDir, 'u1', localDateKey(new Date(NOW_NOV6_18))));
  assert.equal(lines.length, 3);
  const rows = lines.map((line) => JSON.parse(line));
  assert.equal(rows[0].webSearch, true);
  assert.equal(Object.hasOwn(rows[1], 'webSearch'), false);
  assert.equal(Object.hasOwn(rows[2], 'webSearch'), false);
  for (const row of rows) {
    assert.equal(row.model, 'deepseek-flash');
    assert.equal(row.status, 'ok');
  }
});

test('webSearchRequests：totals/todayTotals/userSummary/summary/series 计数（与来源无关、旧行不计）', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  await service.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 10, outputTokens: 5 },
    webSearch: true,
  });
  await service.record({
    userId: 'u1',
    model: 'deepseek-v4-pro',
    usage: { inputTokens: 20, outputTokens: 10 },
  });
  // BYOK 聊天也可能真实联网，同样计 webSearch（与 source 无关）
  await service.record({
    userId: 'u1',
    model: 'gpt-4o-mini',
    usage: { inputTokens: 3, outputTokens: 2 },
    source: 'byok',
    provider: 'openai',
    webSearch: true,
  });

  const totals = await service.todayTotals('u1');
  assert.equal(totals.requests, 2); // 顶层仍只统计 official
  assert.equal(totals.webSearchRequests, 2);

  const userSummary = await service.userSummary('u1', { days: 2 });
  assert.equal(userSummary.totals.webSearchRequests, 2);
  const todayRow = userSummary.series[userSummary.series.length - 1];
  assert.equal(todayRow.webSearchRequests, 2);
  assert.equal(typeof todayRow.cacheHitRate === 'number' || todayRow.cacheHitRate === null, true);

  const summary = await service.summary({ from: '2026-11-06', to: '2026-11-06', groupBy: 'day' });
  assert.equal(summary.totals.webSearchRequests, 2);
  assert.equal(summary.rows[0].webSearchRequests, 2);

  // 旧行（无 webSearch 字段）不计入：手工写一行旧格式再重启对账
  const usagePath = usageFile(dataDir, 'u2', localDateKey(new Date(NOW_NOV6_18)));
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.writeFileSync(
    usagePath,
    `${JSON.stringify({
      ts: NOW_NOV6_18,
      dateKey: localDateKey(new Date(NOW_NOV6_18)),
      userId: 'u2',
      model: 'deepseek-flash',
      status: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    })}\n`,
  );
  const reloaded = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  assert.equal((await reloaded.todayTotals('u2')).webSearchRequests, 0);
});

test('checkWebSearchQuota：limit 空/0 不限；达到上限 allowed:false；按天重置', async (t) => {
  const dataDir = tempDir(t);
  let nowValue = new Date(NOW_NOV6_18);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: () => nowValue });

  // 无记录、limit=2
  let quota = await service.checkWebSearchQuota({ userId: 'u1', limit: 2 });
  assert.deepEqual(Object.keys(quota).sort(), ['allowed', 'limit', 'resetAt', 'used']);
  assert.equal(quota.allowed, true);
  assert.equal(quota.used, 0);
  assert.equal(quota.limit, 2);
  assert.match(quota.resetAt, /^\d{4}-\d{2}-\d{2}T/);

  await service.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 1, outputTokens: 1 },
    webSearch: true,
  });
  quota = await service.checkWebSearchQuota({ userId: 'u1', limit: 2 });
  assert.equal(quota.allowed, true);
  assert.equal(quota.used, 1);

  await service.record({
    userId: 'u1',
    model: 'deepseek-flash',
    usage: { inputTokens: 1, outputTokens: 1 },
    webSearch: true,
  });
  quota = await service.checkWebSearchQuota({ userId: 'u1', limit: 2 });
  assert.equal(quota.allowed, false);
  assert.equal(quota.used, 2);
  assert.equal(quota.limit, 2);

  // limit 为空/0 视为不限
  for (const limit of [null, undefined, 0]) {
    const unlimited = await service.checkWebSearchQuota({ userId: 'u1', limit });
    assert.equal(unlimited.allowed, true);
    assert.equal(unlimited.limit, null);
    assert.equal(unlimited.used, 2);
  }

  // 跨天重置：nowValue 切到次日，used 归零
  nowValue = new Date('2026-11-07T10:00:00.000Z');
  const nextDay = await service.checkWebSearchQuota({ userId: 'u1', limit: 2 });
  assert.equal(nextDay.allowed, true);
  assert.equal(nextDay.used, 0);

  // 其他用户互不影响
  const otherUser = await service.checkWebSearchQuota({ userId: 'u2', limit: 2 });
  assert.equal(otherUser.used, 0);
});

test('flush：等待挂起追加写队列清空，随后新实例可读到全部记录', async (t) => {
  const dataDir = tempDir(t);
  const service = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  const pending = [];
  for (let index = 0; index < 5; index += 1) {
    pending.push(
      service.record({
        userId: 'u1',
        model: 'deepseek-flash',
        usage: { inputTokens: index + 1, outputTokens: 1 },
        webSearch: index === 0,
      }),
    );
  }
  const flushedAt = Date.now();
  await service.flush();
  const flushElapsed = Date.now() - flushedAt;
  assert.ok(flushElapsed < 2000, `flush 未及时完成（${flushElapsed}ms）`);
  await Promise.all(pending);
  // flush 之后再 flush 也安全（无挂起队列）
  await service.flush();

  const reloaded = createUsageService({ dataDir, logger: collectLogger(), now: fixedNow(NOW_NOV6_18) });
  const totals = await reloaded.todayTotals('u1');
  assert.equal(totals.requests, 5);
  assert.equal(totals.webSearchRequests, 1);
});
