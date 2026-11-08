// 多用户账号体系：users.json 持久化 + scrypt 密码哈希 + 用户 CRUD。
// 安全约定：明文密码绝不出现在返回值/日志/磁盘；users.json 权限 0600；写入 tmp+rename 原子替换。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { HttpError } from './http-utils.mjs';

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const ROLES = Object.freeze(['admin', 'user']);
export const STATUSES = Object.freeze(['active', 'banned', 'deleted']);
export const USERS_FILE_NAME = 'users.json';
export const USERS_FILE_VERSION = 1;
export const DISPLAY_NAME_MAX = 64;
export const MODEL_SOURCES = Object.freeze(['official', 'byok']);

/** scrypt 参数：N=16384, r=8, p=1, keylen=32（约 16 MiB 内存，数十毫秒）。 */
export const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });
const SALT_BYTES = 16;
const PASSWORD_ALGO = 'scrypt';

function invalid(message) {
  return new HttpError(400, 'INVALID_INPUT', message);
}

/**
 * 密码哈希：返回 { hash, salt, algo }。salt 为 16 字节 hex，hash 为 32 字节 hex。
 * @param {string} password
 * @returns {{hash:string, salt:string, algo:'scrypt'}}
 */
export function hashPassword(password) {
  if (typeof password !== 'string') throw invalid('密码必须是字符串');
  assertPassword(password);
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return { hash: hash.toString('hex'), salt: salt.toString('hex'), algo: PASSWORD_ALGO };
}

/**
 * 校验密码：兼容 hashPassword 输出与 users.json 记录（passwordHash/passwordSalt）两种形状。
 * @param {string} password
 * @param {{hash?:string, salt?:string, algo?:string, passwordHash?:string, passwordSalt?:string, passwordAlgo?:string}|null} record
 * @returns {boolean}
 */
export function verifyPassword(password, record) {
  if (typeof password !== 'string' || !record) return false;
  const hashHex = record.hash ?? record.passwordHash;
  const saltHex = record.salt ?? record.passwordSalt;
  if (typeof hashHex !== 'string' || typeof saltHex !== 'string') return false;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_PARAMS.keylen) return false;
  const salt = Buffer.from(saltHex, 'hex');
  if (salt.length !== SALT_BYTES) return false;
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
    });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

/** 对外公开的用户视图：绝不包含任何密码字段。 */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    role: user.role,
    status: user.status,
    quota: normalizeQuotaOutput(user.quota),
    modelSource: user.modelSource ?? 'official',
    createdAt: user.createdAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

function normalizeQuotaOutput(quota) {
  if (!quota || typeof quota !== 'object') return null;
  return { dayTokens: quota.dayTokens ?? null, monthTokens: quota.monthTokens ?? null };
}

function assertPassword(password) {
  const length = [...password].length;
  if (length < PASSWORD_MIN) throw invalid(`密码至少 ${PASSWORD_MIN} 位`);
  if (length > PASSWORD_MAX) throw invalid(`密码最多 ${PASSWORD_MAX} 位`);
}

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw invalid('用户名需为 3–32 位字母/数字/下划线/点/短横线');
  }
  return username;
}

function validateDisplayName(displayName) {
  if (displayName === null || displayName === undefined) return null;
  if (typeof displayName !== 'string') throw invalid('显示名必须是字符串');
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return null;
  if ([...trimmed].length > DISPLAY_NAME_MAX) throw invalid(`显示名最多 ${DISPLAY_NAME_MAX} 个字符`);
  return trimmed;
}

function validateRole(role) {
  if (!ROLES.includes(role)) throw invalid('role 只能是 admin / user');
  return role;
}

function validateStatus(status) {
  if (!STATUSES.includes(status)) throw invalid('status 只能是 active / banned / deleted');
  return status;
}

/** 同意记录 `{version, at}`；at 缺省当前 ISO 时间（调用方通常显式传入）。 */
function validateConsent(consent, now) {
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)) {
    throw invalid('consent 必须是对象');
  }
  if (typeof consent.version !== 'string' || consent.version.length === 0) {
    throw invalid('consent.version 必须是非空字符串');
  }
  const at = typeof consent.at === 'string' && consent.at ? consent.at : nowIso(now);
  if (Number.isNaN(Date.parse(at))) throw invalid('consent.at 必须是 ISO 时间字符串');
  return { version: consent.version, at };
}

