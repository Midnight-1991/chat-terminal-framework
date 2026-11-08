// –离页后台续跑（BACKGROUND_GENERATION）。
// - 默认 on：客户端中途断开只标记 clientGone，不 abort 上游；mock 流继续走完，
//   assistant 消息/用量/记忆照常落盘，日志含「后台继续生成」「后台生成完成」。
// - off：保持 行为（断开即 abort、不落 assistant 消息）。
// 测试全程走本机注入的 CHAT_MOCK（无真实网络），客户端用原始 http 请求在收到首个事件后 destroy。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  apiJson,
  createFakeRetriever,
  startAuthedServer,
  startServer,
  waitFor,
} from './helpers.mjs';
import { buildMockAnswer } from '../../server/mock.mjs';
import { parseSSEBlock } from '../../server/sse.mjs';
import { DEFAULTS, loadConfig } from '../../server/config.mjs';

/** mock 单段延迟：足够客户端在收到 meta/首批事件后中途断开（总时长约 1s，窗口充足）。 */
const MOCK_DELAY_MS = '30';

/**
 * 发起 POST /api/chat，在收到 afterEvents 个 SSE 事件后主动 destroy 客户端连接。
 * 返回 { status, events, meta }（meta 已解析为对象）。
 */
function postChatThenDestroy(baseUrl, payload, { headers = {}, afterEvents = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const body = JSON.stringify(payload);
    const events = [];
    let meta = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish({ status: 0, events, meta, timeout: true }), 5000);
    if (typeof timer.unref === 'function') timer.unref();

    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let buffer = '';
        const destroyClient = () => {
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
        };
        res.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            let parsed = null;
            try {
              parsed = parseSSEBlock(block);
            } catch {
              parsed = null;
            }
            if (!parsed) continue;
            events.push(parsed);
            if (parsed.event === 'meta') meta = parsed.data;
            if (events.length >= afterEvents && !settled) {
              finish({ status: res.statusCode, events, meta });
              destroyClient();
            }
          }
        });
        res.on('end', () => finish({ status: res.statusCode, events, meta, ended: true }));
        res.on('error', (error) => finish({ status: res.statusCode, events, meta, error }));
      },
    );
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.write(body);
    req.end();
  });
}

/** 读取 DATA_DIR 下 usage 目录的全部 .jsonl 用量记录（仅测试辅助，不写生产路径）。 */
function readUsageRows(dataDir) {
  const root = path.join(dataDir, 'usage');
  const rows = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            rows.push(JSON.parse(line));
          } catch {
            /* ignore malformed line */
          }
        }
      }
    }
  };
  walk(root);
  return rows;
}

async function getConversation(baseUrl, id, headers = {}) {
  const result = await apiJson(baseUrl, `/api/conversations/${id}`, { headers });
  return result;
}

test('config：BACKGROUND_GENERATION 默认 on，off/false/0 关闭（ 1）', () => {
  assert.equal(DEFAULTS.BACKGROUND_GENERATION, true);
  assert.equal(loadConfig({}, { logger: { warn() {} } }).backgroundGeneration, true);
  assert.equal(
    loadConfig({ BACKGROUND_GENERATION: 'off' }, { logger: { warn() {} } }).backgroundGeneration,
    false,
  );
  assert.equal(
    loadConfig({ BACKGROUND_GENERATION: 'false' }, { logger: { warn() {} } }).backgroundGeneration,
    false,
  );
  assert.equal(
    loadConfig({ BACKGROUND_GENERATION: '0' }, { logger: { warn() {} } }).backgroundGeneration,
    false,
  );
  assert.equal(
    loadConfig({ BACKGROUND_GENERATION: '1' }, { logger: { warn() {} } }).backgroundGeneration,
    true,
  );
});

