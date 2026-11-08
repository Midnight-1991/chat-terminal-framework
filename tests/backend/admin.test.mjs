// 管理员 API 测试（接口契约  5 / 2.4 / 11.6）。
// 策略：fake ctx 注入（in-memory UserService/UsageService + 真实 FeedbackService + mkdtemp DATA_DIR + 固定时钟），
// 直接调用 handleAdmin；不依赖 /102 的 WIP 模块，不启动 HTTP 服务，无网络、无 sleep。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';

import {
  createInviteStore,
  createSettingsStore,
  handleAdmin,
  INVITES_FILE_NAME,
  SETTINGS_FILE_NAME,
} from '../../server/admin.mjs';
import { createFeedbackService } from '../../server/feedback.mjs';

const FIXED_NOW = new Date('2026-11-07T00:00:00.000Z');
const TODAY = '2026-11-07';
const DEFAULT_FROM = '2026-10-09'; // TODAY - 29 天

function fixedNow() {
  return new Date(FIXED_NOW);
}

function makeTmpDir(prefix = 'wild-admin-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function callAdmin(ctx, { method = 'GET', url = '/', body, segments } = {}) {
  const req = makeReq({ method, url, body });
  const res = makeRes();
  await handleAdmin(req, res, ctx, segments ?? url.split('/').filter(Boolean));
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
    modelSource: 'official',
    createdAt: '2026-10-02T00:00:00.000Z',
    lastLoginAt: null,
    passwordHash: 'hash:alice-secret',
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
  },
  {
    id: 'u_carol',
    username: 'carol',
    displayName: 'Carol',
    role: 'user',
    status: 'banned',
    quota: { dayTokens: 0, monthTokens: 0 },
    modelSource: 'official',
    createdAt: '2026-10-04T00:00:00.000Z',
    lastLoginAt: null,
    passwordHash: 'hash:carol-secret',
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
};

