// api.js — 前端对后端的唯一接口层（v3 会话/记忆 + v1 兼容降级）。
//
// 设计约束：
// - 零依赖、纯函数可测：createApi({ fetchImpl }) 可注入假 fetch 在 node:test 里跑。
// - v3 接口（api/conversations、/api/memories）在旧后端上会 404：此时把
//   capability 标成 false，调用方降级到 v1 的 sessionId 内存会话，界面给出提示。
// - 所有 HTTP 错误统一抛 ApiError（带 status / code），调用方只关心可读信息。

export const STORAGE = {
  conversationId: 'ctf.conversationId',
  effort: 'ctf.effort',
  memory: 'ctf.memory',
  // 联网搜索开关按设备持久化；隐私提示只弹一次（设备级）。
  webSearch: 'ctf.webSearch',
  webSearchHintSeen: 'ctf.webSearchHintSeen',
};

/** 带 HTTP 语义的错误；构造时尽量从 {error:{code,message}} 里取信息。 */
export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = Number.isInteger(options.status) ? options.status : 0;
    this.code = options.code || 'NETWORK';
    this.retryable = options.retryable === true;
  }
}

/**
 * @param {{fetchImpl?: typeof fetch, base?: string}} [options]
 */
export function createApi(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const base = options.base || '';
  // 登录态与 CSRF（cookie 是 double-submit 的权威来源，这里只做同日内存缓存）。
  const authCsrf = { value: '' };

  const api = {
    /** v3 会话接口是否可用：null=尚未确认，true/false=已探测。 */
    capabilities: {
      conversations: null,
      memories: null,
      marks: null,
      scales: null,
      scalesHistory: null,
      health: null,
    },

    async request(path, { method = 'GET', body, headers, timeoutMs } = {}) {
      const init = {
        method,
        // 会话 Cookie 走 same-origin；跨源不会带上，避免被第三方页面复用登录态。
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      // 非安全方法带 CSRF double-submit token（服务端 Set-Cookie 下发 csrf，非 HttpOnly）。
      const verb = String(method || 'GET').toUpperCase();
      if (verb !== 'GET' && verb !== 'HEAD') {
        // -hotfix：cookie 是 double-submit 权威来源（其他标签页重新登录会轮换 cookie），内存缓存只兜底。
        const token = readCookie('csrf') || authCsrf.value;
        if (token) init.headers['x-csrf-token'] = token;
      }
      // 可选超时（如 /api/auth/me 的 3s 上限）；假 fetch 会忽略 signal，node:test 不受影响。
      let timer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortController === 'function') {
        const controller = new AbortController();
        init.signal = controller.signal;
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      let response;
      try {
        response = await fetchImpl(`${base}${path}`, init);
      } catch (cause) {
        throw new ApiError('网络中断或服务未启动', { code: 'NETWORK' });
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      let payload = null;
      const text = await response.text().catch(() => '');
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        const detail = payload && payload.error ? payload.error : null;
        throw new ApiError(detail?.message || `HTTP ${response.status}`, {
          status: response.status,
          code: detail?.code || (response.status === 404 ? 'NOT_FOUND' : 'INTERNAL'),
          retryable: detail?.retryable === true,
        });
      }
      return payload;
    },

    async health() {
      return api.request('/api/health');
    },

    /* ---------------- v3：会话 ---------------- */

    async createConversation(title) {
      try {
        const payload = await api.request('/api/conversations', {
          method: 'POST',
          body: title ? { title } : {},
        });
        api.capabilities.conversations = true;
        return payload?.conversation || null;
      } catch (error) {
        markUnsupported(api, 'conversations', error);
        throw error;
      }
    },

    async listConversations() {
      try {
        const payload = await api.request('/api/conversations');
        api.capabilities.conversations = true;
        return Array.isArray(payload?.conversations) ? payload.conversations : [];
      } catch (error) {
        markUnsupported(api, 'conversations', error);
        throw error;
      }
    },

    async getConversation(id) {
      try {
        const payload = await api.request(`/api/conversations/${encodeURIComponent(id)}`);
        api.capabilities.conversations = true;
        return {
          conversation: payload?.conversation || null,
          messages: Array.isArray(payload?.messages) ? payload.messages : [],
        };
      } catch (error) {
        markUnsupported(api, 'conversations', error);
        throw error;
      }
    },

    async renameConversation(id, title) {
      const payload = await api.request(`/api/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { title },
      });
      return payload?.conversation || null;
    },

    async deleteConversation(id) {
      return api.request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    /* ---------------- v3：长期记忆 ---------------- */

    async listMemories() {
      try {
        const payload = await api.request('/api/memories');
        api.capabilities.memories = true;
        return Array.isArray(payload?.memories) ? payload.memories : [];
      } catch (error) {
        markUnsupported(api, 'memories', error);
        throw error;
      }
    },

    /** 可选 attachments（≤1 个），有附件时服务端把手动记忆上限放宽到 800 字符。 */
    async addMemory(text, attachments) {
      try {
        const body = { text };
        if (Array.isArray(attachments) && attachments.length > 0) body.attachments = attachments;
        const payload = await api.request('/api/memories', { method: 'POST', body });
        api.capabilities.memories = true;
        return payload?.memory || null;
      } catch (error) {
        markUnsupported(api, 'memories', error);
        throw error;
      }
    },

    /** 行内编辑记忆（text / level / category 均可选）。 */
    async updateMemory(id, patch) {
      const payload = await api.request(`/api/memories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      });
      return payload?.memory || null;
    },

    async deleteMemory(id) {
      return api.request(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    async clearMemories() {
      return api.request('/api/memories', { method: 'DELETE' });
    },

    /* ---------------- 记录 ---------------- */

    /** GET /api/health 的记录部分（days/summary/lastImportedAt）。 */
    async getHealth() {
      try {
        const payload = await api.request('/api/health');
        api.capabilities.health = true;
        return payload || { ok: false, days: {} };
      } catch (error) {
        markUnsupported(api, 'health', error);
        throw error;
      }
    },

    /** DELETE /api/health 清空导入的记录。 */
    async clearHealth() {
      return api.request('/api/health', { method: 'DELETE' });
    },

    /* ---------------- 资料 ---------------- */

    async getDoc(docId) {
      return api.request(`/api/docs/${encodeURIComponent(docId)}`);
    },

    /* ---------------- 文档库 ---------------- */

    async getLibrary() {
      return api.request('/api/library');
    },

    /* ---------------- 收藏片段 ---------------- */

    async getMarks() {
      try {
        const data = await api.request('/api/marks');
        api.capabilities.marks = true;
        return data;
      } catch (error) {
        markUnsupported(api, 'marks', error);
        throw error;
      }
    },

    async addMark(payload) {
      return api.request('/api/marks', { method: 'POST', body: payload });
    },

    async deleteMark(id) {
      return api.request(`/api/marks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    /* ---------------- 自评问卷（回答不落盘） ---------------- */

    async getScales() {
      try {
        const data = await api.request('/api/scales');
        api.capabilities.scales = true;
        return data;
      } catch (error) {
        markUnsupported(api, 'scales', error);
        throw error;
      }
    },

    async getScale(scaleId) {
      return api.request(`/api/scales/${encodeURIComponent(scaleId)}`);
    },

    async scoreScale(payload) {
      return api.request('/api/scales/score', { method: 'POST', body: payload });
    },

    /* ---------------- 问卷历史（只存结果摘要，不存答案） ---------------- */

    async getScalesHistory(options = {}) {
      const params = new URLSearchParams();
      if (options.scaleId) params.set('scaleId', options.scaleId);
      const limit = Number(options.limit);
      if (Number.isFinite(limit) && limit > 0) params.set('limit', String(Math.floor(limit)));
      const query = params.toString();
      try {
        const data = await api.request(`/api/scales/history${query ? `?${query}` : ''}`);
        api.capabilities.scalesHistory = true;
        return data;
      } catch (error) {
        markUnsupported(api, 'scalesHistory', error);
        throw error;
      }
    },

    async deleteScaleHistoryEntry(id) {
      return api.request(`/api/scales/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    async clearScaleHistory() {
      return api.request('/api/scales/history', { method: 'DELETE' });
    },

    /* ---------------- 登录 / 注册 / 账号（AUTH=off 时这些方法不会被调用） ---------------- */

    /** 登录态钩子：null=未知/未启用，'on'/'off'=服务端确认；不改变既有的请求语义。 */
    auth: { mode: null, user: null },

    /** @param {'on'|'off'|null} mode */
    setAuthMode(mode) {
      api.auth.mode = mode === 'on' || mode === 'off' ? mode : null;
      return api.auth.mode;
    },

    /** @param {object|null} user publicUser */
    setUser(user) {
      api.auth.user = user && typeof user === 'object' ? user : null;
      return api.auth.user;
    },

    /** -hotfix：当前 CSRF token（cookie 优先、内存缓存兜底）；非浏览器环境返回 ''。 */
    csrfToken() {
      return readCookie('csrf') || authCsrf.value || '';
    },

    /**
     * GET /api/auth/me → {auth:'on'|'off', user?, csrf?}；AUTH=on 未登录时 401，由调用方决定跳转。
     * 启动探测限时 3s：超时按 NETWORK 抛错，由调用方静默降级为 auth:'off'。
     */
    async getAuthMe({ timeoutMs = 3000 } = {}) {
      const payload = await api.request('/api/auth/me', { timeoutMs });
      applyAuthPayload(api, authCsrf, payload);
      return payload;
    },

    /** POST /api/auth/login → {auth:'on', user, csrf}；失败抛 ApiError（401 LOGIN_FAILED 等）。 */
    async login({ username, password } = {}) {
      const payload = await api.request('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      applyAuthPayload(api, authCsrf, payload);
      return payload;
    },

    /** POST /api/auth/logout：清本地登录态（Cookie 由服务端清）。 */
    async logout() {
      const payload = await api.request('/api/auth/logout', { method: 'POST' });
      api.setAuthMode('off');
      api.setUser(null);
      authCsrf.value = '';
      return payload;
    },

    /** POST /api/auth/register → 201 {auth:'on', user, csrf}（邀请码注册）。 */
    async register({ inviteCode, username, password, displayName } = {}) {
      const body = { inviteCode, username, password };
      if (typeof displayName === 'string' && displayName.trim()) body.displayName = displayName.trim();
      const payload = await api.request('/api/auth/register', { method: 'POST', body });
      applyAuthPayload(api, authCsrf, payload);
      return payload;
    },

    /** GET /api/auth/invite/:code → {valid:true, role, expiresAt}；无效 404 INVITE_INVALID。 */
    async getInvite(code) {
      return api.request(`/api/auth/invite/${encodeURIComponent(code)}`);
    },

    /* ---------------- 本人资料 / 用量 / 反馈 ---------------- */

    /** GET /api/me → {user}（AUTH=on 未登录 401）。 */
    async getMe() {
      const payload = await api.request('/api/me');
      if (payload?.user) api.setUser(payload.user);
      return payload;
    },

    /** PATCH /api/me {displayName?, oldPassword?, newPassword?} → {user}。 */
    async updateMe(patch = {}) {
      const payload = await api.request('/api/me', { method: 'PATCH', body: patch });
      if (payload?.user) api.setUser(payload.user);
      return payload;
    },

    /** GET /api/me/usage?days=30 → {totals, series, quota}。 */
    async getMyUsage({ days = 30 } = {}) {
      const params = new URLSearchParams();
      const value = Number(days);
      if (Number.isFinite(value) && value > 0) params.set('days', String(Math.floor(value)));
      const query = params.toString();
      return api.request(`/api/me/usage${query ? `?${query}` : ''}`);
    },

    /** GET /api/me/feedback → 本人反馈列表（只读）。 */
    async getMyFeedback() {
      const payload = await api.request('/api/me/feedback');
      return Array.isArray(payload?.feedback) ? payload.feedback : [];
    },

    /** POST /api/feedback {body, allowContext, conversationId?} → 新反馈条目。 */
    async submitFeedback({ body, allowContext = false, conversationId } = {}) {
      const payload = { body, allowContext: allowContext === true };
      if (typeof conversationId === 'string' && conversationId) payload.conversationId = conversationId;
      return api.request('/api/feedback', { method: 'POST', body: payload });
    },
  };

  return api;
}

/** 把 {auth,user,csrf} 响应写进 api 的登录态钩子（只认契约里的字段）。 */
function applyAuthPayload(api, authCsrf, payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  if (data.auth === 'on' || data.auth === 'off') api.setAuthMode(data.auth);
  if (data.user && typeof data.user === 'object') api.setUser(data.user);
  if (typeof data.csrf === 'string' && data.csrf) authCsrf.value = data.csrf;
}

/** 读浏览器 Cookie（node:test 无 document 时返回 ''）。 */
function readCookie(name) {
  if (typeof document === 'undefined' || typeof document.cookie !== 'string') return '';
  for (const part of document.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return '';
}

/** 只允许站内绝对路径作为登录回跳目标：拒绝 //evil.com、https://…、反斜杠与控制字符。 */
export function safeNextPath(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '';
  if (value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '';
  return value;
}

/**
 * 当前页面的登录 URL：`/login.html?next=<当前路径>`。
 * @param {Location|{pathname?:string, search?:string}} [location]
 */
export function loginUrlFor(location) {
  const source = location && typeof location === 'object' ? location : {};
  const pathname = typeof source.pathname === 'string' && source.pathname ? source.pathname : '/';
  const search = typeof source.search === 'string' ? source.search : '';
  const next = safeNextPath(`${pathname}${search}`) || '/';
  return `/login.html?next=${encodeURIComponent(next)}`;
}

/** 只有 404/NOT_FOUND 才视为「旧后端没有这个接口」，其它错误保持原样。 */
function markUnsupported(api, name, error) {
  if (error instanceof ApiError && error.status === 404) {
    api.capabilities[name] = false;
  }
}

/* ==========================================================================
   纯函数：格式化与请求体（可直接在 node:test 里测）
   ========================================================================== */

/** 会话标题兜底。 */
export function conversationTitle(conversation) {
  const title = typeof conversation?.title === 'string' ? conversation.title.trim() : '';
  return title || '新对话';
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / MM-DD / YYYY-MM-DD。 */
export function formatRelativeTime(timestamp, now = Date.now()) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = Math.max(0, now - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  if (sameYear) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 对话里的小号时间（HH:MM）。 */
export function formatClock(timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** meta.memoryUsed > 0 时的状态文案。 */
export function memoryUsedLabel(count) {
  const n = Number(count);
  return Number.isFinite(n) && n > 0 ? `想起 ${n} 条` : '';
}

/**
 * POST /api/chat 请求体：v3 用 conversationId + memory，降级时退回 v1 sessionId。
 * 带附件时附 `attachments`（image→dataBase64 / text→text），无附件时请求体与旧版逐字节一致。
 * @param {{message:string, effort:string, conversationId?:string|null, memory?:boolean|string, sessionId?:string|null, v3?:boolean, attachments?:Array<object>}} input
 */
export function buildChatBody(input) {
  const body = {
    message: input.message,
    effort: input.effort,
  };
  if (Array.isArray(input.attachments) && input.attachments.length > 0) {
    body.attachments = input.attachments;
  }
  if (input.v3) {
    if (input.conversationId) body.conversationId = input.conversationId;
    body.memory = input.memory === false || input.memory === 'off' ? 'off' : 'on';
  } else if (input.sessionId) {
    body.sessionId = input.sessionId;
  }
  // 仅显式 on/off 才带字段；未传时保持旧请求体（缺省=off，老客户端无感）。
  if (input.webSearch === 'on' || input.webSearch === 'off') body.webSearch = input.webSearch;
  return body;
}

/* ==========================================================================
   联网搜索的纯函数（可 node:test 直接 import）
   ========================================================================== */

/**
 * GET /api/health 的 webSearch 段 → 前端视图。
 * 缺失/非法一律按「不可用」处理（旧后端 → chip 隐藏，完全向后兼容）。
 * @returns {{available: boolean, provider: string, maxCitations: number}}
 */
export function webSearchViewFromHealth(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const raw = source.webSearch && typeof source.webSearch === 'object' && !Array.isArray(source.webSearch)
    ? source.webSearch
    : null;
  const available = raw?.enabled === true;
  const provider = typeof raw?.provider === 'string' ? raw.provider.trim() : '';
  const maxCitations = Number.isFinite(Number(raw?.maxCitations))
    ? Math.max(0, Math.trunc(Number(raw.maxCitations)))
    : 0;
  return { available, provider, maxCitations };
}

/** meta.webSearchUsed → 0 或正整数（缺省/脏数据按 0）。 */
export function normalizeWebSearchUsed(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

/** citations 里联网来源（source:'web'）的条数。 */
export function webCitationCount(citations) {
  if (!Array.isArray(citations)) return 0;
  return citations.filter((item) => item && item.source === 'web').length;
}

/**
 * 每轮结束的联网状态文案：
 * - 实际用了联网资料 → 「联网来源 n 条」；
 * - 本轮用户开了联网但没取到 → 「本次未获取到联网资料」（弱化、不报错）；
 * - 未开启 → 空串。
 */
export function webSearchRunLabel(used, requested) {
  const count = normalizeWebSearchUsed(used);
  if (count > 0) return `联网来源 ${count} 条`;
  return requested ? '本次未获取到联网资料' : '';
}

/** 输入框字数提示文本（空输入返回 ''）。 */
export function charCountLabel(value, max = 4000) {
  const length = normalizeLength(value);
  return length > 0 ? `${length}/${max}` : '';
}

/** 是否接近上限（用于标红）。 */
export function charCountNearLimit(value, max = 4000) {
  const length = normalizeLength(value);
  return max - length <= 400 && length > 0;
}

function normalizeLength(value) {
  return typeof value === 'string' ? value.length : 0;
}

/* ==========================================================================
   记录（GET /api/health 的 days/summary → 面板视图）
   后端 summary 字段命名在任务并行期可能调整：优先读 summary 的多个别名，
   缺失时按 days 自行计算最近 7 天均值；任何字段缺失都渲染「—」。
   ========================================================================== */

// 真实后端（server/health.mjs buildLast7Summary）的 summary 形状是嵌套的
// `summary.last7.{stepsAvg,sleepAvgMinutes,restingHrAvg,hrvAvgMs,weightKg,workoutsCount,workoutsMinutes}`；
// 并行期约定里也曾用过扁平别名（last7AvgSteps 等），两者都兼容。
const HEALTH_SUMMARY_ALIASES = {
  steps: { flat: ['last7AvgSteps', 'avgSteps', 'steps'], nested: ['stepsAvg'] },
  sleepMinutes: { flat: ['last7AvgSleepMinutes', 'avgSleepMinutes', 'sleepMinutes'], nested: ['sleepAvgMinutes'] },
  restingHeartRate: {
    flat: ['last7AvgRestingHeartRate', 'avgRestingHeartRate', 'restingHeartRate'],
    nested: ['restingHrAvg'],
  },
  hrvMs: { flat: ['last7AvgHrvMs', 'avgHrvMs', 'hrvMs'], nested: ['hrvAvgMs'] },
  weightKg: { flat: ['latestWeightKg', 'lastWeightKg', 'weightKg'], nested: ['weightKg'] },
  workoutCount: { flat: ['last7WorkoutCount', 'workoutCount'], nested: ['workoutsCount'] },
  workoutMinutes: { flat: ['last7WorkoutMinutes', 'workoutMinutes'], nested: ['workoutsMinutes'] },
};

function healthFiniteNumber(source, key) {
  const value = source ? source[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function healthPickAny(source, keys) {
  for (const key of (keys || [])) {
    const value = healthFiniteNumber(source, key);
    if (value !== null) return value;
  }
  return null;
}

/** 先读 summary 顶层扁平别名，再读真实后端的 summary.last7 嵌套字段。 */
function healthPickSum(summary, spec) {
  if (!summary || typeof summary !== 'object') return null;
  const flat = healthPickAny(summary, spec.flat);
  if (flat !== null) return flat;
  const nested = summary.last7 && typeof summary.last7 === 'object' ? summary.last7 : null;
  return nested ? healthPickAny(nested, spec.nested) : null;
}

function healthDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

/** 睡眠分钟 → 「7 小时 12 分钟」/「42 分钟」/「—」。 */
export function formatSleepDuration(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const total = Math.round(value);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours <= 0) return `${rest} 分钟`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}

/** 最近导入时间 → 「最近导入：3 分钟前」；无记录返回「还没有导入记录」。 */
export function formatHealthImportedAt(timestamp, now = Date.now()) {
  const ts = typeof timestamp === 'string' ? Date.parse(timestamp) : Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return '还没有导入记录';
  return `最近导入：${formatRelativeTime(ts, now)}`;
}

/**
 * GET /api/health 的 payload → 健康面板视图。
 * @param {object|null} payload
 * @param {number} [now]
 * @returns {{hasData:boolean,lastImportedAt:number|null,lastImportedLabel:string,updatedAt:number|null,
 *   days:Array<object>,summary:object}}
 */
export function healthViewFromPayload(payload, now = Date.now()) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const daysRecord = source.days && typeof source.days === 'object' && !Array.isArray(source.days) ? source.days : {};
  const dates = Object.keys(daysRecord)
    .filter((date) => healthDateKey(date) && daysRecord[date] && typeof daysRecord[date] === 'object')
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, 7);
  const entries = dates.map((date) => {
    const data = daysRecord[date];
    const workouts = Array.isArray(data.workouts)
      ? data.workouts.filter((item) => item && typeof item === 'object')
      : [];
    const workoutMinutes = workouts.reduce(
      (sum, item) => sum + (healthFiniteNumber(item, 'minutes') ?? 0),
      0,
    );
    return {
      date,
      dateLabel: date.slice(5),
      steps: healthFiniteNumber(data, 'steps'),
      sleepMinutes: healthFiniteNumber(data, 'sleepMinutes'),
      restingHeartRate: healthFiniteNumber(data, 'restingHeartRate'),
      hrvMs: healthFiniteNumber(data, 'hrvMs'),
      weightKg: healthFiniteNumber(data, 'weightKg'),
      workoutCount: workouts.length,
      workoutMinutes,
    };
  });
  const summary = source.summary && typeof source.summary === 'object' ? source.summary : {};
  const average = (key) => {
    const values = entries.map((entry) => entry[key]).filter((value) => typeof value === 'number');
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  const steps = healthPickSum(summary, HEALTH_SUMMARY_ALIASES.steps) ?? average('steps');
  const sleepMinutes = healthPickSum(summary, HEALTH_SUMMARY_ALIASES.sleepMinutes) ?? average('sleepMinutes');
  const restingHeartRate =
    healthPickSum(summary, HEALTH_SUMMARY_ALIASES.restingHeartRate) ?? average('restingHeartRate');
  const hrvMs = healthPickSum(summary, HEALTH_SUMMARY_ALIASES.hrvMs) ?? average('hrvMs');
  const weightFromDays = entries
    .map((entry) => entry.weightKg)
    .find((value) => typeof value === 'number');
  const latestWeight = healthPickSum(summary, HEALTH_SUMMARY_ALIASES.weightKg) ?? weightFromDays ?? null;
  const workoutCount =
    healthPickSum(summary, HEALTH_SUMMARY_ALIASES.workoutCount) ??
    entries.reduce((sum, entry) => sum + entry.workoutCount, 0);
  const workoutMinutes =
    healthPickSum(summary, HEALTH_SUMMARY_ALIASES.workoutMinutes) ??
    entries.reduce((sum, entry) => sum + entry.workoutMinutes, 0);
  const importedTs = (() => {
    const raw = source.lastImportedAt;
    const ts = typeof raw === 'string' ? Date.parse(raw) : Number(raw);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  })();
  const updatedRaw = source.updatedAt;
  const updatedTs = (() => {
    const ts = typeof updatedRaw === 'string' ? Date.parse(updatedRaw) : Number(updatedRaw);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  })();
  const summaryView = {
    steps: {
      value: steps,
      label: steps === null ? '—' : Math.round(steps).toLocaleString('zh-CN'),
    },
    sleep: { value: sleepMinutes, label: formatSleepDuration(sleepMinutes) },
    restingHeartRate: {
      value: restingHeartRate,
      label: restingHeartRate === null ? '—' : `${Math.round(restingHeartRate)} bpm`,
    },
    hrv: { value: hrvMs, label: hrvMs === null ? '—' : `${Math.round(hrvMs)} ms` },
    weight: {
      value: latestWeight,
      label: latestWeight === null ? '—' : `${latestWeight.toFixed(1)} kg`,
    },
    workouts: {
      count: workoutCount,
      minutes: workoutMinutes,
      label:
        workoutCount <= 0 && workoutMinutes <= 0
          ? '—'
          : `${Math.round(workoutCount)} 次 · ${Math.round(workoutMinutes)} 分钟`,
    },
  };
  const days = entries.map((entry) => ({
    ...entry,
    stepsLabel: entry.steps === null ? '—' : Math.round(entry.steps).toLocaleString('zh-CN'),
    sleepLabel: formatSleepDuration(entry.sleepMinutes),
    restingHeartRateLabel:
      entry.restingHeartRate === null ? '—' : String(Math.round(entry.restingHeartRate)),
    workoutLabel: entry.workoutCount <= 0 ? '—' : `${entry.workoutCount} 次`,
  }));
  return {
    hasData: entries.length > 0,
    lastImportedAt: importedTs,
    lastImportedLabel: formatHealthImportedAt(source.lastImportedAt, now),
    updatedAt: updatedTs,
    days,
    summary: summaryView,
  };
}

/* ==========================================================================
   问卷历史视图（纯函数，可在 node:test 里直接 import）
   契约：GET /api/scales/history → {ok,updatedAt,total,scales:[{scaleId,name,
   category,kind,maxScore,count,entries:[{id,at,score,maxScore,band,factors}]}]}
   - entries 已按 at 升序；缺分数（score:null）不连入折线。
   - 图表只画最近 10 个点；x 轴日期 MM-DD，过密时前端隔点显示。
   ========================================================================== */

/** 历史条目的日期：ISO/时间戳 → 'MM-DD'（图表 x 轴）；非法返回 ''。 */
export function formatScaleHistoryDay(at) {
  const ts = typeof at === 'string' ? Date.parse(at) : Number(at);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 历史明细的完整时间：'YYYY-MM-DD HH:mm'；非法返回 ''。 */
export function formatScaleHistoryDateTime(at) {
  const ts = typeof at === 'string' ? Date.parse(at) : Number(at);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 数字字段归一化：null/undefined/''/非有限值 → null（历史里 score 可能缺失）。 */
function scaleFiniteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 历史条目的可比较分值：
 * - band/factor 问卷直接用服务端给的 score；
 * - 常模（norm）问卷没有统一总分（score=null），回退取首个因子的常模分 normScore，
 *   常模分缺失（normMissing）时再回退原始分 rawScore，保证趋势仍可比较（B1）。
 * @returns {{score:number|null, scoreSource:'score'|'normScore'|'rawScore'|''}}
 */
function scaleHistoryScore(entry, kind) {
  const direct = scaleFiniteOrNull(entry?.score);
  if (direct !== null) return { score: direct, scoreSource: 'score' };
  if (kind !== 'norm') return { score: null, scoreSource: '' };
  const factors = Array.isArray(entry?.factors) ? entry.factors : [];
  const first = factors.find((factor) => factor && typeof factor === 'object') || null;
  const normScore = scaleFiniteOrNull(first?.normScore);
  if (normScore !== null) return { score: normScore, scoreSource: 'normScore' };
  const rawScore = scaleFiniteOrNull(first?.rawScore);
  if (rawScore !== null) return { score: rawScore, scoreSource: 'rawScore' };
  return { score: null, scoreSource: '' };
}

function scaleHistoryEntryView(entry, kind = '') {
  const ts = typeof entry?.at === 'string' ? Date.parse(entry.at) : Number(entry?.at);
  const resolved = scaleHistoryScore(entry, kind);
  const scoreLabel =
    kind === 'norm' ? (resolved.scoreSource === 'rawScore' ? '原始分' : '常模分') : '总分';
  return {
    id: typeof entry?.id === 'string' ? entry.id : '',
    at: Number.isFinite(ts) && ts > 0 ? ts : null,
    dateLabel: formatScaleHistoryDay(entry?.at),
    dateTimeLabel: formatScaleHistoryDateTime(entry?.at),
    score: resolved.score,
    scoreSource: resolved.scoreSource,
    scoreLabel,
    maxScore: scaleFiniteOrNull(entry?.maxScore),
    bandLabel: typeof entry?.band?.label === 'string' ? entry.band.label : '',
    factors: Array.isArray(entry?.factors) ? entry.factors : [],
  };
}

/**
 * GET /api/scales/history payload → 历史视图。
 * @returns {{updatedAt:number|null, total:number, hasData:boolean,
 *   scales:Array<{scaleId:string,name:string,category:string,kind:string,
 *   maxScore:number|null,count:number,entries:Array<object>}>}}
 */
export function buildScaleHistoryView(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const scales = (Array.isArray(source.scales) ? source.scales : [])
    .filter((scale) => scale && typeof scale === 'object' && typeof scale.scaleId === 'string')
    .map((scale) => {
      const kind = typeof scale.kind === 'string' ? scale.kind : 'band';
      const entries = (Array.isArray(scale.entries) ? scale.entries : [])
        .map((entry) => scaleHistoryEntryView(entry, kind))
        .filter((entry) => entry.at !== null);
      return {
        scaleId: scale.scaleId,
        name: typeof scale.name === 'string' && scale.name ? scale.name : scale.scaleId,
        category: typeof scale.category === 'string' ? scale.category : '',
        kind,
        maxScore: scaleFiniteOrNull(scale.maxScore),
        count: Number.isFinite(Number(scale.count)) ? Number(scale.count) : entries.length,
        entries,
      };
    })
    .filter((scale) => scale.entries.length > 0);
  const updatedTs = (() => {
    const ts = typeof source.updatedAt === 'string' ? Date.parse(source.updatedAt) : Number(source.updatedAt);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  })();
  return {
    updatedAt: updatedTs,
    total: scales.reduce((sum, scale) => sum + scale.entries.length, 0),
    hasData: scales.length > 0,
    scales,
  };
}

/** 折线图最多画最近 10 个点（x 轴过密时隔点显示日期）。 */
export const SCALE_TREND_MAX_POINTS = 10;

/**
 * 单个问卷的历史 → 折线图数据（只取最近 10 个点；缺分数断开不连线）。
 * @returns {{points:Array<{id:string,at:number,dateLabel:string,score:number|null,
 *   maxScore:number|null,bandLabel:string}>, scored:Array<object>, maxScore:number,
 *   yMax:number, hasData:boolean, note:string}}
 */
export function buildScaleTrend(scale) {
  const kind = typeof scale?.kind === 'string' ? scale.kind : '';
  const entries = Array.isArray(scale?.entries) ? scale.entries : [];
  const points = entries.slice(-SCALE_TREND_MAX_POINTS).map((entry) => {
    const view = scaleHistoryEntryView(entry, kind);
    return {
      id: view.id,
      at: view.at,
      dateLabel: view.dateLabel,
      score: view.score,
      scoreLabel: view.scoreLabel,
      scoreSource: view.scoreSource,
      maxScore: view.maxScore,
      bandLabel: view.bandLabel,
    };
  });
  const scored = points.filter((point) => point.score !== null);
  const maxFromEntries = scored.reduce((max, point) => Math.max(max, point.maxScore || 0), 0);
  const maxScore = Math.max(
    Number.isFinite(Number(scale?.maxScore)) ? Number(scale.maxScore) : 0,
    maxFromEntries,
  );
  const observedMax = scored.reduce((max, point) => Math.max(max, point.score), 0);
  // y 轴：有 maxScore 时按 0–maxScore（ 口径：总分 x/max）；常模问卷没有统一总分，
  // 按观测到的常模分/原始分向上取整到 5 的倍数（B1：maxScore 缺失时按观测量程取整）。
  const yMax =
    maxScore > 0
      ? maxScore
      : observedMax > 0
        ? kind === 'norm'
          ? Math.max(5, Math.ceil(observedMax / 5) * 5)
          : Math.ceil(observedMax)
        : 1;
  const missing = points.length - scored.length;
  let note = '';
  if (kind === 'factor') {
    note = '这是因子型问卷，没有统一总分；折线展示服务端返回的总分参考值。';
  } else if (kind === 'norm') {
    note = '常模问卷没有统一总分；折线展示首个因子的常模分（缺失时用原始分），仅作趋势参考。';
  }
  if (missing > 0) {
    note = [note, `有 ${missing} 次记录没有可比较的分数，未连入折线。`].filter(Boolean).join(' ');
  }
  return {
    points,
    scored,
    maxScore,
    yMax,
    hasData: scored.length > 0,
    note,
  };
}
