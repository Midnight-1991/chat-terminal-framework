// 后端测试公共工具：启动注入式服务、构造上游 SSE mock、解析客户端 SSE、原始 HTTP 请求。
// 铁律：测试绝不发真实网络请求（上游一律走 fetchImpl 注入）。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { createServer } from '../../server/index.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, 'fixtures');
export const FIXTURE_CORPUS = path.join(FIXTURES, 'corpus');
export const FIXTURE_LIBRARY = path.join(FIXTURES, 'library');
export const FIXTURE_PROMPTS = path.join(FIXTURES, 'prompts');
export const FIXTURE_PUBLIC = path.join(FIXTURES, 'public');

let sharedEmptyRepoRoot;

/** 空仓库根（无 rag/、prompts/、corpus/），用于测试降级路径。 */
export function emptyRepoRoot() {
  if (!sharedEmptyRepoRoot) {
    sharedEmptyRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wild-repo-'));
    fs.mkdirSync(path.join(sharedEmptyRepoRoot, 'rag'), { recursive: true });
  }
  return sharedEmptyRepoRoot;
}

export function makeTmpDir(prefix = 'wild-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(dir, relativePath, content) {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

/** 捕获 logger 输出（用于断言 warn/error 与「不泄漏 key」）。 */
export function createCapturingLogger() {
  const logs = [];
  const push = (level) => (...args) => {
    logs.push({ level, text: args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ') });
  };
  return { logs, log: push('log'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

/** 假检索器：记录调用参数，返回固定条目。 */
export function createFakeRetriever(items = [], stats = { docs: 1, chunks: items.length || 1 }) {
  const calls = [];
  return {
    calls,
    stats: () => stats,
    async retrieve(query, topK = 5, retrieveOpts = {}) {
      calls.push({ query, topK, retrieveOpts });
      return typeof items === 'function' ? items(query, topK, retrieveOpts) : items.slice(0, topK);
    },
  };
}

/** 构造一条契约格式的检索结果（retrieve 的返回项）。 */
export function citationItem(overrides = {}) {
  return {
    chunkId: 'seasonal-01#s2p1',
    docId: 'seasonal-01',
    title: '换季时节的观察笔记',
    heading: '换季时的常见现象',
    anchor: 's2',
    para: 1,
    text: '在季节交替的数周里，反复的增减衣物、早晚温差与注意力分散都可能出现。它们不自动等于问题，而是人对环境变化的正常反应。',
    sourceUrl: 'https://example.com/notes/seasonal-observations',
    license: 'LicenseRef-Synthetic-Fixture',
    score: 8.31,
    ...overrides,
  };
}

/** 启动测试服务：所有依赖注入；不加载真实 rag（除非显式传 retriever）。 */
export async function startServer(t, options = {}) {
  const logger = options.logger ?? createCapturingLogger();
  const env = {
    // 显式 AUTH=off，确保既有单用户测试与生产默认一致（不读取开发机 .env 时也稳定）。
    AUTH: 'off',
    DEEPSEEK_API_KEY: 'test-key-123',
    CHAT_MOCK: '0',
    MOCK_DELAY_MS: '0',
    UPSTREAM_TIMEOUT_MS: '5000',
    // v2 默认关闭记忆抽取，避免后台补全调用污染上游调用断言；记忆测试显式 MEMORY=1。
    MEMORY: '0',
    RERANK: 'off',
    QUERY_EXPAND: 'off',
    ...options.env,
  };
  // 每个测试服务独立的数据目录，绝不写仓库里的 data/；传 dataDir: null 表示走 config.dataDir 解析。
  const dataDir = options.dataDir === null ? null : options.dataDir ?? makeTmpDir('wild-data-');
  const serverOptions = {
    repoRoot: options.repoRoot ?? emptyRepoRoot(),
    env,
    docsDir: options.docsDir ?? FIXTURE_CORPUS,
    promptsDir: options.promptsDir ?? FIXTURE_PROMPTS,
    staticDir: options.staticDir ?? FIXTURE_PUBLIC,
    ...(dataDir ? { dataDir } : {}),
    credentialPath: options.credentialPath ?? path.join(emptyRepoRoot(), 'no-such-credentials.yaml'),
    logger,
  };
  if ('retriever' in options) serverOptions.retriever = options.retriever;
  if ('fetchImpl' in options) serverOptions.fetchImpl = options.fetchImpl;
  if ('callModel' in options) serverOptions.callModel = options.callModel;
  if ('reranker' in options) serverOptions.reranker = options.reranker;
  if ('retrieverOptions' in options) serverOptions.retrieverOptions = options.retrieverOptions;
  if ('marksLimits' in options) serverOptions.marksLimits = options.marksLimits;

  const server = await createServer(serverOptions);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  });
  const address = server.address();
  return { server, ctx: server.ctx, logger, baseUrl: `http://127.0.0.1:${address.port}`, dataDir };
}

/* ------------------------------ 多用户测试工具 ------------------------------ */

/** 解析响应的 Set-Cookie 头（Node fetch 不自动维护 cookie jar）。 */
export function parseSetCookies(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const cookies = {};
  for (const raw of list) {
    const [pair] = String(raw).split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    cookies[pair.slice(0, index).trim()] = pair.slice(index + 1);
  }
  return cookies;
}

/** cookie 对象 → Cookie 请求头。 */
export function cookieHeaderOf(cookies = {}) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * 启动 AUTH=on 的服务，并预置管理员 + 普通用户。
 * 返回 { ...startServer 结果, admin, accounts, login(username,password), session }。
 * login() 返回 { status, payload, cookies, csrf, cookieHeader }；测试用 headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrf }。
 */
export async function startAuthedServer(t, options = {}) {
  const { createUserService } = await import('../../server/users.mjs');
  const dataDir = options.dataDir ?? makeTmpDir('wild-auth-data-');
  const logger = options.logger ?? createCapturingLogger();
  const users = createUserService({ dataDir, logger });
  const adminUsername = options.adminUsername ?? 'admin';
  const adminPassword = options.adminPassword ?? 'admin-pass-123';
  const adminCreated = await users.ensureAdmin({ username: adminUsername, initialPassword: adminPassword });
  const accounts = [
    {
      id: adminCreated.user.id,
      username: adminCreated.user.username,
      password: adminPassword,
      role: 'admin',
    },
  ];
  for (const spec of options.users ?? []) {
    const created = await users.create({
      username: spec.username,
      password: spec.password,
      displayName: spec.displayName ?? null,
      role: spec.role ?? 'user',
      quota: spec.quota ?? null,
    });
    accounts.push({ id: created.id, username: created.username, password: spec.password, role: created.role });
  }
  const started = await startServer(t, {
    ...options,
    logger,
    dataDir,
    env: {
      AUTH: 'on',
      AUTH_COOKIE_SECURE: '0',
      AUTH_SESSION_TTL_DAYS: '7',
      INVITE_ONLY: 'on',
      ...options.env,
    },
  });
  const login = async (username, password) => {
    const response = await fetch(`${started.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const payload = await response.json().catch(() => ({}));
    const cookies = parseSetCookies(response.headers);
    return {
      status: response.status,
      payload,
      cookies,
      csrf: payload?.csrf ?? cookies.csrf ?? '',
      cookieHeader: cookieHeaderOf(cookies),
    };
  };
  const admin = accounts[0];
  const session = await login(admin.username, admin.password);
  return { ...started, admin, accounts, login, session };
}

/* ------------------------------ 上游 SSE mock ------------------------------ */

export function messageStart({ inputTokens = 1234, cacheReadInputTokens = 56, outputTokens = 0 } = {}) {
  return {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_test_1',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-v4-pro',
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheReadInputTokens,
          output_tokens: outputTokens,
        },
      },
    },
  };
}

export function contentBlockStart(type, index = 0) {
  return {
    event: 'content_block_start',
    data: { type: 'content_block_start', index, content_block: { type } },
  };
}

export function thinkingDelta(text, index = 0) {
  return {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } },
  };
}

export function textDelta(text, index = 1) {
  return {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  };
}

export function messageDelta({ stopReason = 'end_turn', outputTokens = 321 } = {}) {
  return {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
  };
}

export function messageStop() {
  return { event: 'message_stop', data: { type: 'message_stop' } };
}

export function ping() {
  return { event: 'ping', data: { type: 'ping' } };
}

/** 标准上游流：message_start → thinking → text → message_delta → message_stop。 */
export function standardUpstreamEvents({ thinking = '先想一下。', text = '第一段。第二段。' } = {}) {
  return [
    messageStart(),
    contentBlockStart('thinking', 0),
    thinkingDelta(thinking),
    contentBlockStart('text', 1),
    textDelta(text),
    messageDelta({ stopReason: 'end_turn', outputTokens: 321 }),
    messageStop(),
  ];
}

/** 把事件数组序列化成上游 Response（体是完整 SSE 文本）。 */
export function sseResponse(events, { status = 200 } = {}) {
  const body = events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join('');
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

/**
 * 注入式 fetch mock：记录每次调用，由 handler 决定返回。
 * @returns {{fetchImpl: Function, calls: Array<{url:string, init:object, body:object|null}>}}
 */
export function createFetchMock(handler) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const call = {
      url: String(url),
      init,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }
  return {
    fetchImpl,
    calls,
    get count() {
      return calls.length;
    },
    last() {
      return calls[calls.length - 1];
    },
    lastBody() {
      return calls[calls.length - 1]?.body;
    },
  };
}

/** 一个永不结束的上游流；abort 时 error 掉流（模拟真实 fetch 被中断）。 */
export function hangingUpstreamResponse(initSignal) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const first = standardUpstreamEvents()[0];
      controller.enqueue(encoder.encode(`event: ${first.event}\ndata: ${JSON.stringify(first.data)}\n\n`));
      initSignal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          /* ignore */
        }
      });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

/* ------------------------------ 客户端工具 ------------------------------ */

/** 解析客户端收到的 SSE 文本为事件数组。 */
export function parseSSEText(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const events = [];
  for (const block of normalized.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    let data = null;
    if (dataLines.length > 0) {
      const dataText = dataLines.join('\n');
      try {
        data = JSON.parse(dataText);
      } catch {
        data = dataText;
      }
    }
    events.push({ event, data });
  }
  return events;
}

/** 通用 JSON 请求（非 SSE 的 /api/* 接口）。 */
export async function apiJson(baseUrl, urlPath, { method = 'GET', body, headers = {} } = {}) {
  const hasBody = body !== undefined;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { response, status: response.status, headers: response.headers, data, text };
}

/** POST /api/chat 并完整读取 SSE 响应。 */
export async function postChat(baseUrl, payload, { headers = {} } = {}) {  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return {
    response,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    events: parseSSEText(text),
    text,
  };
}

/** POST 任意原始 body（用于非法 JSON 等场景）。 */
export async function postRaw(baseUrl, urlPath, body, { headers = {}, method = 'POST' } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, { method, headers, body });
  const text = await response.text();
  return { response, status: response.status, text, body: text };
}

/** 原始 HTTP 请求（path 原样发送，用于路径穿越测试；fetch/URL 会归一化 `..`）。 */
export function rawRequest(baseUrl, { path: urlPath = '/', method = 'GET', headers = {}, body = null } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await sleep(intervalMs);
  }
}

export { sleep };