function copy(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** in-memory UserService（接口同契约 2.2），返回包含 passwordHash 的「内部用户」验证输出脱敏。 */
function createFakeUsers(seed = BUILTIN_USERS) {
  const map = new Map(seed.map((user) => [user.id, copy(user)]));
  const calls = [];
  let counter = 100;
  const matchesQuery = (user, query) => {
    if (query === null || query === undefined || query === '') return true;
    const needle = String(query).toLowerCase();
    return (
      String(user.username ?? '').toLowerCase().includes(needle) ||
      String(user.displayName ?? '').toLowerCase().includes(needle)
    );
  };
  return {
    calls,
    map,
    async list({ query = null, status = null } = {}) {
      calls.push({ method: 'list', query, status });
      return [...map.values()]
        .filter((user) => (status === null ? true : user.status === status))
        .filter((user) => matchesQuery(user, query))
        .map(copy);
    },
    async get(id) {
      calls.push({ method: 'get', id });
      return map.has(id) ? copy(map.get(id)) : null;
    },
    async getByUsername(username) {
      return [...map.values()].find((user) => user.username === username) ?? null;
    },
    async count({ role = null, status = null } = {}) {
      calls.push({ method: 'count', role, status });
      return [...map.values()].filter(
        (user) => (role === null || user.role === role) && (status === null || user.status === status),
      ).length;
    },
    async create(input) {
      counter += 1;
      const user = {
        id: `u_${counter}`,
        username: input.username,
        displayName: input.displayName ?? input.username,
        role: input.role ?? 'user',
        status: 'active',
        quota: input.quota ?? null,
        modelSource: 'official',
        createdAt: FIXED_NOW.toISOString(),
        lastLoginAt: null,
        passwordHash: 'hash:new',
      };
      map.set(user.id, user);
      return copy(user);
    },
    async update(id, patch) {
      calls.push({ method: 'update', id, patch: copy(patch) });
      const user = map.get(id);
      if (!user) return null;
      Object.assign(user, patch);
      return copy(user);
    },
    async setPassword(id, password) {
      calls.push({ method: 'setPassword', id, password });
      const user = map.get(id);
      if (!user) return null;
      user.passwordHash = `hash:${password}`;
      return copy(user);
    },
    async touchLogin(id) {
      return this.get(id);
    },
    async ensureAdmin() {
      return copy(ADMIN_USER);
    },
  };
}

/** in-memory UsageService（接口同契约 3.3），记录 summary/userSummary 调用便于断言区间。 */
function createFakeUsage() {
  const calls = [];
  const state = {
    today: { requests: 12, tokens: 3456, costUsd: 0.0123, cacheHitRate: 0.5 },
    rangeTotals: { requests: 42, tokens: 9999, costUsd: 0.042, cacheHitRate: 0.4 },
    seriesRows: [
      { key: '2026-11-07', requests: 12, tokens: 3456, costUsd: 0.0123 },
      { key: '2026-11-06', requests: 30, tokens: 6543, costUsd: 0.0297 },
    ],
    userTotals: {
      u_admin: { requests: 2, tokens: 200, costUsd: 0.001, cacheHitRate: 0.2 },
      u_alice: { requests: 5, tokens: 500, costUsd: 0.002, cacheHitRate: 0.3 },
      u_bob: { requests: 0, tokens: 0, costUsd: 0, cacheHitRate: null },
      u_carol: { requests: 0, tokens: 0, costUsd: 0, cacheHitRate: null },
    },
    groupRows: {
      day: [{ key: '2026-11-07', requests: 12 }],
      user: [{ key: 'u_alice', requests: 5 }],
      model: [{ key: 'deepseek-flash', requests: 7 }],
    },
  };
  const service = {
    calls,
    state,
    async record() {},
    async checkQuota() {
      return { allowed: true, remaining: 1000 };
    },
    async userSummary(userId, { days = 30 } = {}) {
      calls.push({ method: 'userSummary', userId, days });
      const totals = state.userTotals[userId] ?? {
        requests: 0,
        tokens: 0,
        costUsd: 0,
        cacheHitRate: null,
      };
      return { totals: copy(totals), series: [] };
    },
    async summary({ from, to, groupBy = 'day' } = {}) {
      calls.push({ method: 'summary', from, to, groupBy });
      if (groupBy !== 'day') {
        return {
          groupBy,
          from,
          to,
          rows: copy(state.groupRows[groupBy] ?? []),
          totals: copy(state.rangeTotals),
        };
      }
      if (from === to) {
        return {
          groupBy,
          from,
          to,
          rows: [{ key: from, requests: state.today.requests }],
          totals: copy(state.today),
        };
      }
      if (from === DEFAULT_FROM && to === TODAY) {
        return { groupBy, from, to, rows: copy(state.seriesRows), totals: copy(state.rangeTotals) };
      }
      return { groupBy, from, to, rows: copy(state.seriesRows), totals: copy(state.rangeTotals) };
    },
    async totals() {
      return copy(state.rangeTotals);
    },
    async todayTotals() {
      return copy(state.today);
    },
  };
  return service;
}

function makeCtx({
  dir = makeTmpDir(),
  users = createFakeUsers(),
  usage = createFakeUsage(),
  feedback,
  actor = ADMIN_USER,
  config = FIXED_CONFIG,
  logger = createCapturingLogger(),
} = {}) {
  const baseDataDir = dir;
  const feedbackService =
    feedback ?? createFeedbackService({ dataDir: baseDataDir, logger, now: fixedNow });
  return {
    user: copy(actor),
    userId: actor?.id ?? null,
    authMode: 'on',
    baseDataDir,
    config: copy(config),
    users,
    usage,
    feedback: feedbackService,
    logger,
    now: fixedNow,
  };
}

async function seedFeedback(service) {
  const first = await service.add({ userId: 'u_alice', body: '第一条反馈' });
  const second = await service.add({ userId: 'u_bob', body: '第二条反馈', conversationId: 'c0ffee', allowContext: true });
  await service.update(second.id, { status: 'resolved', reply: '已处理' });
  return { first, second };
}

/* ------------------------------- 鉴权与路由 ------------------------------- */

test('handleAdmin：未登录 401 UNAUTHORIZED，非管理员 403 FORBIDDEN，未知路由 404', async () => {
  const ctx = makeCtx();
  const anonymous = await callAdmin(
    { ...ctx, user: null, userId: null },
    { method: 'GET', url: '/api/admin/overview', segments: ['api', 'admin', 'overview'] },
  );
  assert.equal(anonymous.res.statusCode, 401);
  assert.equal(anonymous.json.error.code, 'UNAUTHORIZED');

  const plainUser = await callAdmin(
    { ...ctx, user: { id: 'u_alice', username: 'alice', role: 'user' }, userId: 'u_alice' },
    { method: 'GET', url: '/api/admin/overview', segments: ['api', 'admin', 'overview'] },
  );
  assert.equal(plainUser.res.statusCode, 403);
  assert.equal(plainUser.json.error.code, 'FORBIDDEN');

  const unknown = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/nope',
    segments: ['api', 'admin', 'nope'],
  });
  assert.equal(unknown.res.statusCode, 404);
  assert.equal(unknown.json.error.code, 'NOT_FOUND');

  const wrongMethod = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/overview',
    segments: ['api', 'admin', 'overview'],
  });
  assert.equal(wrongMethod.res.statusCode, 404);

  const notAdminPath = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/feedback',
    segments: ['api', 'feedback'],
  });
  assert.equal(notAdminPath.res.statusCode, 404);
});

