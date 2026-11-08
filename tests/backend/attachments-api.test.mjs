// 图片附件服务器持久化 + 鉴权读取端到端测试。
// 覆盖：chat 落盘/meta id+previewUrl/二进制 GET·HEAD/404·405/ETag·Cache-Control/文件权限、
// 会话详情回显、删除会话后 sweep、跨会话内容去重、memory 持久化与重启回显、关闭与容量上限降级。
// 全部走本地 mock（CHAT_MOCK=1 / 注入 fetch），不发真实网络请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  apiJson,
  citationItem,
  createCapturingLogger,
  createFakeRetriever,
  makeTmpDir,
  postChat,
  rawRequest,
  sleep,
  startServer,
} from './helpers.mjs';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BUFFER = Buffer.from(PNG_BASE64, 'base64');
const PNG_URL = '/api/attachments';
const ID_RE = /^a[0-9a-f]{24}$/;

function mockChatError() {
  throw new Error('CHAT_MOCK=1 时不得调用真实上游 fetch');
}

function imagePayload(overrides = {}) {
  return { kind: 'image', name: '图.png', mime: 'image/png', dataBase64: PNG_BASE64, ...overrides };
}

function attachDir(dataDir) {
  return path.join(dataDir, 'attachments');
}

function attachmentFiles(dataDir) {
  try {
    return fs.readdirSync(attachDir(dataDir)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function fileFor(dataDir, id) {
  const name = attachmentFiles(dataDir).find((entry) => entry.startsWith(`${id}.`) && !entry.endsWith('.tmp'));
  return name ? path.join(attachDir(dataDir), name) : null;
}

async function startMockServer(t, options = {}) {
  const { env: extraEnv, ...rest } = options;
  return startServer(t, {
    env: { CHAT_MOCK: '1', ...(extraEnv ?? {}) },
    fetchImpl: mockChatError,
    retriever: createFakeRetriever([citationItem()]),
    ...rest,
  });
}

async function stopServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

test('chat 带图 → 持久化 + meta.id/previewUrl；GET/HEAD 二进制、ETag、私有缓存、文件 600/700', async (t) => {
  const { baseUrl, dataDir } = await startMockServer(t);
  const { events } = await postChat(baseUrl, { message: '帮我看看这张图', attachments: [imagePayload()] });
  const meta = events[0].data;
  assert.equal(meta.attachments.length, 1);
  const attachment = meta.attachments[0];
  assert.match(attachment.id, ID_RE);
  assert.equal(attachment.previewUrl, `${PNG_URL}/${attachment.id}`);
  assert.match(attachment.previewUrl, /^\/api\/attachments\/a[0-9a-f]{24}$/);

  // 文件落盘：DATA_DIR/attachments/<id>.png，目录 700、文件 600，无 .tmp 残留。
  const filePath = fileFor(dataDir, attachment.id);
  assert.ok(filePath, '附件文件应写入 DATA_DIR/attachments');
  assert.ok(path.basename(filePath).startsWith(`${attachment.id}.`));
  assert.deepEqual(fs.readFileSync(filePath), PNG_BUFFER, '落盘字节应与上传一致');
  assert.equal(fs.statSync(attachDir(dataDir)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(
    attachmentFiles(dataDir).filter((name) => name.endsWith('.tmp')),
    [],
  );

  // GET：二进制 + 内容类型/长度/ETag/私有缓存/安全头。
  const getResponse = await fetch(`${baseUrl}${attachment.previewUrl}`);
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get('content-type'), 'image/png');
  assert.equal(getResponse.headers.get('content-length'), String(PNG_BUFFER.length));
  assert.equal(getResponse.headers.get('etag'), `"${attachment.id}"`);
  assert.equal(getResponse.headers.get('cache-control'), 'private, max-age=604800');
  assert.equal(getResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await getResponse.arrayBuffer()), PNG_BUFFER);

  // HEAD：同状态与头，无响应体。
  const headResponse = await fetch(`${baseUrl}${attachment.previewUrl}`, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('content-length'), String(PNG_BUFFER.length));
  assert.equal((await headResponse.arrayBuffer()).byteLength, 0);

  // 未知 / 非法 / 穿越 / 长度不符 / 方法不符 → 404（JSON API 错误，不泄露内部路径）。
  const missingId = `a${'0'.repeat(24)}`;
  for (const urlPath of [
    `${PNG_URL}/${missingId}`,
    `${PNG_URL}/not-an-id`,
    `${PNG_URL}/a123`,
    `${PNG_URL}`,
    `${PNG_URL}/${attachment.id}/extra`,
  ]) {
    const response = await fetch(`${baseUrl}${urlPath}`);
    assert.equal(response.status, 404, `${urlPath} 应 404`);
    const payload = await response.json();
    assert.equal(payload.error?.code, 'NOT_FOUND');
    assert.ok(!JSON.stringify(payload).includes(dataDir), '错误响应不得泄露服务器路径');
  }
  // 原始 path 的编码穿越（fetch 会归一化 `..`，这里直发原始请求）。
  const traversal = await rawRequest(baseUrl, {
    path: `/api/attachments/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
  });
  assert.equal(traversal.status, 404);
  // POST 等其他方法 → 404（不暴露方法集）。
  const wrongMethod = await fetch(`${baseUrl}${attachment.previewUrl}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(wrongMethod.status, 404);

  // 会话详情（重启后数据源）：用户消息附件带 id/previewUrl，且 JSON 中无二进制。
  const detail = await apiJson(baseUrl, `/api/conversations/${meta.conversationId}`);
  assert.equal(detail.status, 200);
  const userMessage = detail.data.messages.find((message) => message.role === 'user');
  assert.ok(userMessage);
  assert.equal(userMessage.attachments[0].id, attachment.id);
  assert.equal(userMessage.attachments[0].previewUrl, attachment.previewUrl);
  const detailText = JSON.stringify(detail.data);
  assert.ok(!detailText.includes(PNG_BASE64), '会话详情不得含原始 base64');
  assert.ok(!detailText.includes('dataBase64'));

  // 删除会话 → sweep 清理文件（响应前完成，失败也不会 500）。
  const deletion = await apiJson(baseUrl, `/api/conversations/${meta.conversationId}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  assert.equal(deletion.data.ok, true);
  await sleep(20);
  assert.equal(fs.existsSync(filePath), false, '删除会话后附件文件应被清理');
  assert.deepEqual(attachmentFiles(dataDir), []);
});

test('同一图片跨会话内容去重：删除第一个会话保留文件，删除最后一个会话才清理', async (t) => {
  const { baseUrl, dataDir } = await startMockServer(t);
  const first = await postChat(baseUrl, { message: '第一次发图', attachments: [imagePayload()] });
  const second = await postChat(baseUrl, { message: '第二次发同一张图', attachments: [imagePayload()] });
  const firstId = first.events[0].data.attachments[0].id;
  const secondId = second.events[0].data.attachments[0].id;
  assert.equal(firstId, secondId, '同内容应内容寻址为同一 id');
  assert.equal(attachmentFiles(dataDir).length, 1, '同内容只落一个文件');

  const firstDelete = await apiJson(baseUrl, `/api/conversations/${first.events[0].data.conversationId}`, {
    method: 'DELETE',
  });
  assert.equal(firstDelete.status, 200);
  assert.equal(fs.existsSync(fileFor(dataDir, firstId)), true, '仍被第二个会话引用 → 保留文件');

  const secondDelete = await apiJson(baseUrl, `/api/conversations/${second.events[0].data.conversationId}`, {
    method: 'DELETE',
  });
  assert.equal(secondDelete.status, 200);
  assert.deepEqual(attachmentFiles(dataDir), [], '无引用后清理文件');
});

test('memory 带图：attachments 带 id/previewUrl，GET 可读；重启后回显且文件保留；删除记忆后清理', async (t) => {
  const logger = createCapturingLogger();
  const started = await startMockServer(t, { logger });
  const { baseUrl, dataDir } = started;
  const created = await apiJson(baseUrl, '/api/memories', {
    method: 'POST',
    body: { text: '记住这张图', kind: 'fact', level: 'core', attachments: [imagePayload()] },
  });
  assert.equal(created.status, 201);
  const memory = created.data.memory;
  assert.equal(memory.attachments.length, 1);
  const attachment = memory.attachments[0];
  assert.match(attachment.id, ID_RE);
  assert.equal(attachment.previewUrl, `${PNG_URL}/${attachment.id}`);
  assert.ok(!JSON.stringify(memory).includes(PNG_BASE64));

  const preview = await fetch(`${baseUrl}${attachment.previewUrl}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG_BUFFER);

  // 模拟重启：关掉服务，用同一 DATA_DIR 重新启动；启动 sweep 不得误删被记忆引用的文件。
  await stopServer(started.server);
  const restarted = await startMockServer(t, { logger: createCapturingLogger(), dataDir });
  const list = await apiJson(restarted.baseUrl, '/api/memories');
  assert.equal(list.status, 200);
  const reloaded = list.data.memories.find((entry) => entry.id === memory.id);
  assert.ok(reloaded, '重启后记忆应仍在');
  assert.equal(reloaded.attachments[0].id, attachment.id);
  assert.equal(reloaded.attachments[0].previewUrl, attachment.previewUrl);
  const previewAfterRestart = await fetch(`${restarted.baseUrl}${attachment.previewUrl}`);
  assert.equal(previewAfterRestart.status, 200, '重启后附件仍可鉴权读取');
  assert.ok(fs.existsSync(fileFor(dataDir, attachment.id)));

  const deletion = await apiJson(restarted.baseUrl, `/api/memories/${memory.id}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  await sleep(20);
  assert.equal(fileFor(dataDir, attachment.id), null, '删除记忆后文件应被清理');

  // 清空记忆接口同样触发 sweep（先建一条带图记忆）。
  const another = await apiJson(restarted.baseUrl, '/api/memories', {
    method: 'POST',
    body: { text: '第二张图', attachments: [imagePayload()] },
  });
  assert.equal(another.status, 201);
  const anotherId = another.data.memory.attachments[0].id;
  const clear = await apiJson(restarted.baseUrl, '/api/memories', { method: 'DELETE' });
  assert.equal(clear.status, 200);
  await sleep(20);
  assert.equal(fileFor(dataDir, anotherId), null, '清空记忆后文件应被清理');
});

test('启动 sweep：清理 DATA_DIR 里的孤儿附件与残留 *.tmp（不阻塞启动）', async (t) => {
  const dataDir = makeTmpDir('wild-attach-boot-');
  fs.mkdirSync(attachDir(dataDir), { recursive: true });
  const orphanId = `a${'9'.repeat(24)}`;
  fs.writeFileSync(path.join(attachDir(dataDir), `${orphanId}.png`), 'orphan');
  fs.writeFileSync(path.join(attachDir(dataDir), `${orphanId}.png.tmp`), 'tmp');

  const { baseUrl } = await startMockServer(t, { dataDir });
  const health = await apiJson(baseUrl, '/api/health');
  assert.equal(health.status, 200, '启动 sweep 失败不得阻塞服务');
  assert.deepEqual(attachmentFiles(dataDir), [], '启动时应清理孤儿文件与 tmp');
});

test('ATTACHMENT_STORAGE=0：行为兼容（meta 无 id/previewUrl，不落盘）', async (t) => {
  const { baseUrl, dataDir } = await startMockServer(t, { env: { ATTACHMENT_STORAGE: '0' } });
  const { events } = await postChat(baseUrl, { message: '看图', attachments: [imagePayload()] });
  const meta = events[0].data;
  assert.equal(meta.attachments.length, 1);
  assert.deepEqual(Object.keys(meta.attachments[0]).sort(), ['kind', 'ms', 'name', 'summary']);
  assert.deepEqual(attachmentFiles(dataDir), []);

  const conversation = await apiJson(baseUrl, `/api/conversations/${meta.conversationId}`);
  const userMessage = conversation.data.messages.find((message) => message.role === 'user');
  assert.ok(!('id' in userMessage.attachments[0]));
  assert.ok(!('previewUrl' in userMessage.attachments[0]));

  const created = await apiJson(baseUrl, '/api/memories', {
    method: 'POST',
    body: { text: '记住这张图', attachments: [imagePayload()] },
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.memory.attachments[0].summary);
  assert.ok(!('id' in created.data.memory.attachments[0]));
  assert.deepEqual(attachmentFiles(dataDir), []);
});

test('ATTACHMENT_MAX_MB 超限：只保留解析摘要并 warn，不写文件、不阻断对话', async (t) => {
  // 1.2MB 的伪 PNG：magic bytes 合法（vision 层只做内容嗅探），但超过 1MB 容量上限。
  const bigBuffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(1_200 * 1024, 7),
  ]);
  const logger = createCapturingLogger();
  const { baseUrl, dataDir } = await startMockServer(t, {
    env: { ATTACHMENT_MAX_MB: '1' },
    logger,
  });
  const { status, events } = await postChat(baseUrl, {
    message: '大图',
    attachments: [imagePayload({ name: '大图.png', dataBase64: bigBuffer.toString('base64') })],
  });
  assert.equal(status, 200);
  const attachment = events[0].data.attachments[0];
  assert.equal(attachment.name, '大图.png');
  assert.ok(attachment.summary, '存储失败仍保留解析摘要');
  assert.ok(!('id' in attachment), '超限不返回 id');
  assert.ok(!('previewUrl' in attachment));
  assert.deepEqual(attachmentFiles(dataDir), []);
  assert.ok(
    logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('容量已达上限')),
    '超限应 warn（可观测）',
  );

  // 非法 ATTACHMENT_MAX_MB：warn + 回退默认，服务照常可用。
  const fallbackLogger = createCapturingLogger();
  const fallback = await startMockServer(t, { env: { ATTACHMENT_MAX_MB: 'abc' }, logger: fallbackLogger });
  assert.equal((await apiJson(fallback.baseUrl, '/api/health')).status, 200);
  assert.ok(
    fallbackLogger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('ATTACHMENT_MAX_MB')),
    '非法容量配置应 warn 并回退默认',
  );
  const okChat = await postChat(fallback.baseUrl, { message: '小图', attachments: [imagePayload()] });
  assert.match(okChat.events[0].data.attachments[0].id ?? '', ID_RE);
});
