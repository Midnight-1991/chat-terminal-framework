import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  startServer,
  createFakeRetriever,
  citationItem,
  createFetchMock,
  standardUpstreamEvents,
  sseResponse,
  postChat,
  apiJson,
  makeTmpDir,
  writeFile,
  FIXTURE_PROMPTS,
  messageStart,
  contentBlockStart,
  thinkingDelta,
  textDelta,
  messageDelta,
  messageStop,
  ping,
} from './helpers.mjs';

// citations 新增 source:'rag'|'web'（本地检索缺省 rag，保证旧客户端兼容）。
const CITATION_KEYS = [
  'anchor',
  'c',
  'chunkId',
  'docId',
  'heading',
  'license',
  'para',
  'score',
  'source',
  'sourceUrl',
  'title',
];

function standardMock() {
  return createFetchMock(() => sseResponse(standardUpstreamEvents()));
}

test('SSE 响应头符合契约', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });
  const { headers, status } = await postChat(baseUrl, { message: '我最近很孤独' });

  assert.equal(status, 200);
  assert.equal(headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(headers['cache-control'], 'no-cache, no-transform');
  assert.equal(headers['x-accel-buffering'], 'no');
});

test('事件序列：meta 最先且唯一、done 最后且唯一、增量顺序与上游一致', async (t) => {
  const events = [
    messageStart(),
    ping(),
    contentBlockStart('thinking', 0),
    thinkingDelta('先想一下。'),
    contentBlockStart('text', 1),
    textDelta('第一段。'),
    textDelta('第二段。'),
    messageDelta({ stopReason: 'end_turn', outputTokens: 321 }),
    messageStop(),
  ];
  const mock = createFetchMock(() => sseResponse(events));
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });

  const { events: received } = await postChat(baseUrl, { message: '我最近很孤独' });
  assert.deepEqual(
    received.map((event) => event.event),
    ['meta', 'thinking_delta', 'text_delta', 'text_delta', 'done'],
  );
  assert.equal(received.filter((event) => event.event === 'meta').length, 1);
  assert.equal(received.filter((event) => event.event === 'done').length, 1);
  assert.equal(received.at(-1).event, 'done');
  assert.deepEqual(received[1].data, { text: '先想一下。' });
  assert.deepEqual(received[2].data, { text: '第一段。' });
  assert.deepEqual(received[3].data, { text: '第二段。' });
});

test('meta 字段：sessionId / model / effort / citations（默认 effort=high）', async (t) => {
  const mock = standardMock();
  const retriever = createFakeRetriever([citationItem()]);
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  const { events } = await postChat(baseUrl, { message: '我最近很孤独' });
  const meta = events[0];
  assert.equal(meta.event, 'meta');
  assert.match(meta.data.sessionId, /^s[0-9a-f]{6,}$/);
  assert.equal(meta.data.model, 'deepseek-v4-pro');
  assert.equal(meta.data.effort, 'high');
  assert.ok(Array.isArray(meta.data.citations));
  assert.equal(meta.data.citations.length, 1);
  assert.deepEqual(Object.keys(meta.data.citations[0]).sort(), CITATION_KEYS);
  assert.equal(meta.data.citations[0].c, 1);
  // 本地检索引用的来源默认为 rag（web 来源只在显式开启联网时出现）。
  assert.equal(meta.data.citations[0].source, 'rag');
  // 默认（未开启联网）webSearchUsed=0。
  assert.equal(meta.data.webSearchUsed, 0);
  assert.equal(meta.data.citations[0].chunkId, 'seasonal-01#s2p1');
  assert.equal(meta.data.citations[0].anchor, 's2');
  assert.equal(meta.data.citations[0].para, 1);
  assert.equal(meta.data.citations[0].score, 8.31);
});

test('引用编号 c1..cN 连续、最多 5 条、按 topK=5 调用检索', async (t) => {
  const items = Array.from({ length: 8 }, (_, index) =>
    citationItem({ chunkId: `seasonal-01#s2p${index + 1}`, score: 9 - index * 0.1 }),
  );
  const retriever = createFakeRetriever(items);
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  const { events } = await postChat(baseUrl, { message: '孤独' });
  const citations = events[0].data.citations;
  assert.equal(citations.length, 5);
  assert.deepEqual(
    citations.map((citation) => citation.c),
    [1, 2, 3, 4, 5],
  );
  for (const citation of citations) {
    assert.ok(!('text' in citation), 'meta.citations 不得泄漏内部检索正文');
  }
  assert.equal(retriever.calls.length, 1);
  assert.equal(retriever.calls[0].topK, 5);
  assert.equal(retriever.calls[0].query, '孤独');
});

