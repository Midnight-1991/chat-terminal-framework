// -B：记录导入 API / 聚合存储 / 对话注入（ ~ ）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  startServer,
  makeTmpDir,
  apiJson,
  postChat,
  postRaw,
  createFakeRetriever,
  citationItem,
  createFetchMock,
  standardUpstreamEvents,
  sseResponse,
} from './helpers.mjs';
import { loadConfig } from '../../server/config.mjs';
import {
  HEALTH_FILE_NAME,
  HEALTH_FILE_VERSION,
  HEALTH_INJECT_TITLE,
  tokenMatches,
} from '../../server/health.mjs';

const TOKEN = 'test-health-token-abcdef012345';

function pad(value) {
  return String(value).padStart(2, '0');
}

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function healthEnv(overrides = {}) {
  return { HEALTH_IMPORT_TOKEN: TOKEN, ...overrides };
}

function importHealth(baseUrl, payload, { token = TOKEN, headers = {} } = {}) {
  const requestHeaders = token === null ? { ...headers } : { 'x-health-token': token, ...headers };
  return apiJson(baseUrl, '/api/health-import', {
    method: 'POST',
    body: payload,
    headers: requestHeaders,
  });
}

function readHealthFile(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, HEALTH_FILE_NAME), 'utf8'));
}

test('健康导入：未配置 HEALTH_IMPORT_TOKEN 时返回 503 HEALTH_IMPORT_DISABLED', async (t) => {
  const { baseUrl } = await startServer(t, { retriever: createFakeRetriever([]) });
  const result = await importHealth(baseUrl, { metrics: { steps: 1000 } }, { token: 'anything' });
  assert.equal(result.status, 503);
  assert.equal(result.data.error.code, 'HEALTH_IMPORT_DISABLED');
});

