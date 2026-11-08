//  /  管理端运维后端测试（契约  4）。
// 覆盖：邀请码吊销/编辑（disabled/lastUsedAt/INVITE_REVOKED）、审计日志端点与写入接线、
// 系统状态端点（ 形状 + data 60s 缓存）、users limit/offset/total 与 status=deleted、
// 附件保留期清理端点、权限（401/403）与降级容错。
// 铁律：全部离线；mkdtemp；无 sleep；fake ctx 注入；不依赖他人 WIP 模块（app.mjs 不在测试链路内）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';

import { handleAdmin } from '../../server/admin.mjs';
import { AUDIT_FILE_NAME } from '../../server/audit.mjs';
import { createAuditLog } from '../../server/audit.mjs';
import { createInviteStore } from '../../server/admin.mjs';
import { createAttachmentStore } from '../../server/attachments.mjs';
import { createUserService } from '../../server/users.mjs';

const FIXED_NOW = new Date('2026-11-07T00:00:00.000Z');
const DAY_MS = 86_400_000;
const INVITES_FILE_NAME = 'invites.json';

const ADMIN_ACTOR = Object.freeze({
  id: 'u_admin',
  username: 'root',
  displayName: '管理员',
  role: 'admin',
  status: 'active',
  quota: null,
  modelSource: 'official',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
});

/* ---------------------------------- 通用工具 ---------------------------------- */

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-users-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
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

function makeReq({ method = 'GET', url = '/', body } = {}) {
  const chunks =
    body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
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
    destroyed: false,
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
  const segments = url.split('?')[0].split('/').filter(Boolean);
  await handleAdmin(req, res, ctx, segments);
  const json = res.rawBody ? JSON.parse(res.rawBody) : null;
  return { res, json };
}

/* ---------------------------------- fake 服务 ---------------------------------- */

function createFakeUsage(overrides = {}) {
  const todayTotals = overrides.todayTotals ?? { requests: 3, tokens: 300, costUsd: 0.3, cacheHitRate: 0.5 };
  const userTotals = overrides.userTotals ?? { requests: 1, tokens: 10, costUsd: 0.01, cacheHitRate: 0.2 };
  return {
    calls: { summary: [], userSummary: [] },
    async summary(params = {}) {
      this.calls.summary.push(params);
      return { rows: [], totals: todayTotals };
    },
    async userSummary(userId, options = {}) {
      this.calls.userSummary.push({ userId, options });
      return { totals: userTotals, series: [] };
    },
  };
}

function createFakeUsers(initial = []) {
  const users = initial.map((user) => ({ ...user }));
  return {
    rows: users,
    calls: { list: [], update: [] },
    async list({ query = null, status = null } = {}) {
      this.calls.list.push({ query, status });
      let rows = users.slice();
      if (query) {
        rows = rows.filter(
          (user) =>
            String(user.username ?? '').includes(query) ||
            String(user.displayName ?? '').includes(query),
        );
      }
      if (status) rows = rows.filter((user) => user.status === status);
      return rows.map((user) => ({ ...user }));
    },
    async count({ role = null, status = null } = {}) {
      return users.filter(
        (user) => (!role || user.role === role) && (!status || user.status === status),
      ).length;
    },
    async get(id) {
      const found = users.find((user) => user.id === id);
      return found ? { ...found } : null;
    },
    async update(id, patch) {
      const found = users.find((user) => user.id === id);
      if (!found) return null;
      Object.assign(found, patch);
      this.calls.update.push({ id, patch: { ...patch } });
      return { ...found };
    },
    async setPassword(id, password) {
      const found = users.find((user) => user.id === id);
      if (!found) return null;
      found.passwordHash = 'HASH-DO-NOT-LEAK';
      found.lastTempPassword = password;
      return { ...found };
    },
  };
}

function defaultConfig(overrides = {}) {
  return {
    auth: 'on',
    inviteOnly: true,
    quota: { dayTokens: 200_000, monthTokens: 2_000_000 },
    rateLimit: { perMinute: 20, concurrency: 2 },
    allowedModels: ['deepseek-v4-pro', 'deepseek-flash'],
    priceVersion: 'v1',
    priceTable: {
      version: 'v1',
      currency: 'USD',
      models: { 'deepseek-v4-pro': { inputPerM: 1, cacheReadPerM: 0.1, outputPerM: 2 } },
    },
    usageRetentionDays: 180,
    feedbackMaxChars: 2000,
    webSearchPerUserPerDay: 5,
    feedbackWebhookUrl: '',
    attachmentRetentionDays: 0,
    backupDir: '',
    byokEnabled: false,
    byokCheckEnabled: true,
    byokAllowedModels: ['deepseek-v4-pro'],
    byokAllowedHosts: ['api.deepseek.com'],
    peakModelPolicy: 'off',
    peakModel: 'deepseek-v4-flash',
    peakHoursUtc: '01:00-04:00,06:00-10:00',
    model: 'deepseek-v4-pro',
    consentVersion: '2026-11-01',
    ...overrides,
  };
}