test('上游请求：URL / 请求头 / 请求体符合契约', async (t) => {
  const mock = standardMock();
  const retriever = createFakeRetriever([citationItem()]);
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  await postChat(baseUrl, { message: '我最近很孤独', effort: 'max', sessionId: 's-contract-1' });
  const call = mock.last();
  assert.equal(call.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-api-key'], 'test-key-123');
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
  assert.match(call.init.headers['content-type'], /^application\/json/);

  const body = call.body;
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.equal(body.max_tokens, 1000000, '统一模型输出上限 1,000,000');
  assert.equal(body.stream, true);
  assert.equal(body.thinking.type, 'enabled');
  assert.deepEqual(body.output_config, { effort: 'max' });
  assert.ok(body.system.includes('SYS-A 人格本体。'));
  assert.ok(Array.isArray(body.messages));
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.match(body.messages[0].content[0].text, /\[资料 c1\] 《换季时节的观察笔记》\/ 章节：换季时的常见现象 \/ 锚点：s2/);
});

test('effort=off：thinking.disabled 且不发送 output_config', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });

  const { events, headers } = await postChat(baseUrl, { message: '孤独', effort: 'off' });
  const body = mock.lastBody();
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.ok(!('output_config' in body), 'effort=off 不得发送 output_config');
  assert.equal(events[0].data.effort, 'off');
  assert.equal(headers['content-type'], 'text/event-stream; charset=utf-8');
});

test('effort=low 时 output_config.effort=low', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });
  await postChat(baseUrl, { message: '孤独', effort: 'low' });
  assert.deepEqual(mock.lastBody().output_config, { effort: 'low' });
});

test('usage 从 message_start / message_delta 映射到 done', async (t) => {
  const mock = createFetchMock(() =>
    sseResponse([
      messageStart({ inputTokens: 1234, cacheReadInputTokens: 56, outputTokens: 0 }),
      contentBlockStart('text', 0),
      textDelta('好。'),
      messageDelta({ stopReason: 'max_tokens', outputTokens: 321 }),
      messageStop(),
    ]),
  );
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });

  const { events } = await postChat(baseUrl, { message: '孤独' });
  const done = events.at(-1);
  assert.equal(done.event, 'done');
  assert.deepEqual(done.data, {
    stopReason: 'max_tokens',
    usage: { inputTokens: 1234, outputTokens: 321, cacheReadInputTokens: 56 },
  });
});

test('正文增量透传，不重写模型文本', async (t) => {
  const pieces = ['你问的', '是孤独。', '先别急着', '解释它。'];
  const mock = createFetchMock(() =>
    sseResponse([
      messageStart(),
      contentBlockStart('text', 0),
      ...pieces.map((piece) => textDelta(piece)),
      messageDelta(),
      messageStop(),
    ]),
  );
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });

  const { events } = await postChat(baseUrl, { message: '孤独' });
  const textDeltas = events.filter((event) => event.event === 'text_delta');
  assert.deepEqual(
    textDeltas.map((event) => event.data.text),
    pieces,
  );
  const doneIndex = events.findIndex((event) => event.event === 'done');
  const lastTextIndex = events.findLastIndex((event) => event.event === 'text_delta');
  assert.ok(lastTextIndex < doneIndex, 'done 必须在所有 text_delta 之后');
});

test('证据块：格式符合 DATA-CONTRACT 4、最多 5 条、用户原话最后一段', async (t) => {
  const items = Array.from({ length: 6 }, (_, index) =>
    citationItem({
      chunkId: `seasonal-01#s2p${index + 1}`,
      anchor: 's2',
      para: index + 1,
      heading: `标题${index + 1}`,
      text: `第${index + 1}条证据：` + '哀'.repeat(700),
      score: 9 - index,
    }),
  );
  const retriever = createFakeRetriever(items);
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  await postChat(baseUrl, { message: '我最近一到晚上就很孤独。' });
  const userText = mock.lastBody().messages.at(-1).content[0].text;

  assert.ok(userText.startsWith('[参考资料]\n[资料 c1] 《换季时节的观察笔记》'));
  const blockCount = (userText.match(/\[资料 c\d+\]/g) ?? []).length;
  assert.equal(blockCount, 5, '最多注入 5 条资料');
  assert.ok(!userText.includes('[资料 c6]'), '第 6 条不得注入');
  assert.ok(userText.includes('章节：标题5 / 锚点：s2'));
  // 用户原话原样作为最后一段
  assert.ok(userText.endsWith('[用户] 我最近一到晚上就很孤独。'));
});

