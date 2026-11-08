// -B / 分级记忆 schema v2 —— 迁移、排序、trivia 按需注入、PATCH 编辑、手动记忆豁免矛盾失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  apiJson,
  createCapturingLogger,
  createFakeRetriever,
  makeTmpDir,
  postChat,
  startServer,
  waitFor,
} from './helpers.mjs';
import { createStore } from '../../server/store.mjs';
import {
  MEMORY_HEADING,
  createMemoryService,
  hasRecallIntent,
  mockExtractMemories,
  parseExtractOutput,
  selectInjectable,
  triviaRelevance,
} from '../../server/memory.mjs';

const MEMORY_ID_RE = /^m[0-9a-f]{12}$/;

test('store：v1 memories.json 启动迁移为 v2（level=core / category=other / source=auto|upload）', async () => {
  const dataDir = makeTmpDir('wild-mem-migrate-');
  const file = path.join(dataDir, 'memories.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      memories: [
        { id: 'm111111111111', kind: 'profile', text: '用户叫小林', createdAt: 1000, validFrom: 1000, validTo: null },
        { id: 'm222222222222', kind: 'fact', text: '用户常熬夜', createdAt: 2000, validFrom: 2000, validTo: null },
        {
          id: 'm333333333333',
          kind: 'fact',
          text: '用户上传过一份笔记',
          createdAt: 3000,
          validFrom: 3000,
          validTo: null,
          attachments: [{ name: '笔记.txt', kind: 'text', mime: 'text/plain', size: 10 }],
        },
      ],
    }),
  );

  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const memories = store.listMemories();
  assert.equal(memories.length, 3);
  for (const memory of memories) {
    assert.equal(memory.level, 'core', `${memory.text} 迁移后应为 core`);
    assert.equal(memory.category, 'other', `${memory.text} 迁移后类目应为 other`);
  }
  assert.equal(memories.find((memory) => memory.id === 'm111111111111').source, 'auto');
  assert.equal(memories.find((memory) => memory.id === 'm333333333333').source, 'upload');
  // 排序：同 category=other，最近优先。
  assert.deepEqual(
    memories.map((memory) => memory.text),
    ['用户上传过一份笔记', '用户常熬夜', '用户叫小林'],
  );
  // 迁移结果异步回写为 version 2。
  assert.ok(await waitFor(() => JSON.parse(fs.readFileSync(file, 'utf8')).version === 2));
  assert.ok(fs.readFileSync(file, 'utf8').includes('"level": "core"'));
});

test('store：排序 core 类别优先级（general→…→other）→ trivia 最近优先', async () => {
  const dataDir = makeTmpDir('wild-mem-order-');
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  await store.addMemory({ text: '学业记忆', level: 'core', category: 'academic' });
  await store.addMemory({ text: '记忆', level: 'core', category: 'general' });
  await store.addMemory({ text: '家庭记忆一', level: 'core', category: 'family' });
  await store.addMemory({ text: '家庭记忆二', level: 'core', category: 'family' });
  await store.addMemory({ text: '琐事甲', level: 'trivia' });
  await store.addMemory({ text: '琐事乙', level: 'trivia' });

  assert.deepEqual(
    store.listMemories().map((memory) => memory.text),
    ['记忆', '家庭记忆二', '家庭记忆一', '学业记忆', '琐事乙', '琐事甲'],
  );
});

test('store.updateMemory：编辑 text/level/category 置 editedAt 并落盘（不改 createdAt）', async () => {
  const dataDir = makeTmpDir('wild-mem-edit-');
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const created = await store.addMemory({ text: '用户叫小林', kind: 'profile', level: 'core', category: 'demographics' });
  const updated = await store.updateMemory(created.id, { text: '  用户叫小林（北京）  ', level: 'trivia' });
  assert.equal(updated.text, '用户叫小林（北京）');
  assert.equal(updated.level, 'trivia');
  assert.equal(updated.category, 'other');
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(Number.isFinite(updated.editedAt));

  const recategorized = await store.updateMemory(created.id, { level: 'core', category: 'identity' });
  assert.equal(recategorized.level, 'core');
  assert.equal(recategorized.category, 'identity');
  assert.equal(await store.updateMemory('m000000000000', { text: 'x' }), null);

  const reloaded = await createStore({ dataDir, logger: createCapturingLogger() });
  const persisted = reloaded.listMemories().find((memory) => memory.id === created.id);
  assert.equal(persisted.text, '用户叫小林（北京）');
  assert.equal(persisted.category, 'identity');
  assert.equal(persisted.editedAt, recategorized.editedAt);
});