test('健康导入：缺 token 401 MISSING、错 token 401 INVALID、HEALTH_IMPORT=0 时 503', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const missing = await importHealth(baseUrl, { metrics: { steps: 1000 } }, { token: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.data.error.code, 'HEALTH_TOKEN_MISSING');

  const wrong = await importHealth(baseUrl, { metrics: { steps: 1000 } }, { token: 'wrong-token' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error.code, 'HEALTH_TOKEN_INVALID');

  const disabled = await startServer(t, {
    env: healthEnv({ HEALTH_IMPORT: '0' }),
    retriever: createFakeRetriever([]),
  });
  const off = await importHealth(disabled.baseUrl, { metrics: { steps: 1000 } });
  assert.equal(off.status, 503);
  assert.equal(off.data.error.code, 'HEALTH_IMPORT_DISABLED');
});

test('健康导入：metrics 预聚合落盘 + GET /api/health 摘要（保留服务健康字段）', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, {
    env: healthEnv(),
    retriever: createFakeRetriever([]),
  });
  const date = localDate();
  const result = await importHealth(baseUrl, {
    date,
    metrics: {
      steps: 8000,
      sleepMinutes: 420,
      restingHeartRate: 60,
      hrvMs: 45,
      weightKg: 70,
      workouts: [{ type: '跑步', minutes: 30, kcal: 300 }],
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.date, date);
  assert.equal(result.data.imported.date, date);
  assert.equal(result.data.imported.days, 1);
  assert.equal(result.data.imported.metrics, 6);
  assert.equal(result.data.health.days, 1);
  assert.ok(Number.isFinite(result.data.health.lastImportedAt));
  assert.ok(!result.text.includes(TOKEN), '导入响应不得回显 token');

  const health = await apiJson(baseUrl, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.mock, false);
  assert.ok(health.data.corpus, '既有服务健康字段 corpus 保留');
  assert.ok(health.data.storage, '既有服务健康字段 storage 保留');
  assert.equal(health.data.lastImportedAt, result.data.health.lastImportedAt);
  assert.equal(health.data.days[date].steps, 8000);
  assert.equal(health.data.days[date].sleepMinutes, 420);
  assert.equal(health.data.days[date].workouts[0].type, '跑步');
  assert.equal(health.data.summary.last7.stepsAvg, 8000);
  assert.equal(health.data.summary.last7.sleepAvgMinutes, 420);
  assert.equal(health.data.summary.last7.restingHrAvg, 60);
  assert.equal(health.data.summary.last7.hrvAvgMs, 45);
  assert.equal(health.data.summary.last7.weightKg, 70);
  assert.equal(health.data.summary.last7.workoutsCount, 1);
  assert.equal(health.data.summary.last7.workoutsMinutes, 30);

  const file = readHealthFile(dataDir);
  assert.equal(file.version, HEALTH_FILE_VERSION);
  assert.equal(file.days[date].steps, 8000);
  assert.ok(!JSON.stringify(file).includes('samples'), '落盘只存聚合值，不存 samples');
  assert.ok(!JSON.stringify(file).includes(TOKEN), '落盘不得包含导入 token');
});

test('健康导入：samples 原始样本按日聚合（求和/平均）且不存原始样本', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, {
    env: healthEnv(),
    retriever: createFakeRetriever([]),
  });
  const date = localDate(-2);
  const result = await importHealth(baseUrl, {
    date,
    samples: [
      { type: 'steps', value: 1000, start: `${date}T08:00:00` },
      { type: 'steps', value: 2000, start: `${date}T12:00:00` },
      { type: 'sleepMinutes', value: 60, start: `${date}T07:00:00` },
      { type: 'sleepMinutes', value: 90, start: `${date}T07:10:00` },
      { type: 'restingHeartRate', value: 60, start: `${date}T09:00:00` },
      { type: 'restingHeartRate', value: 80, start: `${date}T21:00:00` },
      // 体重=当日 start 最新一条（不是平均）：故意反序下发，期望取 20:00 的 72。
      { type: 'weightKg', value: 72, start: `${date}T20:00:00` },
      { type: 'weightKg', value: 70, start: `${date}T07:30:00` },
    ],
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.date, date);
  assert.equal(result.data.imported.days, 1);
  const health = await apiJson(baseUrl, '/api/health');
  const day = health.data.days[date];
  assert.equal(day.steps, 3000);
  assert.equal(day.sleepMinutes, 150);
  assert.equal(day.restingHeartRate, 70);
  assert.equal(day.weightKg, 72);
  const fileText = fs.readFileSync(path.join(dataDir, HEALTH_FILE_NAME), 'utf8');
  assert.ok(!fileText.includes('"samples"'));
  assert.ok(!fileText.includes('"value"'));
});

test('健康导入：多日 samples 按 start 归日（imported.days=2）', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const first = localDate(-3);
  const second = localDate(-2);
  const result = await importHealth(baseUrl, {
    samples: [
      { type: 'steps', value: 1000, start: `${first}T10:00:00` },
      { type: 'steps', value: 1500, start: `${second}T10:00:00` },
    ],
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.imported.days, 2);
  const days = result.data.health.days;
  assert.equal(days, 2);
  const health = await apiJson(baseUrl, '/api/health');
  assert.equal(health.data.days[first].steps, 1000);
  assert.equal(health.data.days[second].steps, 1500);
});

test('健康导入：同日合并覆盖本次字段（含 workouts 覆盖、未提供字段保留）', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const date = localDate(-1);
  assert.equal((await importHealth(baseUrl, { date, metrics: { steps: 1000 } })).status, 200);
  assert.equal((await importHealth(baseUrl, { date, metrics: { steps: 2000 } })).status, 200);
  assert.equal(
    (await importHealth(baseUrl, {
      date,
      metrics: {
        sleepMinutes: 480,
        workouts: [
          { type: '走路', minutes: 20 },
          { type: '瑜伽', minutes: 15, kcal: 60 },
        ],
      },
    })).status,
    200,
  );
  let health = await apiJson(baseUrl, '/api/health');
  assert.equal(health.data.days[date].steps, 2000, '未提供的字段保留旧值');
  assert.equal(health.data.days[date].sleepMinutes, 480);
  assert.equal(health.data.days[date].workouts.length, 2);

  // workouts 再次导入时整体覆盖
  await importHealth(baseUrl, { date, metrics: { workouts: [{ type: '游泳', minutes: 40 }] } });
  health = await apiJson(baseUrl, '/api/health');
  assert.deepEqual(
    health.data.days[date].workouts.map((item) => item.type),
    ['游泳'],
  );
  assert.equal(health.data.days[date].steps, 2000);
});

