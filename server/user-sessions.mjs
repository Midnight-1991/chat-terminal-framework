// 登录会话：sessions.json 持久化，sid 随机 16 字节 hex；滑动续期（默认 7 天）。
// 与进程内对话历史会话（server/sessions.mjs）是两件事：这里是登录态。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SESSIONS_FILE_NAME = 'sessions.json';
export const SESSIONS_FILE_VERSION = 1;
export const SESSION_ID_PATTERN = /^s[0-9a-f]{32}$/;
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 10_000;

function newSessionId() {
  return `s${crypto.randomBytes(16).toString('hex')}`;
}

function writeFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* 权限设置失败不阻断 */
  }
}

/**
 * 会话服务：懒加载 DATA_DIR/sessions.json；resolve 时滑动续期；过期会话首次访问即清理。
 * @param {{dataDir?:string, logger?:object, ttlMs?:number, now?:()=>number}} options
 */
export function createSessionService({
  dataDir,
  logger = console,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!dataDir) throw new Error('createSessionService 需要 dataDir');
  const filePath = path.join(dataDir, SESSIONS_FILE_NAME);

  /** @type {{version:number, sessions:Object<string,{userId:string,createdAt:number,lastSeenAt:number,expiresAt:number}>}|null} */
  let state = null;
  let loadError = null;
  let writeChain = Promise.resolve();

  function load() {
    if (state) return state;
    if (loadError) throw loadError;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
        throw new Error(`${filePath} 格式不正确`);
      }
      state = { version: parsed.version ?? SESSIONS_FILE_VERSION, sessions: { ...parsed.sessions } };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state = { version: SESSIONS_FILE_VERSION, sessions: {} };
      } else {
        loadError = error;
        throw error;
      }
    }
    return state;
  }

  function persist() {
    const data = load();
    const payload = JSON.stringify({ version: SESSIONS_FILE_VERSION, sessions: data.sessions }, null, 2);
    writeChain = writeChain.then(() => writeFileAtomic(filePath, payload));
    return writeChain;
  }

  function pruneExpiredLocked() {
    const data = load();
    const at = now();
    let removed = 0;
    for (const [sid, session] of Object.entries(data.sessions)) {
      if (!session || session.expiresAt <= at) {
        delete data.sessions[sid];
        removed += 1;
      }
    }
    return removed;
  }

  /** 创建会话，返回 sid（'s'+32hex）。 */
  async function create(userId) {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('create(userId) 需要合法 userId');
    }
    const data = load();
    const sid = newSessionId();
    const at = now();
    data.sessions[sid] = { userId, createdAt: at, lastSeenAt: at, expiresAt: at + ttlMs };
    // 简易上限：超出时清理过期项，再不行删最久未活动的。
    if (Object.keys(data.sessions).length > MAX_SESSIONS) {
      pruneExpiredLocked();
      const entries = Object.entries(data.sessions);
      if (entries.length > MAX_SESSIONS) {
        entries.sort((a, b) => (a[1]?.lastSeenAt ?? 0) - (b[1]?.lastSeenAt ?? 0));
        for (const [oldSid] of entries.slice(0, entries.length - MAX_SESSIONS)) {
          delete data.sessions[oldSid];
        }
      }
    }
    await persist();
    return sid;
  }

  /** 解析会话：不存在/过期 → null；有效 → 滑动续期并返回 {userId,createdAt,lastSeenAt}。 */
  async function resolve(sid) {
    if (typeof sid !== 'string' || !SESSION_ID_PATTERN.test(sid)) return null;
    const data = load();
    const session = data.sessions[sid];
    if (!session) return null;
    const at = now();
    if (!(session.expiresAt > at)) {
      delete data.sessions[sid];
      await persist();
      return null;
    }
    session.lastSeenAt = at;
    session.expiresAt = at + ttlMs;
    await persist();
    return { userId: session.userId, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt };
  }

  /** 注销单个会话；返回是否删除了记录。 */
  async function revoke(sid) {
    if (typeof sid !== 'string') return false;
    const data = load();
    if (!Object.hasOwn(data.sessions, sid)) return false;
    delete data.sessions[sid];
    await persist();
    return true;
  }

  /**
   * 注销某用户全部会话；返回删除数量。
   * 可选 `exceptSid` 保留当前会话（改密成功后踢掉其它设备但保持本人登录）。
   * @param {string} userId
   * @param {{exceptSid?: string|null}} [options]
   */
  async function revokeAll(userId, { exceptSid = null } = {}) {
    if (typeof userId !== 'string') return 0;
    const keep = typeof exceptSid === 'string' && exceptSid ? exceptSid : null;
    const data = load();
    let removed = 0;
    for (const [sid, session] of Object.entries(data.sessions)) {
      if (session?.userId === userId && sid !== keep) {
        delete data.sessions[sid];
        removed += 1;
      }
    }
    if (removed > 0) await persist();
    return removed;
  }

  /** 清理全部过期会话；返回删除数量。 */
  async function prune() {
    const removed = pruneExpiredLocked();
    if (removed > 0) await persist();
    return removed;
  }

  return { filePath, create, resolve, revoke, revokeAll, prune, ttlMs };
}
