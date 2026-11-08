// 管理员 API 增量测试：settings.byokEnabled 生效值 / 用户行 BYOK 标记 / usage bySource 透传。
// 策略：fake ctx 注入（in-memory UserService/UsageService/ByokService + mkdtemp DATA_DIR + 固定时钟），
// 直接调用 handleAdmin；不依赖并行任务的 WIP 模块，不启动 HTTP 服务，无网络、无 sleep。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';

import { handleAdmin, SETTINGS_FILE_NAME } from '../../server/admin.mjs';

const FIXED_NOW = new Date('2026-11-07T00:00:00.000Z');
const TODAY = '2026-11-07';
const DEFAULT_FROM = '2026-10-09'; // TODAY - 29 天

function fixedNow() {
  return new Date(FIXED_NOW);
}

function makeTmpDir(prefix = 'wild-admin-byok-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copy(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createCapturingLogger() {
  const logs = [];
  const push = (level) => (...args) => {
    logs.push({ level, text: args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ') });
  };
  return {
    logs,
    log: push('log'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  };
}

/* ------------------------------- fake req/res ------------------------------- */

function makeReq({ method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    rawBody: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.writableEnded = true;
      this.rawBody = body === undefined || body === null ? '' : String(body);
    },
  };
}

async function callAdmin(ctx, { method = 'GET', url = '/', body } = {}) {
  const req = makeReq({ method, url, body });
  const res = makeRes();
  const pathname = url.split('?')[0];
  await handleAdmin(req, res, ctx, pathname.split('/').filter(Boolean));
  const json = res.rawBody ? JSON.parse(res.rawBody) : null;
  return { res, json };
}

/* ------------------------------- fixtures ------------------------------- */

const ADMIN_USER = {
  id: 'u_admin',
  username: 'root',
  displayName: 'Root',
  role: 'admin',
  status: 'active',
  quota: null,
  modelSource: 'official',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastLoginAt: '2026-11-06T12:00:00.000Z',
  passwordHash: 'hash:super-secret',
  salt: 'salt:super-secret',
};

const BUILTIN_USERS = [
  ADMIN_USER,
  {
    id: 'u_alice',
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    status: 'active',
    quota: { dayTokens: 1000, monthTokens: 5000 },
    modelSource: 'byok',
    createdAt: '2026-10-02T00:00:00.000Z',
    lastLoginAt: null,
    passwordHash: 'hash:alice-secret',
    salt: 'salt:alice-secret',
  },
  {
    id: 'u_bob',
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    status: 'active',
    quota: null,
    modelSource: 'official',
    createdAt: '2026-10-03T00:00:00.000Z',
    lastLoginAt: null,
    passwordHash: 'hash:bob-secret',
    salt: 'salt:bob-secret',
  },
];

const FIXED_CONFIG = {
  auth: 'on',
  authCookieSecure: false,
  authSessionTtlDays: 30,
  inviteOnly: true,
  quota: { dayTokens: 100_000, monthTokens: 1_000_000 },
  rateLimit: { perMinute: 10, concurrency: 2 },
  allowedModels: ['deepseek-v4-pro', 'deepseek-flash'],
  priceVersion: '2026-01',
  priceTable: { version: '2026-01', currency: 'USD', models: {} },
  usageRetentionDays: 180,
  feedbackMaxChars: 2000,
  webSearchPerUserPerDay: 5,
  byokEnabled: true,
};

/** in-memory UserService（契约 2.2 子集）。 */
function createFakeUsers(seed = BUILTIN_USERS) {
  const map = new Map(seed.map((user) => [user.id, copy(user)]));
  return {
    map,
    async list({ query = null, status = null } = {}) {
      return [...map.values()]
        .filter((user) => (status === null ? true : user.status === status))
        .map(copy);
    },
    async get(id) {
      return map.has(id) ? copy(map.get(id)) : null;
    },
    async count({ role = null, status = null } = {}) {
      return [...map.values()].filter(
        (user) => (role === null || user.role === role) && (status === null || user.status === status),
      ).length;
    },
    async update(id, patch) {
      const user = map.get(id);
      if (!user) return null;
      Object.assign(user, patch);
      return copy(user);
    },
    async setPassword(id, password) {
      const user = map.get(id);
      if (!user) return null;
      user.passwordHash = `hash:${password}`;
      return copy(user);
    },
  };
}

const DEFAULT_TODAY = { requests: 12, tokens: 3456, costUsd: 0.0123, cacheHitRate: 0.5 };
const DEFAULT_RANGE_ROWS = [
  { key: '2026-11-07', requests: 12, tokens: 3456, costUsd: 0.0123 },
  { key: '2026-11-06', requests: 30, tokens: 6543, costUsd: 0.0297 },
];
const DEFAULT_RANGE_TOTALS = { requests: 42, tokens: 9999, costUsd: 0.042, cacheHitRate: 0.4 };

/** in-memory UsageService（契约 3.3/7 子集，可注入 bySource）。 */
function createFakeUsage({
  today = DEFAULT_TODAY,
  rangeRows = DEFAULT_RANGE_ROWS,
  rangeTotals = DEFAULT_RANGE_TOTALS,
  userTotals = {},
  summaryBySource,
} = {}) {
  const calls = [];
  const state = { today, rangeRows, rangeTotals, userTotals, summaryBySource };
  return {
    calls,
    state,
    async record() {},
    async checkQuota() {
      return { allowed: true, remaining: 1000 };
    },
    async userSummary(userId, { days = 30 } = {}) {
      calls.push({ method: 'userSummary', userId, days });
      const totals = state.userTotals[userId] ?? { requests: 0, tokens: 0, costUsd: 0, cacheHitRate: null };
      return { totals: copy(totals), series: [] };
    },
    async summary({ from, to, groupBy = 'day' } = {}) {
      calls.push({ method: 'summary', from, to, groupBy });
      const result =
        from === to
          ? { groupBy, from, to, rows: [{ key: from, requests: state.today.requests }], totals: copy(state.today) }
          : { groupBy, from, to, rows: copy(state.rangeRows), totals: copy(state.rangeTotals) };
      if (state.summaryBySource !== undefined) result.bySource = copy(state.summaryBySource);
      return result;
    },
  };
}

/** fake ByokService：getMeta 由 handler 决定；handler 可抛错模拟异常。 */
function createFakeByok(handler) {
  const calls = [];
  return {
    calls,
    async getMeta(userId) {
      calls.push(userId);
      return handler(userId);
    },
  };
}

const FALLBACK_BYOK = Object.freeze({
  configured: false,
  providerId: null,
  providerLabel: null,
  model: null,
});

function makeCtx({
  dir = makeTmpDir(),
  users = createFakeUsers(),
  usage = createFakeUsage(),
  config = FIXED_CONFIG,
  byok,
  actor = ADMIN_USER,
  logger = createCapturingLogger(),
} = {}) {
  return {
    user: copy(actor),
    userId: actor?.id ?? null,
    authMode: 'on',
    baseDataDir: dir,
    config: copy(config),
    users,
    usage,
    feedback: { async counts() { return { open: 0, total: 0 }; } },
    logger,
    now: fixedNow,
    ...(byok === undefined ? {} : { byok }),
  };
}

function readReadyBody(res) {
  return res.rawBody ?? '';
}

/* ------------------------------- settings.byokEnabled ------------------------------- */

test('settings：byokEnabled 生效值 = stored ?? config.byokEnabled，PATCH 落盘且持久生效', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  const ctx = makeCtx({ dir, logger });

  const initial = await callAdmin(ctx, { url: '/api/admin/settings' });
  assert.equal(initial.res.statusCode, 200);
  assert.equal(initial.json.settings.byokEnabled, true, '未存储时应取 config.byokEnabled=true');

  const patched = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { byokEnabled: false },
  });
  assert.equal(patched.res.statusCode, 200);
  assert.equal(patched.json.settings.byokEnabled, false, '存储值应覆盖 config 默认');
  assert.equal(patched.json.settings.defaultQuota.dayTokens, 100_000, 'settings 其他字段不应漂移');
  assert.equal(patched.json.settings.priceVersion, '2026-01');

  const settingsPath = path.join(dir, SETTINGS_FILE_NAME);
  assert.equal(fs.existsSync(settingsPath), true, 'settings.json 应落盘到 baseDataDir');
  const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(onDisk.byokEnabled, false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600, 'settings.json 应为 0600');
  }

  // 新 ctx（同一 dataDir、config 仍为 true、不同 store 缓存键即同 dir）继续读存储值。
  const again = await callAdmin(makeCtx({ dir }), { url: '/api/admin/settings' });
  assert.equal(again.json.settings.byokEnabled, false, '存储值应持久覆盖 config 默认');
});