test('健康导入：超出 HEALTH_RETENTION_DAYS 的日期被清理', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, {
    env: healthEnv({ HEALTH_RETENTION_DAYS: '3' }),
    retriever: createFakeRetriever([]),
  });
  const oldDate = localDate(-10);
  assert.equal((await importHealth(baseUrl, { date: oldDate, metrics: { steps: 1 } })).status, 200);
  assert.equal(
    (await importHealth(baseUrl, { date: localDate(), metrics: { steps: 2 } })).status,
    200,
  );
  const health = await apiJson(baseUrl, '/api/health');
  assert.deepEqual(Object.keys(health.data.days), [localDate()]);
  assert.ok(!JSON.stringify(readHealthFile(dataDir).days).includes(oldDate));
});

test('健康导入：非法 payload 一律 400 INVALID_HEALTH_PAYLOAD', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const invalidPayloads = [
    {},
    { metrics: {} },
    { metrics: { steps: -5 } },
    { metrics: { steps: 'not-a-number' } },
    { metrics: { unknownMetric: 1 } },
    { metrics: { sleepMinutes: 9999 } },
    { metrics: { workouts: [{ type: '跑步', minutes: -1 }] } },
    { date: '2026-13-40', metrics: { steps: 1 } },
    { samples: 'not-an-array' },
    { samples: [] },
    { samples: [{ type: 'steps', value: 1000 }] },
    { samples: [{ type: 'workout', value: 1000, start: '2026-01-01T00:00:00' }] },
    { samples: [{ type: 'steps', value: 'x', start: '2026-01-01T00:00:00' }] },
  ];
  for (const payload of invalidPayloads) {
    const result = await importHealth(baseUrl, payload);
    assert.equal(result.status, 400, `payload 应被拒绝：${JSON.stringify(payload)}`);
    assert.equal(result.data.error.code, 'INVALID_HEALTH_PAYLOAD');
  }
});

test('健康导入：body 超过 512KB 返回 413', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const payload = JSON.stringify({ metrics: { steps: 1 }, padding: 'x'.repeat(600 * 1024) });
  const result = await postRaw(baseUrl, '/api/health-import', payload, {
    headers: { 'content-type': 'application/json', 'x-health-token': TOKEN },
  });
  assert.equal(result.status, 413);
});

test('健康导入：仅 POST 可用（405）；子路径 404', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const get = await apiJson(baseUrl, '/api/health-import', { headers: { 'x-health-token': TOKEN } });
  assert.equal(get.status, 405);
  assert.equal(get.data.error.code, 'METHOD_NOT_ALLOWED');
  const sub = await importHealth(baseUrl, { metrics: { steps: 1 } }, { token: TOKEN });
  assert.equal(sub.status, 200);
  const extra = await apiJson(baseUrl, '/api/health-import/extra', {
    method: 'POST',
    body: { metrics: { steps: 1 } },
    headers: { 'x-health-token': TOKEN },
  });
  assert.equal(extra.status, 404);
});

test('GET /api/health：无数据时返回空结构（days={}、lastImportedAt=null、摘要全空）', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const health = await apiJson(baseUrl, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.lastImportedAt, null);
  assert.equal(health.data.updatedAt, null);
  assert.deepEqual(health.data.days, {});
  assert.equal(health.data.summary.last7.stepsAvg, null);
  assert.equal(health.data.summary.last7.sleepAvgMinutes, null);
  assert.equal(health.data.summary.last7.restingHrAvg, null);
  assert.equal(health.data.summary.last7.weightKg, null);
  assert.equal(health.data.summary.last7.workoutsCount, 0);
});

