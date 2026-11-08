//  + 用户服务 / 登录会话服务 / 认证服务单元测试（不启动 HTTP 服务）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { HttpError } from '../../server/http-utils.mjs';
import {
  createAuthService,
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  csrfRequired,
  isPublicApi,
  parseCookies,
} from '../../server/auth.mjs';
import { CONSENT_VERSION } from '../../server/consent.mjs';
import { createSessionService, DEFAULT_TTL_MS } from '../../server/user-sessions.mjs';
import {
  createUserService,
  hashPassword,
  PASSWORD_MAX,
  PASSWORD_MIN,
  publicUser,
  STATUSES,
  USERNAME_PATTERN,
  verifyPassword,
} from '../../server/users.mjs';
import { createCapturingLogger, makeTmpDir } from './helpers.mjs';

const PASSWORD = 'good-password-1';

function makeUsers(extra = {}) {
  const dataDir = makeTmpDir('wild-users-');
  const logger = createCapturingLogger();
  return { dataDir, logger, users: createUserService({ dataDir, logger, ...extra }) };
}

function makeAuth({ users, sessions, config = {} } = {}) {
  const logger = createCapturingLogger();
  const dataDir = makeTmpDir('wild-auth-');
  const userService = users ?? createUserService({ dataDir, logger });
  const sessionService = sessions ?? createSessionService({ dataDir, logger });
  const auth = createAuthService({
    config: { authSessionTtlDays: 7, authCookieSecure: false, ...config },
    users: userService,
    sessions: sessionService,
    logger,
  });
  return { dataDir, logger, users: userService, sessions: sessionService, auth };
}

/* --------------------------------- 用户服务 --------------------------------- */

test('hashPassword / verifyPassword：roundtrip、错误密码、大小写与损坏记录', () => {
  const record = hashPassword(PASSWORD);
  assert.equal(record.algo, 'scrypt');
  assert.match(record.salt, /^[0-9a-f]{32}$/);
  assert.match(record.hash, /^[0-9a-f]{64}$/);
  assert.equal(verifyPassword(PASSWORD, record), true);
  assert.equal(verifyPassword(`${PASSWORD}x`, record), false);
  assert.equal(verifyPassword('', record), false);
  assert.equal(verifyPassword(PASSWORD, null), false);
  assert.equal(verifyPassword(PASSWORD, { hash: 'zz', salt: record.salt }), false);
  assert.equal(verifyPassword(PASSWORD, { hash: record.hash, salt: '00' }), false);
  // users.json 记录形状（passwordHash/passwordSalt）也支持
  assert.equal(verifyPassword(PASSWORD, { passwordHash: record.hash, passwordSalt: record.salt }), true);
  // 同一密码两次哈希不同（随机 salt）
  assert.notEqual(hashPassword(PASSWORD).hash, hashPassword(PASSWORD).hash);
});

test('publicUser：只暴露白名单字段，绝不含密码字段', () => {
  const record = { ...hashPassword(PASSWORD), id: 'u1', username: 'alice', displayName: null, role: 'user', status: 'active', quota: null, modelSource: 'official', createdAt: 'x', lastLoginAt: null };
  const pub = publicUser(record);
  for (const key of ['id', 'username', 'displayName', 'role', 'status', 'quota', 'modelSource', 'createdAt', 'lastLoginAt']) {
    assert.ok(Object.hasOwn(pub, key), `缺字段 ${key}`);
  }
  assert.equal(Object.hasOwn(pub, 'passwordHash'), false);
  assert.equal(Object.hasOwn(pub, 'passwordSalt'), false);
  assert.equal(Object.hasOwn(pub, 'hash'), false);
  assert.equal(publicUser(null), null);
});