test('handleAdmin：兼容已归一化 segments（无 api 前缀）', async () => {
  const ctx = makeCtx();
  const overview = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/overview?days=7',
    segments: ['admin', 'overview'],
  });
  assert.equal(overview.res.statusCode, 200);
  assert.equal(overview.json.today.requests, 12);
});

/* ------------------------------- overview ------------------------------- */

test('GET /api/admin/overview：默认近 30 天、today/series/users/feedback 形状正确且不泄漏密码哈希', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  const feedback = createFeedbackService({ dataDir: dir, logger, now: fixedNow });
  await seedFeedback(feedback);
  const usage = createFakeUsage();
  const ctx = makeCtx({ dir, feedback, usage, logger });

  const { res, json } = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/overview',
    segments: ['api', 'admin', 'overview'],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json.today, {
    requests: 12,
    tokens: 3456,
    costUsd: 0.0123,
    cacheHitRate: 0.5,
    activeUsers: 2, // u_admin 与 u_alice 今日有请求
  });
  assert.deepEqual(json.series, [
    { date: '2026-11-07', requests: 12, tokens: 3456, costUsd: 0.0123 },
    { date: '2026-11-06', requests: 30, tokens: 6543, costUsd: 0.0297 },
  ]);
  assert.deepEqual(json.users, { total: 4, active: 3, banned: 1 });
  assert.deepEqual(json.feedback, { open: 1, total: 2 });

  const summaryCalls = usage.calls.filter((call) => call.method === 'summary');
  assert.deepEqual(summaryCalls[0], { method: 'summary', from: TODAY, to: TODAY, groupBy: 'day' });
  assert.deepEqual(summaryCalls[1], { method: 'summary', from: DEFAULT_FROM, to: TODAY, groupBy: 'day' });

  assert.ok(!res.rawBody.includes('passwordHash'), '不能泄漏 passwordHash');
  assert.ok(!res.rawBody.includes('hash:'), '不能泄漏密码哈希');
});

test('GET /api/admin/overview?days=7：区间正确；days 非法 400', async () => {
  const usage = createFakeUsage();
  const ctx = makeCtx({ usage });

  const week = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/overview?days=7',
    segments: ['api', 'admin', 'overview'],
  });
  assert.equal(week.res.statusCode, 200);
  const rangeCall = usage.calls.filter((call) => call.method === 'summary')[1];
  assert.deepEqual(rangeCall, { method: 'summary', from: '2026-11-01', to: TODAY, groupBy: 'day' });

  const zero = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/overview?days=0',
    segments: ['api', 'admin', 'overview'],
  });
  assert.equal(zero.res.statusCode, 400);
  assert.equal(zero.json.error.code, 'INVALID_INPUT');

  const tooLong = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/overview?days=91',
    segments: ['api', 'admin', 'overview'],
  });
  assert.equal(tooLong.res.statusCode, 400);
  assert.equal(tooLong.json.error.code, 'INVALID_INPUT');
});

/* ------------------------------- users ------------------------------- */

test('GET /api/admin/users：列表含 usage30d、支持 query/status 过滤、不含密码字段', async () => {
  const usage = createFakeUsage();
  const ctx = makeCtx({ usage });

  const all = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/users',
    segments: ['api', 'admin', 'users'],
  });
  assert.equal(all.res.statusCode, 200);
  assert.equal(all.json.users.length, 4);
  const alice = all.json.users.find((user) => user.id === 'u_alice');
  assert.deepEqual(alice.usage30d, { requests: 5, tokens: 500, costUsd: 0.002, cacheHitRate: 0.3 });
  assert.deepEqual(alice.quota, { dayTokens: 1000, monthTokens: 5000 });
  assert.equal(alice.passwordHash, undefined);
  assert.equal(alice.salt, undefined);
  assert.ok(!all.res.rawBody.includes('hash:'), '列表不泄漏密码哈希');
  assert.ok(usage.calls.some((call) => call.method === 'userSummary' && call.userId === 'u_bob'));

  const filtered = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/users?query=ali',
    segments: ['api', 'admin', 'users'],
  });
  assert.deepEqual(
    filtered.json.users.map((user) => user.id),
    ['u_alice'],
  );

  const banned = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/users?status=banned',
    segments: ['api', 'admin', 'users'],
  });
  assert.deepEqual(
    banned.json.users.map((user) => user.id),
    ['u_carol'],
  );

  const invalidStatus = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/users?status=gone',
    segments: ['api', 'admin', 'users'],
  });
  assert.equal(invalidStatus.res.statusCode, 400);
  assert.equal(invalidStatus.json.error.code, 'INVALID_INPUT');
});