test('DELETE /api/health：清空记录（幂等）', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, {
    env: healthEnv(),
    retriever: createFakeRetriever([]),
  });
  await importHealth(baseUrl, { date: localDate(), metrics: { steps: 3000, restingHeartRate: 58 } });
  const first = await apiJson(baseUrl, '/api/health', { method: 'DELETE' });
  assert.equal(first.status, 200);
  assert.equal(first.data.ok, true);
  assert.equal(first.data.cleared, 1);
  const health = await apiJson(baseUrl, '/api/health');
  assert.deepEqual(health.data.days, {});
  assert.equal(health.data.lastImportedAt, null);
  const file = readHealthFile(dataDir);
  assert.equal(file.version, HEALTH_FILE_VERSION);
  assert.deepEqual(file.days, {});
  const second = await apiJson(baseUrl, '/api/health', { method: 'DELETE' });
  assert.equal(second.status, 200);
  assert.equal(second.data.cleared, 0);
});

test('健康存储：health.json 损坏时按空数据启动、备份 .corrupt 且日志不打印内容', async (t) => {
  const dataDir = makeTmpDir('wild-health-corrupt-');
  const corrupted = '{ this is not JSON: SECRET-BROKEN-CONTENT';
  fs.writeFileSync(path.join(dataDir, HEALTH_FILE_NAME), corrupted, 'utf8');
  const { baseUrl, logger } = await startServer(t, {
    dataDir,
    env: healthEnv(),
    retriever: createFakeRetriever([]),
  });
  const health = await apiJson(baseUrl, '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.data.days, {});
  assert.ok(fs.existsSync(path.join(dataDir, `${HEALTH_FILE_NAME}.corrupt`)));
  const warnings = logger.logs.filter((entry) => entry.level === 'warn');
  assert.ok(warnings.some((entry) => entry.text.includes('[health]') && entry.text.includes('损坏')));
  assert.ok(!warnings.some((entry) => entry.text.includes('SECRET-BROKEN-CONTENT')));
});

test('对话注入：有记录时 system 追加健康背景段，meta.healthUsed>0', async (t) => {
  const mock = createFetchMock(() => sseResponse(standardUpstreamEvents()));
  const { baseUrl } = await startServer(t, {
    env: healthEnv({ MEMORY: '0' }),
    retriever: createFakeRetriever([citationItem()]),
    fetchImpl: mock.fetchImpl,
  });
  await importHealth(baseUrl, {
    date: localDate(),
    metrics: { steps: 8000, sleepMinutes: 420, restingHeartRate: 60, hrvMs: 45, weightKg: 70 },
  });
  const chat = await postChat(baseUrl, { message: '我最近睡眠不太好的样子。' });
  assert.equal(chat.status, 200);
  const meta = chat.events.find((event) => event.event === 'meta');
  assert.ok(meta, '缺少 meta 事件');
  assert.ok(meta.data.healthUsed > 0);
  const body = mock.lastBody();
  assert.ok(body.system.includes(HEALTH_INJECT_TITLE));
  assert.ok(body.system.includes('日均步数 8000'));
  assert.ok(body.system.includes('仅作背景参考'));
  assert.ok(!body.system.includes(TOKEN), 'system 不得包含导入 token');
  assert.ok(chat.events.some((event) => event.event === 'done'));
});

test('对话注入：无数据或 HEALTH_INJECT=0 时不注入（meta.healthUsed=0）', async (t) => {
  const noDataMock = createFetchMock(() => sseResponse(standardUpstreamEvents()));
  const noData = await startServer(t, {
    env: healthEnv({ MEMORY: '0' }),
    retriever: createFakeRetriever([]),
    fetchImpl: noDataMock.fetchImpl,
  });
  const chat1 = await postChat(noData.baseUrl, { message: '你好。' });
  const meta1 = chat1.events.find((event) => event.event === 'meta');
  assert.equal(meta1.data.healthUsed, 0);
  assert.ok(!noDataMock.lastBody().system.includes(HEALTH_INJECT_TITLE));

  const offMock = createFetchMock(() => sseResponse(standardUpstreamEvents()));
  const off = await startServer(t, {
    env: healthEnv({ MEMORY: '0', HEALTH_INJECT: '0' }),
    retriever: createFakeRetriever([]),
    fetchImpl: offMock.fetchImpl,
  });
  await importHealth(off.baseUrl, { date: localDate(), metrics: { steps: 5000 } });
  const chat2 = await postChat(off.baseUrl, { message: '你好。' });
  const meta2 = chat2.events.find((event) => event.event === 'meta');
  assert.equal(meta2.data.healthUsed, 0);
  assert.ok(!offMock.lastBody().system.includes(HEALTH_INJECT_TITLE));
});

test('配置：HEALTH_* 默认值与 env 覆盖、token 不回显', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.healthImport, true);
  assert.equal(defaults.healthInject, true);
  assert.equal(defaults.healthRetentionDays, 180);
  assert.equal(defaults.healthImportToken, '');

  const custom = loadConfig({
    HEALTH_IMPORT: '0',
    HEALTH_INJECT: '0',
    HEALTH_RETENTION_DAYS: '30',
    HEALTH_IMPORT_TOKEN: 'secret-token-value',
  });
  assert.equal(custom.healthImport, false);
  assert.equal(custom.healthInject, false);
  assert.equal(custom.healthRetentionDays, 30);
  assert.equal(custom.healthImportToken, 'secret-token-value');

  const fallback = loadConfig({ HEALTH_RETENTION_DAYS: 'abc' });
  assert.equal(fallback.healthRetentionDays, 180);
});