test('证据块：单条正文截断到 900 字符（加省略号）', async (t) => {
  const retriever = createFakeRetriever([
    citationItem({ chunkId: 'seasonal-01#s2p1', text: '哀'.repeat(2000) }),
  ]);
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  await postChat(baseUrl, { message: '孤独' });
  const userText = mock.lastBody().messages.at(-1).content[0].text;
  assert.ok(userText.includes(`${'哀'.repeat(900)}…`), '单条正文应截断到 900 字符 + 省略号');
  assert.ok(!userText.includes('哀'.repeat(901) + '…'));
});

test('证据块：总字符受 4000 上限约束（超长证据时提前停止注入）', async (t) => {
  const items = Array.from({ length: 5 }, (_, index) =>
    citationItem({
      chunkId: `seasonal-01#s2p${index + 1}`,
      para: index + 1,
      heading: `标题${index + 1}`,
      text: '哀'.repeat(2000),
      score: 9 - index,
    }),
  );
  const retriever = createFakeRetriever(items);
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  await postChat(baseUrl, { message: '孤独' });
  const userText = mock.lastBody().messages.at(-1).content[0].text;
  assert.ok(userText.length < 4200, `证据块总长度应受控，实际 ${userText.length}`);
  const blockCount = (userText.match(/\[资料 c\d+\]/g) ?? []).length;
  assert.ok(blockCount < 5, `总字符受限时应少注入，实际 ${blockCount} 条`);
  assert.ok(blockCount >= 1);
});

test('无检索命中时证据块明确说明，不编造资料', async (t) => {
  const mock = standardMock();
  const retriever = createFakeRetriever([]);
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  const { events } = await postChat(baseUrl, { message: '孤独' });
  assert.deepEqual(events[0].data.citations, []);
  const userText = mock.lastBody().messages.at(-1).content[0].text;
  assert.match(userText, /\[参考资料\]\n（本轮没有检索到相关资料。）/);
  assert.ok(userText.endsWith('[用户] 孤独'));
});

test('显式 sessionId 原样出现在 meta 中', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });
  const { events } = await postChat(baseUrl, { message: '孤独', sessionId: 'my-session_1' });
  assert.equal(events[0].data.sessionId, 'my-session_1');
});

test('DEEPSEEK_BASE_URL 可配置，仍只请求 /v1/messages', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, {
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([]),
    env: { DEEPSEEK_BASE_URL: 'http://mock-upstream.local/anthropic/' },
  });
  await postChat(baseUrl, { message: '孤独' });
  assert.equal(mock.last().url, 'http://mock-upstream.local/anthropic/v1/messages');
});

test('max_tokens 不再按 effort 分档（统一请求模型上限 1,000,000）', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever: createFakeRetriever([]) });

  const expected = { off: 1000000, low: 1000000, high: 1000000, max: 1000000 };
  for (const [effort, maxTokens] of Object.entries(expected)) {
    const { events } = await postChat(baseUrl, { message: `测试 ${effort} 档`, effort });
    assert.equal(events.at(-1).event, 'done');
    assert.equal(mock.lastBody().max_tokens, maxTokens, `effort=${effort} 的 max_tokens`);
  }
  // 省略 effort 时同样使用统一上限，而不是旧的分档值
  await postChat(baseUrl, { message: '默认档位' });
  assert.equal(mock.lastBody().max_tokens, 1000000);
});

test('显式 MAX_TOKENS=999 覆盖所有 effort 档位（thinking 预算由调用方决定）', async (t) => {
  const mock = standardMock();
  const { baseUrl } = await startServer(t, {
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([]),
    env: { MAX_TOKENS: '999' },
  });
  for (const effort of ['off', 'low', 'high', 'max']) {
    await postChat(baseUrl, { message: `测试 ${effort} 档`, effort });
    assert.equal(mock.lastBody().max_tokens, 999, `effort=${effort} 应被显式 MAX_TOKENS 覆盖`);
  }
});

