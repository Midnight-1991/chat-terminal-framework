import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer, createFakeRetriever, citationItem } from './helpers.mjs';

const DOC_KEYS = ['author', 'id', 'license', 'licenseUrl', 'sections', 'sourceUrl', 'title', 'year'];

test('GET /api/docs/{docId} 返回契约字段与完整章节', async (t) => {
  const { baseUrl } = await startServer(t, { retriever: createFakeRetriever([]) });
  const response = await fetch(`${baseUrl}/api/docs/seasonal-01`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);

  const doc = await response.json();
  assert.deepEqual(Object.keys(doc).sort(), DOC_KEYS);
  assert.equal(doc.id, 'seasonal-01');
  assert.equal(doc.title, '换季时节的观察笔记');
  assert.equal(doc.year, '2026');
  assert.equal(doc.license, 'LicenseRef-Synthetic-Fixture');
  assert.match(doc.licenseUrl, /^https:\/\/example\.com\//);
  assert.match(doc.sourceUrl, /^https:\/\//);

  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].anchor, 's1');
  assert.equal(doc.sections[0].heading, '一句话');
  assert.deepEqual(doc.sections[0].paragraphs, [{ para: 0, text: '换季不是问题，它是时间在生活里的形状。' }]);
  assert.equal(doc.sections[1].anchor, 's2');
  assert.deepEqual(
    doc.sections[1].paragraphs.map((paragraph) => paragraph.para),
    [1, 2],
  );
});

test('docs 的 anchor/para 能与检索 citation 对上（阅读器定位依赖）', async (t) => {
  const { baseUrl } = await startServer(t, { retriever: createFakeRetriever([]) });
  const doc = await (await fetch(`${baseUrl}/api/docs/seasonal-01`)).json();
  const citation = citationItem();
  const section = doc.sections.find((item) => item.anchor === citation.anchor);
  assert.ok(section, 'citation.anchor 必须能定位到 section');
  const paragraph = section.paragraphs.find((item) => item.para === citation.para);
  assert.ok(paragraph, 'citation.para 必须能定位到段落');
  assert.equal(paragraph.text, citation.text);
});

test('不存在的 docId / 非法 docId → 404 NOT_FOUND', async (t) => {
  const { baseUrl } = await startServer(t, { retriever: createFakeRetriever([]) });
  for (const path of ['/api/docs/no-such-doc', '/api/docs/UPPER', '/api/docs/..%2f..%2fsecret', '/api/docs/']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, path);
    const body = await response.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  }
});

test('docs 接口只接受 GET（POST 返回 404 JSON，不崩溃）', async (t) => {
  const { baseUrl } = await startServer(t, { retriever: createFakeRetriever([]) });
  const response = await fetch(`${baseUrl}/api/docs/seasonal-01`, { method: 'POST' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
});
