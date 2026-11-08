// 会话：进程内内存保存最近 12 轮（user+assistant 成对，最多 24 条消息）。
import crypto from 'node:crypto';

export const MAX_ROUNDS = 12;
export const MAX_MESSAGES = MAX_ROUNDS * 2;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function newSessionId() {
  return `s${crypto.randomBytes(6).toString('hex')}`;
}

export function createSessionStore({ maxSessions = 1000 } = {}) {
  /** @type {Map<string, {id:string, turns:Array<{role:string,content:string,ts:number}>}>} */
  const sessions = new Map();

  function trim(session) {
    if (session.turns.length > MAX_MESSAGES) {
      session.turns.splice(0, session.turns.length - MAX_MESSAGES);
    }
  }

  function getOrCreate(sessionId) {
    const id = sessionId || newSessionId();
    let session = sessions.get(id);
    if (!session) {
      session = { id, turns: [] };
      sessions.set(id, session);
      // 简单上限，避免长时间运行无限增长（单用户工具，够用即可）。
      if (sessions.size > maxSessions) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined && oldest !== id) sessions.delete(oldest);
      }
    }
    return session;
  }

  return {
    getOrCreate,
    get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    getTurns(sessionId) {
      return sessions.get(sessionId)?.turns ?? [];
    },
    /** 只保存完整的一轮问答；片段（错误/中断）不入历史。 */
    commitTurn(sessionId, userContent, assistantContent) {
      const session = sessions.get(sessionId);
      if (!session) return;
      const now = Date.now();
      session.turns.push({ role: 'user', content: String(userContent), ts: now });
      session.turns.push({ role: 'assistant', content: String(assistantContent), ts: now });
      trim(session);
    },
    size() {
      return sessions.size;
    },
    clear() {
      sessions.clear();
    },
  };
}
