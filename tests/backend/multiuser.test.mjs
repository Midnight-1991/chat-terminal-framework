// ~按用户数据分区、配额/限流 gate、迁移后 AUTH=on 启动的端到端测试。
// AUTH=off 路径同时验证：不产生 users/ 分区、旧数据目录结构不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { migrateMultiuser } from '../../scripts/migrate-multiuser.mjs';
import {
  apiJson,
  makeTmpDir,
  postChat,
  startAuthedServer,
  startServer,
  waitFor,
} from './helpers.mjs';

function authHeaders(session) {
  return { cookie: session.cookieHeader, 'x-csrf-token': session.csrf };
}

test('按用户分区——两个用户的会话互不可见，数据落在 users/<uid>/', async (t) => {
  const started = await startAuthedServer(t, {
    env: { CHAT_MOCK: '1' },
    users: [
      { username: 'alice', password: 'alice-pass-1' },
      { username: 'bob', password: 'bob-pass-2' },
    ],
  });
  const { baseUrl, login, accounts, dataDir } = started;
  const alice = await login('alice', 'alice-pass-1');
  const bob = await login('bob', 'bob-pass-2');
  assert.equal(alice.status, 200);
  assert.equal(bob.status, 200);

  const chat = await postChat(baseUrl, { message: '你好，我是爱丽丝', effort: 'low' }, {
    headers: authHeaders(alice),
  });
  assert.equal(chat.status, 200);

  const aliceConversations = await apiJson(baseUrl, '/api/conversations', {
    headers: { cookie: alice.cookieHeader },
  });
  assert.equal(aliceConversations.status, 200);
  assert.equal(aliceConversations.data.conversations.length, 1);

  const bobConversations = await apiJson(baseUrl, '/api/conversations', {
    headers: { cookie: bob.cookieHeader },
  });
  assert.equal(bobConversations.status, 200);
  assert.equal(bobConversations.data.conversations.length, 0);

  const aliceId = accounts.find((account) => account.username === 'alice').id;
  const bobId = accounts.find((account) => account.username === 'bob').id;
  assert.ok(fs.existsSync(path.join(dataDir, 'users', aliceId)), 'alice 分区目录应存在');
  assert.ok(fs.existsSync(path.join(dataDir, 'users', bobId)), 'bob 分区目录应存在');
  assert.ok(fs.existsSync(path.join(dataDir, 'users', aliceId, 'index.json')));

  // 管理员（全局视角）也只能看到自己的分区，不会串入普通用户内容。
  const adminConversations = await apiJson(baseUrl, '/api/conversations', {
    headers: { cookie: started.session.cookieHeader },
  });
  assert.equal(adminConversations.status, 200);
  assert.equal(adminConversations.data.conversations.length, 0);
});

test('AUTH=off：旧单用户路径不产生 users/ 分区，会话仍写入 DATA_DIR 根', async (t) => {
  const server = await startServer(t, { env: { CHAT_MOCK: '1' } });
  const chat = await postChat(server.baseUrl, { message: '你好', effort: 'low' });
  assert.equal(chat.status, 200);
  assert.equal(fs.existsSync(`${server.dataDir}/users`), false, 'AUTH=off 不应创建 users/ 目录');
  assert.ok(fs.existsSync(`${server.dataDir}/index.json`), '旧路径数据仍在 DATA_DIR 根');
});

test('配额 gate——超过 QUOTA_DAY_TOKENS 后返回 429 QUOTA_EXCEEDED + retry-after', async (t) => {
  const started = await startAuthedServer(t, {
    env: { CHAT_MOCK: '1', QUOTA_DAY_TOKENS: '1' },
    users: [{ username: 'alice', password: 'alice-pass-1' }],
  });
  const alice = await started.login('alice', 'alice-pass-1');
  const first = await postChat(started.baseUrl, { message: '第一轮', effort: 'low' }, {
    headers: authHeaders(alice),
  });
  assert.equal(first.status, 200);

  const recorded = await waitFor(async () => {
    const usage = await apiJson(started.baseUrl, '/api/me/usage?days=1', {
      headers: { cookie: alice.cookieHeader },
    });
    return usage.status === 200 && Number(usage.data?.totals?.tokens ?? 0) > 0;
  });
  assert.equal(recorded, true, '首轮对话应记录用量');

  const second = await postChat(started.baseUrl, { message: '第二轮', effort: 'low' }, {
    headers: authHeaders(alice),
  });
  assert.equal(second.status, 429);
  const body = JSON.parse(second.text);
  assert.equal(body.error.code, 'QUOTA_EXCEEDED');
  assert.ok(body.error.resetAt, '应返回 resetAt');
  assert.ok(Number(second.headers['retry-after']) >= 1, '应返回 retry-after 秒');

  // 管理员豁免配额（quota 不限制 admin）。
  const adminChat = await postChat(started.baseUrl, { message: '管理员照常', effort: 'low' }, {
    headers: authHeaders(started.session),
  });
  assert.equal(adminChat.status, 200);
});