/* ------------------------------ 联网搜索 ------------------------------ */

test('webSearch 非法值返回 400 INVALID_REQUEST，缺省/空值按 off', async (t) => {
  const { baseUrl } = await startServer(t, {
    fetchImpl: standardMock().fetchImpl,
    retriever: createFakeRetriever([]),
  });
  for (const value of ['maybe', 'ON', 1, true, ['on']]) {
    const { status, data } = await apiJson(baseUrl, '/api/chat', {
      method: 'POST',
      body: { message: '孤独', webSearch: value },
    });
    assert.equal(status, 400, `webSearch=${JSON.stringify(value)} 应为 400`);
    assert.equal(data.error.code, 'INVALID_REQUEST');
    assert.match(data.error.message, /webSearch/);
  }

  const { events } = await postChat(baseUrl, { message: '孤独', webSearch: '' });
  assert.equal(events[0].data.webSearchUsed, 0);
  assert.equal(events.at(-1).event, 'done');
});

test('WEBSEARCH=1+CHAT_MOCK=1 时 webSearch:on → 本地 topK 3 + 联网 2 条合流', async (t) => {
  const retriever = createFakeRetriever([
    citationItem({ chunkId: 'seasonal-01#s2p1' }),
    citationItem({ chunkId: 'seasonal-01#s2p2' }),
    citationItem({ chunkId: 'seasonal-01#s2p3' }),
  ]);
  const { baseUrl, logger } = await startServer(t, {
    env: { WEBSEARCH: '1', CHAT_MOCK: '1' },
    retriever,
  });

  const { status, events } = await postChat(baseUrl, {
    message: '最近 AI 新闻有哪些',
    webSearch: 'on',
  });
  assert.equal(status, 200);
  const meta = events.find((event) => event.event === 'meta');
  assert.equal(meta.data.webSearchUsed, 2);
  // 联网开启时本地检索降到 3，给联网资料留预算。
  assert.equal(retriever.calls.length, 1);
  assert.equal(retriever.calls[0].topK, 3);
  // 本地 3 + 联网 2 = 5，c 连续、来源可区分。
  assert.equal(meta.data.citations.length, 5);
  assert.deepEqual(
    meta.data.citations.map((citation) => citation.c),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    meta.data.citations.map((citation) => citation.source),
    ['rag', 'rag', 'rag', 'web', 'web'],
  );
  assert.match(meta.data.citations[3].sourceUrl, /^https:\/\/example\.com\/web\//);
  assert.ok(!('text' in meta.data.citations[3]), 'meta.citations 不带正文');
  assert.equal(events.at(-1).event, 'done');
  assert.ok(logger.logs.some((entry) => entry.text.includes('[chat-terminal] 联网搜索 on')));
});

test('服务端开启但请求 webSearch:off → 不联网，本地 topK 保持 5', async (t) => {
  const retriever = createFakeRetriever(
    Array.from({ length: 6 }, (_, index) => citationItem({ chunkId: `seasonal-01#s2p${index + 1}` })),
  );
  const { baseUrl } = await startServer(t, {
    env: { WEBSEARCH: '1', CHAT_MOCK: '1' },
    retriever,
  });

  const { events } = await postChat(baseUrl, { message: '孤独', webSearch: 'off' });
  const meta = events[0];
  assert.equal(meta.data.webSearchUsed, 0);
  assert.equal(retriever.calls[0].topK, 5);
  assert.ok(meta.data.citations.every((citation) => citation.source === 'rag'));
});

test('服务端 WEBSEARCH=off（默认）时请求 webSearch:on 也不联网', async (t) => {
  const mock = standardMock();
  const retriever = createFakeRetriever([citationItem()]);
  const { baseUrl } = await startServer(t, { fetchImpl: mock.fetchImpl, retriever });

  const { events } = await postChat(baseUrl, { message: '最近 AI 新闻有哪些', webSearch: 'on' });
  assert.equal(events[0].data.webSearchUsed, 0);
  assert.equal(retriever.calls[0].topK, 5);
  assert.equal(mock.calls.length, 1, '只有上游 /v1/messages 一次调用');
});

test('WEBSEARCH_MOCK_MODE=fail 时联网降级为空，SSE 正常出 text_delta/done', async (t) => {
  const { baseUrl, logger } = await startServer(t, {
    env: { WEBSEARCH: '1', CHAT_MOCK: '1', WEBSEARCH_MOCK_MODE: 'fail' },
    retriever: createFakeRetriever([citationItem()]),
  });

  const { status, events } = await postChat(baseUrl, {
    message: '最近 AI 新闻有哪些',
    webSearch: 'on',
  });
  assert.equal(status, 200);
  assert.equal(events[0].data.webSearchUsed, 0);
  assert.ok(events.some((event) => event.event === 'text_delta'));
  assert.equal(events.at(-1).event, 'done');
  assert.ok(
    logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('mock 失败模式')),
  );
});