test('createUserService：创建/查询/列表/计数 + 校验错误码', async () => {
  const { dataDir, users } = makeUsers();
  assert.equal(USERNAME_PATTERN.test('alice_01.x-y'), true);

  const alice = await users.create({ username: 'alice', password: PASSWORD, displayName: ' 爱丽丝 ' });
  assert.match(alice.id, /^u[0-9a-f]{12}$/);
  assert.equal(alice.username, 'alice');
  assert.equal(alice.displayName, '爱丽丝');
  assert.equal(alice.role, 'user');
  assert.equal(alice.status, 'active');
  assert.equal(alice.quota, null);
  assert.equal(alice.modelSource, 'official');
  assert.equal(alice.lastLoginAt, null);
  // 返回内部记录（登录校验用），HTTP 层必须 publicUser 映射
  assert.equal(verifyPassword(PASSWORD, alice), true);

  const bob = await users.create({ username: 'Bob', password: PASSWORD, role: 'admin', quota: { dayTokens: 100, monthTokens: 200 } });
  assert.equal(bob.role, 'admin');
  assert.deepEqual(bob.quota, { dayTokens: 100, monthTokens: 200 });

  assert.equal(await users.count(), 2);
  assert.equal(await users.count({ role: 'admin' }), 1);
  assert.equal(await users.count({ status: 'active' }), 2);
  assert.equal(await users.count({ status: 'banned' }), 0);
  assert.equal((await users.get(alice.id)).username, 'alice');
  assert.equal(await users.get('nope'), null);
  // 用户名大小写不敏感查重/查询
  assert.equal((await users.getByUsername('ALICE')).id, alice.id);
  assert.equal((await users.getByUsername('alice')).id, alice.id);
  assert.equal(await users.getByUsername('nobody'), null);
  assert.deepEqual((await users.list()).map((user) => user.username), ['alice', 'Bob']);
  assert.deepEqual((await users.list({ query: 'ali' })).map((user) => user.username), ['alice']);
  assert.deepEqual((await users.list({ status: 'banned' })), []);

  // 重名（大小写不敏感）409
  await assert.rejects(() => users.create({ username: 'ALICE', password: PASSWORD }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'USER_EXISTS');
    return true;
  });
  // 校验错误 400 INVALID_INPUT
  for (const payload of [
    { username: 'ab', password: PASSWORD },
    { username: 'has space', password: PASSWORD },
    { username: 'a'.repeat(33), password: PASSWORD },
    { username: 'okname', password: 'short' },
    { username: 'okname', password: 'x'.repeat(PASSWORD_MAX + 1) },
    { username: 'okname', password: PASSWORD, role: 'root' },
    { username: 'okname', password: PASSWORD, quota: { dayTokens: -1 } },
    { username: 'okname', password: PASSWORD, modelSource: 'unknown' },
    { username: 'okname', password: PASSWORD, displayName: 'x'.repeat(65) },
  ]) {
    await assert.rejects(() => users.create(payload), (error) => error instanceof HttpError && error.status === 400);
  }
  assert.equal(await users.count(), 2, '校验失败不得写入');

  // 权限 0600；users.json 不含明文密码
  const raw = fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8');
  assert.equal(raw.includes(PASSWORD), false);
  assert.match(raw, /"passwordHash"/);
  assert.equal(fs.statSync(path.join(dataDir, 'users.json')).mode & 0o777, 0o600);
});

test('createUserService：update/setPassword/touchLogin 与持久化重载', async () => {
  const { dataDir, users } = makeUsers();
  const user = await users.create({ username: 'carol', password: PASSWORD });

  const updated = await users.update(user.id, {
    displayName: 'Carol',
    status: 'banned',
    role: 'admin',
    quota: { dayTokens: 10, monthTokens: 20 },
    modelSource: 'byok',
  });
  assert.equal(updated.displayName, 'Carol');
  assert.equal(updated.status, 'banned');
  assert.equal(updated.role, 'admin');
  assert.deepEqual(updated.quota, { dayTokens: 10, monthTokens: 20 });
  assert.equal(updated.modelSource, 'byok');
  await assert.rejects(() => users.update(user.id, { username: 'x' }), (error) => error.status === 400);
  await assert.rejects(() => users.update('u_missing', { status: 'banned' }), (error) => error.status === 404);

  const touched = await users.touchLogin(user.id);
  assert.equal(typeof touched.lastLoginAt, 'string');

  await users.setPassword(user.id, 'brand-new-password');
  const reloaded = createUserService({ dataDir, logger: createCapturingLogger() });
  const after = await reloaded.getByUsername('carol');
  assert.equal(verifyPassword('brand-new-password', after), true);
  assert.equal(verifyPassword(PASSWORD, after), false);
  assert.equal(after.status, 'banned');
  assert.equal(after.displayName, 'Carol');
});