/**
 * 构造 fake ctx（管理员请求上下文）。nowRef 可推进以测试 60s 缓存/时间相关逻辑。
 */
function buildCtx(t, options = {}) {
  const dir = options.baseDataDir ?? makeTmpDir(t);
  const logger = options.logger ?? createCapturingLogger();
  const nowRef = { value: new Date(FIXED_NOW) };
  const users = options.users ?? createFakeUsers([]);
  const ctx = {
    user: options.adminUser ?? { ...ADMIN_ACTOR },
    baseDataDir: dir,
    logger,
    users,
    usage: options.usage ?? createFakeUsage(),
    feedback: options.feedback ?? {
      async counts() {
        return { open: 0, total: 0 };
      },
      async list() {
        return [];
      },
      async update() {
        return null;
      },
    },
    config: options.config ?? defaultConfig(),
    now: () => new Date(nowRef.value.getTime()),
    audit: options.audit,
    startedAt: options.startedAt,
    version: options.version,
    atRestKey: options.atRestKey ?? null,
    attachments: options.attachments,
    inviteStore: options.inviteStore,
    settingsStore: options.settingsStore,
  };
  return { ctx, dir, logger, nowRef, users };
}

function findInviteOnDisk(dir, code) {
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, INVITES_FILE_NAME), 'utf8'));
  return onDisk.invites.find((invite) => invite.code === code);
}

/** 生成合法附件 id（a + 24 位小写 hex）。 */
function attachmentId(seed) {
  return `a${seed.toString(16).padStart(24, '0').slice(-24)}`;
}

