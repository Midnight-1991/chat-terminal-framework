import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, tokenize, termFrequency, hasCJK, cjkBigrams, STOPWORDS } from '../../rag/tokenize.mjs';

test('normalize 做 NFKC 归一与英文小写', () => {
  assert.equal(normalize('Ｈｅｌｌｏ　ＷＯＲＬＤ'), 'hello world');
  assert.equal(normalize('  ABC  ').trim(), 'abc');
  assert.equal(normalize(''), '');
});

test('tokenize 中文按词切分并保留实词', () => {
  const tokens = tokenize('我最近一到晚上就很孤独，睡不着');
  assert.ok(tokens.includes('孤独'), `应切出“孤独”，实际：${tokens.join('/')}`);
  assert.ok(tokens.includes('晚上'));
  assert.ok(tokens.includes('睡'));
  assert.ok(tokens.length >= 3);
  for (const token of tokens) assert.ok(!STOPWORDS.has(token), `停用词不应出现：${token}`);
});

test('tokenize 中英混排与空输入', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('   '), []);
  const tokens = tokenize('hello 认知 观察 晚间');
  assert.ok(tokens.includes('hello'));
  assert.ok(tokens.includes('认知'));
});

test('termFrequency 统计词频', () => {
  const freq = termFrequency(['孤独', '孤独', '睡眠']);
  assert.equal(freq.get('孤独'), 2);
  assert.equal(freq.get('睡眠'), 1);
  assert.equal(freq.size, 2);
});

test('hasCJK 识别中日韩统一表意文字', () => {
  assert.equal(hasCJK('孤独'), true);
  assert.equal(hasCJK('hello'), false);
  assert.equal(hasCJK('hi 你好'), true);
  assert.equal(hasCJK(''), false);
});

test('cjkBigrams 生成连续汉字二元组、跨标点/英文不连接', () => {
  const bigrams = cjkBigrams('孤独感很强');
  for (const expected of ['孤独', '独感', '感很', '很强']) {
    assert.ok(bigrams.includes(expected), `应包含 ${expected}，实际 ${bigrams.join('/')}`);
  }
  assert.deepEqual(cjkBigrams('好'), [], '单字无法构成 bigram');
  assert.deepEqual(cjkBigrams('hello'), [], '英文不产生中文 bigram');

  const mixed = cjkBigrams('hello 认知 观察');
  assert.ok(mixed.includes('认知'));
  assert.ok(!mixed.includes('知观'), '被空格/字母隔开的汉字不应连接');
});
