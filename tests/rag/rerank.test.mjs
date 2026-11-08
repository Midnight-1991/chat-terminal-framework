// tests/rag/rerank.test.mjs — LLM 重排器：prompt 构造、输出解析容错、超时/异常回退。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CANDIDATES,
  buildRerankPrompt,
  createReranker,
  parseRerankOutput
} from '../../rag/rerank.mjs';

const silentLogger = { warn() {}, log() {}, error() {} };

function candidates(n) {
  return Array.from({ length: n }, (_, index) => ({
    chunkId: `book-d${index}-01#s1p0`,
    docId: `book-d${index}-01`,
    title: `候选标题${index}`,
    heading: `小节${index}`,
    text: `候选正文内容第 ${index} 号，用于排序测试。`,
    score: 10 - index
  }));
}

function docIds(list) {
  return list.map((item) => item.docId);
}

test('buildRerankPrompt 包含查询、候选编号与正文摘要', () => {
  const prompt = buildRerankPrompt('我很孤独', candidates(3));
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.includes('我很孤独'));
  assert.ok(prompt.includes('[0]'));
  assert.ok(prompt.includes('[2]'));
  assert.ok(prompt.includes('候选标题1'));
  assert.ok(prompt.includes('JSON'), '应要求模型只输出 JSON 数组');
});

test('parseRerankOutput 解析普通 JSON 数组与 Markdown 围栏', () => {
  assert.deepEqual(parseRerankOutput('[2, 0, 1]', 3), [2, 0, 1]);
  assert.deepEqual(parseRerankOutput('```json\n[2, 0, 1]\n```', 3), [2, 0, 1]);
  assert.deepEqual(parseRerankOutput('排序结果如下：[2,1,0]，请复核。', 3), [2, 1, 0]);
});

test('parseRerankOutput 兼容 1-based 编号、对象数组与越界去重', () => {
  assert.deepEqual(parseRerankOutput('[1, 3, 2]', 3), [0, 2, 1], '整体 1-based 时自动减 1');
  assert.deepEqual(parseRerankOutput('[{"index":1},{"index":0}]', 2), [1, 0]);
  assert.deepEqual(parseRerankOutput('[2,2,0,5]', 3), [2, 0], '去重并丢弃越界编号');
});

test('parseRerankOutput 无法解析时返回 null', () => {
  assert.equal(parseRerankOutput('', 3), null);
  assert.equal(parseRerankOutput('没有数字的回复', 3), null);
  assert.equal(parseRerankOutput('[0,1,2]', 0), null);
});

test('rerank 使用模型输出顺序重排并截断 topK', async () => {
  const reranker = createReranker({ callModel: async () => '[2, 1, 0]', logger: silentLogger });
  const ranked = await reranker.rerank('查询', candidates(3), 3);
  assert.deepEqual(docIds(ranked), ['book-d2-01', 'book-d1-01', 'book-d0-01']);
  const top2 = await reranker.rerank('查询', candidates(3), 2);
  assert.deepEqual(docIds(top2), ['book-d2-01', 'book-d1-01']);
});

test('rerank 模型只返回部分编号时用原序补齐', async () => {
  const reranker = createReranker({ callModel: async () => '[2,0]', logger: silentLogger });
  const ranked = await reranker.rerank('查询', candidates(4), 3);
  assert.deepEqual(docIds(ranked), ['book-d2-01', 'book-d0-01', 'book-d1-01']);
});

test('rerank 模型输出无法解析时回退原序并 warn', async () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message), log() {}, error() {} };
  const reranker = createReranker({ callModel: async () => '我不知道怎么排序', logger });
  const input = candidates(3);
  const ranked = await reranker.rerank('查询', input, 2);
  assert.deepEqual(docIds(ranked), docIds(input.slice(0, 2)));
  assert.ok(warnings.some((message) => message.includes('回退原序')), `warnings=${warnings}`);
});

test('rerank 模型抛错时回退原序并 warn', async () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message), log() {}, error() {} };
  const reranker = createReranker({
    callModel: async () => {
      throw new Error('upstream 500');
    },
    logger
  });
  const input = candidates(3);
  const ranked = await reranker.rerank('查询', input, 3);
  assert.deepEqual(docIds(ranked), docIds(input));
  assert.ok(warnings.some((message) => message.includes('upstream 500')));
});

test('rerank 超时回退原序（8s 默认、可配置）', async () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message), log() {}, error() {} };
  const reranker = createReranker({
    callModel: () => new Promise(() => {}), // 永不 resolve，模拟上游卡住
    timeoutMs: 20,
    logger
  });
  const startedAt = Date.now();
  const input = candidates(12);
  const ranked = await reranker.rerank('查询', input, 3);
  const elapsed = Date.now() - startedAt;
  assert.deepEqual(docIds(ranked), docIds(input.slice(0, 3)));
  assert.ok(elapsed < 1000, `超时应快速回退，实际 ${elapsed}ms`);
  assert.ok(warnings.some((message) => message.includes('timeout')), `warnings=${warnings}`);
});

test('未注入 callModel 时返回原序并 warn', async () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message), log() {}, error() {} };
  const reranker = createReranker({ logger });
  const input = candidates(MAX_CANDIDATES + 5);
  const ranked = await reranker.rerank('查询', input, 5);
  assert.equal(ranked.length, 5);
  assert.deepEqual(docIds(ranked), docIds(input.slice(0, 5)));
  assert.ok(warnings.some((message) => message.includes('callModel')));
});
