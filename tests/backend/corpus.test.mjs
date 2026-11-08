// tests/backend/corpus.test.mjs — 语料单次加载（server/corpus.mjs）+ 注入式 docStore。
//
// plan.md 语料只读一次并共享给 docStore / library / retriever；本文件校验：
//   1. loadCorpus 的读取顺序/过滤/容错与改造前 docStore 行为一致；
//   2. createDocStore({docs}) 注入路径不再读盘（docsDir 不存在也能工作）；
//   3. server createContext 里 docStore / retriever 拿到同一批 doc（无重复解析）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadCorpus } from '../../server/corpus.mjs';
import { createDocStore } from '../../server/docstore.mjs';
import {
  FIXTURE_LIBRARY,
  HERE,
  createCapturingLogger,
  makeTmpDir,
  startServer,
} from './helpers.mjs';

const REPO_ROOT = path.resolve(HERE, '../..');

/** 写一个最小合法 doc。 */
function writeDoc(dir, name, doc) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));
}

const makeDoc = (id, text = '一段正文。') => ({
  id,
  title: id,
  license: 'Public Domain',
  sections: [{ anchor: 's1', heading: '小节', paragraphs: [{ para: 0, text }] }],
});

test('loadCorpus：按文件名排序读取；跳过 `_` 元数据/坏 JSON/缺 id 并 warn；byId 与 docs 同对象', async () => {
  const dir = makeTmpDir('wild-corpus-');
  writeDoc(dir, 'b-doc.json', makeDoc('doc-b'));
  writeDoc(dir, 'a-doc.json', makeDoc('doc-a'));
  writeDoc(dir, '_manifest.json', { books: [] });
  fs.writeFileSync(path.join(dir, 'c-broken.json'), '{ this is not json');
  writeDoc(dir, 'd-no-id.json', { title: '没有 id' });

  const logger = createCapturingLogger();
  const corpus = await loadCorpus({ docsDir: dir, logger });
  assert.deepEqual(corpus.docs.map((doc) => doc.id), ['doc-a', 'doc-b'], '按文件名排序');
  assert.deepEqual(corpus.files.map((file) => file.name), ['a-doc.json', 'b-doc.json']);
  assert.equal(corpus.byId.get('doc-a'), corpus.docs[0], 'byId 与 docs 应为同一 doc 对象（单次解析共享）');
  assert.equal(corpus.byId.get('doc-b'), corpus.docs[1]);
  assert.equal(corpus.byId.size, 2);
  assert.ok(logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('c-broken.json')), '坏 JSON 应 warn');
  assert.ok(logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('d-no-id.json')), '缺 id 应 warn');
});

test('loadCorpus：目录不可读 → 空结果 + warn（不抛错，启动降级）', async () => {
  const logger = createCapturingLogger();
  const corpus = await loadCorpus({ docsDir: path.join(makeTmpDir('wild-missing-'), 'nope'), logger });
  assert.deepEqual(corpus.docs, []);
  assert.deepEqual(corpus.files, []);
  assert.equal(corpus.byId.size, 0);
  assert.ok(logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('语料目录不可读')));
});

test('createDocStore 注入 docs：不再读盘（docsDir 不存在也能工作），契约字段归一化', async () => {
  const docs = [
    {
      id: 'doc-x',
      title: '甲',
      author: '作者',
      sourceUrl: 'https://example.com/x',
      license: '政府公开',
      sections: [{ anchor: 's1', heading: '标题', paragraphs: [{ para: 0, text: '正文一' }, { para: 1, text: '正文二' }] }],
      hooks: ['不应暴露的内部字段'],
      tags: ['不应暴露'],
    },
  ];
  const store = await createDocStore({ docsDir: '/no/such/corpus-dir', docs });
  assert.deepEqual(store.stats().docs, 1);
  assert.deepEqual(store.stats().chunks, 2);
  assert.ok(store.has('doc-x'));
  const doc = store.get('doc-x');
  assert.equal(doc.title, '甲');
  assert.equal(doc.sections[0].heading, '标题');
  assert.equal('hooks' in doc, false, '注入路径仍只暴露契约字段');
  assert.deepEqual(store.get('missing'), null);
});

test('createContext 中 docStore 与 retriever 共享同一批语料（docs/chunks 一致）', async (t) => {
  // 用后端夹具语料启动真实 createContext（不注入 retriever → 走真实 rag/index.mjs，夹具很小、构建快）。
  const { ctx } = await startServer(t, { docsDir: FIXTURE_LIBRARY, repoRoot: REPO_ROOT });
  assert.ok(ctx.retriever, '应加载到真实检索器（repoRoot 指向仓库）');
  const docStats = ctx.docStore.stats();
  const retrieverStats = ctx.retriever.stats();
  assert.equal(retrieverStats.docs, docStats.docs, 'docStore 与 retriever 的 docs 数应一致（同一批语料）');
  assert.equal(retrieverStats.chunks, docStats.chunks, 'docStore 与 retriever 的 chunks 数应一致');
  assert.deepEqual(ctx.library.get().stats.docs, docStats.docs);
});
