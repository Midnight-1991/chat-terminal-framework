// 带 DNS 钉扎（DNS pinning）的出站 HTTP(S) 传输层。
//
// 背景：BYOK 的 baseUrl 完全由用户填写，普通 fetch 在「校验地址」与「真正连接」之间存在
// TOCTOU 窗口（DNS rebinding：校验时解析到公网 IP，连接时重新解析到内网 IP）。
//
// 安全模型：
// 1) 每次出站都重新解析域名并逐地址校验（不缓存解析结论），因此写入后再 rebinding 也会被拒；
// 2) 通过 node:https.request 的 `lookup` 选项把「主机名解析」替换为「已校验 IP 的选择」，
//    连接层只可能连到本函数返回的、通过 validator 的地址；
// 3) TLS 的 SNI / 证书校验（servername）与 Host 头仍保持原始 host，TLS 语义不变；
// 4) 不跟随重定向（3xx 原样返回，由调用方按错误处理）；超时/中止 destroy 连接并抛
//    ByokError('BYOK_TIMEOUT') / AbortError。
//
// 本模块同时承载 IP 字面量/解析地址的「是否允许出站」判定（从 server/byok.mjs 迁出，
// 单一事实来源）；byok.mjs 负责 URL 形状与静态主机规则，两者共同构成 SSRF 防线。
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

import { ByokError } from './byok-providers.mjs';

/** 默认出站超时：与 BYOK 上游 120s 一致；探活/记忆抽取由调用方传更小值。 */
export const PINNED_DEFAULT_TIMEOUT_MS = 120_000;

/* ------------------------------ 地址校验（契约 5：复用既有 parse 规则） ------------------------------ */

/** 回环/私网/链路本地/云元数据/保留网段（IPv4）。 */
export function isForbiddenIPv4(octets) {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
  if (a >= 224) return true; // 组播/保留
  return false;
}

export function parseIPv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/**
 * 解析 IPv6 字面量为 16 字节（支持 `::` 压缩与内嵌 IPv4 的 dotted/hex 双字形式）。
 * WHATWG URL 会把 `[::ffff:127.0.0.1]` 规范化为 `[::ffff:7f00:1]`，因此不能只匹配 dotted 形式。
 * @returns {number[]|null} 失败返回 null（调用侧保守拒绝）。
 */
export function parseIPv6Bytes(host) {
  let value = String(host).toLowerCase();
  if (value.includes('%')) return null; // zone id 不属于合法 API 主机名，保守拒绝
  let tailOctets = null;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon === -1) return null;
    tailOctets = parseIPv4(value.slice(lastColon + 1));
    if (!tailOctets) return null;
    value = value.slice(0, lastColon);
  }
  const parts = value.split('::');
  if (parts.length > 2) return null;
  const parseGroups = (segment) => {
    if (segment === '') return [];
    const groups = [];
    for (const item of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      groups.push(Number.parseInt(item, 16));
    }
    return groups;
  };
  const head = parseGroups(parts[0]);
  const tail = parts.length === 2 ? parseGroups(parts[1]) : null;
  if (!head) return null;
  if (parts.length === 2 && !tail) return null;
  const wordsFromIpv4 = tailOctets ? 2 : 0;
  const total = head.length + (tail ? tail.length : 0) + wordsFromIpv4;
  let groups;
  if (parts.length === 1) {
    if (total !== 8) return null;
    groups = head;
  } else {
    // '::' 至少压缩一组零。
    if (total > 7) return null;
    groups = [...head, ...new Array(8 - total).fill(0), ...(tail ?? [])];
  }
  if (tailOctets) {
    groups.push((tailOctets[0] << 8) | tailOctets[1], (tailOctets[2] << 8) | tailOctets[3]);
  }
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