test('ensureAdmin：首次创建、二次幂等、同名非 admin 提升', async () => {
  const { users } = makeUsers();
  const first = await users.ensureAdmin({ username: 'root', initialPassword: PASSWORD });
  assert.equal(first.created, true);
  assert.equal(first.user.role, 'admin');
  assert.equal(first.user.username, 'root');
  const second = await users.ensureAdmin({ username: 'root', initialPassword: 'another-password' });
  assert.equal(second.created, false);
  assert.equal(second.user.id, first.user.id);
  // 幂等不改密码
  assert.equal(verifyPassword(PASSWORD, await users.getByUsername('root')), true);
  assert.equal(verifyPassword('another-password', await users.getByUsername('root')), false);

  const fresh = makeUsers();
  const plain = await fresh.users.create({ username: 'root', password: PASSWORD });
  const promoted = await fresh.users.ensureAdmin({ username: 'root', initialPassword: 'new-admin-pass' });
  assert.equal(promoted.created, true);
  assert.equal(promoted.user.id, plain.id);
  assert.equal(promoted.user.role, 'admin');
  assert.equal(verifyPassword('new-admin-pass', await fresh.users.getByUsername('root')), true);

  const empty = makeUsers();
  await assert.rejects(
    () => empty.users.ensureAdmin({ username: 'root2', initialPassword: '' }),
    (error) => error.status === 400,
  );
});

/* --------------------------------- 会话服务 --------------------------------- */

test('createSessionService：create/resolve 滑动续期/revoke/revokeAll/prune/持久化', async () => {
  const dataDir = makeTmpDir('wild-sessions-');
  let current = 1_000_000;
  const sessions = createSessionService({ dataDir, logger: createCapturingLogger(), ttlMs: 1000, now: () => current });
  const sid = await sessions.create('u1');
  assert.match(sid, /^s[0-9a-f]{32}$/);
  assert.deepEqual(await sessions.resolve(sid), { userId: 'u1', createdAt: current, lastSeenAt: current });

  // 滑动续期：过期前访问会顺延
  current += 900;
  assert.equal((await sessions.resolve(sid)).userId, 'u1');
  current += 900; // 离创建 1800ms，但离上次访问 900ms → 仍有效
  assert.equal((await sessions.resolve(sid)).userId, 'u1');
  // 超过 ttl 未访问 → 失效并清除
  current += 1001;
  assert.equal(await sessions.resolve(sid), null);
  assert.equal(await sessions.resolve('not-a-sid'), null);
  assert.equal(await sessions.resolve(`s${'0'.repeat(32)}`), null);

  const sid2 = await sessions.create('u1');
  const sid3 = await sessions.create('u2');
  assert.equal(await sessions.revoke(sid2), true);
  assert.equal(await sessions.revoke(sid2), false);
  assert.equal(await sessions.revokeAll('u2'), 1);
  assert.equal(await sessions.resolve(sid3), null);

  const sid4 = await sessions.create('u3');
  current += 5000;
  assert.equal(await sessions.prune(), 1);
  assert.equal(await sessions.resolve(sid4), null);

  // 持久化：新实例可恢复
  const sid5 = await sessions.create('u4');
  const reloaded = createSessionService({ dataDir, logger: createCapturingLogger(), ttlMs: 1000, now: () => current });
  assert.equal((await reloaded.resolve(sid5)).userId, 'u4');
  assert.equal(fs.statSync(path.join(dataDir, 'sessions.json')).mode & 0o777, 0o600);
  assert.equal(DEFAULT_TTL_MS, 7 * 24 * 3600 * 1000);
});

/* --------------------------------- 认证服务 --------------------------------- */