test('settings：config.byokEnabled 缺省/false 时为 false，PATCH 可开启；非法值 400 不写入', async () => {
  const dir = makeTmpDir();
  const config = { ...FIXED_CONFIG };
  delete config.byokEnabled;
  const ctx = makeCtx({ dir, config });

  const initial = await callAdmin(ctx, { url: '/api/admin/settings' });
  assert.equal(initial.json.settings.byokEnabled, false, 'config 缺省时应为 false');

  const bad = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { byokEnabled: 'yes' },
  });
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.json.error.code, 'INVALID_INPUT');
  assert.equal(fs.existsSync(path.join(dir, SETTINGS_FILE_NAME)), false, '非法 PATCH 不应落盘');

  const patched = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { byokEnabled: true },
  });
  assert.equal(patched.res.statusCode, 200);
  assert.equal(patched.json.settings.byokEnabled, true);
});

/* ------------------------------- 用户行 BYOK 标记 ------------------------------- */

test('users：byok 标记三态（已配置/未配置/ctx.byok 缺失）+ 只输出白名单字段不泄漏 key', async () => {
  const ctx = makeCtx({
    byok: createFakeByok((userId) => {
      if (userId === 'u_alice') {
        return {
          configured: true,
          provider: 'openai',
          providerId: 'openai',
          providerLabel: 'OpenAI（ChatGPT）',
          protocol: 'openai',
          model: 'gpt-4o-mini',
          keyHint: 'test-key-…a1b2',
          apiKey: 'test-key-test-SECRET-must-not-leak',
          baseUrl: 'https://api.openai.com/v1/chat/completions?trace=1',
          baseUrlOrigin: 'https://api.openai.com',
        };
      }
      return null;
    }),
  });

  const { res, json } = await callAdmin(ctx, { url: '/api/admin/users' });
  assert.equal(res.statusCode, 200);
  const byId = new Map(json.users.map((user) => [user.id, user]));

  assert.deepEqual(byId.get('u_alice').byok, {
    configured: true,
    providerId: 'openai',
    providerLabel: 'OpenAI（ChatGPT）',
    model: 'gpt-4o-mini',
  });
  assert.deepEqual(byId.get('u_bob').byok, FALLBACK_BYOK, 'getMeta 返回 null 应降级未配置');
  assert.deepEqual(byId.get('u_admin').byok, FALLBACK_BYOK, 'getMeta 返回 null 应降级未配置');

  // 白名单输出：不得出现明文 key / keyHint / 完整 baseUrl / 内部 hash。
  const raw = readReadyBody(res);
  for (const secret of ['test-key-test-SECRET-must-not-leak', 'api.openai.com', 'chat/completions', 'hash:', 'salt:']) {
    assert.equal(raw.includes(secret), false, `响应不应包含 ${secret}`);
  }
});

