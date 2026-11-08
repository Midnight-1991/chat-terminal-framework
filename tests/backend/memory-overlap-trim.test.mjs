// 记忆事件条文本裁剪：迁移/抽取期裁掉复述概括的子句，保留事件特有部分。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createCapturingLogger, makeTmpDir } from './helpers.mjs';
import { createStore } from '../../server/store.mjs';
import {
  applyOverlapRules,
  containmentRatio,
  createMemoryService,
  migrateOverlaps,
  trimEventOverlap,
} from '../../server/memory.mjs';

// 合成示例记忆（示例种子原文，请勿修改）。
const GENERAL = '我总是想起以前做错的事，感到很烦躁'; // 概括条 core/general
const EVENT = '我总想起以前做错的事，感到烦躁，尤其记得初中当众检举同学不当言行的事'; // 事件条（ 后 trivia/other）
const TRIMMED_EVENT = '尤其记得初中当众检举同学不当言行的事'; //  目标形态

const GENERAL_MEMORY = {
  id: 'm111111111111',
  kind: 'fact',
  level: 'core',
  category: 'general',
  source: 'auto',
  text: GENERAL,
  createdAt: 1,
  validFrom: 1,
  validTo: null,
};
function eventMemory(patch = {}) {
  return {
    id: 'm222222222222',
    kind: 'fact',
    level: 'core',
    category: 'general',
    source: 'auto',
    text: EVENT,
    createdAt: 2,
    validFrom: 2,
    validTo: null,
    ...patch,
  };
}

/** 内存版 store（模拟 server/store.mjs 的记忆方法语义，供抽取/迁移单测）。 */
function createStateStore(initial = []) {
  const state = initial.map((memory) => ({ ...memory }));
  return {
    state,
    listMemories: () => state.map((memory) => ({ ...memory })),
    getActiveMemories: () => state.filter((memory) => !memory.validTo).map((memory) => ({ ...memory })),
    memoryTextList: () => state.map((memory) => memory.text),
    addMemory: async (input = {}) => {
      const memory = {
        id: `m${String(state.length + 1).padStart(12, '0')}`,
        kind: 'fact',
        level: 'core',
        category: 'other',
        source: 'auto',
        createdAt: Date.now(),
        validFrom: Date.now(),
        validTo: null,
        ...input,
      };
      if (memory.level === 'trivia') memory.category = 'other';
      state.push(memory);
      return { ...memory };
    },
    invalidateMemory: async (id) => {
      const memory = state.find((entry) => entry.id === id);
      if (!memory) return false;
      memory.validTo = Date.now();
      return true;
    },
    updateMemory: async (id, patch = {}) => {
      const memory = state.find((entry) => entry.id === id);
      if (!memory) return null;
      if (Object.prototype.hasOwnProperty.call(patch, 'text')) memory.text = String(patch.text).trim();
      if (patch.level === 'core' || patch.level === 'trivia') memory.level = patch.level;
      if (typeof patch.category === 'string') memory.category = patch.category;
      if (memory.level === 'trivia') memory.category = 'other';
      memory.editedAt = Date.now();
      return { ...memory };
    },
  };
}

function createService(store, callModel) {
  return createMemoryService({
    store,
    config: { memory: true, memoryMax: 20, mock: false, memoryExtractTimeoutMs: 1000 },
    logger: createCapturingLogger(),
    callModel,
    extractPrompt: '抽取规则',
  });
}

/* --------------------------- 纯函数：trimEventOverlap --------------------------- */

test('trimEventOverlap：示例案例裁剪为事件特有部分', () => {
  const trimmed = trimEventOverlap(EVENT, GENERAL);
  assert.equal(trimmed, TRIMMED_EVENT);
  // 不再复述概括条内容（ 的 noOverlap 判定）。
  assert.ok(!trimmed.includes('我总是想起以前做错的事'));
  assert.ok(!trimmed.includes('感到烦躁'));
  // 裁剪后与概括条不再达到迁移/降级阈值 → 幂等。
  assert.ok(containmentRatio(trimmed, GENERAL) < 0.7);
  assert.equal(trimEventOverlap(trimmed, GENERAL), trimmed, '再裁一次不再变化');
});

test('trimEventOverlap：无重叠/空串/单子句/无标点等边界保留原文', () => {
  const unrelated = '周末去了图书馆，借了两本书。';
  assert.equal(trimEventOverlap(unrelated, GENERAL), unrelated, '无重叠不重建、原文保持不变');
  assert.equal(trimEventOverlap('', GENERAL), '');
  assert.equal(trimEventOverlap(EVENT, ''), EVENT, '无概括条时保留原文');
  assert.equal(trimEventOverlap('你好呀', GENERAL), '你好呀', '单子句无标点不崩');
  assert.equal(trimEventOverlap('   ', GENERAL), '   ', '空白串原样返回');
  assert.equal(trimEventOverlap(null, GENERAL), '');
});

test('trimEventOverlap：全部子句都在复述概括 → 保留原文（不产生空文本）', () => {
  const allOverlap = '我总是想起以前做错的事，我感到很烦躁';
  assert.equal(trimEventOverlap(allOverlap, GENERAL), allOverlap);
});

