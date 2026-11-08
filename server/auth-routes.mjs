// 认证 / 当前用户路由：HTTP 层，服务层在 auth.mjs / users.mjs。
// 挂载方式：app.mjs 传入完整 segments（含首元素 'api'）。
// AUTH=off：/api/auth/me 返回 {auth:'off'}，其余认证路由 404（不应被前端调用）。
//  / 注册必须显式同意条款（acceptTerms===true → CONSENT_REQUIRED），
// consent 记入 users.json；login / GET /api/auth/me 返回 consent{version,at,current}；
// 改密成功后吊销其它设备会话（revokeAll exceptSid）。
import { HttpError, readJsonBody, sendApiError, sendJson } from './http-utils.mjs';
import { SESSION_COOKIE, parseCookies } from './auth.mjs';
import { createInviteStore } from './admin.mjs';
import { CONSENT_VERSION, consentView } from './consent.mjs';
import { publicUser, verifyPassword } from './users.mjs';

const AUTH_BODY_LIMIT = 64 * 1024;
const USAGE_DAYS_DEFAULT = 30;
const USAGE_DAYS_MAX = 90;

/** 客户端 IP（用于登录失败限流；不信任 X-Forwarded-For 的首跳伪造风险在 nginx 层处理）。 */
function clientIp(req) {
  const raw = req?.socket?.remoteAddress ?? req?.headers?.['x-forwarded-for'] ?? '';
  return typeof raw === 'string' ? raw.split(',')[0].trim() : '';
}

function normalizeSegments(segments) {
  const list = Array.isArray(segments) ? segments.map((part) => String(part)) : [];
  return list[0] === 'api' ? list.slice(1) : list;
}

function combineSetCookie(res, cookies) {
  const list = cookies.filter(Boolean);
  if (list.length > 0) res.setHeader('set-cookie', list);
}

function clearCookieHeader(name, { httpOnly = false, secure = false } = {}) {
  const parts = [`${name}=`, 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 邀请码存储：同一 DATA_DIR 复用实例（懒加载 invites.json，方法内部原子写）。 */
const inviteStores = new Map();
function getInviteStore(ctx) {
  // 优先使用 base ctx 持有的单例（admin 路由与注册路由共用同一实例）；测试可注入 ctx.inviteStore。
  if (ctx?.inviteStore && typeof ctx.inviteStore.get === 'function') return ctx.inviteStore;
  const dataDir = ctx.baseDataDir ?? ctx.dataDir;
  let store = inviteStores.get(dataDir);
  if (!store) {
    store = createInviteStore({ dataDir, logger: ctx.logger ?? console });
    inviteStores.set(dataDir, store);
  }
  return store;
}

async function readJsonObject(req, limit) {
  const payload = await readJsonBody(req, { limit });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'INVALID_INPUT', '请求体必须是 JSON 对象');
  }
  return payload;
}

/** 邀请码校验：返回 {@code invite}（含 role），错误映射见契约 2.4。 */
async function resolveInvite(store, code, now = Date.now()) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new HttpError(400, 'INVITE_INVALID', '邀请码无效');
  }
  const invite = await store.get(code);
  if (!invite) throw new HttpError(400, 'INVITE_INVALID', '邀请码无效');
  const expiresAt = Date.parse(invite.expiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    throw new HttpError(400, 'INVITE_EXPIRED', '邀请码已过期');
  }
  if (invite.uses >= invite.maxUses) throw new HttpError(400, 'INVITE_USED', '邀请码已被使用');
  return invite;
}

/* ------------------------------ /api/auth/* ------------------------------ */