test('抽取矛盾软失效：仅 source=auto 且未编辑的旧条可失效；manual/编辑过的只跳过重复', async () => {
  const state = [];
  const store = {
    listMemories: () => state.map((memory) => ({ ...memory })),
    getActiveMemories: () => state.filter((memory) => !memory.validTo).map((memory) => ({ ...memory })),
    memoryTextList: () => state.map((memory) => memory.text),
    addMemory: async (input) => {
      const memory = {
        id: `m${String(state.length + 1).padStart(12, '0')}`,
        kind: 'fact',
        level: 'core',
        category: 'other',
        source: 'auto',
        text: input.text,
        createdAt: Date.now(),
        validFrom: Date.now(),
        validTo: null,
        ...input,
      };
      state.push(memory);
      return { ...memory };
    },
    invalidateMemory: async (id) => {
      const memory = state.find((entry) => entry.id === id);
      if (!memory) return false;
      memory.validTo = Date.now();
      return true;
    },
  };
  // 手工记忆 / 编辑过的自动记忆 / 普通自动记忆：三条与抽取项的 Jaccard 都落在 [0.5,0.8)。
  state.push(
    { id: 'm000000000001', kind: 'fact', level: 'core', category: 'other', source: 'manual', text: '用户喜欢熬夜看球', createdAt: 1, validFrom: 1, validTo: null },
    { id: 'm000000000002', kind: 'fact', level: 'core', category: 'other', source: 'auto', text: '用户常熬夜看球', createdAt: 2, validFrom: 2, validTo: null },
    { id: 'm000000000003', kind: 'fact', level: 'core', category: 'other', source: 'auto', text: '用户熬夜看球啊', createdAt: 3, validFrom: 3, validTo: null, editedAt: 9 },
  );
  const service = createMemoryService({
    store,
    config: { memory: true, memoryMax: 20, mock: false, memoryExtractTimeoutMs: 1000 },
    logger: createCapturingLogger(),
    callModel: async () =>
      JSON.stringify({ memories: [{ level: 'core', category: 'other', text: '用户熬夜看球赛' }] }),
    extractPrompt: '抽取规则',
  });
  const result = await service.extractAfterTurn({
    conversationId: 'c1',
    messages: [{ role: 'user', content: '我熬夜看球赛' }],
  });
  assert.equal(result.invalidated.length, 1, '只有普通 auto 记忆被软失效');
  assert.equal(result.invalidated[0].id, 'm000000000002');
  assert.equal(state.find((memory) => memory.id === 'm000000000001').validTo, null, 'manual 豁免');
  assert.equal(state.find((memory) => memory.id === 'm000000000003').validTo, null, '编辑过豁免');
  assert.equal(result.added.length, 1);
});

test('triviaRelevance：归一化（小写/去标点空白）2-gram Dice ≥0.15 判据', () => {
  assert.ok(triviaRelevance('周末去了图书馆吗', '周末去了图书馆') >= 0.15);
  assert.ok(triviaRelevance('今天天气不错', '周末去了图书馆') < 0.15);
  assert.ok(triviaRelevance('COFFEE, please!', 'coffee please') >= 0.15);
  assert.equal(triviaRelevance('', '周末去了图书馆'), 0);
  assert.equal(triviaRelevance('周末去了图书馆', ''), 0);
  // 触发词（含 定死的「以前」）
  assert.equal(hasRecallIntent('你还记得我周末去哪了吗'), true);
  assert.equal(hasRecallIntent('我以前说过这件事'), true);
  assert.equal(hasRecallIntent('之前说的话你还记得吗'), true);
  assert.equal(hasRecallIntent('今天天气不错'), false);
});