test('注册用户默认继承全局配额——第 1 次聊天 200，第 2 次 429 QUOTA_EXCEEDED；admin 连续 200', async (t) => {
  const started = await startAuthedServer(t, { env: { CHAT_MOCK: '1', QUOTA_DAY_TOKENS: '1' } });
  const invite = await apiJson(started.baseUrl, '/api/admin/invites', {
    method: 'POST',
    headers: authHeaders(started.session),
    body: { role: 'user', maxUses: 1 },
  });
  assert.equal(invite.status, 201);
  const register = await apiJson(started.baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { inviteCode: invite.data.invite.code, username: 'quota-user', password: 'quota-pass-1', acceptTerms: true },
  });
  assert.equal(register.status, 201);
  assert.deepEqual(register.data.user.quota, { dayTokens: 1, monthTokens: 2000000 });

  const setCookies = register.headers.getSetCookie?.() ?? [];
  const cookies = {};
  for (const raw of setCookies) {
    const pair = raw.split(';')[0];
    const index = pair.indexOf('=');
    cookies[pair.slice(0, index)] = pair.slice(index + 1);
  }
  const userSession = {
    cookieHeader: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: register.data.csrf,
  };

  const first = await postChat(started.baseUrl, { message: '第一次', effort: 'low' }, {
    headers: authHeaders(userSession),
  });
  assert.equal(first.status, 200);
  const recorded = await waitFor(async () => {
    const usage = await apiJson(started.baseUrl, '/api/me/usage?days=1', {
      headers: { cookie: userSession.cookieHeader },
    });
    return usage.status === 200 && Number(usage.data?.totals?.tokens ?? 0) > 0;
  });
  assert.equal(recorded, true);
  const second = await postChat(started.baseUrl, { message: '第二次', effort: 'low' }, {
    headers: authHeaders(userSession),
  });
  assert.equal(second.status, 429);
  assert.equal(JSON.parse(second.text).error.code, 'QUOTA_EXCEEDED');

  for (let index = 0; index < 2; index += 1) {
    const adminChat = await postChat(started.baseUrl, { message: `管理员 ${index}`, effort: 'low' }, {
      headers: authHeaders(started.session),
    });
    assert.equal(adminChat.status, 200);
  }
});

test('限流 gate——超过 RATE_PER_MINUTE 后返回 429 RATE_LIMITED + retry-after', async (t) => {
  const started = await startAuthedServer(t, {
    env: { CHAT_MOCK: '1', RATE_PER_MINUTE: '1' },
    users: [{ username: 'alice', password: 'alice-pass-1' }],
  });
  const alice = await started.login('alice', 'alice-pass-1');
  const first = await postChat(started.baseUrl, { message: '第一次', effort: 'low' }, {
    headers: authHeaders(alice),
  });
  assert.equal(first.status, 200);
  const second = await postChat(started.baseUrl, { message: '第二次', effort: 'low' }, {
    headers: authHeaders(alice),
  });
  assert.equal(second.status, 429);
  const body = JSON.parse(second.text);
  assert.ok(['RATE_LIMITED', 'CONCURRENCY_LIMITED'].includes(body.error.code));
  assert.ok(Number(second.headers['retry-after']) >= 1);

  // 管理员豁免限流。
  const adminChat = await postChat(started.baseUrl, { message: '管理员', effort: 'low' }, {
    headers: authHeaders(started.session),
  });
  assert.equal(adminChat.status, 200);
});

