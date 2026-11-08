//  / /api/me 合规扩展 handler 测试——同意补签、数据导出、账号注销。
// 方式：把 handleMeData 挂到测试内 http server（app.mjs 接线由 Lead 集成任务完成），
// ctx 用真实 users/user-sessions/auth 服务 + 假数据服务（store/marks/health/scaleHistory/feedback/byok/usage）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';

import { CONSENT_VERSION } from '../../server/consent.mjs';
import { handleMeData } from '../../server/me-data.mjs';
import { createAuthService } from '../../server/auth.mjs';
import { createSessionService } from '../../server/user-sessions.mjs';
import { createUserService } from '../../server/users.mjs';
import { apiJson, createCapturingLogger, makeTmpDir } from './helpers.mjs';

const PASSWORD = 'alice-pass-123';

/** 把 handleMeData 挂到独立测试 http server 上（模拟 app.mjs 的 /api/me 分发）。 */
async function startHandlerServer(t, ctx) {
  const server = http.createServer(async (req, res) => {
    const segments = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean);
    try {
      const handled = await handleMeData(req, res, ctx, segments);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '接口不存在' } }));
      }
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: String(error?.message ?? error) } }));
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  );
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

/** 假数据服务：形状与 app.mjs per-user scoped ctx 一致（真实服务形状见各模块测试）。 */
function makeFakeServices(overrides = {}) {
  const calls = {
    revokeAll: [],
    deleteByUser: [],
    listByUser: [],
  };
  const services = {
    store: {
      listConversations: () => [
        { id: 'c1', title: '第一段对话', createdAt: 1700000000000, updatedAt: 1700000005000, turnCount: 2 },
        { id: 'c2', title: '第二段对话', createdAt: 1700000100000, updatedAt: 1700000105000, turnCount: 1 },
      ],
      getConversation: (id) => ({
        conversation: { id, title: id === 'c1' ? '第一段对话' : '第二段对话', createdAt: 1700000000000, updatedAt: 1700000005000 },
        messages: [
          { role: 'user', content: '你好', createdAt: 1700000001000 },
          { role: 'assistant', content: '我在', createdAt: 1700000002000 },
        ],
      }),
      listMemories: () => [
        { id: 'm1', text: '用户最近在准备考试', createdAt: 1700000000000 },
        { id: 'm2', text: '用户喜欢散步', createdAt: 1700000001000 },
      ],
    },
    marks: {
      list: () => ({
        excerpts: [{ id: 'e1', docId: 'seasonal-01', anchor: 's2', para: 1, createdAt: 1700000000000 }],
        favorites: [{ id: 'f1', docId: 'seasonal-01', title: '换季时节的观察笔记', createdAt: 1700000000000 }],
        stats: { excerpts: 1, favorites: 1 },
      }),
    },
    health: {
      days: { '2026-11-01': { sleep: 8, steps: 6000 } },
      healthMeta: () => ({ days: 1, lastImportedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }),
    },
    scaleHistory: {
      entries: [{ id: 's1', scaleId: 'demo-scale-1', at: '2026-11-01T00:00:00.000Z', score: 5 }],
    },
    feedback: {
      async listByUser(userId) {
        calls.listByUser.push(userId);
        return [{ id: 'fb1', body: '希望增加导出功能', createdAt: '2026-11-01T00:00:00.000Z' }];
      },
      async deleteByUser(userId) {
        calls.deleteByUser.push(userId);
        return 1;
      },
    },
    byok: {
      async getMeta() {
        return {
          configured: true,
          provider: { id: 'deepseek', label: 'DeepSeek', protocol: 'openai' },
          model: 'deepseek-chat',
          keyHint: 'test-key-…abcd',
          baseUrlOrigin: null,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
        };
      },
    },
    usage: {
      async userSummary() {
        return {
          totals: { requests: 3, tokens: 120, inputTokens: 80, outputTokens: 40, costUsd: 0.0012 },
          series: [],
          bySource: {
            official: { requests: 2, tokens: 100, costUsd: 0.0012 },
            byok: { requests: 1, tokens: 20, costUsd: null },
          },
        };
      },
    },
  };
  return { ...services, ...overrides, calls };
}