test('客户端中途断开后 mock 生成继续走完：assistant 完整落盘 + 两条后台日志', async (t) => {
  const { baseUrl, logger } = await startServer(t, {
    retriever: createFakeRetriever([]),
    env: { CHAT_MOCK: '1', MOCK_DELAY_MS },
  });
  const expected = buildMockAnswer([]);

  // meta 是首个事件：拿到 conversationId 后立即断开（此时 mock 流远未结束）。
  const { status, events, meta } = await postChatThenDestroy(baseUrl, { message: '我最近很孤独' });
  assert.equal(status, 200);
  assert.ok(events.length >= 1);
  const conversationId = meta?.conversationId;
  assert.ok(conversationId, 'meta 应带 conversationId');

  // 客户端已断：轮询会话详情直到后台生成的 assistant 消息落盘。
  const persisted = await waitFor(
    async () => {
      const { status: code, data } = await getConversation(baseUrl, conversationId);
      return code === 200 && Array.isArray(data?.messages) && data.messages.some((m) => m.role === 'assistant');
    },
    { timeoutMs: 5000, intervalMs: 25 },
  );
  assert.equal(persisted, true, '客户端断开后 assistant 消息应在后台落盘');

  const { status: code, data } = await getConversation(baseUrl, conversationId);
  assert.equal(code, 200);
  const assistants = data.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 1, '后台续跑只落一条 assistant');
  assert.equal(assistants[0].text, expected, 'mock 流必须完整走完（write 在 clientGone 返回 true）');
  assert.equal(data.messages.filter((m) => m.role === 'user').length, 1);

  // 两条后台日志（info 级；注入 logger 无 info 时降级到 log）：
  // assistant 落盘在先、完成日志在后（recordUsage('ok') 之后），因此轮询等待避免时序竞争。
  const logTexts = () => logger.logs.map((entry) => entry.text);
  const continuedLogged = await waitFor(
    () =>
      logTexts().some(
        (text) => text.includes('[chat] 客户端断开，后台继续生成') && text.includes(conversationId),
      ),
    { timeoutMs: 2000, intervalMs: 10 },
  );
  assert.equal(
    continuedLogged,
    true,
    `应记录后台继续生成日志，实际：${logTexts().filter((text) => text.includes('[chat]')).join(' | ')}`,
  );
  const finishedLogged = await waitFor(
    () =>
      logTexts().some(
        (text) =>
          text.includes('[chat] 后台生成完成') &&
          text.includes(conversationId) &&
          text.includes(`chars=${expected.length}`) &&
          text.includes('model=deepseek-v4-pro'),
      ),
    { timeoutMs: 3000, intervalMs: 10 },
  );
  assert.equal(
    finishedLogged,
    true,
    `应记录后台生成完成日志，实际：${logTexts().filter((text) => text.includes('[chat]')).join(' | ')}`,
  );
  assert.ok(!logTexts().some((text) => text.includes('未处理异常')), '后台续跑不应出现未处理异常');
});

test('后台续跑仍记录 usage（status=ok，AUTH=on；）', async (t) => {
  const started = await startAuthedServer(t, {
    retriever: createFakeRetriever([]),
    env: { CHAT_MOCK: '1', MOCK_DELAY_MS },
  });
  const { baseUrl, dataDir, session } = started;
  const headers = { cookie: session.cookieHeader, 'x-csrf-token': session.csrf };

  const { status, meta } = await postChatThenDestroy(
    baseUrl,
    { message: '后台续跑的用量' },
    { headers },
  );
  assert.equal(status, 200);
  const conversationId = meta?.conversationId;
  assert.ok(conversationId);

  const fired = await waitFor(
    async () => {
      const { data } = await getConversation(baseUrl, conversationId, headers);
      return Array.isArray(data?.messages) && data.messages.some((m) => m.role === 'assistant');
    },
    { timeoutMs: 5000, intervalMs: 25 },
  );
  assert.equal(fired, true, '后台生成应完成并落盘');

  // assistant 落盘在先、usage 记账紧随其后（await），轮询等待 status=ok 的用量行出现。
  const recorded = await waitFor(
    () =>
      readUsageRows(dataDir).some(
        (entry) => entry.conversationId === conversationId && entry.status === 'ok',
      ),
    { timeoutMs: 3000, intervalMs: 25 },
  );
  assert.equal(recorded, true, '后台续跑应记录 status=ok 的用量');

  const rows = readUsageRows(dataDir);
  const row = rows.find((entry) => entry.conversationId === conversationId && entry.status === 'ok');
  assert.ok(row, `应有 status=ok 的用量记录，实际：${JSON.stringify(rows)}`);
  assert.ok(row.usage.outputTokens > 0, 'usage.outputTokens 应大于 0（与 done.usage 同源）');
  assert.equal(row.source, 'official');
});

test('BACKGROUND_GENERATION=off：断开即中断，不落 assistant 消息', async (t) => {
  const { baseUrl, logger } = await startServer(t, {
    retriever: createFakeRetriever([]),
    env: { CHAT_MOCK: '1', MOCK_DELAY_MS, BACKGROUND_GENERATION: 'off' },
  });

  const { status, meta } = await postChatThenDestroy(baseUrl, { message: '关闭开关时不应续跑' });
  assert.equal(status, 200);
  const conversationId = meta?.conversationId;
  assert.ok(conversationId);

  // 等待超过 mock 全程（~1s）：开关关闭时 assistant 永远不应出现。
  const persisted = await waitFor(
    async () => {
      const { status: code, data } = await getConversation(baseUrl, conversationId);
      return code === 200 && Array.isArray(data?.messages) && data.messages.some((m) => m.role === 'assistant');
    },
    { timeoutMs: 1200, intervalMs: 25 },
  );
  assert.equal(persisted, false, 'BACKGROUND_GENERATION=off 时不应落 assistant 消息');

  const { data } = await getConversation(baseUrl, conversationId);
  assert.equal(data.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(data.messages.filter((m) => m.role === 'assistant').length, 0);

  const logTexts = logger.logs.map((entry) => entry.text);
  assert.ok(!logTexts.some((text) => text.includes('后台继续生成')));
  assert.ok(!logTexts.some((text) => text.includes('后台生成完成')));
});
