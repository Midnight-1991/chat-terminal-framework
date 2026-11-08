// 双模型桥接：附件（图片/文本文件）在服务端先由 deepseek-flash 解析成摘要，
// 摘要随用户文字注入 deepseek-v4-pro 的用户消息；正文仍由 pro 生成。
// 契约：docs/API-CONTRACT.md 2/6 附件字段；docs/DATA-CONTRACT.md 18。
//
// 隐私基线：
//   - 原始二进制（dataBase64 / text 全文）只在本进程内存中存在，绝不写 DATA_DIR / 日志；
//   - 返回给上层的只有 {name,kind,summary,ms,error?}（摘要 ≤800 字）；
//   - 日志只记附件名与错误原因，不记图片字节/文本内容。
import { messagesUrl } from './config.mjs';
import { upstreamHeaders } from './upstream.mjs';
import { ATTACHMENT_ID_RE, attachmentPreviewUrl } from './attachments.mjs';

/** 每张图片原始字节上限（4MB；base64 传输体积约 5.34MB）。 */
export const VISION_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** 单个文本文件原始字节上限（100KB，UTF-8）。 */
export const VISION_TEXT_MAX_BYTES = 100 * 1024;
/** 一轮请求附件合计原始字节上限（12MB）。 */
export const VISION_TOTAL_MAX_BYTES = 12 * 1024 * 1024;
export const VISION_MAX_IMAGES = 3;
export const VISION_MAX_TEXTS = 1;
/** 解析并发上限（并发 ≤3）。 */
export const VISION_CONCURRENCY = 3;
/** 失败重试次数（重试 1 次）。 */
export const VISION_RETRIES = 1;
/** 单附件摘要字符上限（≤800 字）。 */
export const VISION_SUMMARY_MAX_CHARS = 800;
export const ATTACHMENT_NAME_MAX_CHARS = 200;

export const ALLOWED_IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** HEIC/HEIF（iPhone 默认格式）：官方 flash 不接收，前端应已转 JPEG；服务端仅用于给出明确报错。 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'avif']);

/**
 * 按文件内容（magic bytes）嗅探图片格式，不信任 mime/扩展名（调研 P0）。
 * @param {Buffer} buffer
 * @returns {'image/jpeg'|'image/png'|'image/gif'|'image/webp'|null}
 */
export function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** 是否为 HEIC/HEIF 容器（ftyp box 的 brand）。 */
function isHeicBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buffer.toString('ascii', 8, 12).toLowerCase();
  return HEIC_BRANDS.has(brand);
}

/** 解析提示词：只做客观转写/描述，不做建议、不做诊断。 */
export const VISION_PROMPT = [
  '请客观解析这张图片，用中文输出：',
  '1) 图中可见的文字（尽量逐字转写，看不清的用「（不清）」标注）；',
  '2) 画面的客观描述（场景、人物/物体、版式与图表要点，只描述可见内容）；',
  '3) 如图片是表格/图表/截图，概括其结构与关键数据。',
  '要求：不超过 800 字；不要给建议、不要分析用户情绪、不要做任何诊断或判断。',
].join('\n');

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** 附件校验失败（HTTP 400 INVALID_REQUEST）。 */
export class AttachmentError extends Error {
  constructor(message, { status = 400, code = 'INVALID_REQUEST' } = {}) {
    super(message);
    this.name = 'AttachmentError';
    this.status = status;
    this.code = code;
  }
}

function defaultAttachmentName(kind, index) {
  return kind === 'image' ? `图片 ${index + 1}` : `文本文件 ${index + 1}`;
}

function cleanAttachmentName(value, kind, index) {
  if (value === undefined || value === null) return defaultAttachmentName(kind, index);
  if (typeof value !== 'string') throw new AttachmentError('附件 name 必须是字符串');
  const trimmed = value.trim();
  if (!trimmed) return defaultAttachmentName(kind, index);
  return Array.from(trimmed).slice(0, ATTACHMENT_NAME_MAX_CHARS).join('');
}

