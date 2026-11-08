// 认证服务：Cookie 会话、CSRF 双提交、登录限流、封禁判定。
// 与路由解耦：本文件只做服务层，HTTP handler 在 auth-routes.mjs；
// AUTH=off 时 app.mjs 根本不构造本服务，保障既有单用户路径零回归。
import crypto from 'node:crypto';

import { HttpError } from './http-utils.mjs';
import { publicUser, verifyPassword } from './users.mjs';

export const AUTH_MODES = Object.freeze(['off', 'on']);
export const SESSION_COOKIE = 'sid';
export const CSRF_COOKIE = 'csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_TOKEN_PATTERN = /^[0-9a-f]{32,64}$/;
/** 免登录的公开 API 前缀（仍走 origin/content-type 门）。 */
export const PUBLIC_API = Object.freeze([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/me',
  '/api/auth/invite',
  '/api/health',
  '/api/health-import',
]);

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_KEYS = 5000;

/** 解析 Cookie 头 → 普通对象（同名取第一个；不抛错）。 */
export function parseCookies(header) {
  /** @type {Object<string,string>} */
  const cookies = {};
  if (typeof header !== 'string' || header.length === 0) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/** 命中公开 API（按路径前缀匹配；'invite' 前缀覆盖 /api/auth/invite/:code）。 */
export function isPublicApi(pathname) {
  return PUBLIC_API.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** 写请求（非 GET/HEAD/OPTIONS）且非登录/注册 → 需要 CSRF。 */
export function csrfRequired(method, pathname) {
  const upper = String(method ?? 'GET').toUpperCase();
  if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return false;
  if (pathname === '/api/auth/login' || pathname === '/api/auth/register') return false;
  return true;
}

function newCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

function formatCookie(name, value, { maxAgeSeconds, httpOnly = false } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Lax'];
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (httpOnly) parts.push('HttpOnly');
  return parts;
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(left, right);
}

/**
 * @param {{config?:object, users?:object, sessions?:object, logger?:object, now?:()=>number}} options
 */
export function createAuthService({ config = {}, users, sessions, logger = console, now = () => Date.now() } = {}) {
  if (!users) throw new Error('createAuthService 需要 users 服务');
  if (!sessions) throw new Error('createAuthService 需要 sessions 服务');

  const ttlDays = Number.isFinite(config.authSessionTtlDays) ? config.authSessionTtlDays : 7;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const secure = config.authCookieSecure !== false;

  /** @type {Map<string, number[]>} 登录失败记录：'ip|username' → 失败时间戳 */
  const failures = new Map();

  function sessionCookieHeader(sid) {
    const parts = formatCookie(SESSION_COOKIE, sid, { maxAgeSeconds: ttlMs / 1000, httpOnly: true });
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  function clearSessionCookieHeader() {
    const parts = formatCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true });
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  function csrfCookieHeader(token) {
    const parts = formatCookie(CSRF_COOKIE, token, { maxAgeSeconds: ttlMs / 1000, httpOnly: false });
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  function readCsrfCookie(req) {
    const cookies = parseCookies(req?.headers?.cookie);
    const token = cookies[CSRF_COOKIE];
    return typeof token === 'string' && CSRF_TOKEN_PATTERN.test(token) ? token : null;
  }

  /** 读取（或新建）CSRF token 并写 cookie；返回 token。 */
  function ensureCsrf(req, res) {
    const existing = readCsrfCookie(req);
    const token = existing ?? newCsrfToken();
    if (!existing) res.setHeader('set-cookie', csrfCookieHeader(token));
    return token;
  }

  function getCsrfToken(req) {
    return readCsrfCookie(req);
  }

  /** 双提交校验：header 与 cookie 相等且格式合法。 */
  function verifyCsrf(req) {
    const cookieToken = readCsrfCookie(req);
    if (!cookieToken) return false;
    const header = req?.headers?.[CSRF_HEADER];
    const headerToken = Array.isArray(header) ? header[0] : header;
    if (typeof headerToken !== 'string' || !CSRF_TOKEN_PATTERN.test(headerToken)) return false;
    return sameSecret(cookieToken, headerToken);
  }

  function pruneFailureWindow(key, at) {
    const list = failures.get(key);
    if (!list) return [];
    const fresh = list.filter((timestamp) => at - timestamp < LOGIN_WINDOW_MS);
    if (fresh.length === 0) failures.delete(key);
    else failures.set(key, fresh);
    return fresh;
  }

  function assertNotRateLimited(ip, username) {
    const key = `${ip ?? ''}|${String(username ?? '').toLowerCase()}`;
    const at = now();
    const list = pruneFailureWindow(key, at);
    if (list.length >= LOGIN_MAX_FAILURES) {
      const retryAt = list[0] + LOGIN_WINDOW_MS;
      const retrySeconds = Math.max(1, Math.ceil((retryAt - at) / 1000));
      throw new HttpError(429, 'LOGIN_RATE_LIMITED', `登录失败次数过多，请 ${retrySeconds} 秒后再试`);
    }
  }

  function recordFailure(ip, username) {
    const key = `${ip ?? ''}|${String(username ?? '').toLowerCase()}`;
    const at = now();
    const list = pruneFailureWindow(key, at);
    list.push(at);
    failures.set(key, list);
    if (failures.size > LOGIN_MAX_KEYS) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
  }

  function clearFailures(ip, username) {
    failures.delete(`${ip ?? ''}|${String(username ?? '').toLowerCase()}`);
  }

  async function authenticate(req) {
    const cookies = parseCookies(req?.headers?.cookie);
    const sid = cookies[SESSION_COOKIE];
    if (typeof sid !== 'string' || sid.length === 0) return null;
    const session = await sessions.resolve(sid);
    if (!session) return null;
    const user = await users.get(session.userId);
    if (!user || user.status !== 'active') {
      // 封禁/删除即时失效：尽力清理该会话，但不阻断认证结果。
      if (user?.status === 'banned' || user?.status === 'deleted') {
        Promise.resolve(sessions.revoke(sid)).catch((error) => {
          logger?.warn?.(`[auth] 清理无效会话失败：${error?.message ?? error}`);
        });
      }
      return null;
    }
    return { sid, userId: user.id, user };
  }

  /**
   * 登录：密码优先校验，再判封禁；失败按 IP+用户名 计数限流。
   * @returns {Promise<{user:object, sid:string, csrf:string}>}
   */
  async function login({ username, password, ip = null } = {}) {
    if (typeof username !== 'string' || username.length === 0 || typeof password !== 'string' || password.length === 0) {
      throw new HttpError(400, 'INVALID_INPUT', '用户名和密码不能为空');
    }
    assertNotRateLimited(ip, username);
    const record = await users.getByUsername(username);
    //  / 已注销账号优先返回 401 ACCOUNT_DELETED（密码凭据已清除，不再参与校验）。
    if (record?.status === 'deleted') {
      throw new HttpError(401, 'ACCOUNT_DELETED', '账号已注销');
    }
    if (!record || !verifyPassword(password, record)) {
      recordFailure(ip, username);
      throw new HttpError(401, 'LOGIN_FAILED', '用户名或密码错误');
    }
    if (record.status !== 'active') {
      throw new HttpError(403, 'ACCOUNT_BANNED', '账号已被封禁，请联系管理员');
    }
    clearFailures(ip, username);
    const sid = await sessions.create(record.id);
    await users.touchLogin(record.id);
    const refreshed = (await users.get(record.id)) ?? record;
    const csrf = newCsrfToken();
    return { user: publicUser(refreshed), sid, csrf };
  }

  async function logout(sid) {
    if (typeof sid !== 'string') return false;
    return sessions.revoke(sid);
  }

  return {
    ttlMs,
    secure,
    ensureCsrf,
    getCsrfToken,
    verifyCsrf,
    authenticate,
    login,
    logout,
    setSessionCookie(res, sid) {
      res.setHeader('set-cookie', sessionCookieHeader(sid));
    },
    clearSessionCookie(res) {
      res.setHeader('set-cookie', clearSessionCookieHeader());
    },
    sessionCookieHeader,
    clearSessionCookieHeader,
    csrfCookieHeader,
    setCsrfCookie(res, token) {
      res.setHeader('set-cookie', csrfCookieHeader(token));
    },
  };
}