test('PATCH /api/admin/users/:id：更新资料/配额/状态并写审计日志；未知 id/字段 400/404', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  const users = createFakeUsers();
  const ctx = makeCtx({ dir, users, logger });

  const updated = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/users/u_alice',
    body: { displayName: 'Alice Chen', quota: { dayTokens: 2000, monthTokens: 8000 } },
    segments: ['api', 'admin', 'users', 'u_alice'],
  });
  assert.equal(updated.res.statusCode, 200);
  assert.equal(updated.json.user.displayName, 'Alice Chen');
  assert.deepEqual(updated.json.user.quota, { dayTokens: 2000, monthTokens: 8000 });
  assert.equal(updated.json.user.passwordHash, undefined);
  const updateCall = users.calls.find((call) => call.method === 'update');
  assert.deepEqual(updateCall, {
    method: 'update',
    id: 'u_alice',
    patch: { displayName: 'Alice Chen', quota: { dayTokens: 2000, monthTokens: 8000 } },
  });
  const audit = logger.logs.filter((row) => row.text.includes('[admin]'));
  assert.ok(audit.some((row) => row.text.includes('action=user.update') && row.text.includes('target=u_alice')));

  const banBob = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/users/u_bob',
    body: { status: 'banned' },
    segments: ['api', 'admin', 'users', 'u_bob'],
  });
  assert.equal(banBob.res.statusCode, 200);
  assert.equal(banBob.json.user.status, 'banned');

  const unknownUser = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/users/u_nobody',
    body: { role: 'user' },
    segments: ['api', 'admin', 'users', 'u_nobody'],
  });
  assert.equal(unknownUser.res.statusCode, 404);
  assert.equal(unknownUser.json.error.code, 'NOT_FOUND');

  const unknownField = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/users/u_alice',
    body: { passwordHash: 'x' },
    segments: ['api', 'admin', 'users', 'u_alice'],
  });
  assert.equal(unknownField.res.statusCode, 400);
  assert.equal(unknownField.json.error.code, 'INVALID_INPUT');

  const badQuota = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/users/u_alice',
    body: { quota: { dayTokens: -1 } },
    segments: ['api', 'admin', 'users', 'u_alice'],
  });
  assert.equal(badQuota.res.statusCode, 400);

  const emptyBody = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/users/u_alice',
    body: {},
    segments: ['api', 'admin', 'users', 'u_alice'],
  });
  assert.equal(emptyBody.res.statusCode, 400);
});

test('PATCH /api/admin/users/:id：禁自我封禁 SELF_FORBIDDEN、禁降级/封禁最后 admin LAST_ADMIN', async () => {
  // actor 即 u_admin（唯一 admin）：封禁自己 → SELF_FORBIDDEN
  const users = createFakeUsers();
  const ctx = makeCtx({ users });
  const selfBan = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/users/u_admin',
    body: { status: 'banned' },
    segments: ['api', 'admin', 'users', 'u_admin'],
  });
  assert.equal(selfBan.res.statusCode, 400);
  assert.equal(selfBan.json.error.code, 'SELF_FORBIDDEN');

  // 唯一 admin 自我降级 → LAST_ADMIN
  const selfDemote = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/users/u_admin',
    body: { role: 'user' },
    segments: ['api', 'admin', 'users', 'u_admin'],
  });
  assert.equal(selfDemote.res.statusCode, 400);
  assert.equal(selfDemote.json.error.code, 'LAST_ADMIN');

  // 另一个 admin 身份封禁唯一 admin（u_admin）→ LAST_ADMIN（非自我）
  const otherAdminCtx = makeCtx({
    users,
    actor: { id: 'u_admin2', username: 'root2', role: 'admin', status: 'active' },
  });
  const lastAdminBan = await callAdmin(otherAdminCtx, {
    method: 'PATCH',
    url: '/api/admin/users/u_admin',
    body: { status: 'banned' },
    segments: ['api', 'admin', 'users', 'u_admin'],
  });
  assert.equal(lastAdminBan.res.statusCode, 400);
  assert.equal(lastAdminBan.json.error.code, 'LAST_ADMIN');

  // 有两个 admin 时，降级其中一个允许（u_admin 降级）
  const twoAdminsUsers = createFakeUsers([
    ADMIN_USER,
    { ...ADMIN_USER, id: 'u_admin2', username: 'root2', passwordHash: 'hash:root2' },
  ]);
  const twoAdminCtx = makeCtx({
    users: twoAdminsUsers,
    actor: { id: 'u_admin2', username: 'root2', role: 'admin', status: 'active' },
  });
  const allowedDemote = await callAdmin(twoAdminCtx, {
    method: 'PATCH',
    url: '/api/admin/users/u_admin',
    body: { role: 'user' },
    segments: ['api', 'admin', 'users', 'u_admin'],
  });
  assert.equal(allowedDemote.res.statusCode, 200);
  assert.equal(allowedDemote.json.user.role, 'user');
});