test('parseCookies / isPublicApi / csrfRequired', () => {
  assert.deepEqual(parseCookies('a=1; b=two; c="quoted"; a=ignored'), { a: '1', b: 'two', c: 'quoted' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('broken'), {});
  assert.equal(isPublicApi('/api/auth/login'), true);
  assert.equal(isPublicApi('/api/auth/me'), true);
  assert.equal(isPublicApi('/api/auth/invite/i123'), true);
  assert.equal(isPublicApi('/api/health'), true);
  assert.equal(isPublicApi('/api/health-import'), true);
  assert.equal(isPublicApi('/api/chat'), false);
  assert.equal(isPublicApi('/api/me'), false);
  assert.equal(csrfRequired('GET', '/api/chat'), false);
  assert.equal(csrfRequired('HEAD', '/api/chat'), false);
  assert.equal(csrfRequired('POST', '/api/chat'), true);
  assert.equal(csrfRequired('POST', '/api/auth/login'), false);
  assert.equal(csrfRequired('POST', '/api/auth/register'), false);
  assert.equal(csrfRequired('PATCH', '/api/me'), true);
});

test('createAuthService：ensureCsrf/verifyCsrf 双提交', () => {
  const { auth } = makeAuth();
  const res = { headers: new Map(), setHeader(name, value) { this.headers.set(name, value); } };
  const token = auth.ensureCsrf({ headers: {} }, res);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.match(res.headers.get('set-cookie'), new RegExp(`^${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax`));
  // 已有合法 cookie → 复用、不再 Set-Cookie
  const res2 = { headers: new Map(), setHeader(name, value) { this.headers.set(name, value); } };
  assert.equal(auth.ensureCsrf({ headers: { cookie: `${CSRF_COOKIE}=${token}` } }, res2), token);
  assert.equal(res2.headers.has('set-cookie'), false);
  // 双提交
  const good = { headers: { cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: token } };
  assert.equal(auth.verifyCsrf(good), true);
  assert.equal(auth.verifyCsrf({ headers: { cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: 'f'.repeat(48) } }), false);
  assert.equal(auth.verifyCsrf({ headers: { cookie: `${CSRF_COOKIE}=${token}` } }), false);
  assert.equal(auth.verifyCsrf({ headers: {} }), false);
});

test('createAuthService：login 成功/失败/封禁/限流，authenticate 与 logout', async () => {
  const dataDir = makeTmpDir('wild-auth-login-');
  const logger = createCapturingLogger();
  const users = createUserService({ dataDir, logger });
  const sessions = createSessionService({ dataDir, logger });
  const auth = createAuthService({
    config: { authSessionTtlDays: 7, authCookieSecure: false },
    users,
    sessions,
    logger,
  });
  const user = await users.create({ username: 'dave', password: PASSWORD });

  // 成功登录
  const result = await auth.login({ username: 'dave', password: PASSWORD, ip: '127.0.0.1' });
  assert.equal(result.user.id, user.id);
  assert.equal(result.user.username, 'dave');
  assert.equal(Object.hasOwn(result.user, 'passwordHash'), false);
  assert.match(result.sid, /^s[0-9a-f]{32}$/);
  assert.match(result.csrf, /^[0-9a-f]{48}$/);
  // Cookie 头属性
  const sessionCookie = auth.sessionCookieHeader(result.sid);
  assert.match(sessionCookie, new RegExp(`^${SESSION_COOKIE}=${result.sid}; Path=/; SameSite=Lax; Max-Age=604800; HttpOnly`));
  assert.equal(sessionCookie.includes('Secure'), false, 'AUTH_COOKIE_SECURE=0 时不加 Secure');
  assert.match(auth.clearSessionCookieHeader(), /Max-Age=0/);
  assert.match(auth.csrfCookieHeader(result.csrf), /^csrf=/);
  assert.equal(auth.csrfCookieHeader(result.csrf).includes('HttpOnly'), false);
  // 安全 cookie
  const secureAuth = createAuthService({ config: { authCookieSecure: true }, users, sessions, logger });
  assert.match(secureAuth.sessionCookieHeader(result.sid), /; HttpOnly; Secure$/);

  // authenticate 成功且每次实时查 status
  const req = { headers: { cookie: `${SESSION_COOKIE}=${result.sid}` } };
  const identity = await auth.authenticate(req);
  assert.equal(identity.userId, user.id);
  assert.equal(identity.sid, result.sid);
  assert.equal(await auth.authenticate({ headers: { cookie: `${SESSION_COOKIE}=s${'0'.repeat(32)}` } }), null);
  assert.equal(await auth.authenticate({ headers: {} }), null);

  // 封禁 → 即时失效（不回写 cookie 由 app 层控制是否 401）
  await users.update(user.id, { status: 'banned' });
  assert.equal(await auth.authenticate(req), null);
  await assert.rejects(() => auth.login({ username: 'dave', password: PASSWORD, ip: '127.0.0.1' }), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'ACCOUNT_BANNED');
    return true;
  });
  await users.update(user.id, { status: 'active' });

  // 错误密码 / 未知用户 → 401 LOGIN_FAILED
  for (const payload of [
    { username: 'dave', password: 'wrong-password' },
    { username: 'nobody', password: 'whatever-password' },
  ]) {
    await assert.rejects(() => auth.login({ ...payload, ip: '10.0.0.1' }), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, 'LOGIN_FAILED');
      return true;
    });
  }
  await assert.rejects(() => auth.login({ username: '', password: '' }), (error) => error.status === 400);

  // 限流：5 次失败 → 第 6 次 429（按 IP+username），换 IP 不受影响
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(() => auth.login({ username: 'dave', password: 'bad-password', ip: '10.9.9.9' }));
  }
  await assert.rejects(() => auth.login({ username: 'dave', password: 'bad-password', ip: '10.9.9.9' }), (error) => {
    assert.equal(error.status, 401);
    return true;
  });
  await assert.rejects(() => auth.login({ username: 'dave', password: 'bad-password', ip: '10.9.9.9' }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'LOGIN_RATE_LIMITED');
    return true;
  });
  const otherIp = await auth.login({ username: 'dave', password: PASSWORD, ip: '10.8.8.8' });
  assert.ok(otherIp.sid);

  // logout 撤销会话
  assert.equal(await auth.authenticate({ headers: { cookie: `${SESSION_COOKIE}=${otherIp.sid}` } }) !== null, true);
  await auth.logout(otherIp.sid);
  assert.equal(await auth.authenticate({ headers: { cookie: `${SESSION_COOKIE}=${otherIp.sid}` } }), null);

  // 日志不含明文密码
  for (const line of logger.logs) assert.equal(String(line.text).includes(PASSWORD), false);
});

