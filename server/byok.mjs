// ..BYOK（用户自带 key 的自定义模型）服务端存储、SSRF 校验与探活。
//
// 存储（契约 2，均在 DATA_DIR/users/<uid>/，目录 700 / 文件 600，原子写）：
// - byok.json：明文元数据 {version,provider,protocol,model,baseUrlOrigin,keyHint,createdAt,updatedAt}
//   —— **不含 apiKey，也不含 baseUrl 的路径与 query**；
// - byok.secret.enc：AES-256-GCM（at-rest encodePayload，AAD=`byok:v1:<uid>`），明文为 {apiKey, baseUrl}；
// - 无 atRestKey（明文模式）时 secret 降级为 byok.secret.json（0600，同样只写不读）。
//
// 红线：只有 chat 上游（streamByokUpstream 调用方）可在内存中解密 apiKey；任何 HTTP 响应、日志、
// 审计都不得含明文 key 或 baseUrl 路径；所有对外错误先做密钥形态脱敏（redactSecrets）。
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { decodePayload, encodePayload } from './at-rest.mjs';
import {
  BYOK_PRESETS,
  ByokError,
  MODEL_PATTERN,
  buildHeaders,
  listModelsUrl,
  parseModels,
  resolveProvider,
} from './byok-providers.mjs';
// 地址级 SSRF 判定与 pinned 传输统一由 pinned-http.mjs 提供（单一事实来源）。
import { createPinnedTransport, isAllowedAddress, isForbiddenHostname } from './pinned-http.mjs';

export const BYOK_META_FILE_NAME = 'byok.json';
export const BYOK_SECRET_ENC_FILE_NAME = 'byok.secret.enc';
export const BYOK_SECRET_PLAIN_FILE_NAME = 'byok.secret.json';
export const BYOK_VERSION = 1;
/** 加密 AAD 前缀（绑定 userId，密文拷到别的用户目录解不开）。 */
export const BYOK_SECRET_AAD_PREFIX = 'byok:v1:';
/** 探活限流窗口（契约 4：每用户 3 次/分）。 */
export const BYOK_CHECK_WINDOW_MS = 60_000;
/** 探活请求超时（契约 4：5s）。 */
export const BYOK_PROBE_TIMEOUT_MS = 5_000;
/** 探活失败时回传的上游响应片段上限（先脱敏再记录/回传）。 */
const MAX_UPSTREAM_DETAIL_CHARS = 300;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOG_PREFIX = '[byok]';

const BYOK_ERROR_STATUS = Object.freeze({
  INVALID_INPUT: 400,
  INVALID_PROVIDER: 400,
  INVALID_MODEL: 400,
  BYOK_URL_INVALID: 400,
  BYOK_KEY_INVALID: 400,
  BYOK_NOT_CONFIGURED: 400,
  BYOK_DISABLED: 403,
  BYOK_CHECK_DISABLED: 403,
  BYOK_CHECK_RATE_LIMITED: 429,
  BYOK_ENDPOINT_INVALID: 400,
  BYOK_TIMEOUT: 400,
  BYOK_CHECK_FAILED: 400,
  BYOK_MODEL_NOT_ALLOWED: 400,
  BYOK_HOST_NOT_ALLOWED: 400,
  INTERNAL: 500,
});

function warn(logger, message) {
  try {
    logger?.warn?.(`${LOG_PREFIX} ${message}`);
  } catch {
    /* logger 自身失败不影响主流程 */
  }
}

/**
 * 密钥形态脱敏（契约 6：任何 message 不得出现明文 key）。
 * 覆盖 `test-key-…`、`Bearer …`、`x-api-key: …` 以及显式传入的 key 原文。
 */