/* ------------------------------- reset-password ------------------------------- */

test('POST /api/admin/users/:id/reset-password：未传密码生成 16 位临时密码，仅本次返回且不落日志', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  const users = createFakeUsers();
  const ctx = makeCtx({ dir, users, logger });

  const { res, json } = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/users/u_alice/reset-password',
    segments: ['api', 'admin', 'users', 'u_alice', 'reset-password'],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(typeof json.tempPassword, 'string');
  assert.equal(json.tempPassword.length, 16);
  assert.equal(json.user.id, 'u_alice');
  assert.equal(json.user.passwordHash, undefined);
  assert.equal(json.user.salt, undefined);

  const setCall = users.calls.find((call) => call.method === 'setPassword');
  assert.equal(setCall.id, 'u_alice');
  assert.equal(setCall.password, json.tempPassword, '服务层收到同一临时密码');

  const allLogs = logger.logs.map((row) => row.text).join('\n');
  assert.ok(allLogs.includes('action=user.resetPassword'), '有审计日志');
  assert.ok(allLogs.includes('mode=generated'));
  assert.ok(!allLogs.includes(json.tempPassword), '临时密码绝不落日志');
  assert.ok(!res.rawBody.includes('hash:'), '响应不含密码哈希');
});

test('POST /api/admin/users/:id/reset-password：传入合法密码则不返回 tempPassword；非法密码 400', async () => {
  const users = createFakeUsers();
  const ctx = makeCtx({ users });

  const provided = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/users/u_alice/reset-password',
    body: { password: 'newpass123' },
    segments: ['api', 'admin', 'users', 'u_alice', 'reset-password'],
  });
  assert.equal(provided.res.statusCode, 200);
  assert.equal(provided.json.tempPassword, undefined);
  const setCall = users.calls.find((call) => call.method === 'setPassword');
  assert.equal(setCall.password, 'newpass123');

  const tooShort = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/users/u_alice/reset-password',
    body: { password: 'short' },
    segments: ['api', 'admin', 'users', 'u_alice', 'reset-password'],
  });
  assert.equal(tooShort.res.statusCode, 400);
  assert.equal(tooShort.json.error.code, 'INVALID_INPUT');

  const unknownUser = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/users/u_nobody/reset-password',
    segments: ['api', 'admin', 'users', 'u_nobody', 'reset-password'],
  });
  assert.equal(unknownUser.res.statusCode, 404);
  assert.equal(unknownUser.json.error.code, 'NOT_FOUND');
});

/* ------------------------------- invites：store ------------------------------- */