test('createAuthService：登录成功清零失败计数', async () => {
  const { auth, users } = makeAuth();
  await users.create({ username: 'erin', password: PASSWORD });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => auth.login({ username: 'erin', password: 'nope-nope', ip: '1.1.1.1' }));
  }
  const ok = await auth.login({ username: 'erin', password: PASSWORD, ip: '1.1.1.1' });
  assert.ok(ok.sid);
  // 清零后还能再失败 4 次才触发限流（若未清零，下一次失败即第 5 次后仍到 429）
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(() => auth.login({ username: 'erin', password: 'nope-nope', ip: '1.1.1.1' }), (error) => error.status === 401);
  }
});

/* ------------------------------  /  ------------------------------ */

test('users：STATUSES 含 deleted，setConsent 落盘可重载，markDeleted 软删除并清密码凭据', async () => {
  assert.deepEqual([...STATUSES], ['active', 'banned', 'deleted']);
  const { users, dataDir } = makeUsers();
  const user = await users.create({ username: 'frank', password: PASSWORD });
  assert.equal(verifyPassword(PASSWORD, await users.get(user.id)), true);

  // setConsent：返回视图带 consent，写入 users.json 并可被新实例重载
  const at = '2026-11-01T08:00:00.000Z';
  const consented = await users.setConsent(user.id, { version: CONSENT_VERSION, at });
  assert.deepEqual(consented.consent, { version: CONSENT_VERSION, at });
  const reloaded = createUserService({ dataDir, logger: createCapturingLogger() });
  assert.deepEqual((await reloaded.get(user.id)).consent, { version: CONSENT_VERSION, at });

  // 非法 consent / 不存在的用户
  await assert.rejects(() => users.setConsent(user.id, { version: '' }), (error) => error.status === 400);
  await assert.rejects(() => users.setConsent(user.id, null), (error) => error.status === 400);
  await assert.rejects(() => users.setConsent('u000000000000', { version: CONSENT_VERSION }), (error) => error.status === 404);

  // markDeleted：status=deleted，密码字段从磁盘记录清除，用户名/角色保留
  const deleted = await users.markDeleted(user.id);
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.username, 'frank');
  assert.equal(deleted.role, 'user');
  assert.equal(verifyPassword(PASSWORD, await users.get(user.id)), false);
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  const record = persisted.users.find((item) => item.id === user.id);
  assert.equal(record.status, 'deleted');
  assert.equal(Object.hasOwn(record, 'passwordHash'), false);
  assert.equal(Object.hasOwn(record, 'passwordSalt'), false);
  assert.equal(Object.hasOwn(record, 'passwordAlgo'), false);
  // 管理审计：按 deleted 状态可查询
  const deletedList = await users.list({ status: 'deleted' });
  assert.equal(deletedList.length, 1);
  assert.equal(await users.count({ status: 'deleted' }), 1);
  // 重复 markDeleted 幂等
  assert.equal((await users.markDeleted(user.id)).status, 'deleted');
});