test('tokenMatches：长度无关的恒定时间比较（正确/错误/空值）', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', 'abcdef'), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('abc', ''), false);
});

test('健康导入：value 接受数字字符串，unit 按时长换算（sec/hour→分钟）', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const date = localDate(-2);
  const result = await importHealth(baseUrl, {
    date,
    samples: [
      { type: 'steps', value: '8000', unit: 'count', start: `${date}T08:00:00` },
      { type: 'sleepMinutes', value: '25200', unit: 'sec', start: `${date}T07:00:00` },
      { type: 'restingHeartRate', value: '58', unit: 'count/min', start: `${date}T09:00:00` },
      { type: 'weightKg', value: '68.4', unit: 'kg', start: `${date}T07:10:00` },
    ],
  });
  assert.equal(result.status, 200);
  const health = await apiJson(baseUrl, '/api/health');
  const day = health.data.days[date];
  assert.equal(day.steps, 8000);
  assert.equal(day.sleepMinutes, 420); // 25200 秒 = 420 分钟
  assert.equal(day.restingHeartRate, 58);
  assert.equal(day.weightKg, 68.4);

  // metrics 形态同样接受数字字符串与 workouts.minutes/kcal 字符串
  const date2 = localDate(-1);
  const metrics = await importHealth(baseUrl, {
    date: date2,
    metrics: {
      steps: '4200',
      sleepMinutes: '390',
      restingHeartRate: '60',
      workouts: [{ type: 'running', minutes: '30', kcal: '280' }],
    },
  });
  assert.equal(metrics.status, 200);
  const health2 = await apiJson(baseUrl, '/api/health');
  assert.equal(health2.data.days[date2].steps, 4200);
  assert.equal(health2.data.days[date2].workouts[0].minutes, 30);
  assert.equal(health2.data.days[date2].workouts[0].kcal, 280);
});

