// 收藏片段：/api/marks 路由 + marks store 持久化（API-CONTRACT 8 / DATA-CONTRACT 16）。
// 铁律：不写仓库里的 data/（每个用例用 tmpdir DATA_DIR）；不发真实网络请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createDocStore,
  createMarksStore,
  MARKS_FILE_NAME,
  MARKS_LIMITS,
  MARK_ID_RE,
} from '../../server/index.mjs';
import {
  apiJson,
  createCapturingLogger,
  createFakeRetriever,
  FIXTURE_CORPUS,
  makeTmpDir,
  postRaw,
  startServer,
} from './helpers.mjs';

const SEASONAL_SOURCE = JSON.parse(fs.readFileSync(path.join(FIXTURE_CORPUS, 'seasonal-01.json'), 'utf8'));
const SEASONAL_S1_P0 = SEASONAL_SOURCE.sections[0].paragraphs[0]; // s1 / para 0
const SEASONAL_S2_P1 = SEASONAL_SOURCE.sections[1].paragraphs[0]; // s2 / para 1
const SEASONAL_S2_P2 = SEASONAL_SOURCE.sections[1].paragraphs[1]; // s2 / para 2

/** 测试语料：seasonal-01 + 复制出的 seasonal-02（收藏去重/排序需要两本书）。 */
function makeMarksCorpus() {
  const dir = makeTmpDir('wild-marks-corpus-');
  fs.writeFileSync(path.join(dir, 'seasonal-01.json'), JSON.stringify(SEASONAL_SOURCE));
  const second = JSON.parse(JSON.stringify(SEASONAL_SOURCE));
  second.id = 'seasonal-02';
  second.title = '第二种观察笔记';
  fs.writeFileSync(path.join(dir, 'seasonal-02.json'), JSON.stringify(second));
  return dir;
}

/** 启动带收藏接口的测试服务（默认假检索器，不加载真实 rag）。 */
async function startMarksServer(t, options = {}) {
  return startServer(t, {
    retriever: createFakeRetriever([]),
    docsDir: makeMarksCorpus(),
    ...options,
  });
}

async function makeDocStore(docsDir) {
  return createDocStore({ docsDir, logger: { warn() {} } });
}

async function postMark(baseUrl, body) {
  return apiJson(baseUrl, '/api/marks', { method: 'POST', body });
}

function markedIds(body) {
  return {
    excerpts: body.excerpts.map((entry) => entry.id),
    favorites: body.favorites.map((entry) => entry.id),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('GET /api/marks：初始为空（三个字段齐全）', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const { response, status, data } = await apiJson(baseUrl, '/api/marks');
  assert.equal(response.status, 200);
  assert.equal(status, 200);
  assert.deepEqual(data, { excerpts: [], favorites: [], stats: { excerpts: 0, favorites: 0 } });
});

test('POST favorite：201 新建，视图含 bookTitle，GET 可见', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const { status, data } = await postMark(baseUrl, { kind: 'favorite', docId: 'seasonal-01' });
  assert.equal(status, 201);
  assert.equal(data.duplicated, false);
  assert.match(data.item.id, MARK_ID_RE);
  assert.equal(data.item.docId, 'seasonal-01');
  assert.equal(data.item.bookTitle, '换季时节的观察笔记');
  assert.ok(!Number.isNaN(Date.parse(data.item.createdAt)));

  const list = await apiJson(baseUrl, '/api/marks');
  assert.equal(list.status, 200);
  assert.deepEqual(markedIds(list.data).favorites, [data.item.id]);
  assert.deepEqual(list.data.stats, { excerpts: 0, favorites: 1 });
});

test('POST favorite：同一 docId 去重 → 200 duplicated:true，不新增', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const first = await postMark(baseUrl, { kind: 'favorite', docId: 'seasonal-01' });
  const second = await postMark(baseUrl, { kind: 'favorite', docId: 'seasonal-01' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.data.duplicated, true);
  assert.equal(second.data.item.id, first.data.item.id);
  const list = await apiJson(baseUrl, '/api/marks');
  assert.deepEqual(list.data.stats, { excerpts: 0, favorites: 1 });
});