test('createInviteStore：create/get/getValid/redeem 语义、过期与用尽、持久化 0600', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  let clock = new Date(FIXED_NOW);
  const store = createInviteStore({ dataDir: dir, logger, now: () => new Date(clock) });

  const invite = await store.create({
    role: 'user',
    note: '给同事',
    maxUses: 2,
    expiresInDays: 3,
    createdBy: 'u_admin',
  });
  assert.match(invite.code, /^i[0-9a-f]{8}$/);
  assert.equal(invite.role, 'user');
  assert.equal(invite.maxUses, 2);
  assert.equal(invite.uses, 0);
  assert.equal(invite.createdBy, 'u_admin');
  assert.equal(invite.note, '给同事');
  assert.equal(invite.createdAt, FIXED_NOW.toISOString());
  assert.equal(invite.expiresAt, new Date(FIXED_NOW.getTime() + 3 * 86_400_000).toISOString());

  const filePath = path.join(dir, INVITES_FILE_NAME);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.invites.length, 1);
  assert.equal(onDisk.invites[0].code, invite.code);

  assert.deepEqual(await store.get('inope0000'), null);
  assert.deepEqual(await store.getValid('inope0000'), null);
  assert.equal((await store.get(invite.code)).uses, 0);
  assert.equal((await store.getValid(invite.code)).code, invite.code);

  const redeemed = await store.redeem(invite.code);
  assert.equal(redeemed.uses, 1);
  assert.equal((await store.get(invite.code)).uses, 1, '核销后落盘');
  await store.redeem(invite.code);
  assert.equal(await store.redeem(invite.code), null, '用尽后不可再核销');
  assert.equal(await store.getValid(invite.code), null, '用尽后 getValid 为 null');
  assert.equal((await store.get(invite.code)).uses, 2);

  // 过期：合法但过期 → get 原样返回、getValid/redeem 为 null
  const tiny = await store.create({ maxUses: 5, expiresInDays: 1 });
  clock = new Date(FIXED_NOW.getTime() + 2 * 86_400_000);
  assert.notEqual(await store.get(tiny.code), null, 'get 保留原样用于区分错误码');
  assert.equal(await store.getValid(tiny.code), null);
  assert.equal(await store.redeem(tiny.code), null);

  // 重启新实例：从磁盘恢复
  const reloaded = createInviteStore({ dataDir: dir, logger, now: () => new Date(clock) });
  const list = await reloaded.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].code, tiny.code, '新建在前');

  // 非法创建参数
  await assert.rejects(
    () => store.create({ role: 'superuser' }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => store.create({ maxUses: 0 }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => store.create({ expiresInDays: 0 }),
    (error) => error.status === 400 && error.code === 'INVALID_INPUT',
  );
});

test('createInviteStore：并发 redeem 不超发（写串行）', async () => {
  const dir = makeTmpDir();
  const store = createInviteStore({ dataDir: dir, now: fixedNow });
  const invite = await store.create({ maxUses: 3, expiresInDays: 7 });
  const results = await Promise.all(Array.from({ length: 6 }, () => store.redeem(invite.code)));
  assert.equal(results.filter(Boolean).length, 3, '只成功核销 3 次');
  assert.equal((await store.get(invite.code)).uses, 3);

  const reloaded = createInviteStore({ dataDir: dir, now: fixedNow });
  assert.equal((await reloaded.get(invite.code)).uses, 3, '磁盘 uses 一致');
});

/* ------------------------------- invites：路由 ------------------------------- */

test('POST/GET /api/admin/invites：201 创建、列出、审计日志、非法参数 400', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  const ctx = makeCtx({ dir, logger });

  const created = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/invites',
    body: { role: 'user', note: '欢迎', maxUses: 2, expiresInDays: 5 },
    segments: ['api', 'admin', 'invites'],
  });
  assert.equal(created.res.statusCode, 201);
  assert.match(created.json.invite.code, /^i[0-9a-f]{8}$/);
  assert.equal(created.json.invite.uses, 0);
  assert.equal(created.json.invite.maxUses, 2);
  assert.equal(created.json.invite.expiresAt, new Date(FIXED_NOW.getTime() + 5 * 86_400_000).toISOString());

  const defaultInvite = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/invites',
    body: {},
    segments: ['api', 'admin', 'invites'],
  });
  assert.equal(defaultInvite.res.statusCode, 201);
  assert.equal(defaultInvite.json.invite.role, 'user');
  assert.equal(defaultInvite.json.invite.maxUses, 1);

  const listed = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/invites',
    segments: ['api', 'admin', 'invites'],
  });
  assert.equal(listed.res.statusCode, 200);
  assert.equal(listed.json.invites.length, 2);
  assert.equal(listed.json.invites[0].code, defaultInvite.json.invite.code, '新建在前');

  const audit = logger.logs.map((row) => row.text).join('\n');
  assert.ok(audit.includes('action=invite.create'));

  const badMaxUses = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/invites',
    body: { maxUses: 0 },
    segments: ['api', 'admin', 'invites'],
  });
  assert.equal(badMaxUses.res.statusCode, 400);
  assert.equal(badMaxUses.json.error.code, 'INVALID_INPUT');

  const badField = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/invites',
    body: { code: 'ifake0000' },
    segments: ['api', 'admin', 'invites'],
  });
  assert.equal(badField.res.statusCode, 400);
});

/* ------------------------------- usage summary ------------------------------- */

