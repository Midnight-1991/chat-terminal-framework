// attachments.js — 附件上传的纯逻辑层（零依赖，可在 node:test 里直接 import）。
//
// 契约见 docs/API-CONTRACT.md 5/6：
// - POST /api/chat body.attachments?: [{kind:'image'|'text', name, mime, dataBase64?, text?}]
// - POST /api/memories body.attachments?: [同形状，≤1 个]
// 本文件只做「分类 / 限额 / 尺寸 / 载荷 / 展示文案」的纯计算，DOM 与压缩在 app.js。

/** 上传限额（与 对齐；字节均按原始文件大小）。 */
export const ATTACHMENT_LIMITS = {
  maxImages: 3,
  maxTextFiles: 1,
  maxImageBytes: 4 * 1024 * 1024,
  maxTextBytes: 100 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  maxImageEdge: 1568,
  jpegQuality: 0.85,
};

/** file input 的 accept 文案（.txt/.md/.csv/.json/.log 走文本分支）。 */
export const ATTACHMENT_ACCEPT = 'image/*,.txt,.md,.csv,.json,.log';

const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.log'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif', '.avif', '.bmp'];
const TEXT_MIMES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/x-ndjson',
  'text/x-log',
  'application/octet-stream', // .log 常被浏览器识别成 octet-stream，靠扩展名兜底
];

/** 取小写扩展名（含点）；没有扩展名返回 ''。 */
export function fileExtension(name) {
  const value = String(name || '').toLowerCase();
  const index = value.lastIndexOf('.');
  if (index <= 0 || index === value.length - 1) return '';
  return value.slice(index);
}

/**
 * 归类一个待上传文件。
 * @param {{name?: string, mime?: string, size?: number}} file
 * @returns {{kind: 'image'|'text', reason?: undefined} | {kind: null, reason: string}}
 */
export function classifyAttachmentFile(file = {}) {
  const name = String(file.name || '');
  const mime = String(file.mime || file.type || '').toLowerCase();
  const size = Math.max(0, Number(file.size) || 0);
  const ext = fileExtension(name);

  const image = mime.startsWith('image/') || IMAGE_EXTENSIONS.includes(ext);
  if (image) {
    if (size > ATTACHMENT_LIMITS.maxImageBytes) {
      return { kind: null, reason: `${name || '图片'}超过 4MB 上限，先压缩或换一张。` };
    }
    return { kind: 'image' };
  }

  const text =
    TEXT_MIMES.includes(mime) ||
    mime.startsWith('text/') ||
    TEXT_EXTENSIONS.includes(ext);
  if (text) {
    if (size > ATTACHMENT_LIMITS.maxTextBytes) {
      return { kind: null, reason: `${name || '文本文件'}超过 100KB 上限。` };
    }
    return { kind: 'text' };
  }

  return { kind: null, reason: `不支持的文件类型：${name || mime || '未知文件'}。` };
}

/** 按类型统计草稿里的附件数量。 */
export function countDraftKinds(drafts = []) {
  const counts = { image: 0, text: 0, total: drafts.length, bytes: 0 };
  for (const draft of drafts) {
    if (draft?.kind === 'image') counts.image += 1;
    else if (draft?.kind === 'text') counts.text += 1;
    counts.bytes += Math.max(0, Number(draft?.size) || 0);
  }
  return counts;
}

/**
 * 是否还能往草稿区加这个附件（数量上限 + 合计大小）。
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function canAddDraft(drafts = [], candidate = {}) {
  const counts = countDraftKinds(drafts);
  const size = Math.max(0, Number(candidate.size) || 0);
  if (counts.bytes + size > ATTACHMENT_LIMITS.maxTotalBytes) {
    return { ok: false, message: '附件总大小超过 12MB 上限。' };
  }
  if (candidate.kind === 'image') {
    if (counts.image >= ATTACHMENT_LIMITS.maxImages) {
      return { ok: false, message: `最多带 ${ATTACHMENT_LIMITS.maxImages} 张图片。` };
    }
    return { ok: true };
  }
  if (candidate.kind === 'text') {
    if (counts.text >= ATTACHMENT_LIMITS.maxTextFiles) {
      return { ok: false, message: `最多带 ${ATTACHMENT_LIMITS.maxTextFiles} 个文本文件。` };
    }
    return { ok: true };
  }
  return { ok: false, message: '不支持的文件类型。' };
}

/** 图片压缩后的目标尺寸：最长边 ≤ maxEdge，等比缩小（不放大）。 */
export function scaledSize(width, height, maxEdge = ATTACHMENT_LIMITS.maxImageEdge) {
  const w = Math.max(1, Number(width) || 0);
  const h = Math.max(1, Number(height) || 0);
  const edge = Math.max(1, Number(maxEdge) || ATTACHMENT_LIMITS.maxImageEdge);
  const longest = Math.max(w, h);
  if (longest <= edge) return { width: Math.round(w), height: Math.round(h) };
  const ratio = edge / longest;
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) };
}

/** 人类可读文件大小：<1KB 用 B，其余 KB/MB 保留一位小数。 */
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** 草稿是否已经处理完成（图片有 dataBase64、文本有 text）。 */
export function isDraftReady(draft) {
  if (!draft) return false;
  if (draft.kind === 'image') return typeof draft.dataBase64 === 'string' && draft.dataBase64.length > 0;
  if (draft.kind === 'text') return typeof draft.text === 'string' && draft.text.length > 0;
  return false;
}