export async function handleAuthRoutes(req, res, ctx, segments) {
  const route = normalizeSegments(segments);
  const method = String(req?.method ?? 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  try {
    // POST /api/auth/login
    if (route.length === 2 && route[1] === 'login') {
      if (method !== 'POST') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      const body = await readJsonObject(req, AUTH_BODY_LIMIT);
      const result = await ctx.auth.login({
        username: body.username,
        password: body.password,
        ip: clientIp(req),
      });
      combineSetCookie(res, [ctx.auth.sessionCookieHeader(result.sid), ctx.auth.csrfCookieHeader(result.csrf)]);
      // 附 consent 视图（无记录为 null，旧版本 current=false 由前端提示重签）。
      const profile = await ctx.users.get(result.user.id);
      sendJson(res, 200, { auth: 'on', user: { ...result.user, consent: consentView(profile) }, csrf: result.csrf });
      return;
    }

    // POST /api/auth/logout（需登录 + CSRF；handler 再兜底一次）
    if (route.length === 2 && route[1] === 'logout') {
      if (method !== 'POST') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      if (!ctx.auth.verifyCsrf(req)) throw new HttpError(403, 'FORBIDDEN', 'CSRF 校验失败');
      const sid = parseCookies(req?.headers?.cookie)[SESSION_COOKIE];
      await ctx.auth.logout(sid);
      combineSetCookie(res, [
        ctx.auth.clearSessionCookieHeader(),
        clearCookieHeader('csrf', { secure: ctx.auth.secure }),
      ]);
      sendJson(res, 200, { ok: true });
      return;
    }

    // GET /api/auth/me
    if (route.length === 2 && route[1] === 'me') {
      if (!isRead) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      if (ctx.authMode !== 'on') {
        sendJson(res, 200, { auth: 'off' });
        return;
      }
      const identity = await ctx.auth.authenticate(req);
      if (!identity) {
        const csrf = ctx.auth.ensureCsrf(req, res);
        sendJson(res, 401, {
          error: { code: 'UNAUTHORIZED', message: '请先登录' },
          csrf,
        });
        return;
      }
      const csrf = ctx.auth.ensureCsrf(req, res);
      sendJson(res, 200, { auth: 'on', user: { ...publicUser(identity.user), consent: consentView(identity.user) }, csrf });
      return;
    }

    // POST /api/auth/register
    if (route.length === 2 && route[1] === 'register') {
      if (method !== 'POST') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      const body = await readJsonObject(req, AUTH_BODY_LIMIT);
      // 注册必须显式同意《用户协议》《隐私政策》。
      if (body.acceptTerms !== true) {
        throw new HttpError(400, 'CONSENT_REQUIRED', '注册需要先同意《用户协议》与《隐私政策》');
      }
      const totalUsers = await ctx.users.count();
      const inviteOnly = ctx.config.inviteOnly !== false;
      let invite = null;
      if (!inviteOnly) {
        // 邀请制关闭：仅允许首个用户自助注册（引导用），其余 403。
        if (totalUsers > 0) throw new HttpError(403, 'REGISTER_CLOSED', '注册已关闭');
      } else if (totalUsers > 0 || body.inviteCode) {
        const store = getInviteStore(ctx);
        invite = await resolveInvite(store, body.inviteCode);
      }
      const role = invite?.role ?? 'user';
      //  / 安全 P0：邀请码必须先核销再建用户，否则「吊销/用尽的码」会先创建出可登录账号，
      // 再在 redeem 阶段报错 —— 吊销即可被绕过（backend-admin 复审发现）。
      // 代价：核销后若建用户失败（如用户名已占用）会消耗一次使用额度（管理员可重新发码，可接受）。
      if (invite) {
        const redeemed = await getInviteStore(ctx).redeem(invite.code);
        if (!redeemed) throw new HttpError(400, 'INVITE_USED', '邀请码已被使用');
      }
      const user = await ctx.users.create({
        username: body.username,
        password: body.password,
        displayName: body.displayName ?? null,
        role,
        // 普通用户默认继承全局配额（config.quota），否则配额形同虚设；管理员不配额。
        quota: role === 'admin' ? null : (ctx.config?.quota ?? null),
      });
      // 记录注册时点同意（版本冻结在 CONSENT_VERSION，时间 ISO）。
      const consented = await ctx.users.setConsent(user.id, {
        version: CONSENT_VERSION,
        at: new Date().toISOString(),
      });
      const result = await ctx.auth.login({
        username: user.username,
        password: body.password,
        ip: clientIp(req),
      });
      combineSetCookie(res, [ctx.auth.sessionCookieHeader(result.sid), ctx.auth.csrfCookieHeader(result.csrf)]);
      sendJson(res, 201, {
        auth: 'on',
        user: { ...result.user, consent: consentView(consented) },
        csrf: result.csrf,
      });
      return;
    }

    // GET /api/auth/invite/:code（公开：注册页校验邀请码）
    if (route.length === 3 && route[1] === 'invite') {
      if (!isRead) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      const store = getInviteStore(ctx);
      const code = route[2];
      const invite = await store.getValid(code);
      if (!invite) throw new HttpError(404, 'INVITE_INVALID', '邀请码无效');
      sendJson(res, 200, { valid: true, role: invite.role, expiresAt: invite.expiresAt });
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', '接口不存在');
  } catch (error) {
    if (error instanceof HttpError) {
      sendApiError(res, error.status, error.code, error.message);
      return;
    }
    throw error;
  }
}

/* ------------------------------- /api/me* ------------------------------- */

export async function handleMeRoutes(req, res, ctx, segments) {
  const route = normalizeSegments(segments);
  const method = String(req?.method ?? 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  try {
    if (route.length === 1 && route[0] === 'me') {
      if (isRead) {
        // 附 consent 视图（无记录 null；旧版本 current=false）。
        const record = await ctx.users.get(ctx.userId);
        sendJson(res, 200, { user: { ...ctx.user, consent: consentView(record) } });
        return;
      }
      if (method !== 'PATCH') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      const body = await readJsonObject(req, AUTH_BODY_LIMIT);
      const allowed = new Set(['displayName', 'oldPassword', 'newPassword']);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new HttpError(400, 'INVALID_INPUT', `不支持字段 ${key}`);
      }
      if (Object.keys(body).length === 0) throw new HttpError(400, 'INVALID_INPUT', '未提供要更新的字段');
      const patch = {};
      let passwordChanged = false;
      if (Object.hasOwn(body, 'displayName')) patch.displayName = body.displayName;
      if (Object.hasOwn(body, 'newPassword')) {
        if (typeof body.oldPassword !== 'string' || body.oldPassword.length === 0) {
          throw new HttpError(400, 'INVALID_INPUT', '修改密码需要提供原密码');
        }
        const record = await ctx.users.get(ctx.userId);
        if (!record || !verifyPassword(body.oldPassword, record)) {
          throw new HttpError(401, 'INVALID_PASSWORD', '原密码错误');
        }
        await ctx.users.setPassword(ctx.userId, body.newPassword);
        passwordChanged = true;
      } else if (Object.hasOwn(body, 'oldPassword')) {
        throw new HttpError(400, 'INVALID_INPUT', '缺少 newPassword');
      }
      if (Object.hasOwn(patch, 'displayName')) {
        await ctx.users.update(ctx.userId, { displayName: patch.displayName });
      }
      // 改密成功后吊销该用户其它设备会话，保留当前会话（ 即时失效）。
      if (passwordChanged && ctx.userSessions?.revokeAll) {
        const currentSid = parseCookies(req?.headers?.cookie)[SESSION_COOKIE];
        await ctx.userSessions.revokeAll(ctx.userId, { exceptSid: currentSid ?? null });
      }
      const updated = await ctx.users.get(ctx.userId);
      sendJson(res, 200, { user: { ...publicUser(updated), consent: consentView(updated) } });
      return;
    }

    // GET /api/me/usage?days=30
    if (route.length === 2 && route[0] === 'me' && route[1] === 'usage') {
      if (!isRead) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rawDays = url.searchParams.get('days');
      let days = USAGE_DAYS_DEFAULT;
      if (rawDays !== null) {
        days = Number(rawDays);
        if (!Number.isInteger(days) || days < 1 || days > USAGE_DAYS_MAX) {
          throw new HttpError(400, 'INVALID_INPUT', `days 需为 1–${USAGE_DAYS_MAX} 的整数`);
        }
      }
      const summary = (await ctx.usage.userSummary(ctx.userId, { days })) ?? {};
      sendJson(res, 200, {
        totals: summary.totals ?? {},
        series: Array.isArray(summary.series) ? summary.series : [],
        quota: ctx.user?.quota ?? null,
        //  / 契约 7（Lead 授权扩展）：来源双桶透传，byok 不计入官方 totals/costUsd。
        bySource: summary.bySource ?? null,
      });
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', '接口不存在');
  } catch (error) {
    if (error instanceof HttpError) {
      sendApiError(res, error.status, error.code, error.message);
      return;
    }
    throw error;
  }
}