test('trimEventOverlap：部分子句重叠 → 只保留事件子句并清理首尾标点', () => {
  const general = '今天下雨心情不好';
  const event = '今天下雨，心情不好，尤其记得那次在图书馆遇见他。';
  assert.equal(trimEventOverlap(event, general), '尤其记得那次在图书馆遇见他');
  // 中间保留多个子句时用「，」重建，顺序不变。
  const multi = '今天下雨，尤其记得那次在图书馆遇见他，后来一起吃了饭';
  assert.equal(trimEventOverlap(multi, general), '尤其记得那次在图书馆遇见他，后来一起吃了饭');
});

/* --------------------------- applyOverlapRules 接入 --------------------------- */

test('applyOverlapRules 规则 2：新 core 事件条降 trivia 时同步裁剪文本', () => {
  const decision = applyOverlapRules({ level: 'core', category: 'general', kind: 'fact', text: EVENT }, [GENERAL_MEMORY]);
  assert.equal(decision.action, 'add');
  assert.equal(decision.reason, 'event-demoted');
  assert.equal(decision.item.level, 'trivia');
  assert.equal(decision.item.category, 'other');
  assert.equal(decision.item.text, TRIMMED_EVENT);
  assert.deepEqual(decision.invalidateIds, []);
  assert.deepEqual(decision.demoteIds, []);
  assert.deepEqual(decision.demoteText, {});
});

test('applyOverlapRules 规则 2b：本身是 trivia 的事件条与概括 core 重叠时裁剪；无重叠不动', () => {
  const decision = applyOverlapRules({ level: 'trivia', category: 'other', text: EVENT }, [GENERAL_MEMORY]);
  assert.equal(decision.action, 'add');
  assert.equal(decision.item.level, 'trivia');
  assert.equal(decision.item.category, 'other');
  assert.equal(decision.item.text, TRIMMED_EVENT);

  const unrelated = applyOverlapRules({ level: 'trivia', category: 'other', text: '周末去了图书馆，借了两本书' }, [GENERAL_MEMORY]);
  assert.equal(unrelated.action, 'add');
  assert.equal(unrelated.item.text, '周末去了图书馆，借了两本书', '无重叠保持原文');
});

test('applyOverlapRules 规则 3：概括替代旧事件 core → demoteText 给出裁剪后的旧条文本', () => {
  const oldEvent = eventMemory();
  const decision = applyOverlapRules({ level: 'core', category: 'general', kind: 'fact', text: GENERAL }, [oldEvent]);
  assert.equal(decision.action, 'add');
  assert.equal(decision.reason, 'replaced-event');
  assert.equal(decision.item.text, GENERAL);
  assert.deepEqual(decision.demoteIds, [oldEvent.id]);
  assert.deepEqual(decision.demoteText, { [oldEvent.id]: TRIMMED_EVENT });
  assert.deepEqual(decision.invalidateIds, []);
});

/* --------------------------- 抽取路径 --------------------------- */

test('extractAfterTurn：事件扩写既有概括 → 落库 trivia/other 且文本已裁剪', async () => {
  const store = createStateStore([GENERAL_MEMORY]);
  const service = createService(
    store,
    async () => JSON.stringify({ memories: [{ level: 'core', category: 'general', kind: 'fact', text: EVENT }] }),
  );
  const result = await service.extractAfterTurn({
    conversationId: 'c1',
    messages: [{ role: 'user', content: EVENT }],
  });
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].level, 'trivia');
  assert.equal(result.added[0].category, 'other');
  assert.equal(result.added[0].text, TRIMMED_EVENT);
  assert.equal(result.skipped.length, 0);
  assert.equal(store.state.find((memory) => memory.id === GENERAL_MEMORY.id).text, GENERAL, '概括条不动');
});

test('extractAfterTurn：概括替代旧事件 core → updateMemory 写回裁剪文本（不删数据）', async () => {
  const oldEvent = eventMemory();
  const store = createStateStore([oldEvent]);
  const service = createService(
    store,
    async () => JSON.stringify({ memories: [{ level: 'core', category: 'general', kind: 'fact', text: GENERAL }] }),
  );
  const result = await service.extractAfterTurn({
    conversationId: 'c1',
    messages: [{ role: 'user', content: GENERAL }],
  });
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].level, 'core');
  assert.deepEqual(result.demoted.map((entry) => entry.id), [oldEvent.id]);
  const demoted = store.state.find((memory) => memory.id === oldEvent.id);
  assert.equal(demoted.level, 'trivia');
  assert.equal(demoted.category, 'other');
  assert.equal(demoted.validTo, null, '只降级不失效');
  assert.equal(demoted.text, TRIMMED_EVENT, '降级时文本一并裁剪');
  assert.equal(store.state.length, 2);
});

/* --------------------------- 启动迁移（migrateOverlaps v2） --------------------------- */