/**
 * 组装 POST /api/chat 的 attachments 载荷（只含已完成处理的草稿）。
 * image → {kind:'image', name, mime, dataBase64}；text → {kind:'text', name, mime, text}
 */
export function buildAttachmentPayload(drafts = []) {
  const payload = [];
  for (const draft of drafts) {
    if (!isDraftReady(draft)) continue;
    if (draft.kind === 'image') {
      payload.push({
        kind: 'image',
        name: String(draft.name || '图片'),
        mime: String(draft.mime || 'image/jpeg'),
        dataBase64: draft.dataBase64,
      });
    } else if (draft.kind === 'text') {
      payload.push({
        kind: 'text',
        name: String(draft.name || '文本'),
        mime: String(draft.mime || 'text/plain'),
        text: draft.text,
      });
    }
  }
  return payload;
}

/** 消息气泡上的附件 chip 文案：图片/文件＋名字。 */
export function attachmentChipLabel(attachment = {}, options = {}) {
  const name = String(attachment.name || '附件');
  const kind = attachment.kind === 'image' ? '图片' : attachment.kind === 'text' ? '文件' : '附件';
  const state = options.state;
  if (state === 'parsing') return `附件：${name}（正在理解…）`;
  if (state === 'error') return `附件：${name}（解析失败）`;
  return `附件：${name}（已解析）`;
}

/** 同源附件读取路径：仅 `/api/attachments/<a+24hex>`（契约见 docs/API-CONTRACT.md 11）。 */
const ATTACHMENT_PREVIEW_PATH_RE = /^\/api\/attachments\/a[0-9a-f]{24}$/;
/** 站内预览路径长度上限（绝对路径都很短；超长/畸形一律拒绝）。 */
const PREVIEW_URL_MAX = 512;
/** 本地草稿的 data:image 预览上限（压缩后 JPEG base64 可达数百 KB，留 6MB 字符余量）。 */
const DATA_PREVIEW_MAX = 6 * 1024 * 1024;
const DATA_IMAGE_PREVIEW_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i;

/**
 * 可安全回显的图片预览地址：
 * - 站内附件读取路径 `/api/attachments/<a+24hex>`（同源加载自带 Basic Auth）；
 * - 本地草稿的 data:image 预览（发送后立即回显，不经网络、不引外部资源）；
 * - 绝对同源 URL（origin 与当前页面一致、pathname 命中附件读取路径）。
 * 其余（http(s) 外部地址、协议相对 `//`、任意其他同源相对路径、非图片 data:）一律返回 null。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeAttachmentPreviewUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url) return null;
  if (DATA_IMAGE_PREVIEW_RE.test(url)) return url.length <= DATA_PREVIEW_MAX ? url : null;
  if (url.length > PREVIEW_URL_MAX) return null;
  if (/[\s\\]/.test(url)) return null;
  if (ATTACHMENT_PREVIEW_PATH_RE.test(url)) return url;
  // 绝对同源 URL：只在浏览器环境（有 location）里按 origin 校验，Node 测试环境不推断来源。
  if (!/^https?:\/\//i.test(url)) return null;
  const location = globalThis.location;
  if (!location || typeof location.origin !== 'string' || !location.origin || location.origin === 'null') {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== location.origin) return null;
  if (parsed.search || parsed.hash) return null;
  return ATTACHMENT_PREVIEW_PATH_RE.test(parsed.pathname) ? url : null;
}

/** 附件持久化 id：契约 'a' + 24 位小写 hex；不合法返回 ''。 */
export function safeAttachmentId(value) {
  return typeof value === 'string' && /^a[0-9a-f]{24}$/.test(value) ? value : '';
}

/** 从后端附件元数据里取可回显的 {id,previewUrl}（只有图片才回传 previewUrl）。 */
function attachmentPreviewFields(item) {
  const id = safeAttachmentId(item.id);
  const previewUrl = item.kind === 'image' ? safeAttachmentPreviewUrl(item.previewUrl) : null;
  return {
    ...(id ? { id } : {}),
    ...(previewUrl ? { previewUrl } : {}),
  };
}

/** SSE meta.attachments → 统一结构（容错：非数组/脏数据返回 []）。 */
export function normalizeMetaAttachments(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    list.push({
      name,
      kind: item.kind === 'image' ? 'image' : item.kind === 'text' ? 'text' : 'unknown',
      ...attachmentPreviewFields(item),
      summary: typeof item.summary === 'string' ? item.summary : '',
      error: typeof item.error === 'string' ? item.error : '',
      ms: Number.isFinite(Number(item.ms)) ? Number(item.ms) : 0,
    });
  }
  return list;
}

/** 历史消息里的 attachments（name/kind/mime/size/summary + 的 id/previewUrl）→ 轻量结构。 */
export function normalizeMessageAttachments(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    list.push({
      name,
      kind: item.kind === 'image' ? 'image' : 'text',
      ...attachmentPreviewFields(item),
      mime: typeof item.mime === 'string' ? item.mime : '',
      size: Math.max(0, Number(item.size) || 0),
      summary: typeof item.summary === 'string' ? item.summary : '',
      error: typeof item.error === 'string' ? item.error : '',
    });
  }
  return list;
}