test('POST excerpt：201，text 与 corpus 段落逐字一致，bookTitle/sectionHeading 正确', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const { status, data } = await postMark(baseUrl, {
    kind: 'excerpt',
    docId: 'seasonal-01',
    anchor: 's2',
    para: 2,
    // 客户端传入 text 不应生效（服务端从语料取）。
    text: '客户端伪造的正文',
  });
  assert.equal(status, 201);
  assert.equal(data.duplicated, false);
  assert.match(data.item.id, MARK_ID_RE);
  assert.equal(data.item.text, SEASONAL_S2_P2.text);
  assert.equal(data.item.bookTitle, '换季时节的观察笔记');
  assert.equal(data.item.sectionHeading, '换季时的常见现象');
  assert.equal(data.item.anchor, 's2');
  assert.equal(data.item.para, 2);

  const list = await apiJson(baseUrl, '/api/marks');
  assert.equal(list.data.excerpts.length, 1);
  assert.equal(list.data.excerpts[0].text, SEASONAL_S2_P2.text);
  assert.deepEqual(list.data.stats, { excerpts: 1, favorites: 0 });
});

test('POST excerpt：同 docId+anchor+para 去重 → 200 duplicated:true', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const payload = { kind: 'excerpt', docId: 'seasonal-01', anchor: 's2', para: 1 };
  const first = await postMark(baseUrl, payload);
  const second = await postMark(baseUrl, payload);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.data.duplicated, true);
  assert.equal(second.data.item.id, first.data.item.id);
  // 同一段落用不同 anchor 不是重复（不同 section 的坐标）。
  const list = await apiJson(baseUrl, '/api/marks');
  assert.equal(list.data.stats.excerpts, 1);
});

test('POST excerpt：文档不存在 → 404 DOC_NOT_FOUND（收藏同理）', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const excerpt = await postMark(baseUrl, {
    kind: 'excerpt',
    docId: 'no-such-doc',
    anchor: 's1',
    para: 0,
  });
  assert.equal(excerpt.status, 404);
  assert.equal(excerpt.data.error.code, 'DOC_NOT_FOUND');

  const favorite = await postMark(baseUrl, { kind: 'favorite', docId: 'no-such-doc' });
  assert.equal(favorite.status, 404);
  assert.equal(favorite.data.error.code, 'DOC_NOT_FOUND');
});

test('POST excerpt：section 或 para 不存在 → 404 PARA_NOT_FOUND', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const badAnchor = await postMark(baseUrl, {
    kind: 'excerpt',
    docId: 'seasonal-01',
    anchor: 's9',
    para: 0,
  });
  assert.equal(badAnchor.status, 404);
  assert.equal(badAnchor.data.error.code, 'PARA_NOT_FOUND');

  const badPara = await postMark(baseUrl, {
    kind: 'excerpt',
    docId: 'seasonal-01',
    anchor: 's2',
    para: 99,
  });
  assert.equal(badPara.status, 404);
  assert.equal(badPara.data.error.code, 'PARA_NOT_FOUND');
});

test('POST 参数校验：kind / docId / anchor / para 非法 → 400 INVALID_REQUEST', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const cases = [
    { kind: 'bookmark', docId: 'seasonal-01' },
    { docId: 'seasonal-01' },
    { kind: 'favorite' },
    { kind: 'favorite', docId: '' },
    { kind: 'favorite', docId: 42 },
    { kind: 'excerpt', docId: 'seasonal-01', para: 1 },
    { kind: 'excerpt', docId: 'seasonal-01', anchor: '', para: 1 },
    { kind: 'excerpt', docId: 'seasonal-01', anchor: 's2' },
    { kind: 'excerpt', docId: 'seasonal-01', anchor: 's2', para: -1 },
    { kind: 'excerpt', docId: 'seasonal-01', anchor: 's2', para: '2' },
    { kind: 'excerpt', docId: 'seasonal-01', anchor: 's2', para: 1.5 },
  ];
  for (const body of cases) {
    const { status, data } = await postMark(baseUrl, body);
    assert.equal(status, 400, `应 400：${JSON.stringify(body)}`);
    assert.equal(data.error.code, 'INVALID_REQUEST');
  }
});