test('migrateOverlaps 第一遍：core 事件条降 trivia/other 并同步裁剪文本（ 形态、幂等）', async (t) => {
  const dataDir = makeTmpDir('wild-mem-trim-migrate-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'memories.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, memories: [GENERAL_MEMORY, eventMemory()] }), 'utf8');

  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const logs = [];
  const logger = { log: (line) => logs.push(String(line)), warn: () => {} };
  const result = await migrateOverlaps(store, logger);
  assert.deepEqual(result, { migrated: 1, trimmed: 0 });
  assert.ok(logs.some((line) => line.includes('1 条事件记忆降为 trivia')), '日志统计降级条数');

  const memories = store.listMemories();
  assert.equal(memories.length, 2, '不删数据');
  const general = memories.find((memory) => memory.id === GENERAL_MEMORY.id);
  const event = memories.find((memory) => memory.id === 'm222222222222');
  assert.equal(general.level, 'core');
  assert.equal(general.category, 'general');
  assert.equal(general.text, GENERAL, '概括条文本不变');
  assert.equal(event.level, 'trivia');
  assert.equal(event.category, 'other');
  assert.equal(event.text, TRIMMED_EVENT, '事件条文本已裁剪');

  // 幂等：二次运行 0/0，文本不再变。
  assert.deepEqual(await migrateOverlaps(store, logger), { migrated: 0, trimmed: 0 });
  assert.equal(store.listMemories().find((memory) => memory.id === 'm222222222222').text, TRIMMED_EVENT);
  // 落盘文本同样已裁剪。
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.memories.find((memory) => memory.id === 'm222222222222').text, TRIMMED_EVENT);
});

test('migrateOverlaps 第二遍：生产存量 auto trivia（已带 editedAt）按内容重叠裁剪，不按 editedAt 豁免', async (t) => {
  const dataDir = makeTmpDir('wild-mem-trim-prod-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'memories.json');
  // 生产现状： 迁移只降级未裁剪，且 updateMemory 已写入 editedAt。
  const productionEvent = eventMemory({ level: 'trivia', category: 'other', editedAt: 111 });
  fs.writeFileSync(file, JSON.stringify({ version: 2, memories: [GENERAL_MEMORY, productionEvent] }), 'utf8');

  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const logs = [];
  const logger = { log: (line) => logs.push(String(line)), warn: () => {} };
  const result = await migrateOverlaps(store, logger);
  assert.deepEqual(result, { migrated: 0, trimmed: 1 }, '第一遍无 core 事件、第二遍裁剪 1 条');
  assert.ok(logs.some((line) => line.includes('1 条事件文本去重')), '日志统计裁剪条数');

  const event = store.listMemories().find((memory) => memory.id === 'm222222222222');
  assert.equal(event.level, 'trivia');
  assert.equal(event.category, 'other');
  assert.equal(event.text, TRIMMED_EVENT, '存量事件条被裁剪（editedAt 不豁免）');
  assert.ok(Number.isFinite(event.editedAt), '只改文本与 level/category，编辑标记仍在（store 现状）');
  assert.equal(store.listMemories().find((memory) => memory.id === GENERAL_MEMORY.id).text, GENERAL);

  // 幂等：二次运行 0/0，不再变更。
  assert.deepEqual(await migrateOverlaps(store, logger), { migrated: 0, trimmed: 0 });
  assert.equal(store.listMemories().find((memory) => memory.id === 'm222222222222').text, TRIMMED_EVENT);
});

test('migrateOverlaps：manual trivia 与无重叠 trivia 一律不动', async (t) => {
  const dataDir = makeTmpDir('wild-mem-trim-skip-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dataDir, 'memories.json'),
    JSON.stringify({
      version: 2,
      memories: [
        GENERAL_MEMORY,
        eventMemory({ id: 'm222222222222', level: 'trivia', category: 'other', source: 'manual' }),
        eventMemory({ id: 'm333333333333', level: 'trivia', category: 'other', text: '周末去了图书馆，借了两本书' }),
      ],
    }),
    'utf8',
  );
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  assert.deepEqual(await migrateOverlaps(store, createCapturingLogger()), { migrated: 0, trimmed: 0 });
  assert.equal(store.listMemories().find((memory) => memory.id === 'm222222222222').text, EVENT, '手动条不裁剪');
  assert.equal(store.listMemories().find((memory) => memory.id === 'm333333333333').text, '周末去了图书馆，借了两本书');
});

test('migrateOverlaps：无可裁子句（全部子句都重叠）时保留原文、trimmed 不计数', async () => {
  const store = createStateStore([
    GENERAL_MEMORY,
    // 事件条全文都在复述概括（无事件特有子句）→ trimEventOverlap 返回原文，不应写入/计数。
    eventMemory({ level: 'trivia', category: 'other', text: '我总是想起以前做错的事，我感到很烦躁' }),
  ]);
  const result = await migrateOverlaps(store, createCapturingLogger());
  assert.deepEqual(result, { migrated: 0, trimmed: 0 });
  assert.equal(store.state.find((memory) => memory.id === 'm222222222222').text, '我总是想起以前做错的事，我感到很烦躁');
});