test('GET /api/admin/usage/summary：默认近 30 天/groupBy=day、支持三种 groupBy、>90 天 RANGE_TOO_LARGE', async () => {
  const usage = createFakeUsage();
  const ctx = makeCtx({ usage });

  const defaults = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/usage/summary',
    segments: ['api', 'admin', 'usage', 'summary'],
  });
  assert.equal(defaults.res.statusCode, 200);
  assert.equal(defaults.json.groupBy, 'day');
  assert.equal(defaults.json.from, DEFAULT_FROM);
  assert.equal(defaults.json.to, TODAY);
  assert.equal(defaults.json.rows.length, 2);
  assert.deepEqual(defaults.json.totals, createFakeUsage().state.rangeTotals);

  const byModel = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/usage/summary?from=2026-11-01&to=2026-11-07&groupBy=model',
    segments: ['api', 'admin', 'usage', 'summary'],
  });
  assert.equal(byModel.res.statusCode, 200);
  assert.equal(byModel.json.groupBy, 'model');
  assert.deepEqual(byModel.json.rows, [{ key: 'deepseek-flash', requests: 7 }]);
  const modelCall = usage.calls.filter((call) => call.method === 'summary').at(-1);
  assert.deepEqual(modelCall, { method: 'summary', from: '2026-11-01', to: '2026-11-07', groupBy: 'model' });

  const byUser = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/usage/summary?groupBy=user',
    segments: ['api', 'admin', 'usage', 'summary'],
  });
  assert.equal(byUser.json.groupBy, 'user');
  assert.deepEqual(byUser.json.rows, [{ key: 'u_alice', requests: 5 }]);

  const tooLarge = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/usage/summary?from=2026-01-01&to=2026-11-07',
    segments: ['api', 'admin', 'usage', 'summary'],
  });
  assert.equal(tooLarge.res.statusCode, 400);
  assert.equal(tooLarge.json.error.code, 'RANGE_TOO_LARGE');

  const invalidFrom = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/usage/summary?from=2026-13-01',
    segments: ['api', 'admin', 'usage', 'summary'],
  });
  assert.equal(invalidFrom.res.statusCode, 400);
  assert.equal(invalidFrom.json.error.code, 'INVALID_INPUT');

  const reversed = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/usage/summary?from=2026-11-07&to=2026-11-01',
    segments: ['api', 'admin', 'usage', 'summary'],
  });
  assert.equal(reversed.res.statusCode, 400);

  const badGroup = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/usage/summary?groupBy=week',
    segments: ['api', 'admin', 'usage', 'summary'],
  });
  assert.equal(badGroup.res.statusCode, 400);
  assert.equal(badGroup.json.error.code, 'INVALID_INPUT');
});

/* ------------------------------- admin feedback ------------------------------- */

test('GET/PATCH /api/admin/feedback：列表带 username、状态过滤、更新状态与回复', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  const feedback = createFeedbackService({ dataDir: dir, logger, now: fixedNow });
  const { first, second } = await seedFeedback(feedback);
  const users = createFakeUsers();
  const ctx = makeCtx({ dir, feedback, users, logger });

  const all = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/feedback',
    segments: ['api', 'admin', 'feedback'],
  });
  assert.equal(all.res.statusCode, 200);
  assert.equal(all.json.feedback.length, 2);
  const firstEntry = all.json.feedback.find((entry) => entry.id === first.id);
  assert.equal(firstEntry.username, 'alice');
  assert.equal(firstEntry.body, '第一条反馈');
  assert.equal(firstEntry.passwordHash, undefined);

  const resolved = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/feedback?status=resolved',
    segments: ['api', 'admin', 'feedback'],
  });
  assert.deepEqual(
    resolved.json.feedback.map((entry) => entry.id),
    [second.id],
  );
  assert.equal(resolved.json.feedback[0].username, 'bob');

  const patched = await callAdmin(ctx, {
    method: 'PATCH',
    url: `/api/admin/feedback/${first.id}`,
    body: { status: 'resolved', reply: '收到，已安排' },
    segments: ['api', 'admin', 'feedback', first.id],
  });
  assert.equal(patched.res.statusCode, 200);
  assert.equal(patched.json.feedback.status, 'resolved');
  assert.equal(patched.json.feedback.reply, '收到，已安排');
  assert.equal(patched.json.feedback.username, 'alice');
  const audit = logger.logs.map((row) => row.text).join('\n');
  assert.ok(audit.includes('action=feedback.update'));

  const badStatus = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/feedback?status=closed',
    segments: ['api', 'admin', 'feedback'],
  });
  assert.equal(badStatus.res.statusCode, 400);
  assert.equal(badStatus.json.error.code, 'INVALID_INPUT');

  const unknown = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/feedback/f00000000',
    body: { status: 'resolved' },
    segments: ['api', 'admin', 'feedback', 'f00000000'],
  });
  assert.equal(unknown.res.statusCode, 404);
  assert.equal(unknown.json.error.code, 'NOT_FOUND');

  const empty = await callAdmin(ctx, {
    method: 'PATCH',
    url: `/api/admin/feedback/${first.id}`,
    body: {},
    segments: ['api', 'admin', 'feedback', first.id],
  });
  assert.equal(empty.res.statusCode, 400);
});