test('POST 请求体非法：空体 / 坏 JSON / 数组 → 400 INVALID_REQUEST', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const jsonHeaders = { 'content-type': 'application/json' };
  const empty = await postRaw(baseUrl, '/api/marks', '', { headers: jsonHeaders });
  assert.equal(empty.status, 400);
  assert.equal(JSON.parse(empty.text).error.code, 'INVALID_REQUEST');

  const broken = await postRaw(baseUrl, '/api/marks', '{ not json', { headers: jsonHeaders });
  assert.equal(broken.status, 400);
  assert.equal(JSON.parse(broken.text).error.code, 'INVALID_REQUEST');

  const array = await postMark(baseUrl, []);
  assert.equal(array.status, 400);
  assert.equal(array.data.error.code, 'INVALID_REQUEST');

  // 全局 JSON 校验：带请求体但 content-type 不是 JSON → 415（契约 0/全局约定）。
  const notJson = await postRaw(baseUrl, '/api/marks', 'kind=favorite&docId=seasonal-01', {
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(notJson.status, 415);
  assert.equal(JSON.parse(notJson.text).error.code, 'INVALID_REQUEST');
});

test('上限：摘录达上限后 → 429 TOO_MANY_MARKS（不淘汰旧数据）', async (t) => {
  const { baseUrl } = await startMarksServer(t, { marksLimits: { MAX_EXCERPTS: 1 } });
  const first = await postMark(baseUrl, { kind: 'excerpt', docId: 'seasonal-01', anchor: 's1', para: 0 });
  assert.equal(first.status, 201);
  const second = await postMark(baseUrl, { kind: 'excerpt', docId: 'seasonal-01', anchor: 's2', para: 1 });
  assert.equal(second.status, 429);
  assert.equal(second.data.error.code, 'TOO_MANY_MARKS');
  const list = await apiJson(baseUrl, '/api/marks');
  assert.deepEqual(markedIds(list.data).excerpts, [first.data.item.id]);
});

test('上限：收藏达上限后 → 429 TOO_MANY_MARKS（默认上限各 500）', async (t) => {
  const { baseUrl } = await startMarksServer(t, { marksLimits: { MAX_FAVORITES: 1 } });
  const first = await postMark(baseUrl, { kind: 'favorite', docId: 'seasonal-01' });
  assert.equal(first.status, 201);
  const second = await postMark(baseUrl, { kind: 'favorite', docId: 'seasonal-02' });
  assert.equal(second.status, 429);
  assert.equal(second.data.error.code, 'TOO_MANY_MARKS');
  assert.deepEqual(MARKS_LIMITS, { MAX_EXCERPTS: 500, MAX_FAVORITES: 500 });
});

test('GET 视图：摘录/收藏分区，均按 createdAt 倒序', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const olderExcerpt = await postMark(baseUrl, { kind: 'excerpt', docId: 'seasonal-01', anchor: 's1', para: 0 });
  const olderFavorite = await postMark(baseUrl, { kind: 'favorite', docId: 'seasonal-01' });
  await sleep(5);
  const newerExcerpt = await postMark(baseUrl, { kind: 'excerpt', docId: 'seasonal-02', anchor: 's2', para: 2 });
  const newerFavorite = await postMark(baseUrl, { kind: 'favorite', docId: 'seasonal-02' });
  const { data } = await apiJson(baseUrl, '/api/marks');
  assert.deepEqual(markedIds(data), {
    excerpts: [newerExcerpt.data.item.id, olderExcerpt.data.item.id],
    favorites: [newerFavorite.data.item.id, olderFavorite.data.item.id],
  });
  assert.equal(data.excerpts[0].bookTitle, '第二种观察笔记');
  assert.equal(data.favorites[0].bookTitle, '第二种观察笔记');
  assert.deepEqual(data.stats, { excerpts: 2, favorites: 2 });
});