/** 构造 per-user scoped ctx（真实 users 服务 + 假数据服务）。 */
async function makeCtx(t, { username = 'alice', role = 'user' } = {}) {
  const dataDir = makeTmpDir('wild-medata-');
  const logger = createCapturingLogger();
  const users = createUserService({ dataDir, logger });
  let user = null;
  if (role === 'admin') {
    const ensured = await users.ensureAdmin({ username, initialPassword: PASSWORD });
    user = ensured.user;
  } else {
    user = await users.create({ username, password: PASSWORD });
  }
  const userDir = path.join(dataDir, 'users', user.id);
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'memories.json'), '[]');
  fs.writeFileSync(path.join(userDir, 'byok.secret.enc'), 'ciphertext');
  const fake = makeFakeServices();
  const sessions = [];
  const ctx = {
    ...fake,
    userId: user.id,
    user,
    users,
    userSessions: {
      async revokeAll(userId, options) {
        sessions.push({ userId, options });
        return 2;
      },
    },
    baseDataDir: dataDir,
    userDir,
    logger,
  };
  return { ctx, user, users, dataDir, userDir, logger, sessions, calls: fake.calls };
}

/* ------------------------------ POST /api/me/consent ------------------------------ */

test('POST /api/me/consent：版本匹配→200 写入 users.json 且返回 current=true；旧版本→400', async (t) => {
  const { ctx, user, dataDir } = await makeCtx(t);
  const baseUrl = await startHandlerServer(t, ctx);

  const wrong = await apiJson(baseUrl, '/api/me/consent', {
    method: 'POST',
    body: { version: '2020-01-01' },
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.error.code, 'CONSENT_VERSION_INVALID');

  const ok = await apiJson(baseUrl, '/api/me/consent', {
    method: 'POST',
    body: { version: CONSENT_VERSION },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.consent.version, CONSENT_VERSION);
  assert.equal(ok.data.consent.current, true);
  assert.ok(Number.isFinite(Date.parse(ok.data.consent.at)));

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  const record = persisted.users.find((item) => item.id === user.id);
  assert.deepEqual(record.consent, { version: CONSENT_VERSION, at: ok.data.consent.at });
  assert.equal(ctx.user.consent, undefined, 'handler 不应改写内存里的旧 user 对象');
});

test('POST /api/me/consent：非 JSON / 缺 version 的安全失败（400），不写库', async (t) => {
  const { ctx, dataDir } = await makeCtx(t);
  const baseUrl = await startHandlerServer(t, ctx);
  for (const body of [{}, { version: 123 }]) {
    const result = await apiJson(baseUrl, '/api/me/consent', { method: 'POST', body });
    assert.equal(result.status, 400);
    assert.equal(result.data.error.code, 'CONSENT_VERSION_INVALID');
  }
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  assert.equal(persisted.users.some((item) => item.consent !== undefined), false);
});

/* ------------------------------ GET /api/me/export ------------------------------ */

test('GET /api/me/export：bundle 形状冻结、无敏感字段、附件头正确', async (t) => {
  const { ctx, user, calls } = await makeCtx(t);
  await ctx.users.setConsent(user.id, { version: CONSENT_VERSION, at: '2026-11-01T08:00:00.000Z' });
  const baseUrl = await startHandlerServer(t, ctx);

  const result = await apiJson(baseUrl, '/api/me/export');
  assert.equal(result.status, 200);
  assert.match(String(result.headers.get('content-type')), /application\/json; charset=utf-8/);
  assert.match(
    String(result.headers.get('content-disposition')),
    /^attachment; filename="ctf-export-alice-\d{8}\.json"$/,
  );
  const bundle = result.data;
  assert.deepEqual(Object.keys(bundle).sort(), [
    'byok',
    'consent',
    'conversations',
    'exportedAt',
    'feedback',
    'health',
    'marks',
    'memories',
    'scalesHistory',
    'usage',
    'user',
    'version',
  ]);
  assert.equal(bundle.version, 'm44-1');
  assert.ok(Number.isFinite(Date.parse(bundle.exportedAt)));
  assert.deepEqual(Object.keys(bundle.user).sort(), ['createdAt', 'displayName', 'id', 'lastLoginAt', 'role', 'username']);
  assert.equal(bundle.user.username, 'alice');
  assert.equal(bundle.user.role, 'user');
  assert.equal(bundle.consent.version, CONSENT_VERSION);
  assert.equal(bundle.consent.current, true);

  assert.equal(bundle.conversations.length, 2);
  assert.deepEqual(Object.keys(bundle.conversations[0]).sort(), ['createdAt', 'id', 'messages', 'title', 'updatedAt']);
  assert.equal(bundle.conversations[0].messages.length, 2);
  assert.equal(bundle.memories.length, 2);
  assert.equal(bundle.marks.stats.excerpts, 1);
  assert.equal(bundle.marks.stats.favorites, 1);
  assert.equal(bundle.health.days['2026-11-01'].sleep, 8);
  assert.equal(bundle.scalesHistory.length, 1);
  assert.equal(bundle.feedback.length, 1);
  assert.deepEqual(bundle.byok, {
    configured: true,
    provider: 'deepseek',
    model: 'deepseek-chat',
    keyHint: 'test-key-…abcd',
    baseUrlOrigin: null,
    updatedAt: '2026-11-02T00:00:00.000Z',
  });
  assert.match(bundle.usage.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(bundle.usage.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(bundle.usage.from < bundle.usage.to, true);
  assert.equal(bundle.usage.bySource.official.requests, 2);
  assert.equal(bundle.usage.bySource.byok.costUsd, null);
  assert.equal(bundle.usage.totals.requests, 3);

  // 敏感字段绝不出现（密码哈希 / salt / session id / BYOK 密钥与密文）
  const json = JSON.stringify(bundle);
  for (const secretKey of ['passwordHash', 'passwordSalt', 'passwordAlgo', 'apiKey', '"sid"', 'secret.enc']) {
    assert.equal(json.includes(secretKey), false, `导出 bundle 不应包含 ${secretKey}`);
  }
  // 假 ctx 的 feedback.listByUser 被调用且入参是本人
  assert.deepEqual(calls.listByUser, [user.id]);
});

test('GET /api/me/export：无 BYOK / 无反馈时返回 null 与空数组（不抛错）', async (t) => {
  const { ctx } = await makeCtx(t);
  ctx.byok = { async getMeta() { return { configured: false }; } };
  ctx.feedback = {};
  const baseUrl = await startHandlerServer(t, ctx);
  const result = await apiJson(baseUrl, '/api/me/export');
  assert.equal(result.status, 200);
  assert.equal(result.data.byok, null);
  assert.deepEqual(result.data.feedback, []);
});

/* ------------------------------ DELETE /api/me ------------------------------ */

test('DELETE /api/me：密码错误→400 PASSWORD_INVALID，账号与目录均不变', async (t) => {
  const { ctx, user, users, userDir, sessions, calls } = await makeCtx(t);
  const baseUrl = await startHandlerServer(t, ctx);
  const result = await apiJson(baseUrl, '/api/me', { method: 'DELETE', body: { password: 'wrong-password' } });
  assert.equal(result.status, 400);
  assert.equal(result.data.error.code, 'PASSWORD_INVALID');
  assert.equal((await users.get(user.id)).status, 'active');
  assert.equal(fs.existsSync(userDir), true);
  assert.equal(sessions.length, 0);
  assert.equal(calls.deleteByUser.length, 0);
});

test('DELETE /api/me：最后一个 active admin→409 LAST_ADMIN，一切不变', async (t) => {
  const { ctx, user, users, userDir, sessions } = await makeCtx(t, { username: 'admin', role: 'admin' });
  const baseUrl = await startHandlerServer(t, ctx);
  const result = await apiJson(baseUrl, '/api/me', { method: 'DELETE', body: { password: PASSWORD } });
  assert.equal(result.status, 409);
  assert.equal(result.data.error.code, 'LAST_ADMIN');
  assert.equal((await users.get(user.id)).status, 'active');
  assert.equal(fs.existsSync(userDir), true);
  assert.equal(sessions.length, 0);
});

test('DELETE /api/me：成功→204、会话吊销、status=deleted 且密码凭据清除、用户目录与反馈删除', async (t) => {
  const { ctx, user, users, dataDir, userDir, sessions, calls } = await makeCtx(t);
  const baseUrl = await startHandlerServer(t, ctx);
  const result = await apiJson(baseUrl, '/api/me', { method: 'DELETE', body: { password: PASSWORD } });
  assert.equal(result.status, 204);

  // 会话吊销（全部，无 exceptSid）与反馈删除
  assert.deepEqual(sessions, [{ userId: user.id, options: undefined }]);
  assert.deepEqual(calls.deleteByUser, [user.id]);

  // 软删除落盘：status=deleted + 密码凭据清除 + username/role/createdAt 保留
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  const record = persisted.users.find((item) => item.id === user.id);
  assert.equal(record.status, 'deleted');
  assert.equal(record.username, 'alice');
  assert.equal(record.role, 'user');
  assert.ok(record.createdAt);
  assert.equal(Object.hasOwn(record, 'passwordHash'), false);
  assert.equal(Object.hasOwn(record, 'passwordSalt'), false);
  assert.equal(Object.hasOwn(record, 'passwordAlgo'), false);
  assert.equal((await users.get(user.id)).status, 'deleted');

  // 用户数据目录（含 byok.secret.enc）递归删除
  assert.equal(fs.existsSync(userDir), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'users')), true);

  // 注销后登录 → 401 ACCOUNT_DELETED（auth.mjs 由  接线）
  const auth = createAuthService({
    config: { authSessionTtlDays: 7, authCookieSecure: false },
    users,
    sessions: createSessionService({ dataDir, logger: ctx.logger }),
    logger: ctx.logger,
  });
  await assert.rejects(
    () => auth.login({ username: 'alice', password: PASSWORD, ip: '127.0.0.1' }),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, 'ACCOUNT_DELETED');
      return true;
    },
  );
});