/* ------------------------------- settings ------------------------------- */

test('GET /api/admin/settings：无 settings.json 时合并 config 默认值', async () => {
  const dir = makeTmpDir();
  const ctx = makeCtx({ dir });

  const { res, json } = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/settings',
    segments: ['api', 'admin', 'settings'],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json.settings, {
    byokEnabled: false,
    defaultQuota: { dayTokens: 100_000, monthTokens: 1_000_000 },
    allowedModels: ['deepseek-v4-pro', 'deepseek-flash'],
    rateLimit: { perMinute: 10, concurrency: 2 },
    quota: { dayTokens: 100_000, monthTokens: 1_000_000 },
    priceVersion: '2026-01',
    webSearchPerUserPerDay: 5,
  });
});

test('PATCH /api/admin/settings：合并写入 settings.json（0600）、GET 反映新值、非法字段 400', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  const ctx = makeCtx({ dir, logger });

  const patched = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/settings',
    body: {
      byokEnabled: true,
      defaultQuota: { dayTokens: 50_000 },
      webSearchPerUserPerDay: 9,
    },
    segments: ['api', 'admin', 'settings'],
  });
  assert.equal(patched.res.statusCode, 200);
  assert.equal(patched.json.settings.byokEnabled, true);
  assert.deepEqual(patched.json.settings.defaultQuota, { dayTokens: 50_000, monthTokens: 1_000_000 });
  assert.deepEqual(patched.json.settings.quota, { dayTokens: 50_000, monthTokens: 1_000_000 });
  assert.equal(patched.json.settings.webSearchPerUserPerDay, 9);

  const filePath = path.join(dir, SETTINGS_FILE_NAME);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, 'settings.json 权限 0600');
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.byokEnabled, true);
  assert.deepEqual(onDisk.defaultQuota, { dayTokens: 50_000, monthTokens: 1_000_000 });
  assert.equal(onDisk.updatedAt, FIXED_NOW.toISOString());

  const reread = await callAdmin(ctx, {
    method: 'GET',
    url: '/api/admin/settings',
    segments: ['api', 'admin', 'settings'],
  });
  assert.equal(reread.json.settings.byokEnabled, true);
  assert.equal(reread.json.settings.webSearchPerUserPerDay, 9);

  const audit = logger.logs.map((row) => row.text).join('\n');
  assert.ok(audit.includes('action=settings.update'));

  const badByok = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { byokEnabled: 'yes' },
    segments: ['api', 'admin', 'settings'],
  });
  assert.equal(badByok.res.statusCode, 400);

  const badField = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { priceVersion: 'x' },
    segments: ['api', 'admin', 'settings'],
  });
  assert.equal(badField.res.statusCode, 400);
  assert.equal(badField.json.error.code, 'INVALID_INPUT');

  const emptyBody = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/settings',
    body: {},
    segments: ['api', 'admin', 'settings'],
  });
  assert.equal(emptyBody.res.statusCode, 400);
});

test('createSettingsStore：直接读写与重启恢复', async () => {
  const dir = makeTmpDir();
  const logger = createCapturingLogger();
  const store = createSettingsStore({ dataDir: dir, logger, now: fixedNow });
  assert.deepEqual(await store.read(), {});
  await store.patch({ byokEnabled: true, defaultQuota: { dayTokens: 1, monthTokens: 2 } }, { updatedBy: 'u_admin' });
  assert.equal((await store.read()).byokEnabled, true);
  assert.equal((await store.read()).defaultQuota.dayTokens, 1);

  const reloaded = createSettingsStore({ dataDir: dir, logger, now: fixedNow });
  const loaded = await reloaded.read();
  assert.equal(loaded.byokEnabled, true);
  assert.deepEqual(loaded.defaultQuota, { dayTokens: 1, monthTokens: 2 });
  assert.equal(loaded.updatedBy, 'u_admin');

  // 损坏文件降级为空设置
  const badDir = makeTmpDir();
  fs.writeFileSync(path.join(badDir, SETTINGS_FILE_NAME), '{bad-json', { mode: 0o600 });
  const recovered = createSettingsStore({ dataDir: badDir, logger: createCapturingLogger(), now: fixedNow });
  assert.deepEqual(await recovered.read(), {});
});