export function redactSecrets(text, explicitSecret = null) {
  let value = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (typeof explicitSecret === 'string' && explicitSecret.length > 0) {
    value = value.split(explicitSecret).join('***');
  }
  value = value.replace(/test-key-[A-Za-z0-9_.-]{6,}/g, 'test-key-***');
  value = value.replace(/(Bearer\s+)[^\s"'`,;]+/gi, '$1***');
  value = value.replace(/(["']?x-api-key["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1***');
  return value;
}

function toMillis(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function isoOf(millis) {
  return new Date(millis).toISOString();
}

function byokError(code, message, status = BYOK_ERROR_STATUS[code] ?? 400) {
  return new ByokError(code, message, { status });
}

/* ------------------------------ BYOK allowlist（契约 5 / ） ------------------------------ */

/** 读取 CSV/数组形式的 allowlist 配置（空数组 = 不限制）。 */
function allowedListOf(config, key) {
  const value = config && typeof config === 'object' ? config[key] : null;
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * 校验模型是否在管理员 allowlist 内（BYOK_ALLOWED_MODELS CSV，空 = 不限制）。
 * 精确匹配（大小写敏感）；失败抛 ByokError('BYOK_MODEL_NOT_ALLOWED')。
 * @param {{config?: object, model?: string}} opts
 */
export function assertAllowedModel({ config = {}, model = '' } = {}) {
  const list = allowedListOf(config, 'byokAllowedModels');
  if (list.length === 0) return;
  const value = typeof model === 'string' ? model.trim() : '';
  if (!list.includes(value)) {
    throw byokError('BYOK_MODEL_NOT_ALLOWED', '该模型不在管理员允许的自定义模型列表内');
  }
}

/**
 * 校验 baseUrl 主机是否在管理员 allowlist 内（BYOK_ALLOWED_HOSTS CSV，空 = 不限制）。
 * 主机名比较不区分大小写；失败抛 ByokError('BYOK_HOST_NOT_ALLOWED')。
 * @param {{config?: object, host?: string}} opts
 */
export function assertAllowedHost({ config = {}, host = '' } = {}) {
  const list = allowedListOf(config, 'byokAllowedHosts').map((item) => item.toLowerCase());
  if (list.length === 0) return;
  const value = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (!list.includes(value)) {
    throw byokError('BYOK_HOST_NOT_ALLOWED', '该厂商主机不在管理员允许的自定义模型主机列表内');
  }
}

/**
 * 校验用户填写的 baseUrl（契约 5）。
 * @param {string} raw
 * @param {{allowLoopback?: boolean, dnsLookup?: Function, maxChars?: number}} [options]
 * @returns {Promise<{baseUrl:string, origin:string, protocol:string}>}
 */
async function validateBaseUrlImpl(raw, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 512;
  const allowLoopback = options.allowLoopback === true;
  const dnsLookup = typeof options.dnsLookup === 'function' ? options.dnsLookup : dns.promises.lookup;

  if (typeof raw !== 'string') throw byokError('BYOK_URL_INVALID', 'baseUrl 必须是字符串');
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw byokError('BYOK_URL_INVALID', 'baseUrl 不能为空');
  if (trimmed.length > maxChars) {
    throw byokError('BYOK_URL_INVALID', `baseUrl 长度不能超过 ${maxChars} 字符`);
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw byokError('BYOK_URL_INVALID', 'baseUrl 不是合法 URL');
  }

  if (url.username !== '' || url.password !== '') {
    throw byokError('BYOK_URL_INVALID', 'baseUrl 不允许携带用户名或密码');
  }
  if (url.search !== '' || url.hash !== '') {
    throw byokError('BYOK_URL_INVALID', 'baseUrl 不允许携带 query 或 fragment');
  }

  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (hostname === '') throw byokError('BYOK_URL_INVALID', 'baseUrl 缺少主机名');

  // 测试/测试例外：仅 http + 精确回环主机（127.0.0.1 / localhost）且必须带端口。
  const loopbackException =
    allowLoopback && url.protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost') && url.port !== '';

  if (url.protocol !== 'https:' && !loopbackException) {
    throw byokError('BYOK_URL_INVALID', 'baseUrl 必须使用 https（本地测试允许 http 回环地址）');
  }
  if (url.port !== '' && url.port !== '443' && !loopbackException) {
    throw byokError('BYOK_URL_INVALID', 'baseUrl 端口必须为空或 443');
  }

  if (!loopbackException) {
    if (isForbiddenHostname(hostname)) {
      throw byokError('BYOK_URL_INVALID', 'baseUrl 不允许指向本机、内网或云元数据地址');
    }
    if (net.isIP(hostname)) {
      if (!isAllowedAddress(hostname)) {
        throw byokError('BYOK_URL_INVALID', 'baseUrl 不允许指向内网、回环或链路本地地址');
      }
    } else {
      let addresses;
      try {
        addresses = await dnsLookup(hostname, { all: true });
      } catch {
        throw byokError('BYOK_URL_INVALID', 'baseUrl 域名解析失败');
      }
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) throw byokError('BYOK_URL_INVALID', 'baseUrl 域名解析失败');
      for (const item of list) {
        const address = typeof item === 'string' ? item : item?.address;
        if (!isAllowedAddress(address)) {
          throw byokError('BYOK_URL_INVALID', 'baseUrl 域名解析到内网、回环或链路本地地址');
        }
      }
    }
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  return {
    baseUrl: `${url.origin}${pathname}`,
    origin: url.origin,
    protocol: url.protocol,
  };
}

/* ------------------------------ 服务工厂 ------------------------------ */

/**
 * @param {{
 *   baseDataDir: string,
 *   atRestKey?: Buffer|null,
 *   config?: object,
 *   logger?: object,
 *   fetchImpl?: typeof fetch,
 *   transport?: {request: Function, readText: Function},
 *   now?: () => Date,
 *   dnsLookup?: Function,
 * }} opts
 */
export function createByokService({
  baseDataDir,
  atRestKey = null,
  config = {},
  logger = console,
  fetchImpl = globalThis.fetch,
  transport = null,
  now = () => new Date(),
  dnsLookup = dns.promises.lookup,
} = {}) {
  // fetchImpl 仅为兼容旧调用签名保留；BYOK 出站已统一走 pinned 传输
  // （DNS 钉扎 + 逐地址校验 + 不跟随重定向），不再使用 fetch。
  void fetchImpl;
  if (typeof baseDataDir !== 'string' || baseDataDir.trim() === '') {
    throw new Error('createByokService 需要 baseDataDir');
  }
  const rootDir = path.resolve(baseDataDir);
  const allowLoopback = config.byokAllowLoopback === true;
  const checkPerMinute =
    Number.isInteger(config.byokCheckPerMinute) && config.byokCheckPerMinute > 0 ? config.byokCheckPerMinute : 3;
  const maxKeyChars =
    Number.isInteger(config.byokMaxKeyChars) && config.byokMaxKeyChars > 0 ? config.byokMaxKeyChars : 512;
  const maxModelChars =
    Number.isInteger(config.byokMaxModelChars) && config.byokMaxModelChars > 0 ? config.byokMaxModelChars : 128;
  const maxBaseUrlChars =
    Number.isInteger(config.byokMaxBaseUrlChars) && config.byokMaxBaseUrlChars > 0 ? config.byokMaxBaseUrlChars : 512;

  // 出站传输（测试可注入同形 transport；生产默认 pinned + 逐次 DNS 校验）。
  const outboundTransport =
    transport && typeof transport.request === 'function' && typeof transport.readText === 'function'
      ? transport
      : createPinnedTransport({ allowLoopback, dnsLookup });

  /** 每用户写串行队列（set/remove 不并发写同一目录）。 */
  const writeChains = new Map();
  /** 探活滑动窗口：userId → 最近窗口内的调用时间戳。 */
  const checkTimes = new Map();

  function userDirOf(userId) {
    if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
      throw byokError('INVALID_INPUT', '用户 id 不合法');
    }
    return path.join(rootDir, 'users', userId);
  }

  function filePaths(userId) {
    const dir = userDirOf(userId);
    return {
      dir,
      meta: path.join(dir, BYOK_META_FILE_NAME),
      secretEnc: path.join(dir, BYOK_SECRET_ENC_FILE_NAME),
      secretPlain: path.join(dir, BYOK_SECRET_PLAIN_FILE_NAME),
    };
  }

  async function removeFile(filePath) {
    try {
      await fs.promises.access(filePath);
    } catch {
      return false;
    }
    try {
      await fs.promises.rm(filePath, { force: true });
      return true;
    } catch (error) {
      warn(logger, `删除 ${path.basename(filePath)} 失败：${error?.message ?? error}`);
      return false;
    }
  }

  async function readJsonFile(filePath) {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      warn(logger, `读取 ${path.basename(filePath)} 失败：${error?.message ?? error}`);
      return null;
    }
    try {
      const data = JSON.parse(raw.toString('utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (error) {
      warn(logger, `${path.basename(filePath)} 解析失败：${error?.message ?? error}`);
      return null;
    }
  }

  async function writeFileAtomic(filePath, content, mode = 0o600) {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.chmod(dir, 0o700);
    } catch {
      /* 非 POSIX 或权限不足时忽略 */
    }
    const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    await fs.promises.writeFile(tmpPath, content, { mode });
    try {
      await fs.promises.chmod(tmpPath, mode);
    } catch {
      /* 忽略 */
    }
    await fs.promises.rename(tmpPath, filePath);
    try {
      await fs.promises.chmod(filePath, mode);
    } catch {
      /* 忽略 */
    }
  }

  /** 同用户串行执行写操作；前一个失败不阻断后一个。 */
  function enqueueWrite(userId, task) {
    const previous = writeChains.get(userId) ?? Promise.resolve();
    const next = previous.then(task, task);
    writeChains.set(
      userId,
      next.catch(() => {}),
    );
    return next;
  }

  function emptyMeta() {
    return {
      configured: false,
      provider: null,
      model: null,
      keyHint: null,
      baseUrlOrigin: null,
      createdAt: null,
      updatedAt: null,
    };
  }

  /** 对外只读元数据（契约 4 GET 形状；不含 key / baseUrl 路径）。 */
  async function getMeta(userId) {
    userDirOf(userId);
    const stored = await readJsonFile(filePaths(userId).meta);
    if (!stored || (stored.version !== undefined && stored.version !== BYOK_VERSION)) return emptyMeta();
    const providerId = typeof stored.provider === 'string' ? stored.provider : null;
    if (!providerId) return emptyMeta();
    const preset = BYOK_PRESETS.find((item) => item.id === providerId) ?? null;
    return {
      configured: true,
      provider: {
        id: providerId,
        label: preset?.label ?? providerId,
        protocol: typeof stored.protocol === 'string' ? stored.protocol : (preset?.protocol ?? 'openai'),
      },
      model: typeof stored.model === 'string' ? stored.model : null,
      keyHint: typeof stored.keyHint === 'string' ? stored.keyHint : null,
      baseUrlOrigin: typeof stored.baseUrlOrigin === 'string' ? stored.baseUrlOrigin : null,
      createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : null,
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    };
  }

  /**
   * 保存配置（校验 + 加密落盘）。返回与 getMeta 相同的只读视图。
   * @param {string} userId
   * @param {{provider:string, model:string, apiKey:string, baseUrl?:string}} input
   */
  async function set(userId, input = {}) {
    userDirOf(userId);
    const { provider, model, apiKey, baseUrl } = input ?? {};
    if (typeof provider !== 'string' || provider.trim() === '') {
      throw byokError('INVALID_INPUT', 'provider 必填');
    }
    if (typeof model !== 'string' || model.trim() === '') {
      throw byokError('INVALID_MODEL', 'model 必填');
    }
    const resolvedModel = model.trim();
    if (resolvedModel.length > maxModelChars || !MODEL_PATTERN.test(resolvedModel)) {
      throw byokError('INVALID_MODEL', `模型名不合法（1–${maxModelChars} 位字母/数字/._:/-）`);
    }
    // 先做 allowlist 校验（纯配置判断），再做出站 SSRF/DNS 校验 ——
    // 否则被禁域名会先触发 DNS 校验错误（BYOK_URL_INVALID），错误码不稳定且无谓出站解析。
    assertAllowedModel({ config, model: resolvedModel });
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw byokError('BYOK_KEY_INVALID', 'API key 必填');
    }
    const resolvedKey = apiKey.trim();
    if (resolvedKey.length < 8 || resolvedKey.length > maxKeyChars) {
      throw byokError('BYOK_KEY_INVALID', `API key 长度必须在 8–${maxKeyChars} 字符之间`);
    }
    if (/\s/.test(resolvedKey)) {
      throw byokError('BYOK_KEY_INVALID', 'API key 不能包含空白字符');
    }

    let preset;
    try {
      preset = resolveProvider({ provider: provider.trim(), baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined });
    } catch (error) {
      if (error instanceof ByokError) throw error;
      throw byokError('INVALID_PROVIDER', '未知厂商预设');
    }
    if (!preset || typeof preset !== 'object') throw byokError('INVALID_PROVIDER', '未知厂商预设');

    let storedBaseUrl = typeof preset.baseUrl === 'string' ? preset.baseUrl : null;
    let baseUrlOrigin = storedBaseUrl ? new URL(storedBaseUrl).origin : null;
    if (preset.requiresBaseUrl === true || preset.baseUrl == null) {
      if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
        throw byokError('BYOK_URL_INVALID', '自定义厂商必须提供 HTTPS baseUrl');
      }
      // allowlist host 先于 SSRF/DNS 求值（见上方注释）；URL 无法解析时仍交给 validateBaseUrlImpl 报 BYOK_URL_INVALID。
      try {
        assertAllowedHost({ config, host: new URL(baseUrl.trim()).hostname });
      } catch (error) {
        if (error instanceof ByokError) throw error;
      }
      const validated = await validateBaseUrlImpl(baseUrl.trim(), {
        allowLoopback,
        dnsLookup,
        maxChars: maxBaseUrlChars,
      });
      storedBaseUrl = validated.baseUrl;
      baseUrlOrigin = validated.origin;
    }
    if (!storedBaseUrl) throw byokError('BYOK_URL_INVALID', 'baseUrl 缺失');

    // 管理员 allowlist（空 = 不限制）。PUT 保存前校验，避免落盘后才失败。
    assertAllowedModel({ config, model: resolvedModel });
    assertAllowedHost({ config, host: new URL(storedBaseUrl).hostname });

    const atMillis = toMillis(now);
    const at = isoOf(atMillis);
    const keyHint = `test-key-…${resolvedKey.slice(-4)}`;

    await enqueueWrite(userId, async () => {
      const target = filePaths(userId);
      const previous = await readJsonFile(target.meta);
      const meta = {
        version: BYOK_VERSION,
        provider: preset.id,
        protocol: preset.protocol ?? 'openai',
        model: resolvedModel,
        baseUrlOrigin,
        keyHint,
        createdAt: typeof previous?.createdAt === 'string' ? previous.createdAt : at,
        updatedAt: at,
      };
      const secretJson = JSON.stringify({ apiKey: resolvedKey, baseUrl: storedBaseUrl });
      await fs.promises.mkdir(target.dir, { recursive: true, mode: 0o700 });
      if (atRestKey) {
        const encrypted = encodePayload(atRestKey, `${BYOK_SECRET_AAD_PREFIX}${userId}`, secretJson);
        await writeFileAtomic(target.secretEnc, encrypted);
        await removeFile(target.secretPlain);
      } else {
        await writeFileAtomic(target.secretPlain, secretJson);
        await removeFile(target.secretEnc);
      }
      // 元数据最后写：文件存在即代表「已配置」，避免半写状态被 GET 误判。
      await writeFileAtomic(target.meta, `${JSON.stringify(meta, null, 2)}\n`);
    });
    return getMeta(userId);
  }

  /** 删除配置（幂等）。 */
  async function remove(userId) {
    userDirOf(userId);
    return enqueueWrite(userId, async () => {
      const target = filePaths(userId);
      const results = await Promise.all([
        removeFile(target.meta),
        removeFile(target.secretEnc),
        removeFile(target.secretPlain),
      ]);
      return { removed: results.some(Boolean) };
    });
  }

  /**
   * 供 chat 上游在内存中解密使用（契约 2：只有 chat 上游可调用）。
   * 任何失败（不存在/解密失败/结构不合法）返回 null，并降级为官方模型。
   * @returns {Promise<null|{provider:string, protocol:string, model:string, baseUrl:string, apiKey:string, keyHint:string|null}>}
   */
  async function getSecret(userId) {
    let target;
    try {
      target = filePaths(userId);
    } catch {
      return null;
    }
    const meta = await readJsonFile(target.meta);
    if (!meta || typeof meta.provider !== 'string') return null;

    let raw;
    try {
      raw = await fs.promises.readFile(atRestKey ? target.secretEnc : target.secretPlain);
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(logger, `读取自定义模型密钥失败：${error?.message ?? error}`);
      return null;
    }

    let plain;
    try {
      plain = atRestKey ? decodePayload(atRestKey, `${BYOK_SECRET_AAD_PREFIX}${userId}`, raw) : raw;
    } catch (error) {
      warn(logger, `解密自定义模型密钥失败（按官方模型处理）：${redactSecrets(error?.message ?? String(error))}`);
      return null;
    }

    let data;
    try {
      data = JSON.parse(plain.toString('utf8'));
    } catch {
      warn(logger, '自定义模型密钥文件解析失败（按官方模型处理）');
      return null;
    }
    if (!data || typeof data !== 'object' || typeof data.apiKey !== 'string' || data.apiKey === '') return null;
    if (typeof data.baseUrl !== 'string' || data.baseUrl === '') return null;

    return {
      provider: meta.provider,
      protocol: meta.protocol === 'anthropic' ? 'anthropic' : 'openai',
      model: typeof meta.model === 'string' ? meta.model : '',
      baseUrl: data.baseUrl,
      apiKey: data.apiKey,
      keyHint: typeof meta.keyHint === 'string' ? meta.keyHint : null,
    };
  }

  /**
   * 探活（契约 4）：GET models 端点，5s 超时，3 次/分/用户；错误归一化后返回，不抛上游原文。
   * @returns {Promise<{ok:boolean,latencyMs:number,modelCount:number,errorCode?:string}>}
   */
  async function check(userId) {
    userDirOf(userId);
    const secret = await getSecret(userId);
    if (!secret) throw byokError('BYOK_NOT_CONFIGURED', '尚未配置自定义模型');

    // 管理员 allowlist（空 = 不限制）。管理员可能在保存后收紧名单，
    // 探活前同样复核；被拒属于配置错误（400），不占探活限流窗口、不发起连接。
    let storedHost = '';
    try {
      storedHost = new URL(secret.baseUrl).hostname;
    } catch {
      storedHost = '';
    }
    assertAllowedModel({ config, model: secret.model });
    assertAllowedHost({ config, host: storedHost });

    // 只有真正发起探活才计数（未配置 / allowlist 拒绝的无效请求不占配额）。
    const atMillis = toMillis(now);
    const recent = (checkTimes.get(userId) ?? []).filter((time) => atMillis - time < BYOK_CHECK_WINDOW_MS);
    if (recent.length >= checkPerMinute) {
      checkTimes.set(userId, recent);
      throw byokError('BYOK_CHECK_RATE_LIMITED', '测试连接过于频繁，请稍后再试');
    }
    recent.push(atMillis);
    checkTimes.set(userId, recent);

    // 每次探活出站前重校验端点（URL 形状 + 静态主机规则 + DNS 全部地址）；
    // 失败直接返回归一化错误码，不发起请求、不把上游原文透出。
    try {
      await assertRequestUrl(secret.baseUrl);
    } catch {
      return { ok: false, latencyMs: 0, modelCount: 0, errorCode: 'BYOK_ENDPOINT_INVALID' };
    }

    let url;
    try {
      url = listModelsUrl(secret.protocol, secret.baseUrl);
    } catch {
      return { ok: false, latencyMs: 0, modelCount: 0, errorCode: 'BYOK_CHECK_FAILED' };
    }
    const headers = { ...buildHeaders(secret.protocol, secret.apiKey), accept: 'application/json' };
    const startedAt = Date.now();
    let response;
    try {
      // 探活走 pinned 传输（一次解析 → 逐地址校验 → 只连已校验 IP；不跟随重定向）。
      response = await outboundTransport.readText({
        url,
        method: 'GET',
        headers,
        timeoutMs: BYOK_PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const errorCode =
        error?.code === 'BYOK_ENDPOINT_INVALID'
          ? 'BYOK_ENDPOINT_INVALID'
          : error?.code === 'BYOK_TIMEOUT' || error?.name === 'TimeoutError' || error?.name === 'AbortError'
            ? 'BYOK_TIMEOUT'
            : 'BYOK_CHECK_FAILED';
      warn(
        logger,
        `探活失败（${secret.provider}，${errorCode}）：${redactSecrets(error?.message ?? String(error), secret.apiKey)}`,
      );
      return { ok: false, latencyMs, modelCount: 0, errorCode };
    }
    const latencyMs = Date.now() - startedAt;

    if (!response || typeof response.statusCode !== 'number') {
      return { ok: false, latencyMs, modelCount: 0, errorCode: 'BYOK_CHECK_FAILED' };
    }
    const status = response.statusCode;
    if (status === 401 || status === 403) {
      return { ok: false, latencyMs, modelCount: 0, errorCode: 'BYOK_KEY_INVALID' };
    }
    if (status === 404) {
      return { ok: false, latencyMs, modelCount: 0, errorCode: 'BYOK_ENDPOINT_INVALID' };
    }
    if (status >= 300 && status < 400) {
      return { ok: false, latencyMs, modelCount: 0, errorCode: 'BYOK_CHECK_FAILED' };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, latencyMs, modelCount: 0, errorCode: 'BYOK_CHECK_FAILED' };
    }

    const json = typeof response.json === 'function' ? response.json() : null;
    const models = parseModels(secret.protocol, json);
    const modelCount = Array.isArray(models) ? models.length : 0;
    if (modelCount === 0) {
      return { ok: false, latencyMs, modelCount: 0, errorCode: 'BYOK_CHECK_FAILED' };
    }
    return { ok: true, latencyMs, modelCount };
  }

  /** PUT / check 复用的 baseUrl 校验（契约 5）。 */
  async function validateBaseUrl(raw, options = {}) {
    return validateBaseUrlImpl(raw, {
      allowLoopback,
      dnsLookup,
      maxChars: maxBaseUrlChars,
      ...options,
    });
  }

  /**
   * 出站前重校验 baseUrl（check / 对话 upstream / 记忆抽取三路径共用）。
   * 与 PUT 同一套完整校验：URL 形状 + 静态主机规则 + dnsLookup(host,{all:true}) 逐地址校验；
   * 失败统一抛 ByokError('BYOK_ENDPOINT_INVALID')，不泄露内部细节。
   * @param {string} rawBaseUrl
   * @returns {Promise<string>} 规范化 baseUrl
   */
  async function assertRequestUrl(rawBaseUrl) {
    try {
      const result = await validateBaseUrl(rawBaseUrl);
      return result.baseUrl;
    } catch (error) {
      if (error instanceof ByokError && error.code === 'BYOK_ENDPOINT_INVALID') throw error;
      throw byokError('BYOK_ENDPOINT_INVALID', '自定义模型端点解析到受限地址（已拒绝）');
    }
  }

  return {
    getMeta,
    set,
    remove,
    getSecret,
    check,
    validateBaseUrl,
    assertRequestUrl,
    // 对话 / 记忆抽取复用同一 pinned 传输（每次出站仍重新解析并逐地址校验）。
    transport: outboundTransport,
  };
}

/**
 *  / 契约 6：解析本轮对话应使用的模型来源。
 * 全部条件满足才返回 BYOK；否则 {kind:'official'}（官方路径行为逐字节不变）。
 * @param {object} ctx 请求作用域 ctx（AUTH=on 时含 userId/user；scoped ctx 继承 base ctx 的 byok/getByokEnabled）
 * @returns {Promise<{kind:'official'}|{kind:'byok',provider:string,protocol:string,model:string,baseUrl:string,apiKey:string,keyHint:string|null}>}
 */
export async function resolveChatModelSource(ctx) {
  const official = { kind: 'official' };
  try {
    if (!ctx || ctx.authMode !== 'on' || !ctx.userId) return official;
    if (ctx.user?.modelSource !== 'byok') return official;
    if (!ctx.byok || typeof ctx.byok.getSecret !== 'function') return official;
    const enabled =
      typeof ctx.getByokEnabled === 'function' ? await ctx.getByokEnabled() : ctx.config?.byokEnabled !== false;
    if (enabled !== true) return official;
    const secret = await ctx.byok.getSecret(ctx.userId);
    if (!secret || !secret.apiKey || !secret.model || !secret.baseUrl) return official;
    return { kind: 'byok', ...secret };
  } catch (error) {
    warn(ctx?.logger, `解析自定义模型配置失败（按官方模型处理）：${redactSecrets(error?.message ?? String(error))}`);
    return official;
  }
}