test('DELETE /api/me：feedback 服务缺 deleteByUser 时 warn 降级、仍返回 204', async (t) => {
  const { ctx, user, userDir, logger } = await makeCtx(t);
  ctx.feedback = {};
  const baseUrl = await startHandlerServer(t, ctx);
  const result = await apiJson(baseUrl, '/api/me', { method: 'DELETE', body: { password: PASSWORD } });
  assert.equal(result.status, 204);
  assert.equal(fs.existsSync(userDir), false);
  assert.ok(
    logger.logs.some((line) => line.level === 'warn' && line.text.includes('deleteByUser')),
    '缺少 deleteByUser 时应 warn 降级',
  );
  assert.equal((await ctx.users.get(user.id)).status, 'deleted');
});

/* ------------------------------ 路由回退语义 ------------------------------ */

test('handleMeData：非本模块路径返回 false（api/me/usage、/api/me/feedback、错误方法、非 me 路径）', async (t) => {
  const { ctx } = await makeCtx(t);
  const baseUrl = await startHandlerServer(t, ctx);
  // 未命中本模块时测试服务器回 404，证明 handler 返回 false（未吞掉其它路由）。
  for (const [method, route] of [
    ['GET', '/api/me/usage'],
    ['GET', '/api/me/feedback'],
    ['GET', '/api/auth/me'],
    ['POST', '/api/me/export'],
    ['PATCH', '/api/me/consent'],
  ]) {
    const result = await apiJson(baseUrl, route, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(result.status, 404, `${method} ${route} 应回退 404（实际 ${result.status}）`);
    assert.equal(result.data.error.code, 'NOT_FOUND');
  }
});