function writeAttachmentFile(dir, id, { size = 16, mtime = FIXED_NOW } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.png`);
  fs.writeFileSync(filePath, Buffer.alloc(size, 7));
  fs.utimesSync(filePath, mtime, mtime);
  return { filePath, size };
}

function writeConversation(dir, id, attachmentIds) {
  const conversationsDir = path.join(dir, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });
  const record = {
    id,
    title: '测试会话',
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    messages: [
      {
        role: 'user',
        content: '看这张图',
        attachments: attachmentIds.map((attachmentIdValue) => ({ id: attachmentIdValue })),
      },
    ],
  };
  fs.writeFileSync(path.join(conversationsDir, `${id}.json`), JSON.stringify(record));
}

function writeMemories(dir, attachmentIds) {
  const payload = {
    version: 1,
    memories: [
      {
        id: 'm1',
        text: '记忆',
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
        attachments: attachmentIds.map((attachmentIdValue) => ({ id: attachmentIdValue })),
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'memories.json'), JSON.stringify(payload));
}

/* ================================ 邀请码：编辑 / 吊销 ================================ */

test('邀请码：PATCH 吊销（disabled=true）→ 注册侧 redeem 抛 400 INVITE_REVOKED，默认列表隐藏、include=all 可见', async (t) => {
  const dir = makeTmpDir(t);
  const logger = createCapturingLogger();
  const store = createInviteStore({ dataDir: dir, logger, now: () => new Date(FIXED_NOW) });
  const { ctx } = buildCtx(t, { baseDataDir: dir, logger, inviteStore: store });

  const created = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/invites',
    body: { role: 'user', maxUses: 1, note: '待吊销' },
  });
  assert.equal(created.res.statusCode, 201);
  assert.equal(created.json.invite.disabled, false);
  assert.equal(created.json.invite.lastUsedAt, null);
  const code = created.json.invite.code;

  const patched = await callAdmin(ctx, {
    method: 'PATCH',
    url: `/api/admin/invites/${code}`,
    body: { disabled: true },
  });
  assert.equal(patched.res.statusCode, 200);
  assert.equal(patched.json.invite.code, code);
  assert.equal(patched.json.invite.disabled, true);
  assert.equal(findInviteOnDisk(dir, code).disabled, true, '吊销状态落盘');

  // 注册侧：auth-routes 对 redeem 的 InviteError 走 HttpError 分支 → 400 INVITE_REVOKED。
  await assert.rejects(store.redeem(code), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'INVITE_REVOKED');
    return true;
  });
  assert.equal(await store.getValid(code), null);
  assert.equal((await store.get(code)).disabled, true);

  const activeList = await callAdmin(ctx, { url: '/api/admin/invites' });
  assert.equal(activeList.res.statusCode, 200);
  assert.deepEqual(activeList.json.invites, []);
  const allList = await callAdmin(ctx, { url: '/api/admin/invites?include=all' });
  assert.equal(allList.json.invites.length, 1);
  assert.equal(allList.json.invites[0].disabled, true);
});

test('邀请码：PATCH 解除吊销后 redeem 成功并写 lastUsedAt（persist 可重启恢复）', async (t) => {
  const dir = makeTmpDir(t);
  const store = createInviteStore({
    dataDir: dir,
    logger: createCapturingLogger(),
    now: () => new Date(FIXED_NOW),
  });
  const { ctx } = buildCtx(t, { baseDataDir: dir, inviteStore: store });
  const created = await callAdmin(ctx, { method: 'POST', url: '/api/admin/invites', body: {} });
  const code = created.json.invite.code;
  await callAdmin(ctx, {
    method: 'PATCH',
    url: `/api/admin/invites/${code}`,
    body: { disabled: true },
  });
  const enabled = await callAdmin(ctx, {
    method: 'PATCH',
    url: `/api/admin/invites/${code}`,
    body: { disabled: false },
  });
  assert.equal(enabled.json.invite.disabled, false);

  const redeemed = await store.redeem(code);
  assert.equal(redeemed.uses, 1);
  assert.equal(redeemed.lastUsedAt, FIXED_NOW.toISOString());
  const onDisk = findInviteOnDisk(dir, code);
  assert.equal(onDisk.uses, 1);
  assert.equal(onDisk.lastUsedAt, FIXED_NOW.toISOString());

  // 另一个实例（模拟重启）能读到最新状态。
  const reloaded = createInviteStore({ dataDir: dir, logger: createCapturingLogger(), now: () => new Date(FIXED_NOW) });
  const row = await reloaded.get(code);
  assert.equal(row.lastUsedAt, FIXED_NOW.toISOString());
  assert.equal(row.disabled, false);
});

test('邀请码：PATCH 支持 note/maxUses/expiresAt；非法字段/未知 code/非法格式 → 400/404', async (t) => {
  const { ctx } = buildCtx(t);
  const created = await callAdmin(ctx, { method: 'POST', url: '/api/admin/invites', body: {} });
  const code = created.json.invite.code;
  const expiresAt = new Date(FIXED_NOW.getTime() + 2 * DAY_MS).toISOString();
  const patched = await callAdmin(ctx, {
    method: 'PATCH',
    url: `/api/admin/invites/${code}`,
    body: { note: '新备注', maxUses: 3, expiresAt },
  });
  assert.equal(patched.res.statusCode, 200);
  assert.equal(patched.json.invite.note, '新备注');
  assert.equal(patched.json.invite.maxUses, 3);
  assert.equal(patched.json.invite.expiresAt, expiresAt);

  const badField = await callAdmin(ctx, {
    method: 'PATCH',
    url: `/api/admin/invites/${code}`,
    body: { role: 'admin' },
  });
  assert.equal(badField.res.statusCode, 400);
  assert.equal(badField.json.error.code, 'INVALID_INPUT');

  const badValue = await callAdmin(ctx, {
    method: 'PATCH',
    url: `/api/admin/invites/${code}`,
    body: { disabled: 'yes' },
  });
  assert.equal(badValue.res.statusCode, 400);

  const empty = await callAdmin(ctx, { method: 'PATCH', url: `/api/admin/invites/${code}`, body: {} });
  assert.equal(empty.res.statusCode, 400);

  const unknown = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/invites/ideadbeef',
    body: { disabled: true },
  });
  assert.equal(unknown.res.statusCode, 404);
  assert.equal(unknown.json.error.code, 'INVITE_NOT_FOUND');

  const malformed = await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/invites/not-a-code',
    body: { disabled: true },
  });
  assert.equal(malformed.res.statusCode, 400);
});

test('邀请码：DELETE 吊销（幂等 200 {invite.disabled:true}），未知 → 404 INVITE_NOT_FOUND', async (t) => {
  const dir = makeTmpDir(t);
  const store = createInviteStore({ dataDir: dir, logger: createCapturingLogger(), now: () => new Date(FIXED_NOW) });
  const { ctx } = buildCtx(t, { baseDataDir: dir, inviteStore: store });
  const created = await callAdmin(ctx, { method: 'POST', url: '/api/admin/invites', body: {} });
  const code = created.json.invite.code;

  const deleted = await callAdmin(ctx, { method: 'DELETE', url: `/api/admin/invites/${code}` });
  assert.equal(deleted.res.statusCode, 200);
  assert.equal(deleted.json.invite.code, code);
  assert.equal(deleted.json.invite.disabled, true);
  const again = await callAdmin(ctx, { method: 'DELETE', url: `/api/admin/invites/${code}` });
  assert.equal(again.res.statusCode, 200, '重复吊销幂等');
  assert.equal(again.json.invite.disabled, true);
  await assert.rejects(store.redeem(code), (error) => error.code === 'INVITE_REVOKED');

  const unknown = await callAdmin(ctx, { method: 'DELETE', url: '/api/admin/invites/ideadbeef' });
  assert.equal(unknown.res.statusCode, 404);
  assert.equal(unknown.json.error.code, 'INVITE_NOT_FOUND');
});

test('邀请码：旧数据（无 disabled/lastUsedAt 字段）加载时补齐默认值', async (t) => {
  const dir = makeTmpDir(t);
  const legacyInvite = {
    code: 'i0a1b2c3d',
    role: 'user',
    maxUses: 5,
    uses: 2,
    createdBy: 'root',
    note: '历史邀请码',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
  };
  fs.writeFileSync(
    path.join(dir, INVITES_FILE_NAME),
    JSON.stringify({ version: 1, invites: [legacyInvite] }),
    { mode: 0o600 },
  );
  const store = createInviteStore({ dataDir: dir, logger: createCapturingLogger(), now: () => new Date(FIXED_NOW) });
  const { ctx } = buildCtx(t, { baseDataDir: dir, inviteStore: store });
  const list = await callAdmin(ctx, { url: '/api/admin/invites?include=all' });
  assert.equal(list.res.statusCode, 200);
  const row = list.json.invites[0];
  assert.equal(row.disabled, false, '旧数据视为启用');
  assert.equal(row.lastUsedAt, null, '旧数据视为未使用');
  assert.equal((await store.getValid(legacyInvite.code)).code, legacyInvite.code);
});

/* ================================ 审计日志端点 ================================ */

test('审计：写操作（settings/user/invite）接线写入 audit.jsonl 并可经 GET /api/admin/audit 查到', async (t) => {
  const dir = makeTmpDir(t);
  const logger = createCapturingLogger();
  const audit = createAuditLog({ dataDir: dir, logger, now: () => new Date(FIXED_NOW) });
  const users = createFakeUsers([
    { id: 'u_admin', username: 'root', role: 'admin', status: 'active' },
    { id: 'u2', username: 'alice', role: 'user', status: 'active' },
  ]);
  const { ctx } = buildCtx(t, { baseDataDir: dir, logger, audit, users });

  await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { byokEnabled: true },
  });
  await callAdmin(ctx, {
    method: 'PATCH',
    url: '/api/admin/users/u2',
    body: { status: 'banned' },
  });
  const created = await callAdmin(ctx, { method: 'POST', url: '/api/admin/invites', body: { maxUses: 2 } });
  const code = created.json.invite.code;

  const page = await callAdmin(ctx, { url: '/api/admin/audit?limit=10' });
  assert.equal(page.res.statusCode, 200);
  assert.equal(page.json.entries.length, 3, '三条写操作各一条审计');
  const actions = page.json.entries.map((entry) => entry.action);
  assert.deepEqual(actions, ['invite.create', 'user.update', 'settings.update'], '时间倒序（最新在前）');
  for (const entry of page.json.entries) {
    assert.equal(entry.actorId, 'u_admin');
    assert.equal(entry.actorUsername, 'root');
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(entry.detail && typeof entry.detail === 'object');
  }
  assert.equal(page.json.entries[1].targetType, 'user');
  assert.equal(page.json.entries[1].targetId, 'u2');
  assert.deepEqual(page.json.entries[1].detail, { fields: ['status'] });
  assert.equal(page.json.entries[0].targetId, code);
  assert.equal(page.json.nextCursor, null);

  const leaked = JSON.stringify(page.json.entries);
  assert.equal(leaked.includes('password'), false, '审计不含密码字段名');
  assert.equal(leaked.includes('HASH-DO-NOT-LEAK'), false);

  const filePath = path.join(dir, AUDIT_FILE_NAME);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[2].action, 'invite.create');
});

test('审计：limit/cursor 分页与非法 cursor → 400 INVALID_CURSOR；limit 越界 400', async (t) => {
  const dir = makeTmpDir(t);
  const audit = createAuditLog({ dataDir: dir, logger: createCapturingLogger(), now: () => new Date(FIXED_NOW) });
  const { ctx } = buildCtx(t, { baseDataDir: dir, audit });
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push(
      (
        await audit.append({
          ts: new Date(FIXED_NOW.getTime() + index * 1000).toISOString(),
          action: 'noop.check',
        })
      ).id,
    );
  }
  const page1 = await callAdmin(ctx, { url: '/api/admin/audit?limit=2' });
  assert.equal(page1.json.entries.length, 2);
  assert.deepEqual(
    page1.json.entries.map((entry) => entry.id),
    [ids[4], ids[3]],
  );
  assert.equal(page1.json.nextCursor, ids[3]);
  const page2 = await callAdmin(ctx, {
    url: `/api/admin/audit?limit=2&cursor=${page1.json.nextCursor}`,
  });
  assert.deepEqual(
    page2.json.entries.map((entry) => entry.id),
    [ids[2], ids[1]],
  );
  const page3 = await callAdmin(ctx, {
    url: `/api/admin/audit?limit=2&cursor=${page2.json.nextCursor}`,
  });
  assert.equal(page3.json.entries.length, 1);
  assert.equal(page3.json.nextCursor, null);

  const badCursor = await callAdmin(ctx, { url: '/api/admin/audit?cursor=aNOTREAL' });
  assert.equal(badCursor.res.statusCode, 400);
  assert.equal(badCursor.json.error.code, 'INVALID_CURSOR');

  const badLimit = await callAdmin(ctx, { url: '/api/admin/audit?limit=101' });
  assert.equal(badLimit.res.statusCode, 400);
});

test('审计：ctx.audit 缺失时 GET 返回空列表；写入失败不影响主操作（只 warn）', async (t) => {
  const noAudit = buildCtx(t);
  const empty = await callAdmin(noAudit.ctx, { url: '/api/admin/audit' });
  assert.equal(empty.res.statusCode, 200);
  assert.deepEqual(empty.json, { entries: [], nextCursor: null });

  const failing = buildCtx(t, {
    audit: {
      async append() {
        throw new Error('disk full');
      },
      async list() {
        return { entries: [], nextCursor: null };
      },
    },
  });
  const patched = await callAdmin(failing.ctx, {
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { byokEnabled: true },
  });
  assert.equal(patched.res.statusCode, 200, '审计失败不阻断设置更新');
  assert.equal(patched.json.settings.byokEnabled, true);
  assert.ok(
    failing.logger.logs.some((line) => line.level === 'warn' && /写审计日志失败/.test(line.text)),
    '审计失败应 warn',
  );
});

/* ================================ 系统状态  ================================ */

test('system： 字段齐全（version/uptime/disk/memory/data/backup/effective）', async (t) => {
  const dir = makeTmpDir(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'world!');
  const backupsDir = path.join(makeTmpDir(t), 'backups');
  fs.mkdirSync(path.join(backupsDir, '20260101-aaaa'), { recursive: true });
  fs.mkdirSync(path.join(backupsDir, '20260102-bbbb'), { recursive: true });
  const users = createFakeUsers([
    { id: 'u1', username: 'a', role: 'user', status: 'active' },
    { id: 'u2', username: 'b', role: 'user', status: 'banned' },
    { id: 'u3', username: 'c', role: 'admin', status: 'active' },
  ]);
  const { ctx } = buildCtx(t, {
    baseDataDir: dir,
    users,
    version: '1.2.3',
    startedAt: FIXED_NOW.getTime() - 65_000,
    config: defaultConfig({
      backupDir: backupsDir,
      attachmentRetentionDays: 2,
      byokAllowedModels: ['deepseek-v4-pro', 'deepseek-flash'],
      byokAllowedHosts: ['api.deepseek.com'],
    }),
  });
  const { res, json } = await callAdmin(ctx, { url: '/api/admin/system' });
  assert.equal(res.statusCode, 200);
  assert.equal(json.version, '1.2.3');
  assert.equal(json.startedAt, new Date(FIXED_NOW.getTime() - 65_000).toISOString());
  assert.equal(json.uptimeSec, 65);
  assert.match(json.node, /^v\d+/);
  assert.equal(typeof json.platform, 'string');

  if (json.disk !== null) {
    assert.equal(json.disk.path, path.resolve(dir));
    assert.ok(json.disk.totalBytes > 0);
    assert.ok(json.disk.freeBytes >= 0);
    assert.ok(json.disk.usedBytes >= 0);
    assert.ok(json.disk.usedPercent >= 0 && json.disk.usedPercent <= 100);
  }

  assert.equal(typeof json.memory.rss, 'number');
  assert.equal(typeof json.memory.heapUsed, 'number');
  assert.equal(typeof json.memory.heapTotal, 'number');

  assert.ok(json.data.dirBytes >= 11, 'data.dirBytes 统计目录文件字节');
  assert.ok(json.data.files >= 2, 'data.files 统计文件数');
  assert.equal(json.data.userCount, 3);

  assert.equal(json.backup.dir, path.resolve(backupsDir));
  assert.equal(json.backup.entries, 2);
  assert.ok(json.backup.lastPath.endsWith('20260102-bbbb'), '按目录名倒序取最近备份');
  assert.match(json.backup.lastAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(json.effective, {
    model: 'deepseek-v4-pro',
    peakPolicy: 'off',
    peakModel: 'deepseek-v4-flash',
    peakHours: '01:00-04:00,06:00-10:00',
    byokCheckEnabled: true,
    allowlists: {
      models: ['deepseek-v4-pro', 'deepseek-flash'],
      hosts: ['api.deepseek.com'],
    },
    webSearchPerUserPerDay: 5,
    attachmentRetentionDays: 2,
  });
});

test('system：backup 未配置/目录不存在时返回稳定空对象（不抛错）', async (t) => {
  const unconfigured = buildCtx(t);
  const first = await callAdmin(unconfigured.ctx, { url: '/api/admin/system' });
  assert.equal(first.res.statusCode, 200);
  assert.deepEqual(first.json.backup, { dir: '', lastAt: null, lastPath: null, entries: 0 });

  const missing = buildCtx(t, {
    config: defaultConfig({ backupDir: path.join(makeTmpDir(t), 'does-not-exist') }),
  });
  const second = await callAdmin(missing.ctx, { url: '/api/admin/system' });
  assert.equal(second.res.statusCode, 200);
  assert.equal(second.json.backup.lastAt, null);
  assert.equal(second.json.backup.entries, 0);
  assert.equal(second.json.backup.lastPath, null);
  assert.ok(second.json.backup.dir.length > 0);
});

test('system：data 指标 60s 进程内缓存（同一时钟内不重算，超过 60s 才刷新）', async (t) => {
  const dir = makeTmpDir(t);
  fs.writeFileSync(path.join(dir, 'one.txt'), '1');
  const { ctx, nowRef } = buildCtx(t, {
    baseDataDir: dir,
    users: createFakeUsers([{ id: 'u1', username: 'a', role: 'user', status: 'active' }]),
  });
  const first = await callAdmin(ctx, { url: '/api/admin/system' });
  assert.equal(first.json.data.files, 1);

  fs.writeFileSync(path.join(dir, 'two.txt'), '22');
  const cached = await callAdmin(ctx, { url: '/api/admin/system' });
  assert.equal(cached.json.data.files, 1, '60s 内命中缓存');

  nowRef.value = new Date(FIXED_NOW.getTime() + 61_000);
  const refreshed = await callAdmin(ctx, { url: '/api/admin/system' });
  assert.equal(refreshed.json.data.files, 2, '超过 60s 重新统计');
});

/* ================================ users 分页 / deleted ================================ */

function mixUsers() {
  return createFakeUsers([
    { id: 'u_admin', username: 'root', displayName: '管理员', role: 'admin', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'u2', username: 'alice', displayName: 'Alice', role: 'user', status: 'active', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'u3', username: 'bob', displayName: 'Bob', role: 'user', status: 'banned', createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'u4', username: 'carol', displayName: 'Carol', role: 'admin', status: 'active', createdAt: '2026-01-04T00:00:00.000Z' },
    { id: 'u5', username: 'dave', displayName: 'Dave', role: 'user', status: 'deleted', createdAt: '2026-01-05T00:00:00.000Z' },
  ]);
}

test('users：limit/offset 分页 + total=过滤后总数；无 limit 时返回全部（含 deleted，不默认隐藏）', async (t) => {
  const users = mixUsers();
  const { ctx } = buildCtx(t, { users });

  const all = await callAdmin(ctx, { url: '/api/admin/users' });
  assert.equal(all.res.statusCode, 200);
  assert.equal(all.json.users.length, 5);
  assert.equal(all.json.total, 5);
  assert.ok(all.json.users.some((user) => user.status === 'deleted'), '默认列表不隐藏 deleted 用户');
  for (const row of all.json.users) {
    assert.equal(Object.hasOwn(row, 'passwordHash'), false);
    assert.equal(Object.hasOwn(row, 'salt'), false);
    assert.ok(row.usage30d && typeof row.usage30d === 'object');
    assert.ok(row.byok && row.byok.configured === false);
  }

  const page1 = await callAdmin(ctx, { url: '/api/admin/users?limit=2&offset=0' });
  assert.equal(page1.json.users.length, 2);
  assert.equal(page1.json.total, 5);
  assert.equal(page1.json.limit, 2);
  assert.equal(page1.json.offset, 0);
  assert.deepEqual(
    page1.json.users.map((user) => user.id),
    ['u_admin', 'u2'],
  );

  const page2 = await callAdmin(ctx, { url: '/api/admin/users?limit=2&offset=2' });
  assert.deepEqual(
    page2.json.users.map((user) => user.id),
    ['u3', 'u4'],
  );
  assert.equal(page2.json.total, 5);

  const filtered = await callAdmin(ctx, { url: '/api/admin/users?query=ali&limit=10' });
  assert.equal(filtered.json.users.length, 1);
  assert.equal(filtered.json.total, 1, 'total 为过滤后总数');

  const banned = await callAdmin(ctx, { url: '/api/admin/users?status=banned' });
  assert.equal(banned.json.users.length, 1);
  assert.equal(banned.json.users[0].status, 'banned');
  assert.equal(banned.json.total, 1);

  const deletedOnly = await callAdmin(ctx, { url: '/api/admin/users?status=deleted' });
  assert.equal(deletedOnly.res.statusCode, 200);
  assert.equal(deletedOnly.json.users.length, 1);
  assert.equal(deletedOnly.json.users[0].id, 'u5');
  assert.equal(deletedOnly.json.total, 1);
});

test('users：非法 limit/offset/status → 400', async (t) => {
  const { ctx } = buildCtx(t, { users: mixUsers() });
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'offset=x', 'status=weird']) {
    const { res } = await callAdmin(ctx, { url: `/api/admin/users?${query}` });
    assert.equal(res.statusCode, 400, `${query} 应 400`);
  }
});

test('users：真实 UserService 注册→注销后 ?status=deleted 能查到该行（且不含密码哈希）', async (t) => {
  const usersDir = makeTmpDir(t);
  const logger = createCapturingLogger();
  const service = createUserService({
    dataDir: usersDir,
    logger,
    now: () => new Date(FIXED_NOW),
  });
  const admin = await service.ensureAdmin({ username: 'root', initialPassword: 'adminPass123' });
  const zoe = await service.create({ username: 'zoe', password: 'password123' });
  await service.markDeleted(zoe.id);

  const { ctx } = buildCtx(t, {
    users: service,
    adminUser: { ...admin.user, role: 'admin', status: 'active' },
  });
  const deletedOnly = await callAdmin(ctx, { url: '/api/admin/users?status=deleted' });
  assert.equal(deletedOnly.res.statusCode, 200);
  assert.equal(deletedOnly.json.users.length, 1);
  assert.equal(deletedOnly.json.users[0].username, 'zoe');
  assert.equal(deletedOnly.json.users[0].status, 'deleted');
  assert.equal(deletedOnly.json.total, 1);
  const raw = JSON.stringify(deletedOnly.json);
  assert.equal(raw.includes('passwordHash'), false);
  assert.equal(raw.includes(zoe.id) && raw.includes('zoe'), true);

  const all = await callAdmin(ctx, { url: '/api/admin/users' });
  assert.ok(
    all.json.users.some((user) => user.username === 'zoe' && user.status === 'deleted'),
    '默认列表仍返回已注销用户（供审计/复登排查）',
  );
});

/* ================================ 附件保留期清理 ================================ */

function prepareSweepFixture(t) {
  const dir = makeTmpDir(t);
  const attachmentsDir = path.join(dir, 'attachments');
  const refBase = attachmentId(0x11);
  const oldUnref = attachmentId(0x12);
  const freshUnref = attachmentId(0x13);
  const memRef = attachmentId(0x16);
  writeAttachmentFile(attachmentsDir, refBase, { size: 11, mtime: new Date(FIXED_NOW.getTime() - 10 * DAY_MS) });
  writeAttachmentFile(attachmentsDir, oldUnref, { size: 12, mtime: new Date(FIXED_NOW.getTime() - 10 * DAY_MS) });
  writeAttachmentFile(attachmentsDir, freshUnref, { size: 13, mtime: FIXED_NOW });
  writeAttachmentFile(attachmentsDir, memRef, { size: 14, mtime: new Date(FIXED_NOW.getTime() - 10 * DAY_MS) });
  const tmpOldPath = path.join(attachmentsDir, 'orphan.tmp');
  fs.writeFileSync(tmpOldPath, Buffer.alloc(5, 1));
  fs.utimesSync(tmpOldPath, new Date(FIXED_NOW.getTime() - 10 * DAY_MS), new Date(FIXED_NOW.getTime() - 10 * DAY_MS));
  const tmpFreshPath = path.join(attachmentsDir, 'inflight.tmp');
  fs.writeFileSync(tmpFreshPath, Buffer.alloc(6, 1));
  fs.utimesSync(tmpFreshPath, FIXED_NOW, FIXED_NOW);

  writeConversation(dir, 'c1', [refBase]);
  writeMemories(dir, [memRef]);

  const userDir = path.join(dir, 'users', 'u1');
  const userRef = attachmentId(0x14);
  const userOld = attachmentId(0x15);
  writeAttachmentFile(path.join(userDir, 'attachments'), userRef, {
    size: 15,
    mtime: new Date(FIXED_NOW.getTime() - 10 * DAY_MS),
  });
  writeAttachmentFile(path.join(userDir, 'attachments'), userOld, {
    size: 16,
    mtime: new Date(FIXED_NOW.getTime() - 10 * DAY_MS),
  });
  writeConversation(userDir, 'c2', [userRef]);

  return {
    dir,
    users: createFakeUsers([{ id: 'u1', username: 'alice', role: 'user', status: 'deleted' }]),
    attachments: createAttachmentStore({ dataDir: dir, logger: createCapturingLogger() }),
    ids: { refBase, oldUnref, freshUnref, memRef, userRef, userOld },
    paths: {
      attachmentsDir,
      tmpOldPath,
      tmpFreshPath,
      userAttachmentsDir: path.join(userDir, 'attachments'),
    },
  };
}

test('maintenance/sweep-attachments：只删「全库无引用 + mtime 超龄」附件（含用户目录），返回 {removed,bytes} 并写审计', async (t) => {
  const dir = makeTmpDir(t);
  const fixture = prepareSweepFixture(t);
  const logger = createCapturingLogger();
  const audit = createAuditLog({ dataDir: dir, logger, now: () => new Date(FIXED_NOW) });
  const { ctx } = buildCtx(t, {
    baseDataDir: fixture.dir,
    users: fixture.users,
    attachments: fixture.attachments,
    audit,
    logger,
    config: defaultConfig({ attachmentRetentionDays: 2 }),
  });
  const { res, json } = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/maintenance/sweep-attachments',
    body: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(json.removed, 3, '基础目录孤儿 + 用户目录孤儿 + 超龄 tmp');
  assert.ok(json.bytes >= 12 + 16 + 5, 'bytes 为被删文件大小合计');

  const { ids, paths } = fixture;
  assert.equal(fs.existsSync(path.join(paths.attachmentsDir, `${ids.oldUnref}.png`)), false, '无引用超龄删除');
  assert.equal(fs.existsSync(path.join(paths.attachmentsDir, `${ids.refBase}.png`)), true, '被会话引用保留');
  assert.equal(fs.existsSync(path.join(paths.attachmentsDir, `${ids.memRef}.png`)), true, '被记忆引用保留');
  assert.equal(fs.existsSync(path.join(paths.attachmentsDir, `${ids.freshUnref}.png`)), true, '未超龄保留');
  assert.equal(fs.existsSync(paths.tmpOldPath), false, '超龄 tmp 删除');
  assert.equal(fs.existsSync(paths.tmpFreshPath), true, '新鲜 tmp 保留');
  assert.equal(fs.existsSync(path.join(paths.userAttachmentsDir, `${ids.userOld}.png`)), false);
  assert.equal(fs.existsSync(path.join(paths.userAttachmentsDir, `${ids.userRef}.png`)), true);

  const auditPage = await callAdmin(ctx, { url: '/api/admin/audit?limit=10' });
  const entry = auditPage.json.entries.find((item) => item.action === 'maintenance.attachments_sweep');
  assert.ok(entry, '清理动作写审计');
  assert.equal(entry.targetType, 'attachments');
  assert.equal(entry.detail.maxAgeDays, 2);
  assert.equal(entry.detail.removed, 3);
});

test('maintenance/sweep-attachments：body.maxAgeDays 覆盖配置；未启用（0）→ 400 MAINTENANCE_DISABLED', async (t) => {
  const fixture = prepareSweepFixture(t);
  const audit = createAuditLog({ dataDir: fixture.dir, logger: createCapturingLogger(), now: () => new Date(FIXED_NOW) });
  const base = buildCtx(t, {
    baseDataDir: fixture.dir,
    users: fixture.users,
    attachments: fixture.attachments,
    audit,
    config: defaultConfig({ attachmentRetentionDays: 0 }),
  });
  const disabled = await callAdmin(base.ctx, {
    method: 'POST',
    url: '/api/admin/maintenance/sweep-attachments',
    body: {},
  });
  assert.equal(disabled.res.statusCode, 400);
  assert.equal(disabled.json.error.code, 'MAINTENANCE_DISABLED');

  const zero = await callAdmin(base.ctx, {
    method: 'POST',
    url: '/api/admin/maintenance/sweep-attachments',
    body: { maxAgeDays: 0 },
  });
  assert.equal(zero.res.statusCode, 400);
  const negative = await callAdmin(base.ctx, {
    method: 'POST',
    url: '/api/admin/maintenance/sweep-attachments',
    body: { maxAgeDays: -1 },
  });
  assert.equal(negative.res.statusCode, 400);
  const badKey = await callAdmin(base.ctx, {
    method: 'POST',
    url: '/api/admin/maintenance/sweep-attachments',
    body: { retention: 1 },
  });
  assert.equal(badKey.res.statusCode, 400);

  const overridden = await callAdmin(base.ctx, {
    method: 'POST',
    url: '/api/admin/maintenance/sweep-attachments',
    body: { maxAgeDays: 2 },
  });
  assert.equal(overridden.res.statusCode, 200);
  assert.equal(overridden.json.removed, 3, '显式 maxAgeDays 可覆盖配置 0');
});

/* ================================ 权限 ================================ */

test('权限：新端点匿名 401、非管理员 403；GET audit/system 之外的方法 404', async (t) => {
  const { ctx } = buildCtx(t);
  const anonymous = { ...ctx, user: null };
  const normal = { ...ctx, user: { id: 'u2', username: 'alice', role: 'user', status: 'active' } };
  const endpoints = [
    { method: 'GET', url: '/api/admin/audit' },
    { method: 'GET', url: '/api/admin/system' },
    { method: 'PATCH', url: '/api/admin/invites/ideadbeef', body: { disabled: true } },
    { method: 'DELETE', url: '/api/admin/invites/ideadbeef' },
    { method: 'POST', url: '/api/admin/maintenance/sweep-attachments', body: {} },
    { method: 'GET', url: '/api/admin/users?status=deleted' },
  ];
  for (const endpoint of endpoints) {
    const noAuth = await callAdmin(anonymous, endpoint);
    assert.equal(noAuth.res.statusCode, 401, `${endpoint.method} ${endpoint.url} 匿名应 401`);
    const forbidden = await callAdmin(normal, endpoint);
    assert.equal(forbidden.res.statusCode, 403, `${endpoint.method} ${endpoint.url} 非管理员应 403`);
  }

  const auditPost = await callAdmin(ctx, {
    method: 'POST',
    url: '/api/admin/audit',
    body: { action: 'fake' },
  });
  assert.equal(auditPost.res.statusCode, 404, '审计只读');
  const systemPost = await callAdmin(ctx, { method: 'POST', url: '/api/admin/system', body: {} });
  assert.equal(systemPost.res.statusCode, 404, 'system 只读');
});
