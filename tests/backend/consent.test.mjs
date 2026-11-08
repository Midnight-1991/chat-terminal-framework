//  / 用户协议/隐私政策同意（consent）契约与注册/登录/当前用户链路测试。
// 覆盖：consent.mjs 常量与视图；注册必须 acceptTerms；同意落 users.json；login / GET /api/auth/me
// 返回 consent{version,at,current}；AUTH=off 既有语义不回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CONSENT_DOCS, CONSENT_VERSION, consentView } from '../../server/consent.mjs';
import { apiJson, parseSetCookies, cookieHeaderOf, startAuthedServer, startServer } from './helpers.mjs';

/* ------------------------------ consent.mjs 单元 ------------------------------ */

test('consent：版本常量冻结且与契约一致', () => {
  assert.equal(CONSENT_VERSION, '2026-11-01');
  assert.deepEqual(CONSENT_DOCS, ['terms', 'privacy']);
  assert.ok(Object.isFrozen(CONSENT_DOCS));
});

test('consentView：无记录/损坏记录返回 null，当前版本 current=true，旧版本 current=false', () => {
  assert.equal(consentView(null), null);
  assert.equal(consentView(undefined), null);
  assert.equal(consentView({}), null);
  assert.equal(consentView({ consent: null }), null);
  assert.equal(consentView({ consent: 'yes' }), null);
  assert.equal(consentView({ consent: [] }), null);
  assert.equal(consentView({ consent: { at: '2026-11-01T00:00:00.000Z' } }), null);
  assert.equal(consentView({ consent: { version: CONSENT_VERSION } }), null);

  const current = consentView({ consent: { version: CONSENT_VERSION, at: '2026-11-01T08:00:00.000Z' } });
  assert.deepEqual(current, { version: CONSENT_VERSION, at: '2026-11-01T08:00:00.000Z', current: true });

  const stale = consentView({ consent: { version: '2025-01-01', at: '2025-01-01T00:00:00.000Z' } });
  assert.equal(stale.current, false);
  assert.equal(stale.version, '2025-01-01');
});

/* ------------------------------ 注册 / 登录链路（AUTH=on） ------------------------------ */

test('注册缺 acceptTerms → 400 CONSENT_REQUIRED，且不创建用户', async (t) => {
  const { baseUrl, ctx } = await startAuthedServer(t);
  const before = await ctx.users.count();
  const result = await apiJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { username: 'noconsent', password: 'noconsent-pass-1', inviteCode: 'i00000000' },
  });
  assert.equal(result.status, 400);
  assert.equal(result.data.error.code, 'CONSENT_REQUIRED');
  assert.equal(await ctx.users.count(), before, '缺同意不应创建用户');

  const wrong = await apiJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { username: 'noconsent', password: 'noconsent-pass-1', acceptTerms: 'yes' },
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.error.code, 'CONSENT_REQUIRED');
});

test('注册 acceptTerms=true → consent 落 users.json，login 与 /api/auth/me 返回 consent 视图', async (t) => {
  const { baseUrl, session, ctx } = await startAuthedServer(t);

  const invite = await apiJson(baseUrl, '/api/admin/invites', {
    method: 'POST',
    headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf },
    body: { role: 'user', maxUses: 1 },
  });
  assert.equal(invite.status, 201);
  const code = invite.data.invite.code;

  const registered = await apiJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { inviteCode: code, username: 'consented', password: 'consented-pass-1', acceptTerms: true },
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.user.username, 'consented');
  assert.equal(registered.data.user.consent.version, CONSENT_VERSION);
  assert.equal(registered.data.user.consent.current, true);
  assert.ok(Number.isFinite(Date.parse(registered.data.user.consent.at)));
  assert.equal(JSON.stringify(registered.data).includes('passwordHash'), false);

  // users.json 落盘记录（consent 保留、无明文密码）
  const raw = fs.readFileSync(path.join(ctx.baseDataDir ?? ctx.dataDir, 'users.json'), 'utf8');
  const persisted = JSON.parse(raw);
  const record = persisted.users.find((user) => user.username === 'consented');
  assert.ok(record, 'users.json 应有新用户');
  assert.deepEqual(record.consent, registered.data.user.consent && {
    version: registered.data.user.consent.version,
    at: registered.data.user.consent.at,
  });
  assert.equal(record.status, 'active');

  // 未登录直接 login，response user 带 consent
  const login = await apiJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: 'consented', password: 'consented-pass-1' },
  });
  assert.equal(login.status, 200);
  assert.deepEqual(login.data.user.consent, registered.data.user.consent);
  const cookies = parseSetCookies(login.headers);
  const cookieHeader = cookieHeaderOf(cookies);

  const me = await apiJson(baseUrl, '/api/auth/me', { headers: { cookie: cookieHeader } });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.consent.current, true);
  assert.equal(me.data.user.consent.version, CONSENT_VERSION);

  // 管理员（非注册用户）无 consent 记录 → 视图为 null（不伪造同意）
  assert.equal(session.payload.user.consent, null);
});

test('旧版本同意记录在 login 返回 current=false（前端提示重签）', async (t) => {
  const { baseUrl, ctx, login } = await startAuthedServer(t, {
    users: [{ username: 'legacy', password: 'legacy-pass-1' }],
  });
  const legacy = await login('legacy', 'legacy-pass-1');
  assert.equal(legacy.status, 200);
  const user = (await ctx.users.getByUsername('legacy')) ?? null;
  assert.ok(user);
  await ctx.users.setConsent(user.id, { version: '2025-01-01', at: '2025-01-01T00:00:00.000Z' });

  const again = await login('legacy', 'legacy-pass-1');
  assert.equal(again.status, 200);
  assert.equal(again.payload.user.consent.current, false);
  assert.equal(again.payload.user.consent.version, '2025-01-01');

  const me = await apiJson(baseUrl, '/api/auth/me', { headers: { cookie: again.cookieHeader } });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.consent.current, false);
});

/* ------------------------------ AUTH=off 零回归 ------------------------------ */

test('AUTH=off：/api/auth/me 仍返回 {auth:off}（不被 consent 改动影响）', async (t) => {
  const { baseUrl } = await startServer(t, { env: { AUTH: 'off' } });
  const me = await apiJson(baseUrl, '/api/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.data, { auth: 'off' });
});