test('selectInjectable 纯函数：core ≤8；trivia 相关/不相关/触发词三类；总数受 max 限制', () => {
  const core = Array.from({ length: 10 }, (_, index) => ({
    id: `mc${index}`,
    level: 'core',
    category: index === 0 ? 'general' : 'other',
    text: `核心${index}`,
    validTo: null,
  }));
  const trivia = [
    { id: 't1', level: 'trivia', category: 'other', text: '周末去了图书馆', validTo: null },
    { id: 't2', level: 'trivia', category: 'other', text: '昨天晚上失眠了', validTo: null },
    { id: 't3', level: 'trivia', category: 'other', text: '下周三要考试', validTo: null },
  ];
  const active = [...core, ...trivia];

  // 无 query：只注入 core，上限 8。
  assert.equal(selectInjectable(active, { query: '' }).length, 8);
  // 相关 query（Dice 命中）→ core + 1 条相关 trivia。
  assert.deepEqual(
    selectInjectable(active, { query: '我周末去了图书馆' }).slice(8).map((memory) => memory.id),
    ['t1'],
  );
  // 不相关 query → trivia 0 条。
  assert.equal(selectInjectable(active, { query: '今天天气不错' }).length, 8);
  // 回忆意图词 → trivia 最多 3 条全部注入。
  assert.deepEqual(
    selectInjectable(active, { query: '你还记得我上次说的事情吗' }).slice(8).map((memory) => memory.id),
    ['t1', 't2', 't3'],
  );
  // 总数不超过 max。
  assert.equal(selectInjectable(active, { query: '你还记得上次吗', max: 5 }).length, 5);
  assert.deepEqual(selectInjectable([], { query: '记得' }), []);
});