test('users：ctx.byok 缺失或 getMeta 抛错时降级 configured:false 且列表 200', async () => {
  const usage = createFakeUsage();
  const withoutByok = await callAdmin(makeCtx({ usage }), { url: '/api/admin/users' });
  assert.equal(withoutByok.res.statusCode, 200);
  for (const user of withoutByok.json.users) assert.deepEqual(user.byok, FALLBACK_BYOK);

  const logger = createCapturingLogger();
  const throwing = makeCtx({
    usage,
    logger,
    byok: createFakeByok(() => {
      throw new Error('byok meta unavailable');
    }),
  });
  const { res, json } = await callAdmin(throwing, { url: '/api/admin/users' });
  assert.equal(res.statusCode, 200, 'getMeta 异常不应让用户列表失败');
  for (const user of json.users) assert.deepEqual(user.byok, FALLBACK_BYOK);
  assert.equal(
    logger.logs.some((line) => line.level === 'warn' && line.text.includes('BYOK')),
    true,
    '降级时应记录 warn 日志',
  );
});

test('users：兼容 getMeta 的多种元数据形状（provider 字符串/对象、configured 缺省）', async () => {
  const ctx = makeCtx({
    byok: createFakeByok((userId) => {
      if (userId === 'u_alice') return { provider: 'moonshot', model: 'moonshot-v1-8k' };
      if (userId === 'u_bob') {
        return { provider: { id: 'anthropic', label: 'Anthropic Claude' }, model: 'claude-sonnet-4-5' };
      }
      return { configured: false, model: 'should-not-show' };
    }),
  });
  const { res, json } = await callAdmin(ctx, { url: '/api/admin/users' });
  assert.equal(res.statusCode, 200);
  const byId = new Map(json.users.map((user) => [user.id, user]));

  assert.deepEqual(byId.get('u_alice').byok, {
    configured: true,
    providerId: 'moonshot',
    providerLabel: null,
    model: 'moonshot-v1-8k',
  });
  assert.deepEqual(byId.get('u_bob').byok, {
    configured: true,
    providerId: 'anthropic',
    providerLabel: 'Anthropic Claude',
    model: 'claude-sonnet-4-5',
  });
  assert.deepEqual(byId.get('u_admin').byok, FALLBACK_BYOK, 'configured:false 应降级未配置');
});

