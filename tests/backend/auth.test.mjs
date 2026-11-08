// ~认证、会话、CSRF、角色、封禁、注册、当前用户路由的端到端测试（AUTH=on）。
// AUTH=off 零回归路径同时覆盖：/api/auth/me 可用、其余多用户路由 404、/api/health 字段不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createServer } from '../../server/index.mjs';
import {
  apiJson,
  emptyRepoRoot,
  makeTmpDir,
  rawRequest,
  startAuthedServer,
  startServer,
} from './helpers.mjs';

/* ------------------------------ AUTH=off 零回归 ------------------------------ */

test('AUTH=off：仅 /api/auth/me 返回 {auth:off}，其余认证/多用户路由 404', async (t) => {
  const { baseUrl, ctx } = await startServer(t, { env: { CHAT_MOCK: '0' } });
  const me = await apiJson(baseUrl, '/api/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.data, { auth: 'off' });

  for (const [method, path] of [
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/register'],
    ['GET', '/api/auth/invite/i00000000'],
    ['GET', '/api/me'],
    ['GET', '/api/me/usage'],
    ['GET', '/api/me/feedback'],
    ['GET', '/api/feedback'],
    ['GET', '/api/admin/overview'],
  ]) {
    const result = await apiJson(baseUrl, path, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(result.status, 404, `${method} ${path} 应 404（实际 ${result.status}）`);
  }

  // 单用户路径上下文不构造多用户服务，且 health 响应字段不变。
  assert.equal(ctx.authMode, 'off');
  assert.equal(ctx.auth, null);
  assert.equal(ctx.users, null);
  assert.equal(ctx.usage, null);
  assert.equal(ctx.ratelimit, null);
  const health = await apiJson(baseUrl, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(Object.hasOwn(health.data, 'auth'), false);
});

test('AUTH=off：路径穿越旧语义保持 404（不返回 400 BAD_PATH）', async (t) => {
  const { baseUrl } = await startServer(t, { env: {} });
  const result = await rawRequest(baseUrl, { path: '/api/attachments/%2e%2e%2f%2e%2e%2fetc%2fpasswd' });
  assert.equal(result.status, 404);
});

/* ------------------------------  登录 / 会话 ------------------------------ */

test('登录成功下发 sid(HttpOnly)+csrf，/api/auth/me 与 /api/me 返回当前用户', async (t) => {
  const started = await startAuthedServer(t);
  const { baseUrl, session } = started;
  assert.equal(session.status, 200);
  assert.equal(session.payload.auth, 'on');
  assert.equal(session.payload.user.username, 'admin');
  assert.equal(session.payload.user.role, 'admin');
  assert.equal(typeof session.payload.user.passwordHash, 'undefined');
  assert.ok(session.cookies.sid, '应设置 sid cookie');
  assert.ok(session.cookies.csrf, '应设置 csrf cookie');
  assert.equal(typeof started.ctx.auth?.setSessionCookie, 'function');

  const me = await apiJson(baseUrl, '/api/auth/me', { headers: { cookie: session.cookieHeader } });
  assert.equal(me.status, 200);
  assert.equal(me.data.auth, 'on');
  assert.equal(me.data.user.id, started.admin.id);
  assert.equal(me.data.csrf, session.csrf);

  const profile = await apiJson(baseUrl, '/api/me', { headers: { cookie: session.cookieHeader } });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.user.username, 'admin');
});

test('未登录访问 /api/auth/me 返回 401 + 下发 csrf 供双提交', async (t) => {
  const { baseUrl } = await startAuthedServer(t);
  const result = await apiJson(baseUrl, '/api/auth/me');
  assert.equal(result.status, 401);
  assert.equal(result.data.error.code, 'UNAUTHORIZED');
  assert.match(result.data.csrf, /^[0-9a-f]{32,64}$/);
  const setCookies = (result.headers.getSetCookie?.() ?? []).join('\n');
  assert.ok(setCookies.includes('csrf='), '未登录探测应 Set-Cookie csrf');
});

test('未知用户与错误密码统一返回 401 LOGIN_FAILED（不泄露账号是否存在）', async (t) => {
  const { baseUrl, login } = await startAuthedServer(t, {
    users: [{ username: 'alice', password: 'alice-pass-1' }],
  });
  const wrongPassword = await login('alice', 'wrong-password');
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.payload.error.code, 'LOGIN_FAILED');
  const unknownUser = await login('no-such-user', 'whatever-123');
  assert.equal(unknownUser.status, 401);
  assert.equal(unknownUser.payload.error.code, 'LOGIN_FAILED');
  assert.equal(unknownUser.payload.error.message, wrongPassword.payload.error.message);
});

test('同一账号连续失败 5 次后限流 429 LOGIN_RATE_LIMITED', async (t) => {
  const { baseUrl, login } = await startAuthedServer(t, {
    users: [{ username: 'alice', password: 'alice-pass-1' }],
  });
  for (let index = 0; index < 5; index += 1) {
    const attempt = await login('alice', 'bad-password');
    assert.equal(attempt.status, 401);
  }
  const limited = await login('alice', 'alice-pass-1');
  assert.equal(limited.status, 429);
  assert.equal(limited.payload.error.code, 'LOGIN_RATE_LIMITED');
});

/* ------------------------------  CSRF / 封禁 ------------------------------ */

test('CSRF 双提交——无 token 403、带 token 200、GET 免校验', async (t) => {
  const { baseUrl, session } = await startAuthedServer(t);
  const noToken = await apiJson(baseUrl, '/api/me', {
    method: 'PATCH',
    headers: { cookie: session.cookieHeader },
    body: { displayName: '改名失败' },
  });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.data.error.code, 'FORBIDDEN');

  const wrongToken = await apiJson(baseUrl, '/api/me', {
    method: 'PATCH',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': 'f'.repeat(48) },
    body: { displayName: '改名失败' },
  });
  assert.equal(wrongToken.status, 403);

  const ok = await apiJson(baseUrl, '/api/me', {
    method: 'PATCH',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: { displayName: '管理员' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.displayName, '管理员');

  const read = await apiJson(baseUrl, '/api/me', { headers: { cookie: session.cookieHeader } });
  assert.equal(read.status, 200);
});

test('封禁用户登录 403 ACCOUNT_BANNED，且已存在会话立即失效', async (t) => {
  const { baseUrl, session, admin, login, accounts } = await startAuthedServer(t, {
    users: [{ username: 'alice', password: 'alice-pass-1' }],
  });
  const aliceSession = await login('alice', 'alice-pass-1');
  assert.equal(aliceSession.status, 200);
  const aliceId = accounts.find((account) => account.username === 'alice').id;

  const before = await apiJson(baseUrl, '/api/me', { headers: { cookie: aliceSession.cookieHeader } });
  assert.equal(before.status, 200);

  const ban = await apiJson(baseUrl, `/api/admin/users/${aliceId}`, {
    method: 'PATCH',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: { status: 'banned' },
  });
  assert.equal(ban.status, 200);
  assert.equal(ban.data.user.status, 'banned');

  const denied = await login('alice', 'alice-pass-1');
  assert.equal(denied.status, 403);
  assert.equal(denied.payload.error.code, 'ACCOUNT_BANNED');

  const invalidated = await apiJson(baseUrl, '/api/me', { headers: { cookie: aliceSession.cookieHeader } });
  assert.equal(invalidated.status, 401);
  assert.equal(admin.role, 'admin');
});

/* ------------------------------  角色 / 管理员 ------------------------------ */

test('普通用户访问 /api/admin/* 403，管理员 200；health DELETE 仅管理员', async (t) => {
  const { baseUrl, session, login } = await startAuthedServer(t, {
    users: [{ username: 'alice', password: 'alice-pass-1' }],
  });
  const alice = await login('alice', 'alice-pass-1');

  const asUser = await apiJson(baseUrl, '/api/admin/overview', { headers: { cookie: alice.cookieHeader } });
  assert.equal(asUser.status, 403);
  assert.equal(asUser.data.error.code, 'FORBIDDEN');
  const asAdmin = await apiJson(baseUrl, '/api/admin/overview', { headers: { cookie: session.cookieHeader } });
  assert.equal(asAdmin.status, 200);

  const deleteAsUser = await apiJson(baseUrl, '/api/health', {
    method: 'DELETE',
    headers: { cookie: alice.cookieHeader, 'x-csrf-token': alice.csrf },
  });
  assert.equal(deleteAsUser.status, 403);
  const deleteNoCsrf = await apiJson(baseUrl, '/api/health', {
    method: 'DELETE',
    headers: { cookie: session.cookieHeader },
  });
  assert.equal(deleteNoCsrf.status, 403);
  const deleteAsAdmin = await apiJson(baseUrl, '/api/health', {
    method: 'DELETE',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
  });
  assert.equal(deleteAsAdmin.status, 200);
  assert.equal(deleteAsAdmin.data.ok, true);
});

test('AUTH=on：路径穿越防护提前返回 400 BAD_PATH', async (t) => {
  const { baseUrl } = await startAuthedServer(t);
  const result = await rawRequest(baseUrl, { path: '/api/attachments/%2e%2e%2f%2e%2e%2fetc%2fpasswd' });
  assert.equal(result.status, 400);
  assert.equal(JSON.parse(result.body).error.code, 'BAD_PATH');
});

/* ------------------------------  注册 / 邀请码 ------------------------------ */

test('邀请制注册——无效/过期/复用邀请码映射，注册成功后自动登录', async (t) => {
  const { baseUrl, session } = await startAuthedServer(t);

  const missing = await apiJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { username: 'bob', password: 'bob-pass-123', acceptTerms: true },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error.code, 'INVITE_INVALID');

  const created = await apiJson(baseUrl, '/api/admin/invites', {
    method: 'POST',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: { role: 'user', maxUses: 1, expiresInDays: 7 },
  });
  assert.equal(created.status, 201);
  const code = created.data.invite.code;

  const lookup = await apiJson(baseUrl, `/api/auth/invite/${code}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.valid, true);
  assert.equal(lookup.data.role, 'user');

  const registered = await apiJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { inviteCode: code, username: 'bob', password: 'bob-pass-123', displayName: '鲍勃', acceptTerms: true },
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.auth, 'on');
  assert.equal(registered.data.user.username, 'bob');
  assert.equal(registered.data.user.displayName, '鲍勃');
  assert.equal(registered.data.user.consent.version, '2026-11-01');
  assert.equal(registered.data.user.consent.current, true);
  assert.match(registered.data.csrf, /^[0-9a-f]{32,64}$/);
  const setCookies = (registered.headers.getSetCookie?.() ?? []).join('\n');
  assert.ok(setCookies.includes('sid=') && setCookies.includes('csrf='));

  const reused = await apiJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { inviteCode: code, username: 'carol', password: 'carol-pass-123', acceptTerms: true },
  });
  assert.equal(reused.status, 400);
  assert.equal(reused.data.error.code, 'INVITE_USED');

  const secondInvite = await apiJson(baseUrl, '/api/admin/invites', {
    method: 'POST',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: { role: 'user', maxUses: 1 },
  });
  const duplicate = await apiJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { inviteCode: secondInvite.data.invite.code, username: 'BOB', password: 'bob-pass-123', acceptTerms: true },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error.code, 'USER_EXISTS');
});

test('INVITE_ONLY=off 且已有用户时注册返回 403 REGISTER_CLOSED', async (t) => {
  const { baseUrl } = await startAuthedServer(t, { env: { INVITE_ONLY: 'off' } });
  const closed = await apiJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { username: 'bob', password: 'bob-pass-123', acceptTerms: true },
  });
  assert.equal(closed.status, 403);
  assert.equal(closed.data.error.code, 'REGISTER_CLOSED');
});

/* ------------------------------ 登出 / 改密 / 我的 ------------------------------ */

test('登出清空 cookie 并让会话立即失效', async (t) => {
  const { baseUrl, session } = await startAuthedServer(t);
  const logout = await apiJson(baseUrl, '/api/auth/logout', {
    method: 'POST',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: {},
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.data, { ok: true });
  const setCookies = (logout.headers.getSetCookie?.() ?? []).join('\n');
  assert.ok(/sid=;.*Max-Age=0/.test(setCookies), '登出应清空 sid');
  const me = await apiJson(baseUrl, '/api/auth/me', { headers: { cookie: session.cookieHeader } });
  assert.equal(me.status, 401);
});

test('PATCH /api/me 改密——旧密码错误 401 INVALID_PASSWORD，成功后新密码可登录', async (t) => {
  const { baseUrl, session, login } = await startAuthedServer(t);
  const wrong = await apiJson(baseUrl, '/api/me', {
    method: 'PATCH',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: { oldPassword: 'not-the-password', newPassword: 'new-admin-pass-9' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error.code, 'INVALID_PASSWORD');

  const ok = await apiJson(baseUrl, '/api/me', {
    method: 'PATCH',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: { oldPassword: 'admin-pass-123', newPassword: 'new-admin-pass-9' },
  });
  assert.equal(ok.status, 200);

  const oldLogin = await login('admin', 'admin-pass-123');
  assert.equal(oldLogin.status, 401);
  const newLogin = await login('admin', 'new-admin-pass-9');
  assert.equal(newLogin.status, 200);
});

test('/GET /api/me/usage 与 GET /api/me/feedback 形状正确', async (t) => {
  const { baseUrl, session } = await startAuthedServer(t);
  const usage = await apiJson(baseUrl, '/api/me/usage?days=7', { headers: { cookie: session.cookieHeader } });
  assert.equal(usage.status, 200);
  assert.ok(usage.data.totals && typeof usage.data.totals === 'object');
  assert.ok(Array.isArray(usage.data.series));
  assert.equal(usage.data.quota, null);

  const badDays = await apiJson(baseUrl, '/api/me/usage?days=0', { headers: { cookie: session.cookieHeader } });
  assert.equal(badDays.status, 400);

  const feedback = await apiJson(baseUrl, '/api/me/feedback', { headers: { cookie: session.cookieHeader } });
  assert.equal(feedback.status, 200);
  assert.ok(Array.isArray(feedback.data.feedback));

  const posted = await apiJson(baseUrl, '/api/feedback', {
    method: 'POST',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: { body: '希望增加导出功能', allowContext: true },
  });
  assert.equal(posted.status, 201);
  const mine = await apiJson(baseUrl, '/api/me/feedback', { headers: { cookie: session.cookieHeader } });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.feedback.length, 1);
  assert.equal(mine.data.feedback[0].body, '希望增加导出功能');
});

/* ------------------------------ 启动 fail-fast ------------------------------ */

test('AUTH=on 缺 ADMIN_INITIAL_PASSWORD_FILE 时启动 fail-fast 且报错不含密码', async () => {
  const dataDir = makeTmpDir('wild-auth-fail-');
  let error = null;
  try {
    await createServer({
      repoRoot: emptyRepoRoot(),
      dataDir,
      env: { AUTH: 'on', ADMIN_USERNAME: 'admin', ADMIN_INITIAL_PASSWORD_FILE: '' },
      docsDir: emptyRepoRoot(),
      promptsDir: emptyRepoRoot(),
      staticDir: emptyRepoRoot(),
      credentialPath: `${emptyRepoRoot()}/no-such-credentials.yaml`,
      logger: { log() {}, warn() {}, error() {}, info() {} },
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, '缺管理员初始密码应启动失败');
  assert.match(String(error.message), /ADMIN_INITIAL_PASSWORD_FILE/);
  assert.equal(String(error.message).includes('admin-pass'), false);
  assert.equal(fs.existsSync(`${dataDir}/users.json`), false);
});

/* ------------------------------  合规链路 ------------------------------ */

test('改密成功后吊销其它设备会话，当前会话保持可用', async (t) => {
  const { baseUrl, session, login } = await startAuthedServer(t);
  const second = await login('admin', 'admin-pass-123');
  assert.equal(second.status, 200);
  assert.ok(second.cookieHeader);
  // 第二台设备会话可用
  const secondBefore = await apiJson(baseUrl, '/api/auth/me', { headers: { cookie: second.cookieHeader } });
  assert.equal(secondBefore.status, 200);

  const changed = await apiJson(baseUrl, '/api/me', {
    method: 'PATCH',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: { oldPassword: 'admin-pass-123', newPassword: 'new-admin-pass-9' },
  });
  assert.equal(changed.status, 200);

  // 其它设备立即失效，当前会话保留（exceptSid）
  const secondAfter = await apiJson(baseUrl, '/api/auth/me', { headers: { cookie: second.cookieHeader } });
  assert.equal(secondAfter.status, 401);
  assert.equal(secondAfter.data.error.code, 'UNAUTHORIZED');
  const current = await apiJson(baseUrl, '/api/auth/me', { headers: { cookie: session.cookieHeader } });
  assert.equal(current.status, 200);

  // 新密码可登录、旧密码不可登录
  const relogin = await login('admin', 'new-admin-pass-9');
  assert.equal(relogin.status, 200);
  const oldPassword = await login('admin', 'admin-pass-123');
  assert.equal(oldPassword.status, 401);
});

test('已注销账号登录 → 401 ACCOUNT_DELETED（不泄露密码正确与否）', async (t) => {
  const { baseUrl, ctx, accounts, login } = await startAuthedServer(t, {
    users: [{ username: 'deluser', password: 'deluser-pass-1' }],
  });
  const account = accounts.find((item) => item.username === 'deluser');
  assert.ok(account);
  // 模拟注销完成后的 users.json 状态（DELETE /api/me 的软删除）
  await ctx.users.markDeleted(account.id);

  const withRightPassword = await apiJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: 'deluser', password: 'deluser-pass-1' },
  });
  assert.equal(withRightPassword.status, 401);
  assert.equal(withRightPassword.data.error.code, 'ACCOUNT_DELETED');

  const withWrongPassword = await login('deluser', 'wrong-password-1');
  assert.equal(withWrongPassword.status, 401);
  assert.equal(withWrongPassword.payload.error.code, 'ACCOUNT_DELETED');

  // 已删除用户不因登录成功签发会话
  const me = await apiJson(baseUrl, '/api/auth/me', {
    headers: { cookie: withRightPassword.headers.getSetCookie?.().join('; ') ?? '' },
  });
  assert.equal(me.status, 401);
});