test('健康导入：samples unit 白名单/兼容性校验，未知或错配 unit → 400', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const date = localDate(-1);
  const base = { type: 'steps', value: 1000, start: `${date}T08:00:00` };
  // unit 未知
  let result = await importHealth(baseUrl, { date, samples: [{ ...base, unit: 'furlong' }] });
  assert.equal(result.status, 400);
  assert.equal(result.data.error.code, 'INVALID_HEALTH_PAYLOAD');
  // unit 已知但与 type 不兼容（steps 只能 count）
  result = await importHealth(baseUrl, { date, samples: [{ ...base, unit: 'kg' }] });
  assert.equal(result.status, 400);
  // 白名单内但本类型不支持（km）
  result = await importHealth(baseUrl, { date, samples: [{ ...base, unit: 'km' }] });
  assert.equal(result.status, 400);
  // 缺省 unit 按 type 默认值接受
  result = await importHealth(baseUrl, { date, samples: [{ ...base }] });
  assert.equal(result.status, 200);
});

test('健康导入：samples 支持 workouts（时长单位换算，计为一次运动）', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const date = localDate(-2);
  const result = await importHealth(baseUrl, {
    date,
    samples: [
      { type: 'workouts', value: 1800, unit: 'sec', start: `${date}T07:00:00`, name: 'running' },
      { type: 'workouts', value: 1, unit: 'hour', start: `${date}T18:00:00`, name: 'cycling' },
    ],
  });
  assert.equal(result.status, 200);
  const health = await apiJson(baseUrl, '/api/health');
  const day = health.data.days[date];
  assert.equal(day.workouts.length, 2);
  assert.equal(day.workouts[0].type, 'running');
  assert.equal(day.workouts[0].minutes, 30);
  assert.equal(day.workouts[1].type, 'cycling');
  assert.equal(day.workouts[1].minutes, 60);
  assert.equal(health.data.summary.last7.workoutsCount, 2);
  assert.equal(health.data.summary.last7.workoutsMinutes, 90);
});

test('健康导入：顶层扁平字段（iOS 快捷指令 JSON 表单）等价于 metrics', async (t) => {
  const { baseUrl, dataDir } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const date = localDate(0);
  const result = await importHealth(baseUrl, {
    date,
    steps: '8000',
    sleepMinutes: 420,
    restingHeartRate: 58,
  });
  assert.equal(result.status, 200);
  const health = await apiJson(baseUrl, '/api/health');
  const day = health.data.days[date];
  assert.equal(day.steps, 8000);
  assert.equal(day.sleepMinutes, 420);
  assert.equal(day.restingHeartRate, 58);
  assert.equal(health.data.summary.last7.stepsAvg, 8000);
  assert.equal(readHealthFile(dataDir).days[date].steps, 8000);
});

test('健康导入：metrics 存在时优先于顶层扁平字段；两者都缺省 400', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const date = localDate(-1);
  const merged = await importHealth(baseUrl, { date, steps: 111, metrics: { steps: 222 } });
  assert.equal(merged.status, 200);
  const health = await apiJson(baseUrl, '/api/health');
  assert.equal(health.data.days[date].steps, 222);

  const empty = await importHealth(baseUrl, { date });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error.code, 'INVALID_HEALTH_PAYLOAD');
});

test('健康导入：扁平 workoutsCount/workoutsMinutes 合成 workouts 并按汇总计数', async (t) => {
  const { baseUrl } = await startServer(t, { env: healthEnv(), retriever: createFakeRetriever([]) });
  const date = localDate(-2);
  const result = await importHealth(baseUrl, { date, workoutsCount: 3, workoutsMinutes: 90 });
  assert.equal(result.status, 200);
  const health = await apiJson(baseUrl, '/api/health');
  const day = health.data.days[date];
  assert.equal(day.workouts.length, 3);
  assert.equal(day.workouts.reduce((sum, item) => sum + item.minutes, 0), 90);
  assert.equal(health.data.summary.last7.workoutsCount, 3);
  assert.equal(health.data.summary.last7.workoutsMinutes, 90);

  const bad = await importHealth(baseUrl, { date, workoutsCount: 2 });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'INVALID_HEALTH_PAYLOAD');
});
