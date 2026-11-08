// markup.js — 纯函数：`[[cN]]` 引用标记解析、流式安全切分、展示工具。
// 无 DOM 依赖，可在 node:test 中直接 import。
//
// 规则（API-CONTRACT 2）：
//   - 引用标记格式固定为 `[[c1]]`，单个标记只含一个编号；
//   - 多个标记可相邻：`[[c1]][[c2]]`；
//   - 其他形如 `[1]`、`[[c]]`、`[[x1]]` 的内容一律按普通文本处理，不做猜测。

/** 一个不完整标记最多可能有多长（`[[c` + 6 位编号 + `]` ≈ 10，留足余量）。 */
export const MAX_MARKER_PREFIX = 14;

/**
 * 判断字符串 s 是否可能是某个完整标记的前缀。
 * 用于流式渲染时把「可能还没收完的标记」暂扣，等下一段 delta 再决定。
 * @param {string} s
 * @returns {boolean}
 */
export function isMarkerPrefix(s) {
  if (typeof s !== 'string' || s.length === 0 || s[0] !== '[') return false;
  if (s.length === 1) return true; // "["  — 可能是 "[[c1]]" 的开头
  if (s[1] !== '[') return false; // "[x" 不可能是标记
  if (s.length === 2) return true; // "[["
  if (s[2] !== 'c') return false; // "[[x"
  const rest = s.slice(3);
  if (rest === '') return true; // "[[c"
  if (/^\d+$/.test(rest)) return true; // "[[c1", "[[c12"
  return /^\d+\]$/.test(rest); // "[[c1]"
}

/**
 * 流过一段原文后，最多可以安全渲染到哪个下标。
 * 返回的 index 之前的内容不会包含「半个引用标记」。
 * 若末尾没有可疑前缀，返回 text.length。
 * @param {string} text 已累积的完整原文
 * @returns {number}
 */
export function safeCutoff(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const from = Math.max(0, text.length - MAX_MARKER_PREFIX);
  for (let i = from; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 91) continue; // '['
    if (isMarkerPrefix(text.slice(i))) return i;
  }
  return text.length;
}

/**
 * 把一段文本切成 text / cite 两种 token。
 * @param {string} text
 * @returns {Array<{type:'text',value:string}|{type:'cite',c:number}>}
 */
export function parseCitations(text) {
  const tokens = [];
  if (!text) return tokens;
  const re = /\[\[c(\d+)\]\]/g;
  let last = 0;
  let match = re.exec(text);
  while (match) {
    if (match.index > last) {
      tokens.push({ type: 'text', value: text.slice(last, match.index) });
    }
    tokens.push({ type: 'cite', c: Number(match[1]) });
    last = match.index + match[0].length;
    match = re.exec(text);
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) });
  return tokens;
}

/** 正文里出现的引用编号（去重、升序）。 */
export function citationNumbers(text) {
  const seen = new Set();
  for (const token of parseCitations(text)) {
    if (token.type === 'cite') seen.add(token.c);
  }
  return [...seen].sort((a, b) => a - b);
}

/** 去掉标记后的纯文本（用于日志、摘要、aria-label）。 */
export function stripCitationMarkers(text) {
  return parseCitations(text)
    .map((token) => (token.type === 'text' ? token.value : `[${token.c}]`))
    .join('');
}

/**
 * 把 sourceUrl 收敛成可展示的域名；非法 URL 返回空串。
 * @param {string} url
 * @returns {string}
 */
export function domainOf(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 仅允许 http(s) 外链，避免 javascript: 之类被塞进 href。
 * @param {string} url
 * @returns {string} 安全 URL 或空串
 */
export function safeExternalUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * 耗时格式化：<1s 用 ms，其余保留一位小数。
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0.0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 输入是否可发送（1–4000 字符，trim 后非空）。 */
export function isSendable(text, max = 4000) {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  return value.length >= 1 && value.length <= max;
}

/** 发送前归一化用户输入：统一换行符、裁掉首尾空白、保留内部换行。 */
export function normalizeMessage(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
}

/** 会话 id 的短展示（状态栏用），过短/空返回占位符。 */
export function shortSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return 's———';
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}…`;
}

/**
 * 从一行错误信息生成终端风错误文案。
 * @param {{code?:string,message?:string,status?:number}} error
 * @returns {string}
 */
export function formatTerminalError(error = {}) {
  const code = typeof error.code === 'string' ? error.code : '';
  const known = {
    INVALID_REQUEST: '请求无效',
    NOT_FOUND: '资料不存在',
    UPSTREAM: '上游模型出错',
    RATE_LIMIT: '请求过于频繁',
    INTERNAL: '服务内部错误',
    NETWORK: '网络中断',
    PROTOCOL: '响应格式异常',
    ABORTED: '连接已中断',
  };
  const head = known[code] || '请求失败';
  const detail = typeof error.message === 'string' ? error.message.trim() : '';
  const status = Number.isInteger(error.status) ? ` (HTTP ${error.status})` : '';
  return detail ? `error: ${head}${status} · ${detail}` : `error: ${head}${status}`;
}

/**
 * 解析离页后台生成待恢复记录（sessionStorage['ctf.bg.pending']）。
 * 非法 JSON 或字段缺失返回 null；存储可能被外部改写，这里绝不抛错。
 * @param {string|null|undefined} raw
 * @returns {{conversationId:string, at:number}|null}
 */
export function parseBackgroundPending(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const conversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId.trim() : '';
  const at = Number(parsed.at);
  if (conversationId === '' || !Number.isFinite(at) || at <= 0) return null;
  return { conversationId, at };
}

/**
 * 从历史消息上取毫秒时间戳：服务端存 number(ms)，旧数据可能是 ISO 字符串。
 * @param {{createdAt?:number|string, ts?:number|string}} message
 * @returns {number} 无法解析时返回 0
 */
function messageTimestamp(message) {
  const value = message?.createdAt ?? message?.ts;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * 轮询到的会话详情里是否出现了「本轮」的 assistant 消息。
 * 判定：存在 role==='assistant' 且 createdAt >= pending.at。
 * @param {{messages?:Array<object>}|null|undefined} detail GET /api/conversations/:id 响应
 * @param {{at?:number}|null|undefined} pending
 * @returns {boolean}
 */
export function backgroundAssistantReady(detail, pending) {
  const at = Number(pending?.at) || 0;
  const messages = Array.isArray(detail?.messages) ? detail.messages : [];
  if (at <= 0) return false;
  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue;
    if (messageTimestamp(message) >= at) return true;
  }
  return false;
}

/**
 * 「离页中断」判定——只有页面不可见/发生过 pagehide 时的网络层中断才转后台恢复；
 * HTTP 4xx/5xx 等明确错误照常渲染红色错误行。
 * @param {{error?:object|null, hidden?:boolean, pageHidden?:boolean}} input
 * @returns {boolean}
 */
export function isBackgroundInterruption({ error = null, hidden = false, pageHidden = false } = {}) {
  if (!hidden && !pageHidden) return false;
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400) return false;
  const name = typeof error?.name === 'string' ? error.name : '';
  if (name === 'AbortError' || name === 'TypeError') return true;
  const code =
    typeof error?.code === 'string'
      ? error.code
      : typeof error?.apiCode === 'string'
        ? error.apiCode
        : '';
  return code === 'NETWORK' || code === 'PROTOCOL' || code === 'ABORTED';
}