test('auth：注销账号登录 → 401 ACCOUNT_DELETED（banned 仍 403 ACCOUNT_BANNED）', async () => {
  const { auth, users, sessions } = makeAuth();
  const deletedUser = await users.create({ username: 'gone', password: PASSWORD });
  await users.markDeleted(deletedUser.id);
  await assert.rejects(() => auth.login({ username: 'gone', password: PASSWORD, ip: '1.2.3.4' }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, 'ACCOUNT_DELETED');
    return true;
  });
  // 错误密码也返回 ACCOUNT_DELETED（不泄露密码正确与否）
  await assert.rejects(() => auth.login({ username: 'gone', password: 'wrong-password', ip: '1.2.3.4' }), (error) => {
    assert.equal(error.code, 'ACCOUNT_DELETED');
    return true;
  });
  // 已删除账号即使有历史 sid 也不能通过 authenticate
  const bannedUser = await users.create({ username: 'banme', password: PASSWORD });
  const sid = await sessions.create(bannedUser.id);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${sid}` } };
  assert.ok(await auth.authenticate(req));
  await users.update(bannedUser.id, { status: 'banned' });
  assert.equal(await auth.authenticate(req), null);
  await assert.rejects(() => auth.login({ username: 'banme', password: PASSWORD, ip: '1.2.3.4' }), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'ACCOUNT_BANNED');
    return true;
  });
});

test('createSessionService：revokeAll(exceptSid) 保留当前会话，缺省全吊销', async () => {
  const dataDir = makeTmpDir('wild-sessions-except-');
  const logger = createCapturingLogger();
  const sessions = createSessionService({ dataDir, logger });
  const first = await sessions.create('u1');
  const current = await sessions.create('u1');
  const other = await sessions.create('u2');

  assert.equal(await sessions.revokeAll('u1', { exceptSid: current }), 1);
  assert.equal(await sessions.resolve(first), null);
  assert.ok(await sessions.resolve(current), 'exceptSid 指定会话应保留');
  assert.ok(await sessions.resolve(other), '其它用户会话不受影响');

  // 非法 exceptSid 视为不保留
  assert.equal(await sessions.revokeAll('u1', { exceptSid: 123 }), 1);
  assert.equal(await sessions.resolve(current), null);
  assert.equal(await sessions.revokeAll('u1'), 0, '已无会话时返回 0');
  assert.equal(await sessions.resolve(other) !== null, true);
});