export function isForbiddenIPv6(host) {
  const bytes = parseIPv6Bytes(host);
  if (!bytes) return true; // 无法解析的异常形式保守拒绝
  const zeroRange = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);

  if (zeroRange(0, 16)) return true; // ::
  if (zeroRange(0, 15) && bytes[15] === 1) return true; // ::1
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 链路本地
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 唯一本地
  if (bytes[0] === 0xff) return true; // ff00::/8 组播

  // IPv4 映射地址 ::ffff:a.b.c.d（dotted 与 hex 双字形式统一按内嵌 IPv4 判定）。
  if (zeroRange(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isForbiddenIPv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }
  // IPv4 兼容地址（已废弃）::a.b.c.d：::/96 除 :: 与 ::1 外按内嵌 IPv4 判定。
  if (zeroRange(0, 12)) {
    return isForbiddenIPv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }
  // NAT64 64:ff9b::/96 按内嵌 IPv4 判定；64:ff9b:1::/48（本地使用）保守拒绝。
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (bytes[4] === 0x00 && bytes[5] === 0x01) return true;
    if (zeroRange(4, 12)) {
      return isForbiddenIPv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
    }
  }
  // 6to4 2002::/16 内嵌 IPv4 判定（防经 6to4 中转访问内网）。
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isForbiddenIPv4([bytes[2], bytes[3], bytes[4], bytes[5]]);
  }
  // Teredo 2001:0::/32：地址含混淆 IPv4，保守拒绝。
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  return false;
}

export function isForbiddenHostname(hostname) {
  const value = hostname.toLowerCase().replace(/\.$/, '');
  if (value === '') return true;
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (value.endsWith('.internal') || value.endsWith('.local')) return true;
  // 云厂商元数据主机名（metadata.google.internal 已被 .internal 覆盖，这里再留常见别名）
  if (value === 'metadata' || value === 'metadata.google.internal') return true;
  return false;
}

/** 单个解析结果（IP 字面量或 DNS 解析地址）是否允许。 */
export function isAllowedAddress(address) {
  const value = typeof address === 'string' ? address.trim() : '';
  if (value === '') return false;
  const family = net.isIP(value);
  if (family === 4) {
    const octets = parseIPv4(value);
    return octets ? !isForbiddenIPv4(octets) : false;
  }
  if (family === 6) return !isForbiddenIPv6(value);
  return false;
}

/** 回环地址判定（仅供 BYOK_ALLOW_LOOPBACK=on 的测试/本机开发例外使用）。 */
export function isLoopbackAddress(address) {
  const value = typeof address === 'string' ? address.trim() : '';
  const family = net.isIP(value);
  if (family === 4) return value.startsWith('127.');
  if (family === 6) {
    const bytes = parseIPv6Bytes(value);
    if (!bytes) return false;
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1
    if (
      bytes.slice(0, 10).every((byte) => byte === 0) &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff &&
      bytes[12] === 127
    ) {
      return true; // ::ffff:127.0.0.0/8
    }
    return false;
  }
  return false;
}

function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').toLowerCase();
  return value === 'localhost' || value.endsWith('.localhost');
}

/**
 * 构造地址级校验器。
 * - 默认 = isAllowedAddress（拒绝回环/私网/链路本地/云元数据）；
 * - allowLoopback=true 时额外放行回环地址（仅 BYOK_ALLOW_LOOPBACK=on 的测试/本机开发场景，
 *   用于连接 127.0.0.1 上的假上游；私网/元数据仍拒绝）。
 */
export function createAddressValidator({ allowLoopback = false } = {}) {
  if (allowLoopback !== true) return isAllowedAddress;
  return function allowLoopbackAddress(address) {
    return isLoopbackAddress(address) || isAllowedAddress(address);
  };
}

function endpointInvalidError() {
  return new ByokError('BYOK_ENDPOINT_INVALID', '自定义模型端点解析到受限地址（已拒绝）', { status: 400 });
}

function invalidUrlError() {
  return new ByokError('BYOK_URL_INVALID', '自定义模型端点不是合法 URL', { status: 400 });
}

function timeoutError(timeoutMs) {
  return new ByokError('BYOK_TIMEOUT', `自定义模型请求超时（>${timeoutMs}ms）`, { status: 400 });
}