test('users：byok 标记不改变旧字段（publicUser/usage30d 兼容）', async () => {
  const ctx = makeCtx({
    usage: createFakeUsage({
      userTotals: { u_alice: { requests: 5, tokens: 500, costUsd: 0.002, cacheHitRate: 0.3 } },
    }),
    byok: createFakeByok(() => ({ configured: true, providerId: 'qwen', model: 'qwen-plus' })),
  });
  const { json } = await callAdmin(ctx, { url: '/api/admin/users' });
  const alice = json.users.find((user) => user.id === 'u_alice');
  assert.equal(alice.username, 'alice');
  assert.equal(alice.role, 'user');
  assert.equal(alice.modelSource, 'byok');
  assert.deepEqual(alice.usage30d, { requests: 5, tokens: 500, costUsd: 0.002, cacheHitRate: 0.3 });
  assert.equal(alice.byok.configured, true);
  assert.equal(Object.hasOwn(alice, 'passwordHash'), false);
  assert.equal(Object.hasOwn(alice, 'salt'), false);
});

/* ------------------------------- usage summary bySource ------------------------------- */

test('usage summary：bySource 原样透传，旧字段（groupBy/from/to/rows/totals）不变', async () => {
  const bySource = {
    official: { requests: 40, tokens: 9000, costUsd: 0.042 },
    byok: { requests: 2, tokens: 99, costUsd: null },
  };
  const usage = createFakeUsage({ summaryBySource: bySource });
  const { res, json } = await callAdmin(makeCtx({ usage }), {
    url: '/api/admin/usage/summary?groupBy=day',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json.bySource, bySource);
  assert.equal(json.groupBy, 'day');
  assert.equal(json.from, DEFAULT_FROM);
  assert.equal(json.to, TODAY);
  assert.equal(Array.isArray(json.rows), true);
  assert.deepEqual(json.totals, DEFAULT_RANGE_TOTALS);
});

test('usage summary：usage 服务未提供 bySource 时为 null（向后兼容）', async () => {
  const { res, json } = await callAdmin(makeCtx({ usage: createFakeUsage() }), {
    url: '/api/admin/usage/summary?groupBy=day',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(json.bySource, null);
  assert.deepEqual(json.totals, DEFAULT_RANGE_TOTALS);
});

/* ------------------------------- 概览 costUsd 只算 official ------------------------------- */

test('overview：costUsd 只算 official（bySource.official），requests/tokens 旧口径不变', async () => {
  const usage = createFakeUsage({
    today: {
      requests: 5,
      tokens: 100,
      costUsd: 9.99,
      cacheHitRate: 0.5,
      bySource: {
        official: { requests: 3, tokens: 60, costUsd: 1.5 },
        byok: { requests: 2, tokens: 40, costUsd: null },
      },
    },
    rangeRows: [
      {
        key: '2026-11-07',
        requests: 5,
        tokens: 100,
        costUsd: 9.99,
        bySource: {
          official: { requests: 3, tokens: 60, costUsd: 1.5 },
          byok: { requests: 2, tokens: 40, costUsd: null },
        },
      },
      {
        key: '2026-11-06',
        requests: 7,
        tokens: 200,
        costUsd: 8,
        bySource: {
          official: { requests: 7, tokens: 200, costUsd: 0.25 },
          byok: { requests: 0, tokens: 0, costUsd: null },
        },
      },
    ],
  });
  const { res, json } = await callAdmin(makeCtx({ usage }), { url: '/api/admin/overview?days=30' });
  assert.equal(res.statusCode, 200);
  assert.equal(json.today.costUsd, 1.5, 'today.costUsd 应只取 official.costUsd');
  assert.equal(json.today.requests, 5, 'requests 旧口径不变（含 byok）');
  assert.equal(json.today.tokens, 100, 'tokens 旧口径不变（含 byok）');
  assert.deepEqual(
    json.series.map((row) => row.costUsd),
    [1.5, 0.25],
    'series.costUsd 应只取 official',
  );
  assert.deepEqual(
    json.series.map((row) => row.date),
    ['2026-11-07', '2026-11-06'],
  );
  assert.deepEqual(json.users, { total: 3, active: 3, banned: 0 });
});

test('overview：usage 无 bySource 时回退旧 costUsd（向后兼容）', async () => {
  const { res, json } = await callAdmin(makeCtx({ usage: createFakeUsage() }), {
    url: '/api/admin/overview?days=30',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(json.today.costUsd, DEFAULT_TODAY.costUsd);
  assert.deepEqual(
    json.series.map((row) => row.costUsd),
    DEFAULT_RANGE_ROWS.map((row) => row.costUsd),
  );
});

/* ------------------------------- 权限不回归 ------------------------------- */

test('权限：匿名 401、非管理员 403 对新增字段端点依然生效', async () => {
  const ctx = makeCtx();
  const anonymous = await callAdmin(
    { ...ctx, user: null, userId: null },
    { url: '/api/admin/users' },
  );
  assert.equal(anonymous.res.statusCode, 401);
  assert.equal(anonymous.json.error.code, 'UNAUTHORIZED');

  const plain = await callAdmin(
    { ...ctx, user: { id: 'u_alice', username: 'alice', role: 'user' }, userId: 'u_alice' },
    { url: '/api/admin/settings' },
  );
  assert.equal(plain.res.statusCode, 403);
  assert.equal(plain.json.error.code, 'FORBIDDEN');
});