test('危机/身心困扰消息不联网（webSearchUsed=0，不发起搜索）', async (t) => {
  const { baseUrl, ctx } = await startServer(t, {
    env: { WEBSEARCH: '1', CHAT_MOCK: '1' },
    retriever: createFakeRetriever([citationItem()]),
  });

  const { events } = await postChat(baseUrl, { message: '我想极端想法', webSearch: 'on' });
  assert.equal(events[0].data.webSearchUsed, 0);
  assert.equal(ctx.webSearch.stats().searches, 0);
});

test('真实模式搜索 500 重试后降级，SSE 正常且 system 注入外部资料规则', async (t) => {
  const promptsDir = makeTmpDir('wild-prompts-web-');
  fs.cpSync(FIXTURE_PROMPTS, promptsDir, { recursive: true });
  writeFile(
    promptsDir,
    'websearch-rules.md',
    '外部资料规则：只能引用本轮实际给出的 cN，不得编造 URL。',
  );

  const mock = createFetchMock((call) => {
    if (call.url.includes('/v1/tools/search')) {
      return new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return sseResponse(standardUpstreamEvents());
  });
  const { baseUrl, logger } = await startServer(t, {
    promptsDir,
    env: { WEBSEARCH: '1' },
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([citationItem()]),
  });

  const { status, events } = await postChat(baseUrl, {
    message: '最近 AI 新闻有哪些',
    webSearch: 'on',
  });
  assert.equal(status, 200);
  const meta = events.find((event) => event.event === 'meta');
  assert.equal(meta.data.webSearchUsed, 0);
  assert.equal(meta.data.citations.length, 1);
  assert.equal(meta.data.citations[0].source, 'rag');
  assert.ok(events.some((event) => event.event === 'text_delta'));
  assert.equal(events.at(-1).event, 'done');

  // 搜索 500 重试一次（2 次请求）+ 上游 /v1/messages 1 次。
  assert.equal(mock.calls.length, 3);
  const system = mock.lastBody().system;
  assert.ok(system.includes('外部资料规则：只能引用本轮实际给出的 cN'));
  assert.ok(
    logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('[websearch] 搜索失败')),
  );
});

test(' 隐私——查询词脱敏后发送，日志不落手机号原文，联网模块不写缓存文件', async (t) => {
  const { baseUrl, dataDir, logger } = await startServer(t, {
    env: { WEBSEARCH: '1', CHAT_MOCK: '1' },
    retriever: createFakeRetriever([citationItem()]),
  });
  const phone = '13800138000';
  const { status, events } = await postChat(baseUrl, {
    message: `帮我查一下 ${phone} 这个号码的归属地`,
    webSearch: 'on',
  });
  assert.equal(status, 200);
  const meta = events.find((event) => event.event === 'meta');
  // 非危机消息，mock 模式下正常联网（手机号已在发送前脱敏为 [手机号]）。
  assert.equal(meta.data.webSearchUsed, 2);
  assert.equal(events.at(-1).event, 'done');

  // 日志只出现 query hash/长度/条数：手机号原文不得进日志。
  assert.ok(
    !logger.logs.some((entry) => entry.text.includes(phone)),
    '日志不得出现手机号原文',
  );
  // 联网搜索模块不落盘：DATA_DIR 不出现 cache/websearch 类文件。
  // （会话消息与由首条消息派生的标题属于既有会话持久化，不属于联网模块落盘。）
  const entries = fs.readdirSync(dataDir);
  assert.ok(!entries.some((name) => /cache|websearch|search/i.test(name)));
  assert.ok(!fs.existsSync(path.join(dataDir, 'websearch.json')));
});