function abortError() {
  const error = new Error('请求已中止');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/* ------------------------------ DNS 钉扎 lookup ------------------------------ */

/**
 * 构造给 node:http(s).request 使用的 `lookup`：一次解析（all）→ 逐地址 validator →
 * 取第一个合法地址连接；全部非法抛 ByokError('BYOK_ENDPOINT_INVALID')，不发起连接。
 * 同时兼容 Node 的 happy-eyeballs（autoSelectFamily）用到的 options.all=true 形式。
 * @param {{validator?: (address: string) => boolean, dnsLookup?: Function}} [opts]
 * @returns {(hostname: string, options: object, callback: Function) => void}
 */
export function createPinnedLookup({ validator = isAllowedAddress, dnsLookup = dns.promises.lookup } = {}) {
  const validate = typeof validator === 'function' ? validator : isAllowedAddress;
  const resolve = typeof dnsLookup === 'function' ? dnsLookup : dns.promises.lookup;

  return function pinnedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' || options == null ? {} : options;
    const wantAll = opts.all === true;
    const done = (error, result, family) => {
      try {
        cb(error, result, family);
      } catch {
        /* 调用方回调异常不影响解析流程 */
      }
    };
    if (typeof cb !== 'function') return;

    const host = String(hostname ?? '')
      .replace(/^\[/, '')
      .replace(/\]$/, '');
    // IP 字面量不会经过 DNS：按同一 validator 校验后直接返回（防 lookup 被绕过）。
    const literalFamily = net.isIP(host);
    if (literalFamily !== 0) {
      if (!validate(host)) {
        done(endpointInvalidError());
        return;
      }
      if (wantAll) done(null, [{ address: host, family: literalFamily }]);
      else done(null, host, literalFamily);
      return;
    }

    let pending;
    try {
      pending = resolve(host, { all: true });
    } catch (error) {
      done(error);
      return;
    }
    Promise.resolve(pending).then(
      (results) => {
        const list = (Array.isArray(results) ? results : [])
          .map((item) => (typeof item === 'string' ? { address: item } : item))
          .filter((item) => item && typeof item.address === 'string')
          .map((item) => {
            const address = item.address.trim();
            const family = Number.isInteger(item.family) && item.family > 0 ? item.family : net.isIP(address);
            return { address, family };
          })
          .filter((item) => item.family !== 0);
        const allowed = list.filter((item) => validate(item.address));
        if (allowed.length === 0) {
          done(endpointInvalidError());
          return;
        }
        if (wantAll) done(null, allowed);
        else done(null, allowed[0].address, allowed[0].family);
      },
      (error) => done(error),
    );
  };
}

/* ------------------------------ 传输层 ------------------------------ */

function hasHeader(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

/**
 * 创建 pinned 传输器。`request` 返回 {statusCode, headers, stream}；`readText` 额外读完正文。
 * @param {{validator?: Function, dnsLookup?: Function, allowLoopback?: boolean}} [opts]
 */
export function createPinnedTransport({ validator, dnsLookup, allowLoopback = false } = {}) {
  const allowLoopbackEnabled = allowLoopback === true;
  const validate =
    allowLoopbackEnabled
      ? createAddressValidator({ allowLoopback: true })
      : typeof validator === 'function'
        ? validator
        : isAllowedAddress;
  const lookup = createPinnedLookup({ validator: validate, dnsLookup });

  function buildOptions({ url, method = 'GET', headers = {}, body = null } = {}) {
    let target;
    try {
      target = new URL(String(url));
    } catch {
      throw invalidUrlError();
    }
    const host = target.hostname.replace(/^\[/, '').replace(/\]$/, '');
    const isHttps = target.protocol === 'https:';
    const loopbackHttp =
      allowLoopbackEnabled && target.protocol === 'http:' && (isLoopbackHostname(host) || isLoopbackAddress(host));
    if (!isHttps && !loopbackHttp) {
      throw new ByokError('BYOK_URL_INVALID', '自定义模型端点必须使用 https（本地测试例外仅限回环地址）', {
        status: 400,
      });
    }
    // IP 字面量不经过 lookup：这里先按同一 validator 校验，避免绕过钉扎校验。
    if (net.isIP(host) !== 0 && !validate(host)) throw endpointInvalidError();

    const outHeaders = { ...headers };
    let bodyBuffer = null;
    if (body !== null && body !== undefined) {
      bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      if (!hasHeader(outHeaders, 'content-length') && !hasHeader(outHeaders, 'transfer-encoding')) {
        outHeaders['content-length'] = String(bodyBuffer.length);
      }
    }
    const options = {
      method,
      hostname: host,
      port: target.port === '' ? (isHttps ? 443 : 80) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      headers: outHeaders,
      lookup,
      // TLS SNI / 证书校验仍按用户填写的原始 host（连接层用已校验 IP）。
      ...(isHttps ? { servername: host } : {}),
    };
    return { module: isHttps ? https : http, options, bodyBuffer };
  }

  function request({ url, method = 'GET', headers = {}, body = null, timeoutMs, signal = null } = {}) {
    let spec;
    try {
      spec = buildOptions({ url, method, headers, body });
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal?.aborted) return Promise.reject(abortError());

    const timeoutValue =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PINNED_DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let req = null;
      let response = null;
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const settleWith = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const fail = (error) => {
        cleanup();
        settleWith(reject, error);
      };
      const normalizeError = (error) => {
        if (timedOut) return timeoutError(timeoutValue);
        if (signal?.aborted) return abortError();
        if (error instanceof ByokError) return error;
        if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) return abortError();
        return error;
      };
      const onAbort = () => {
        const error = abortError();
        try {
          if (req) req.destroy();
        } catch {
          /* ignore */
        }
        try {
          if (response) response.destroy();
        } catch {
          /* ignore */
        }
        fail(error);
      };
      timer = setTimeout(() => {
        timedOut = true;
        const error = timeoutError(timeoutValue);
        try {
          if (req) req.destroy(error);
        } catch {
          /* ignore */
        }
        try {
          if (response) response.destroy(error);
        } catch {
          /* ignore */
        }
        // 等待中的请求直接失败；已返回响应头的请求由读流方收到 error。
        fail(error);
      }, timeoutValue);
      if (typeof timer.unref === 'function') timer.unref();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      try {
        req = spec.module.request(spec.options, (incoming) => {
          response = incoming;
          incoming.once('end', cleanup);
          incoming.once('close', cleanup);
          settleWith(resolve, {
            statusCode: incoming.statusCode ?? 0,
            headers: incoming.headers ?? {},
            stream: incoming,
          });
        });
      } catch (error) {
        fail(normalizeError(error));
        return;
      }
      req.on('error', (error) => fail(normalizeError(error)));
      if (spec.bodyBuffer) req.write(spec.bodyBuffer);
      req.end();
    });
  }

  async function readText(opts = {}) {
    const { statusCode, headers, stream } = await request(opts);
    const chunks = [];
    try {
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof ByokError) throw error;
      // 外部中止会 destroy 底层响应流（iterator 可能抛 premature close），统一归一化为 AbortError。
      if (opts.signal?.aborted) throw abortError();
      const name = error?.name ?? '';
      if (name === 'AbortError' || error?.code === 'ABORT_ERR') throw abortError();
      throw error;
    }
    if (opts.signal?.aborted) throw abortError();
    const text = Buffer.concat(chunks).toString('utf8');
    return {
      statusCode,
      headers,
      text,
      json() {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      },
    };
  }

  return { request, readText, lookup, validator: validate };
}