function validateQuota(quota) {
  if (quota === null || quota === undefined) return null;
  if (typeof quota !== 'object' || Array.isArray(quota)) throw invalid('quota 必须是对象或 null');
  const dayTokens = quota.dayTokens ?? null;
  const monthTokens = quota.monthTokens ?? null;
  for (const [name, value] of [
    ['dayTokens', dayTokens],
    ['monthTokens', monthTokens],
  ]) {
    if (value === null) continue;
    if (!Number.isInteger(value) || value < 0) throw invalid(`quota.${name} 必须是非负整数或 null`);
  }
  return { dayTokens, monthTokens };
}

function validateModelSource(modelSource) {
  if (!MODEL_SOURCES.includes(modelSource)) throw invalid('modelSource 只能是 official / byok');
  return modelSource;
}

function newUserId() {
  return `u${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso(now) {
  return now().toISOString();
}

function writeFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* 权限设置失败不阻断（部分文件系统不支持） */
  }
}

function emptyState() {
  return { version: USERS_FILE_VERSION, users: [] };
}

/**
 * 用户服务：懒加载 DATA_DIR/users.json，写队列串行化，避免并发写丢失。
 * @param {{dataDir?:string, logger?:object, now?:()=>Date}} options
 */
export function createUserService({ dataDir, logger = console, now = () => new Date() } = {}) {
  if (!dataDir) throw new Error('createUserService 需要 dataDir');
  const filePath = path.join(dataDir, USERS_FILE_NAME);

  /** @type {{version:number, users:Array<object>}|null} */
  let state = null;
  let loadError = null;
  let writeChain = Promise.resolve();

  function load() {
    if (state) return state;
    if (loadError) throw loadError;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.users)) {
        throw new Error(`${filePath} 格式不正确`);
      }
      state = { version: parsed.version ?? USERS_FILE_VERSION, users: parsed.users };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state = emptyState();
      } else {
        loadError = error;
        throw error;
      }
    }
    return state;
  }

  function persist() {
    const data = load();
    const payload = JSON.stringify({ version: USERS_FILE_VERSION, users: data.users }, null, 2);
    writeChain = writeChain.then(() => writeFileAtomic(filePath, payload));
    return writeChain;
  }

  function findIndexById(id) {
    return load().users.findIndex((user) => user.id === id);
  }

  function normalizeUserRecord(user) {
    return {
      ...user,
      displayName: user.displayName ?? null,
      quota: normalizeQuotaOutput(user.quota),
      modelSource: user.modelSource ?? 'official',
      lastLoginAt: user.lastLoginAt ?? null,
    };
  }

  function findByUsername(username) {
    if (typeof username !== 'string') return null;
    const lowered = username.toLowerCase();
    return load().users.find((user) => user.username.toLowerCase() === lowered) ?? null;
  }

  async function list({ query, status } = {}) {
    let users = load().users.slice();
    if (typeof query === 'string' && query.trim()) {
      const needle = query.trim().toLowerCase();
      users = users.filter(
        (user) =>
          user.username.toLowerCase().includes(needle) ||
          (typeof user.displayName === 'string' && user.displayName.toLowerCase().includes(needle)),
      );
    }
    if (status !== undefined && status !== null) {
      const wanted = validateStatus(status);
      users = users.filter((user) => user.status === wanted);
    }
    users.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    return users.map(normalizeUserRecord);
  }

  async function get(id) {
    if (typeof id !== 'string') return null;
    const index = findIndexById(id);
    if (index < 0) return null;
    return normalizeUserRecord(load().users[index]);
  }

  async function getByUsername(username) {
    const found = findByUsername(username);
    return found ? normalizeUserRecord(found) : null;
  }

  async function count({ role, status } = {}) {
    let users = load().users;
    if (role !== undefined && role !== null) {
      const wantedRole = validateRole(role);
      users = users.filter((user) => user.role === wantedRole);
    }
    if (status !== undefined && status !== null) {
      const wantedStatus = validateStatus(status);
      users = users.filter((user) => user.status === wantedStatus);
    }
    return users.length;
  }

  async function create({
    username,
    password,
    displayName = null,
    role = 'user',
    quota = null,
    modelSource = 'official',
  } = {}) {
    const validUsername = validateUsername(username);
    assertPassword(password ?? '');
    const validDisplayName = validateDisplayName(displayName);
    const validRole = validateRole(role);
    const validQuota = validateQuota(quota);
    const validModelSource = validateModelSource(modelSource);
    if (findByUsername(validUsername)) {
      throw new HttpError(409, 'USER_EXISTS', '用户名已存在');
    }
    const { hash, salt, algo } = hashPassword(password);
    const user = {
      id: newUserId(),
      username: validUsername,
      displayName: validDisplayName,
      passwordHash: hash,
      passwordSalt: salt,
      passwordAlgo: algo,
      role: validRole,
      status: 'active',
      quota: validQuota,
      modelSource: validModelSource,
      createdAt: nowIso(now),
      lastLoginAt: null,
    };
    load().users.push(user);
    await persist();
    return normalizeUserRecord(user);
  }

  async function update(id, patch = {}) {
    const index = findIndexById(id);
    if (index < 0) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('patch 必须是对象');
    const allowed = new Set(['displayName', 'status', 'role', 'quota', 'modelSource']);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) throw invalid(`不支持修改字段：${key}`);
    }
    const user = load().users[index];
    if (Object.hasOwn(patch, 'displayName')) user.displayName = validateDisplayName(patch.displayName);
    if (Object.hasOwn(patch, 'status')) user.status = validateStatus(patch.status);
    if (Object.hasOwn(patch, 'role')) user.role = validateRole(patch.role);
    if (Object.hasOwn(patch, 'quota')) user.quota = validateQuota(patch.quota);
    if (Object.hasOwn(patch, 'modelSource')) user.modelSource = validateModelSource(patch.modelSource);
    await persist();
    return normalizeUserRecord(user);
  }

  async function setPassword(id, newPassword) {
    const index = findIndexById(id);
    if (index < 0) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    const { hash, salt, algo } = hashPassword(newPassword);
    const user = load().users[index];
    user.passwordHash = hash;
    user.passwordSalt = salt;
    user.passwordAlgo = algo;
    await persist();
    return normalizeUserRecord(user);
  }

  async function touchLogin(id) {
    const index = findIndexById(id);
    if (index < 0) return null;
    const user = load().users[index];
    user.lastLoginAt = nowIso(now);
    await persist();
    return normalizeUserRecord(user);
  }

  /**
   *  / 记录用户对当前条款版本的同意（users.json `consent:{version,at}`）。
   * 登录/当前用户接口通过 consent.mjs 的 consentView 输出 `{version,at,current}`。
   */
  async function setConsent(id, consent) {
    const index = findIndexById(id);
    if (index < 0) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    const valid = validateConsent(consent, now);
    const user = load().users[index];
    user.consent = valid;
    await persist();
    return normalizeUserRecord(user);
  }

  /**
   *  / 软删除账号（不可恢复）。
   * status='deleted' 并清除全部密码凭据；username/role/createdAt 保留（防冒用 + 审计）。
   * 登录拒绝由 auth.mjs（401 ACCOUNT_DELETED）负责；DATA_DIR 删除由调用方处理。
   */
  async function markDeleted(id) {
    const index = findIndexById(id);
    if (index < 0) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    const user = load().users[index];
    user.status = 'deleted';
    delete user.passwordHash;
    delete user.passwordSalt;
    delete user.passwordAlgo;
    await persist();
    return normalizeUserRecord(user);
  }

  /**
   * 启动引导：确保存在一个 admin 账号（幂等）。
   * - 已存在 admin → { created:false, user }（不改密码/不改其它字段）。
   * - 同名用户已存在但非 admin → 提升为 admin 并设置密码（created:true）。
   * - 否则新建 admin（created:true）。
   */
  async function ensureAdmin({ username, initialPassword } = {}) {
    const existingAdmin = load().users.find((user) => user.role === 'admin');
    if (existingAdmin) return { created: false, user: normalizeUserRecord(existingAdmin) };
    const validUsername = validateUsername(username);
    if (typeof initialPassword !== 'string' || initialPassword.length === 0) {
      throw invalid('缺少初始管理员密码');
    }
    assertPassword(initialPassword);
    const sameName = findByUsername(validUsername);
    if (sameName) {
      const { hash, salt, algo } = hashPassword(initialPassword);
      sameName.passwordHash = hash;
      sameName.passwordSalt = salt;
      sameName.passwordAlgo = algo;
      sameName.role = 'admin';
      sameName.status = 'active';
      await persist();
      return { created: true, user: normalizeUserRecord(sameName) };
    }
    const user = await create({
      username: validUsername,
      password: initialPassword,
      role: 'admin',
      modelSource: 'official',
    });
    return { created: true, user };
  }

  return {
    filePath,
    list,
    get,
    getByUsername,
    count,
    create,
    update,
    setPassword,
    setConsent,
    markDeleted,
    touchLogin,
    ensureAdmin,
  };
}