test('HTTP：POST level/category 校验 + PATCH 编辑/400/404 + 落盘跨重启 + GET 新字段', async (t) => {
  const dataDir = makeTmpDir('wild-mem-http-');
  const first = await startServer(t, { retriever: createFakeRetriever([]), dataDir });

  const invalidLevel = await apiJson(first.baseUrl, '/api/memories', {
    method: 'POST',
    body: { text: '用户最近担忧', level: 'urgent' },
  });
  assert.equal(invalidLevel.status, 400);
  const invalidCategory = await apiJson(first.baseUrl, '/api/memories', {
    method: 'POST',
    body: { text: '用户最近担忧', category: 'nope' },
  });
  assert.equal(invalidCategory.status, 400);

  const created = await apiJson(first.baseUrl, '/api/memories', {
    method: 'POST',
    body: { text: '测试核心：最近担忧加重', level: 'core', category: 'general' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.memory.level, 'core');
  assert.equal(created.data.memory.category, 'general');
  assert.equal(created.data.memory.source, 'manual');
  const memoryId = created.data.memory.id;
  assert.match(memoryId, MEMORY_ID_RE);

  const patched = await apiJson(first.baseUrl, `/api/memories/${memoryId}`, {
    method: 'PATCH',
    body: { text: '  测试核心：最近担忧加重（已编辑）  ', level: 'trivia' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.memory.text, '测试核心：最近担忧加重（已编辑）');
  assert.equal(patched.data.memory.level, 'trivia');
  assert.equal(patched.data.memory.category, 'other');
  assert.ok(Number.isFinite(patched.data.memory.editedAt));

  const recategorized = await apiJson(first.baseUrl, `/api/memories/${memoryId}`, {
    method: 'PATCH',
    body: { level: 'core', category: 'family' },
  });
  assert.equal(recategorized.status, 200);
  assert.equal(recategorized.data.memory.category, 'family');

  for (const body of [
    {},
    { text: '' },
    { text: '   ' },
    { text: 'x'.repeat(801) },
    { text: 42 },
    { level: 'urgent' },
    { category: 'nope' },
  ]) {
    const bad = await apiJson(first.baseUrl, `/api/memories/${memoryId}`, { method: 'PATCH', body });
    assert.equal(bad.status, 400, `PATCH 应 400：${JSON.stringify(body)}`);
  }
  assert.equal(
    (await apiJson(first.baseUrl, '/api/memories/m-doesnotexist', { method: 'PATCH', body: { text: 'x' } })).status,
    404,
  );
  assert.equal(
    (await apiJson(first.baseUrl, '/api/memories/m000000000000', { method: 'PATCH', body: { text: 'x' } })).status,
    404,
  );

  const list = (await apiJson(first.baseUrl, '/api/memories')).data.memories;
  const found = list.find((memory) => memory.id === memoryId);
  assert.equal(found.text, '测试核心：最近担忧加重（已编辑）');
  assert.equal(found.level, 'core');
  assert.equal(found.category, 'family');
  assert.equal(found.source, 'manual');
  assert.ok(Number.isFinite(found.editedAt));

  // 落盘跨重启：编辑结果与 editedAt 保留。
  const second = await startServer(t, { retriever: createFakeRetriever([]), dataDir });
  const reloaded = (await apiJson(second.baseUrl, '/api/memories')).data.memories.find(
    (memory) => memory.id === memoryId,
  );
  assert.equal(reloaded.text, '测试核心：最近担忧加重（已编辑）');
  assert.equal(reloaded.category, 'family');
  assert.equal(reloaded.editedAt, recategorized.data.memory.editedAt);
});

test('PATCH 编辑上限 800（ 修复）：长上传记忆可编辑，801 拒绝', async (t) => {
  const dataDir = makeTmpDir('wild-mem-long-edit-');
  const longText = '这是一条带附件摘要的长记忆。'.repeat(40).slice(0, 600);
  fs.writeFileSync(
    path.join(dataDir, 'memories.json'),
    JSON.stringify({
      version: 2,
      memories: [
        {
          id: 'mabcdefabcdef',
          kind: 'fact',
          level: 'core',
          category: 'other',
          source: 'upload',
          text: longText,
          createdAt: 1000,
          validFrom: 1000,
          validTo: null,
          editedAt: null,
        },
      ],
    }),
  );
  const { baseUrl } = await startServer(t, { retriever: createFakeRetriever([]), dataDir });
  const list = await apiJson(baseUrl, '/api/memories');
  assert.equal(list.status, 200);
  assert.equal(list.data.memories.length, 1);
  const edited = await apiJson(baseUrl, '/api/memories/mabcdefabcdef', {
    method: 'PATCH',
    body: { text: longText.slice(0, 500) },
  });
  assert.equal(edited.status, 200, '长记忆（≤800）应允许编辑');
  assert.equal(edited.data.memory.text.length, 500);
  assert.ok(Number.isFinite(edited.data.memory.editedAt));
  const tooLong = await apiJson(baseUrl, '/api/memories/mabcdefabcdef', {
    method: 'PATCH',
    body: { text: 'x'.repeat(801) },
  });
  assert.equal(tooLong.status, 400);
});

test('HTTP mock 端到端（ 路径）：分级抽取 core + trivia 不相关轮不注入 / 回忆轮注入', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { CHAT_MOCK: '1', MEMORY: '1' },
    retriever: createFakeRetriever([]),
  });

  const first = await postChat(baseUrl, { message: '记住：我妈妈每次打电话都会说我哪里不够好，我最怕晚上一个人。' });
  assert.equal(first.events[0].data.memoryUsed, 0);
  assert.ok(await waitFor(async () => (await apiJson(baseUrl, '/api/memories')).data.memories.length === 1));
  const extracted = (await apiJson(baseUrl, '/api/memories')).data.memories[0];
  assert.equal(extracted.level, 'core');
  assert.equal(extracted.category, 'general');
  assert.equal(extracted.source, 'auto');

  const trivia = await apiJson(baseUrl, '/api/memories', {
    method: 'POST',
    body: { text: '周末去了图书馆', level: 'trivia' },
  });
  assert.equal(trivia.status, 201);
  assert.equal(trivia.data.memory.level, 'trivia');
  assert.equal(trivia.data.memory.category, 'other');

  const coreCount = (await apiJson(baseUrl, '/api/memories')).data.memories.filter(
    (memory) => memory.level === 'core',
  ).length;
  const unrelated = await postChat(baseUrl, { message: '今天天气不错。' });
  assert.equal(unrelated.events[0].data.memoryUsed, coreCount, '不相关轮不注入 trivia');
  const recall = await postChat(baseUrl, { message: '你还记得我周末去哪了吗？' });
  assert.ok(recall.events[0].data.memoryUsed > coreCount, '回忆轮应注入 trivia');
  assert.equal(recall.events[0].data.memoryUsed, coreCount + 1);
});

test('buildSystemSuffix：记忆段标题与注入数（核心经 chat 调用点传 query）', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { CHAT_MOCK: '1', MEMORY: '1' },
    retriever: createFakeRetriever([]),
  });
  await postChat(baseUrl, { message: '记住：我最怕晚上一个人。' });
  assert.ok(await waitFor(async () => (await apiJson(baseUrl, '/api/memories')).data.memories.length === 1));
  const second = await postChat(baseUrl, { message: '我今天有点难受。' });
  assert.equal(second.events[0].data.memoryUsed, 1);
  // mockExtractMemories 直测（分级字段）
  assert.equal(mockExtractMemories('我习惯晚上散步')[0].level, 'trivia');
  assert.equal(parseExtractOutput('{"memories":[]}').length, 0);
  const service = createMemoryService({
    store: {
      getActiveMemories: () => [
        { id: 'm1', level: 'core', category: 'general', text: '长期担忧', validTo: null },
      ],
      listMemories: () => [],
    },
    config: { memory: true, memoryMax: 20, mock: true },
    logger: createCapturingLogger(),
  });
  const suffix = service.buildSystemSuffix({ query: '' });
  assert.ok(suffix.text.includes(MEMORY_HEADING));
  assert.equal(suffix.count, 1);
});