function normalizeBase64(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AttachmentError(`图片「${name}」缺少 dataBase64`);
  }
  let data = value.trim();
  // 兼容前端可能直接贴 data URL 的情况（契约仍以纯 base64 为准）。
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',');
    if (comma !== -1) data = data.slice(comma + 1);
  }
  data = data.replace(/\s+/g, '');
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw new AttachmentError(`图片「${name}」的 dataBase64 不是合法 base64`);
  }
  return data;
}

/**
 * 校验并归一化 attachments（纯函数，不做网络）。
 * @param {unknown} raw 请求体 attachments
 * @param {{maxImages?:number,maxTexts?:number,maxTotal?:number}} [limits]
 * @returns {Array<{name:string,kind:'image'|'text',mime:string,bytes:number,size:number,dataBase64?:string,text?:string}>}
 */
export function normalizeAttachments(raw, { maxImages = VISION_MAX_IMAGES, maxTexts = VISION_MAX_TEXTS, maxTotal = Infinity } = {}) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AttachmentError('attachments 必须是数组');
  if (raw.length > maxTotal) throw new AttachmentError(`附件最多 ${maxTotal} 个`);

  const normalized = [];
  let imageCount = 0;
  let textCount = 0;
  let totalBytes = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const label = `attachments[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AttachmentError(`${label} 必须是对象`);
    }
    const kind = item.kind;
    if (kind !== 'image' && kind !== 'text') {
      throw new AttachmentError(`${label}.kind 必须是 'image' 或 'text'`);
    }
    const name = cleanAttachmentName(item.name, kind, index);

    if (kind === 'image') {
      imageCount += 1;
      if (imageCount > maxImages) throw new AttachmentError(`最多上传 ${maxImages} 张图片`);
      const dataBase64 = normalizeBase64(item.dataBase64, name);
      const buffer = Buffer.from(dataBase64, 'base64');
      const bytes = buffer.length;
      if (bytes <= 0) throw new AttachmentError(`图片「${name}」内容为空`);
      // P0：格式以内容为准（官方 flash 只收 JPEG/PNG/GIF/WebP，且按文件内容判断）。
      const mime = sniffImageMime(buffer);
      if (!mime) {
        if (isHeicBuffer(buffer)) {
          throw new AttachmentError(
            `图片「${name}」是 HEIC/HEIF 格式，服务端不支持；请先转换为 JPEG/PNG/WebP/GIF 后再上传`,
            { code: 'INVALID_ATTACHMENT' },
          );
        }
        throw new AttachmentError(
          `图片「${name}」内容不是支持的图片格式（仅 JPEG/PNG/GIF/WebP，按文件内容校验）`,
          { code: 'INVALID_ATTACHMENT' },
        );
      }
      // 内容合法后，再校验客户端声明的 mime（不认识/不支持的声明类型直接拒收，避免 TIFF/HEIC 等误传）。
      const declaredMime = typeof item.mime === 'string' ? item.mime.trim().toLowerCase() : '';
      if (declaredMime && !ALLOWED_IMAGE_MIMES.includes(declaredMime)) {
        throw new AttachmentError(
          `图片「${name}」声明的类型 ${declaredMime} 不受支持（仅 JPEG/PNG/GIF/WebP；实际格式以文件内容为准）`,
          { code: 'INVALID_ATTACHMENT' },
        );
      }
      if (bytes > VISION_IMAGE_MAX_BYTES) {
        throw new AttachmentError(`图片「${name}」超过 4MB 上限（当前 ${(bytes / 1024 / 1024).toFixed(2)}MB）`);
      }
      totalBytes += bytes;
      if (totalBytes > VISION_TOTAL_MAX_BYTES) throw new AttachmentError('附件合计不能超过 12MB');
      normalized.push({ name, kind, mime, dataBase64, bytes, size: bytes });
      continue;
    }

    textCount += 1;
    if (textCount > maxTexts) throw new AttachmentError(`最多上传 ${maxTexts} 个文本文件`);
    if (typeof item.text !== 'string' || item.text.trim() === '') {
      throw new AttachmentError(`文本文件「${name}」内容不能为空`);
    }
    const bytes = Buffer.byteLength(item.text, 'utf8');
    if (bytes > VISION_TEXT_MAX_BYTES) {
      throw new AttachmentError(`文本文件「${name}」超过 100KB 上限（当前 ${(bytes / 1024).toFixed(1)}KB）`);
    }
    totalBytes += bytes;
    if (totalBytes > VISION_TOTAL_MAX_BYTES) throw new AttachmentError('附件合计不能超过 12MB');
    const mime = typeof item.mime === 'string' && item.mime.trim() ? item.mime.trim() : 'text/plain';
    normalized.push({ name, kind, mime, text: item.text, bytes, size: bytes });
  }

  return normalized;
}

/** 截断到 ≤800 字（按 Unicode 码点），并压缩多余空白。 */
export function truncateSummary(text, maxChars = VISION_SUMMARY_MAX_CHARS) {
  const compacted = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
  const chars = Array.from(compacted);
  if (chars.length <= maxChars) return compacted;
  return `${chars.slice(0, maxChars).join('')}…`;
}

/** CHAT_MOCK=1 的确定性摘要（不调真实 API，供测试 / 断言）。 */
export function mockAttachmentSummary(attachment) {
  if (attachment.kind === 'image') {
    return `（mock 解析）图片「${attachment.name}」：画面为测试占位图，可见一段说明文字与两个简单图形。`;
  }
  return `（mock 解析）文本文件「${attachment.name}」：已读取 ${attachment.bytes} 字节测试内容。`;
}

/** 构造 flash 的 Anthropic 兼容请求体（单张图片）；导出供单测断言。 */
export function buildVisionRequestBody(config, attachment) {
  return {
    model: config.visionModel ?? 'deepseek-flash',
    max_tokens: config.visionMaxTokens ?? 800,
    stream: false,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: attachment.mime,
              data: attachment.dataBase64,
            },
          },
          { type: 'text', text: VISION_PROMPT },
        ],
      },
    ],
  };
}

/** 从非流式 Messages 响应中取文本摘要。 */
export function extractVisionText(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((block) => block !== '')
    .join('\n');
  return truncateSummary(text);
}

function visionStatusMessage(status) {
  if (status === 429) return '解析器限流（HTTP 429），请稍后重试';
  if (status >= 500) return `解析器服务错误（HTTP ${status}），请稍后重试`;
  if (status === 401 || status === 403) return `解析器鉴权失败（HTTP ${status}），请检查 DEEPSEEK_API_KEY`;
  return `解析器请求失败（HTTP ${status}）`;
}

async function discardBody(response) {
  try {
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (text) return String(text).slice(0, 200);
    }
  } catch {
    /* ignore */
  }
  return '';
}

async function parseImageAttachment(attachment, { config, apiKey, logger, fetchImpl }) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  if (config.mock) {
    return { name: attachment.name, kind: 'image', summary: mockAttachmentSummary(attachment), ms: elapsed() };
  }
  if (!apiKey) {
    return { name: attachment.name, kind: 'image', error: '未配置 DEEPSEEK_API_KEY，无法解析图片（可改用文字描述）', ms: elapsed() };
  }

  const url = messagesUrl(config);
  const body = buildVisionRequestBody(config, attachment);
  let lastError = '解析失败';

  for (let attempt = 0; attempt <= VISION_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.visionTimeoutMs ?? 30_000);
    if (typeof timer.unref === 'function') timer.unref();
    let retryable = false;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: upstreamHeaders(apiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== 'boolean') {
        lastError = '解析器返回了无法识别的响应';
        retryable = true;
      } else if (!response.ok) {
        const detail = await discardBody(response);
        lastError = visionStatusMessage(response.status);
        logger?.warn?.(`[vision] 图片「${attachment.name}」HTTP ${response.status}${detail ? `：${detail}` : ''}`);
        retryable = response.status === 429 || response.status >= 500;
      } else {
        let json;
        try {
          json = await response.json();
        } catch {
          lastError = '解析器返回的响应不是合法 JSON';
          retryable = false;
          json = null;
        }
        if (json !== null) {
          lastError = '解析器没有返回可用的文字摘要';
          const summary = extractVisionText(json);
          if (summary) {
            return { name: attachment.name, kind: 'image', summary, ms: elapsed() };
          }
          retryable = true;
        }
      }
    } catch (error) {
      const timedOut = controller.signal.aborted;
      lastError = timedOut
        ? `解析超时（>${config.visionTimeoutMs ?? 30_000}ms）`
        : `解析失败（${error?.message ?? error}）`;
      logger?.warn?.(`[vision] 图片「${attachment.name}」${lastError}（第 ${attempt + 1} 次尝试）`);
      // 网络错误/超时可重试；解析或格式类错误不重试。
      retryable = timedOut || isRetryableNetworkError(error);
    } finally {
      clearTimeout(timer);
    }
    if (!retryable || attempt >= VISION_RETRIES) break;
  }

  return { name: attachment.name, kind: 'image', error: lastError, ms: elapsed() };
}

function isRetryableNetworkError(error) {
  const name = error?.name ?? '';
  if (name === 'TypeError' || name === 'AbortError') return true;
  const code = error?.code ?? error?.cause?.code ?? '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code);
}

async function mapLimit(items, limit, mapper) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 解析附件：文本文件直接取内容做摘要（无需模型）；图片逐张调 deepseek-flash 转写摘要。
 * 单张失败不抛错，返回带 error 的条目（chat 不阻断；memory 由调用方转 422）。
 *
 * @param {{
 *   config: object, apiKey?: string, logger?: object,
 *   attachments?: Array<object>, fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<Array<{name:string,kind:string,summary?:string,ms:number,error?:string}>>}
 */
export async function parseAttachments({
  config,
  apiKey = '',
  logger = console,
  attachments = [],
  fetchImpl = globalThis.fetch,
} = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return [];

  return mapLimit(list, VISION_CONCURRENCY, async (attachment) => {
    if (attachment.kind === 'text') {
      return {
        name: attachment.name,
        kind: 'text',
        summary: truncateSummary(attachment.text),
        ms: 0,
      };
    }
    return parseImageAttachment(attachment, { config, apiKey, logger, fetchImpl });
  });
}

/** 生成可安全返回/落库的附件元数据（不含二进制与原文）。 */
export function publicAttachmentMeta(parsed) {
  const meta = { name: parsed.name, kind: parsed.kind };
  if (parsed.summary) meta.summary = parsed.summary;
  if (parsed.error) meta.error = parsed.error;
  meta.ms = Number.isFinite(parsed.ms) ? parsed.ms : 0;
  return withPersistedAttachmentRefs(meta, parsed);
}

/** 生成可写进消息持久化的附件元数据（name/kind/mime/size/summary|error，无二进制）。 */
export function persistedAttachmentMeta(parsed, attachment) {
  const meta = {
    name: parsed.name,
    kind: parsed.kind,
    mime: attachment?.mime ?? '',
    size: attachment?.size ?? attachment?.bytes ?? 0,
  };
  if (parsed.summary) meta.summary = parsed.summary;
  if (parsed.error) meta.error = parsed.error;
  return withPersistedAttachmentRefs(meta, parsed);
}

/**
 * 给公开/持久化附件元数据追加图片持久化引用（id + previewUrl）。
 * 只接受合法内容寻址 id（a+24hex），无 id 时不出现（与关闭存储时逐字节兼容）。
 */
export function withPersistedAttachmentRefs(meta, parsed) {
  const id = parsed?.id;
  if (typeof id === 'string' && ATTACHMENT_ID_RE.test(id)) {
    meta.id = id;
    meta.previewUrl = attachmentPreviewUrl(id);
  }
  return meta;
}