test('legacy 数据迁移后 AUTH=on 启动——管理员接管旧会话，备份与 migration.json 落盘', async (t) => {
  // 1) 先在 AUTH=off 下产生 legacy 单用户数据（DATA_DIR 根）。
  const legacy = await startServer(t, { env: { CHAT_MOCK: '1' } });
  const chat = await postChat(legacy.baseUrl, { message: '旧世界的对话', effort: 'low' });
  assert.equal(chat.status, 200);
  await new Promise((resolve) => legacy.server.close(resolve));
  const legacyConversations = await import('node:fs/promises').then(async (fsPromises) => {
    const raw = await fsPromises.readFile(path.join(legacy.dataDir, 'index.json'), 'utf8');
    return JSON.parse(raw).conversations.length;
  });
  assert.ok(legacyConversations >= 1);

  // 2) 准备管理员初始密码文件，执行迁移。
  const passwordFile = path.join(makeTmpDir('wild-auth-pwd-'), 'admin-initial-password.txt');
  fs.writeFileSync(passwordFile, 'admin-migrate-pass-1\n', { mode: 0o600 });
  const env = {
    AUTH: 'on',
    ADMIN_USERNAME: 'admin',
    ADMIN_INITIAL_PASSWORD_FILE: passwordFile,
  };
  const result = await migrateMultiuser({ dataDir: legacy.dataDir, env, repoRoot: legacy.dataDir, logger: { log() {}, warn() {}, error() {} } });
  assert.equal(result.migrated, true);
  assert.ok(fs.existsSync(path.join(legacy.dataDir, 'migration.json')));
  assert.ok(
    fs.existsSync(path.isAbsolute(result.backupDir) ? result.backupDir : path.join(legacy.dataDir, result.backupDir)),
    '备份目录应存在',
  );
  assert.equal(fs.existsSync(path.join(legacy.dataDir, 'index.json')), false, '迁移后源文件应删除');

  // 3) 用同一 DATA_DIR 以 AUTH=on 启动：管理员看到迁移后的会话。
  const server = await startServer(t, {
    dataDir: legacy.dataDir,
    env: { ...env, CHAT_MOCK: '1' },
  });
  const loginResponse = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
  });
  // 密码文件里是 admin-migrate-pass-1，这里先用错误密码确认 401，再用正确密码登录。
  assert.equal(loginResponse.status, 401);
  const loginOk = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-migrate-pass-1' }),
  });
  assert.equal(loginOk.status, 200);
  const setCookies = loginOk.headers.getSetCookie?.() ?? [];
  const cookies = {};
  for (const raw of setCookies) {
    const pair = raw.split(';')[0];
    const index = pair.indexOf('=');
    cookies[pair.slice(0, index)] = pair.slice(index + 1);
  }
  const cookieHeader = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  const conversations = await apiJson(server.baseUrl, '/api/conversations', { headers: { cookie: cookieHeader } });
  assert.equal(conversations.status, 200);
  assert.equal(conversations.data.conversations.length, legacyConversations);
  assert.equal(conversations.data.conversations[0].title, '旧世界的对话');

  // 重启幂等：migration.json 已存在 → 直接 skip，不依赖密码文件。
  const secondRun = await migrateMultiuser({
    dataDir: legacy.dataDir,
    env: { AUTH: 'on' },
    repoRoot: legacy.dataDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(secondRun.migrated, false);
  assert.equal(secondRun.skipped, true);
});

test('AUTH=on 记录按用户作用域——导入落管理员分区、登录后可见、匿名与他人不可见、DELETE 只清本人', async (t) => {
  const started = await startAuthedServer(t, {
    env: {
      CHAT_MOCK: '1',
      HEALTH_IMPORT: '1',
      HEALTH_IMPORT_TOKEN: 'health-token-test',
      HEALTH_INJECT: '1',
    },
    users: [{ username: 'carol', password: 'carol-pass-1' }],
  });
  const { baseUrl, accounts, dataDir, login, session } = started;
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  // 1) iOS 导入（token 鉴权，无需登录）→ 写入管理员分区 users/<adminId>/health.json
  const imported = await fetch(`${baseUrl}/api/health-import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-health-token': 'health-token-test' },
    body: JSON.stringify({ date: today, metrics: { steps: 8123, sleepMinutes: 415 } }),
  });
  assert.equal(imported.status, 200);
  const adminId = accounts[0].id;
  const adminHealthFile = path.join(dataDir, 'users', adminId, 'health.json');
  assert.ok(fs.existsSync(adminHealthFile), '导入后 health.json 应在管理员分区（而非根目录）');
  const saved = JSON.parse(fs.readFileSync(adminHealthFile, 'utf8'));
  assert.equal(saved.days[today].steps, 8123);
  assert.ok(!fs.existsSync(path.join(dataDir, 'health.json')), '根目录不应产生 health.json');

  // 2) 登录管理员可见；普通用户与匿名不可见（各看各的）
  const adminHealth = await apiJson(baseUrl, '/api/health', { headers: { cookie: session.cookieHeader } });
  assert.equal(adminHealth.status, 200);
  assert.equal(adminHealth.data.days[today].steps, 8123);
  const carol = await login('carol', 'carol-pass-1');
  const carolHealth = await apiJson(baseUrl, '/api/health', { headers: { cookie: carol.cookieHeader } });
  assert.equal(carolHealth.status, 200);
  assert.deepEqual(carolHealth.data.days, {});
  const anonHealth = await apiJson(baseUrl, '/api/health');
  assert.equal(anonHealth.status, 200);
  assert.deepEqual(anonHealth.data.days, {});

  // 3) DELETE：匿名 401；普通用户 403（清空记录仍仅管理员）；管理员清空本人数据
  const anonDelete = await fetch(`${baseUrl}/api/health`, { method: 'DELETE' });
  assert.equal(anonDelete.status, 401);
  const carolDelete = await fetch(`${baseUrl}/api/health`, {
    method: 'DELETE',
    headers: { cookie: carol.cookieHeader, 'x-csrf-token': carol.csrf },
  });
  assert.equal(carolDelete.status, 403);
  const adminDelete = await fetch(`${baseUrl}/api/health`, {
    method: 'DELETE',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
  });
  assert.equal(adminDelete.status, 200);
  const adminAfter = await apiJson(baseUrl, '/api/health', { headers: { cookie: session.cookieHeader } });
  assert.deepEqual(adminAfter.data.days, {});
});