test('DELETE /api/marks/:id：摘录 200 → 移除；重复删除 404', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const created = await postMark(baseUrl, { kind: 'excerpt', docId: 'seasonal-01', anchor: 's2', para: 2 });
  const deleted = await apiJson(baseUrl, `/api/marks/${created.data.item.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, { ok: true });

  const list = await apiJson(baseUrl, '/api/marks');
  assert.deepEqual(list.data.stats, { excerpts: 0, favorites: 0 });

  const again = await apiJson(baseUrl, `/api/marks/${created.data.item.id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
  assert.equal(again.data.error.code, 'NOT_FOUND');
});

test('DELETE /api/marks/:id：收藏 200 → 移除', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const created = await postMark(baseUrl, { kind: 'favorite', docId: 'seasonal-02' });
  const deleted = await apiJson(baseUrl, `/api/marks/${created.data.item.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const list = await apiJson(baseUrl, '/api/marks');
  assert.deepEqual(list.data.stats, { excerpts: 0, favorites: 0 });
});

test('DELETE 非法 id / 不存在 id → 404 NOT_FOUND', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  for (const id of ['not-a-mark', 'mk_1234', 'mk_zzzzzzzzzzzz', 'mk_000000000000']) {
    const { status, data } = await apiJson(baseUrl, `/api/marks/${id}`, { method: 'DELETE' });
    assert.equal(status, 404, `应 404：${id}`);
    assert.equal(data.error.code, 'NOT_FOUND');
  }
});

test('方法不允许：PUT /api/marks → 404；HEAD 正常 200', async (t) => {
  const { baseUrl } = await startMarksServer(t);
  const put = await apiJson(baseUrl, '/api/marks', { method: 'PUT', body: {} });
  assert.equal(put.status, 404);
  const head = await fetch(`${baseUrl}/api/marks`, { method: 'HEAD' });
  assert.equal(head.status, 200);
});

test('重启（HTTP 层）：同一 DATA_DIR 重启服务后收藏片段仍在', async (t) => {
  const corpusDir = makeMarksCorpus();
  const dataDir = makeTmpDir('wild-marks-data-');
  const first = await startMarksServer(t, { dataDir, docsDir: corpusDir });
  const favorite = await postMark(first.baseUrl, { kind: 'favorite', docId: 'seasonal-01' });
  const excerpt = await postMark(first.baseUrl, { kind: 'excerpt', docId: 'seasonal-02', anchor: 's2', para: 2 });
  const before = await apiJson(first.baseUrl, '/api/marks');
  await new Promise((resolve) => first.server.close(() => resolve()));

  const second = await startMarksServer(t, { dataDir, docsDir: corpusDir });
  const after = await apiJson(second.baseUrl, '/api/marks');
  assert.deepEqual(after.data, before.data);
  assert.deepEqual(markedIds(after.data).favorites, [favorite.data.item.id]);
  assert.deepEqual(markedIds(after.data).excerpts, [excerpt.data.item.id]);
});

test('重启（store 层）：flush 后重建 store，数据与视图完全一致', async () => {
  const corpusDir = makeMarksCorpus();
  const dataDir = makeTmpDir('wild-marks-data-');
  const docStore = await makeDocStore(corpusDir);
  const logger = createCapturingLogger();
  const first = await createMarksStore({ dataDir, logger, docStore });
  const excerpt = await first.addExcerpt({ docId: 'seasonal-01', anchor: 's2', para: 2 });
  const favorite = await first.addFavorite({ docId: 'seasonal-02' });
  await first.flush();
  const before = first.list();

  const second = await createMarksStore({ dataDir, logger, docStore });
  const after = second.list();
  assert.deepEqual(after, before);
  assert.equal(after.excerpts[0].id, excerpt.item.id);
  assert.equal(after.excerpts[0].text, SEASONAL_S2_P2.text);
  assert.equal(after.favorites[0].id, favorite.item.id);
  assert.ok(fs.existsSync(path.join(dataDir, MARKS_FILE_NAME)));
});

test('写入文件权限 600，且原子写不留下 .tmp 残留', async () => {
  const corpusDir = makeMarksCorpus();
  const dataDir = makeTmpDir('wild-marks-data-');
  const docStore = await makeDocStore(corpusDir);
  const store = await createMarksStore({ dataDir, docStore, logger: createCapturingLogger() });
  await store.addExcerpt({ docId: 'seasonal-01', anchor: 's1', para: 0 });
  await store.flush();
  const filePath = path.join(dataDir, MARKS_FILE_NAME);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  assert.deepEqual(
    fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('marks.json 损坏 → warn + 视为空，之后仍可正常写入', async () => {
  const corpusDir = makeMarksCorpus();
  const dataDir = makeTmpDir('wild-marks-data-');
  fs.writeFileSync(path.join(dataDir, MARKS_FILE_NAME), '{ broken json');
  const logger = createCapturingLogger();
  const docStore = await makeDocStore(corpusDir);
  const store = await createMarksStore({ dataDir, docStore, logger });
  assert.deepEqual(store.list(), { excerpts: [], favorites: [], stats: { excerpts: 0, favorites: 0 } });
  assert.ok(logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('解析失败')));

  await store.addFavorite({ docId: 'seasonal-01' });
  await store.flush();
  const reloaded = await createMarksStore({ dataDir, docStore, logger: createCapturingLogger() });
  assert.deepEqual(reloaded.stats(), { excerpts: 0, favorites: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, MARKS_FILE_NAME), 'utf8')).version, 1);
});

test('marks.json 部分无效记录 → 忽略无效项并 warn，保留合法项', async () => {
  const corpusDir = makeMarksCorpus();
  const dataDir = makeTmpDir('wild-marks-data-');
  const validFavorite = {
    id: 'mk_0123456789ab',
    docId: 'seasonal-01',
    createdAt: '2026-10-31T12:00:00.000Z',
  };
  fs.writeFileSync(
    path.join(dataDir, MARKS_FILE_NAME),
    JSON.stringify({
      version: 1,
      excerpts: [{ id: 'broken', docId: 'seasonal-01', anchor: 's1', para: 0, text: 'x', createdAt: 'x' }],
      favorites: [validFavorite, { id: 'mk_ffffffffffff', docId: '' }],
    }),
  );
  const logger = createCapturingLogger();
  const docStore = await makeDocStore(corpusDir);
  const store = await createMarksStore({ dataDir, docStore, logger });
  assert.deepEqual(store.stats(), { excerpts: 0, favorites: 1 });
  assert.ok(logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('无效记录')));
});

test('DATA_DIR 不可写 → 内存降级 + warn，写操作仍然可用', async () => {
  const corpusDir = makeMarksCorpus();
  const parent = makeTmpDir('wild-marks-blocked-');
  const blocker = path.join(parent, 'blocked');
  fs.writeFileSync(blocker, 'not a directory');
  const dataDir = path.join(blocker, 'data');
  const logger = createCapturingLogger();
  const docStore = await makeDocStore(corpusDir);
  const store = await createMarksStore({ dataDir, docStore, logger });
  assert.equal(store.degraded(), true);
  assert.ok(
    logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('降级为内存模式')),
  );
  const added = await store.addFavorite({ docId: 'seasonal-01' });
  assert.equal(added.duplicated, false);
  assert.deepEqual(store.stats(), { excerpts: 0, favorites: 1 });
  assert.equal(fs.existsSync(path.join(dataDir, MARKS_FILE_NAME)), false);
});

test('语料中已不存在的 docId → 视图 bookTitle/sectionHeading 退化为空串（不崩）', async () => {
  const dataDir = makeTmpDir('wild-marks-data-');
  fs.writeFileSync(
    path.join(dataDir, MARKS_FILE_NAME),
    JSON.stringify({
      version: 1,
      excerpts: [
        {
          id: 'mk_aaaaaaaaaaaa',
          docId: 'removed-doc',
          anchor: 's1',
          para: 0,
          text: '旧语料正文',
          createdAt: '2026-10-31T12:00:00.000Z',
        },
      ],
      favorites: [
        { id: 'mk_bbbbbbbbbbbb', docId: 'removed-doc', createdAt: '2026-10-31T11:00:00.000Z' },
      ],
    }),
  );
  const docStore = await makeDocStore(makeMarksCorpus());
  const store = await createMarksStore({ dataDir, docStore, logger: createCapturingLogger() });
  const list = store.list();
  assert.deepEqual(list.stats, { excerpts: 1, favorites: 1 });
  assert.equal(list.excerpts[0].bookTitle, '');
  assert.equal(list.excerpts[0].sectionHeading, '');
  assert.equal(list.excerpts[0].text, '旧语料正文');
  assert.equal(list.favorites[0].bookTitle, '');
  assert.equal(list.favorites[0].id, 'mk_bbbbbbbbbbbb');
});