/**
 * 兼容旧 `fetchImpl` 注入（探针脚本/旧单测使用）：把 fetch 适配成 transport 同形接口。
 * 仅供显式注入 fetchImpl 的兼容路径；生产 / 新测试一律走 createPinnedTransport（DNS 钉扎）。
 * @param {typeof fetch} fetchImpl
 */
export function createFetchTransport(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createFetchTransport 需要 fetch 函数');
  const toHeaderObject = (headers) => {
    const output = {};
    try {
      headers?.forEach?.((value, key) => {
        output[key] = value;
      });
    } catch {
      /* ignore */
    }
    return output;
  };
  async function request({ url, method = 'GET', headers = {}, body = null, timeoutMs, signal = null } = {}) {
    const timeoutValue = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PINNED_DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutValue);
    if (typeof timer.unref === 'function') timer.unref();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw abortError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === null || body === undefined ? null : String(body),
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      cleanup();
      if (signal?.aborted) throw abortError();
      if (timedOut) throw timeoutError(timeoutValue);
      throw error;
    }
    let stream;
    try {
      stream = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
    } catch {
      throw new Error('自定义模型响应没有可读流');
    }
    stream.once('end', cleanup);
    stream.once('close', cleanup);
    stream.once('error', cleanup);
    return { statusCode: response.status, headers: toHeaderObject(response.headers), stream };
  }
  async function readText(opts = {}) {
    const { statusCode, headers, stream } = await request(opts);
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    return {
      statusCode,
      headers,
      text,
      json() {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      },
    };
  }
  return { request, readText };
}

const defaultTransport = createPinnedTransport();

/** 契约 5：默认 pinned 传输的单次请求（不跟随重定向）。 */
export function pinnedRequest(options) {
  return defaultTransport.request(options);
}

/** 契约 5：默认 pinned 传输 + 读完整正文。 */
export function pinnedReadText(options) {
  return defaultTransport.readText(options);
}

export { defaultTransport as pinnedTransport };
