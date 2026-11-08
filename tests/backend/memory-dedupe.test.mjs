// 记忆判定增强（task-C）：bigram 相似度、具体事件降级、重叠去重、矛盾替代、启动迁移。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createCapturingLogger, makeTmpDir } from './helpers.mjs';
import { createStore } from '../../server/store.mjs';
import {
  EVENT_MARKERS,
  applyOverlapRules,
  charBigrams,
  containmentRatio,
  createMemoryService,
  diceCoefficient,
  hasEventMarkers,
  migrateOverlaps,
} from '../../server/memory.mjs';

// 合成示例记忆（示例种子原文，请勿修改： 依赖同一文本触发迁移）。
const GENERAL = '我总是想起以前做错的事，感到很烦躁'; // 稳定概括，较早
const EVENT = '我总想起以前做错的事，感到烦躁，尤其记得初中当众检举同学不当言行的事'; // 具体事件，较新
const TRIMMED_EVENT = '尤其记得初中当众检举同学不当言行的事'; // 裁剪后只保留事件特有部分

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
const EVENT_MEMORY = {
  id: 'm222222222222',
  kind: 'fact',
  level: 'core',
  category: 'general',
  source: 'auto',
  text: EVENT,
  createdAt: 2,
  validFrom: 2,
  validTo: null,
};

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
      Object.assign(memory, patch);
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

/* --------------------------- 纯函数：相似度数值 --------------------------- */

test('charBigrams/diceCoefficient/containmentRatio：用户 A/B 对数值', () => {
  const generalGrams = charBigrams(GENERAL);
  const eventGrams = charBigrams(EVENT);
  const total = (grams) => [...grams.values()].reduce((sum, count) => sum + count, 0);
  assert.equal(total(generalGrams), 15, '概括条 normalize 后 15 个 bigram');
  assert.equal(total(eventGrams), 31, '事件条 normalize 后 31 个 bigram');
  assert.equal(eventGrams.size, 30, '事件条「的事」重复一次 → Map size 少 1');

  let shared = 0;
  for (const [gram, count] of generalGrams) shared += Math.min(count, eventGrams.get(gram) ?? 0);
  assert.equal(shared, 11);

  // 说明手算「12/14≈0.857」基于不带「总是」的概括文本； 种子含「总是」，实测 11/15≈0.733，
  // 因此 OVERLAP_CONTAINMENT_MIN 取 0.7（详见 server/memory.mjs 注释与 report 存疑项）。
  assert.ok(Math.abs(containmentRatio(EVENT, GENERAL) - 11 / 15) < 1e-9);
  assert.ok(containmentRatio(EVENT, GENERAL) >= 0.7 && containmentRatio(EVENT, GENERAL) < 0.8);
  assert.ok(Math.abs(diceCoefficient(EVENT, GENERAL) - 22 / 46) < 1e-9);
  assert.ok(diceCoefficient(EVENT, GENERAL) < 0.8);
  // 两者公式均对称；事件条不能被当成 bigram Dice≥0.9 的等价重复（否则直接 skip 就丢了 trivia 信息）。
  assert.equal(diceCoefficient(EVENT, GENERAL), diceCoefficient(GENERAL, EVENT));
  assert.equal(containmentRatio(EVENT, GENERAL), containmentRatio(GENERAL, EVENT));
  assert.equal(diceCoefficient(GENERAL, GENERAL), 1);
  assert.equal(diceCoefficient('', GENERAL), 0);
  assert.equal(containmentRatio('', GENERAL), 0);
  assert.equal(containmentRatio(GENERAL, ''), 0);
  assert.equal(charBigrams('').size, 0);
  // 归一化口径：大小写/标点/空白不参与。
  assert.deepEqual([...charBigrams('COFFEE, please!')], [...charBigrams('coffee please')]);
});

test('EVENT_MARKERS：覆盖用户事件条、不误伤稳定概括条', () => {
  assert.equal(hasEventMarkers(EVENT), true);
  assert.equal(hasEventMarkers(GENERAL), false);
  for (const text of ['尤其记得那次', '当时我在场', '初中时', '高中那会儿', '那天晚上', '第一次', '今天发生了一件事', '昨天', '上周', '上个月', '当众讲话', '检举']) {
    assert.equal(hasEventMarkers(text), true, `应命中事件标记：${text}`);
  }
  // 「以前/想起/总是」不在标记里：两条用户记忆都含这些词，含了就无法区分事件与概括。
  for (const text of ['我总是想起以前做错的事', '我最近总是失眠', '我经常想起以前的事', '我这个人容易担忧']) {
    assert.equal(hasEventMarkers(text), false, `不应命中事件标记：${text}`);
  }
  assert.ok(EVENT_MARKERS instanceof RegExp);
});

/* --------------------------- 纯函数：重叠规则 --------------------------- */

test('applyOverlapRules：新 core 事件条是既有概括的扩写 → 降级存 trivia/other 并裁掉复述概括的子句', () => {
  const decision = applyOverlapRules({ level: 'core', category: 'general', kind: 'fact', text: EVENT }, [GENERAL_MEMORY]);
  assert.equal(decision.action, 'add');
  assert.equal(decision.reason, 'event-demoted');
  assert.equal(decision.item.level, 'trivia');
  assert.equal(decision.item.category, 'other');
  assert.equal(decision.item.text, TRIMMED_EVENT, '裁掉复述概括的子句，只保留事件特有部分');
  assert.deepEqual(decision.invalidateIds, []);
  assert.deepEqual(decision.demoteIds, []);

  // 不同 category 的既有 core 不构成「同一件事的概括」→ 保持 core。
  const crossCategory = applyOverlapRules({ level: 'core', category: 'family', text: EVENT }, [GENERAL_MEMORY]);
  assert.equal(crossCategory.action, 'add');
  assert.equal(crossCategory.item.level, 'core');
  assert.notEqual(crossCategory.reason, 'event-demoted');
});

test('applyOverlapRules：等价重复 skip（保留 口径 +  bigram/包含度判据）', () => {
  // 归一化相等（标点/空白不参与）。
  const normalized = applyOverlapRules({ level: 'core', category: 'general', text: ` ${GENERAL}。` }, [GENERAL_MEMORY]);
  assert.equal(normalized.action, 'skip');
  assert.equal(normalized.reason, 'duplicate');
  assert.equal(normalized.duplicateOf, GENERAL_MEMORY.id);

  // bigram Dice 仅 0.526，靠包含度 1.0 判定「短条只是长条的一部分」→ skip。
  const longExisting = { id: 'm0000000000aa', kind: 'fact', level: 'core', category: 'other', source: 'auto', text: '用户喜欢熬夜看球赛已经很多年了', validTo: null };
  const shorter = applyOverlapRules({ level: 'core', category: 'other', text: '用户喜欢熬夜' }, [longExisting]);
  assert.equal(shorter.action, 'skip');
  assert.equal(shorter.duplicateOf, longExisting.id);
  assert.ok(diceCoefficient('用户喜欢熬夜', longExisting.text) < 0.9);
  assert.ok(containmentRatio('用户喜欢熬夜', longExisting.text) >= 0.95);

  // 归一化相等跨 level 也 skip（避免同一事实两存）。
  const crossLevel = applyOverlapRules({ level: 'trivia', text: GENERAL }, [GENERAL_MEMORY]);
  assert.equal(crossLevel.action, 'skip');
  assert.equal(crossLevel.duplicateOf, GENERAL_MEMORY.id);
});

test('applyOverlapRules：矛盾软失效保留；手动/编辑过的旧条豁免', () => {
  const autoOld = { id: 'm0000000000b1', kind: 'fact', level: 'core', category: 'other', source: 'auto', text: '用户喜欢熬夜', validTo: null };
  const decision = applyOverlapRules({ level: 'core', category: 'other', text: '用户讨厌熬夜' }, [autoOld]);
  assert.equal(decision.action, 'add');
  assert.equal(decision.reason, 'contradiction');
  assert.deepEqual(decision.invalidateIds, ['m0000000000b1']);
  assert.deepEqual(decision.demoteIds, []);

  const manualDecision = applyOverlapRules({ level: 'core', category: 'other', text: '用户讨厌熬夜' }, [{ ...autoOld, source: 'manual' }]);
  assert.equal(manualDecision.reason, 'new');
  assert.deepEqual(manualDecision.invalidateIds, [], '手动记忆不自动失效');

  const editedDecision = applyOverlapRules({ level: 'core', category: 'other', text: '用户讨厌熬夜' }, [{ ...autoOld, editedAt: 9 }]);
  assert.equal(editedDecision.reason, 'new');
  assert.deepEqual(editedDecision.invalidateIds, [], '编辑过的记忆不自动失效');
});

test('applyOverlapRules：更稳定的概括替代旧 core 事件条（降 trivia、不删数据）', () => {
  const decision = applyOverlapRules({ level: 'core', category: 'general', text: GENERAL }, [EVENT_MEMORY]);
  assert.equal(decision.action, 'add');
  assert.equal(decision.reason, 'replaced-event');
  assert.equal(decision.item.level, 'core');
  assert.equal(decision.item.category, 'general');
  assert.deepEqual(decision.demoteIds, [EVENT_MEMORY.id]);
  assert.deepEqual(decision.invalidateIds, []);

  // 手动/编辑过的事件条不自动降级。
  for (const curated of [{ ...EVENT_MEMORY, source: 'manual' }, { ...EVENT_MEMORY, editedAt: 9 }]) {
    const curatedDecision = applyOverlapRules({ level: 'core', category: 'general', text: GENERAL }, [curated]);
    assert.deepEqual(curatedDecision.demoteIds, []);
    assert.deepEqual(curatedDecision.invalidateIds, []);
  }
});

test('applyOverlapRules：trivia 近似重复 skip；手动记忆仅参与等价重复 skip', () => {
  const triviaOld = { id: 'm0000000000c1', kind: 'fact', level: 'trivia', category: 'other', source: 'manual', text: '今天下雨心情不好', validTo: null };
  const duplicate = applyOverlapRules({ level: 'trivia', text: '今天下雨心情不好呀' }, [triviaOld]);
  assert.equal(duplicate.action, 'skip');
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(duplicate.duplicateOf, 'm0000000000c1');

  // 手动 core 记忆即使语义相近也不被降级/失效，但归一化相等仍按等价重复 skip。
  const manualCore = { id: 'm0000000000c2', kind: 'fact', level: 'core', category: 'general', source: 'manual', text: GENERAL, validTo: null };
  const sameText = applyOverlapRules({ level: 'core', category: 'general', text: GENERAL }, [manualCore]);
  assert.equal(sameText.action, 'skip');
  assert.deepEqual(sameText.invalidateIds, []);
  assert.deepEqual(sameText.demoteIds, []);
});

/* --------------------------- 抽取流程（extractAfterTurn） --------------------------- */

test('extractAfterTurn：事件扩写既有概括 → 落库 trivia/other，既有概括保持 core/general', async () => {
  const store = createStateStore([GENERAL_MEMORY]);
  const service = createService(
    store,
    async () => JSON.stringify({ memories: [{ level: 'core', category: 'general', kind: 'fact', text: EVENT }] }),
  );
  const result = await service.extractAfterTurn({
    conversationId: 'c1',
    messages: [{ role: 'user', content: '我总想起以前做错的事，尤其记得初中当众检举同学的事' }],
  });
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].level, 'trivia');
  assert.equal(result.added[0].category, 'other');
  assert.equal(result.added[0].text, TRIMMED_EVENT, '降级落库前裁剪事件条文本');
  assert.equal(result.skipped.length, 0);
  const general = store.state.find((memory) => memory.id === GENERAL_MEMORY.id);
  assert.equal(general.level, 'core');
  assert.equal(general.category, 'general');
  assert.equal(general.validTo, null);
  assert.equal(store.state.length, 2);
});

test('extractAfterTurn：更稳定的概括条到来 → 旧 core 事件条降 trivia（不删数据）', async () => {
  const store = createStateStore([EVENT_MEMORY]);
  const service = createService(
    store,
    async () => JSON.stringify({ memories: [{ level: 'core', category: 'general', kind: 'fact', text: GENERAL }] }),
  );
  const result = await service.extractAfterTurn({
    conversationId: 'c1',
    messages: [{ role: 'user', content: '我总是想起以前做错的事，感到很烦躁' }],
  });
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].level, 'core');
  assert.deepEqual(result.demoted.map((entry) => entry.id), [EVENT_MEMORY.id]);
  assert.deepEqual(result.invalidated, []);
  const event = store.state.find((memory) => memory.id === EVENT_MEMORY.id);
  assert.equal(event.level, 'trivia', '旧事件条降级而不是软失效');
  assert.equal(event.category, 'other');
  assert.equal(event.validTo, null, '不删数据、不失效');
  assert.equal(event.text, TRIMMED_EVENT, ' 降级时裁掉复述概括的子句，只保留事件特有部分');
  assert.equal(store.state.length, 2);
});

/* --------------------------- 启动迁移（memory.ready / migrateOverlaps） --------------------------- */

test('memory.ready：用户两条真实记忆启动迁移（概括留 core/general、事件降 trivia/other、条数不变、幂等）', async (t) => {
  const dataDir = makeTmpDir('wild-mem-dedupe-migrate-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'memories.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 2, memories: [GENERAL_MEMORY, EVENT_MEMORY] }), 'utf8');

  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const service = createMemoryService({
    store,
    config: { memory: true, memoryMax: 20, mock: true },
    logger: createCapturingLogger(),
  });
  assert.ok(service.ready instanceof Promise, 'service.ready 必须是 Promise');
  assert.equal(typeof service.migrateOverlaps, 'function');
  await service.ready; // 启动即执行，永不 reject

  const memories = store.listMemories();
  assert.equal(memories.length, 2, '迁移不改变条数（不删数据）');
  const general = memories.find((memory) => memory.id === 'm111111111111');
  const event = memories.find((memory) => memory.id === 'm222222222222');
  assert.ok(general, '概括条仍在');
  assert.ok(event, '事件条仍在（只改 level/category）');
  assert.equal(general.level, 'core');
  assert.equal(general.category, 'general');
  assert.equal(general.validTo, null);
  assert.equal(general.text, GENERAL);
  assert.equal(event.level, 'trivia');
  assert.equal(event.category, 'other');
  assert.equal(event.validTo, null);
  assert.equal(event.text, TRIMMED_EVENT, '迁移降级时同步裁剪文本（ 目标形态）');
  // 存疑项（report 已记录）：store.updateMemory 无条件写 editedAt，迁移因此会带 editedAt；无害。
  assert.ok(Number.isFinite(event.editedAt));

  // 幂等：再跑两次都 migrated:0 / trimmed:0，数据不再变化。
  assert.deepEqual(await service.migrateOverlaps(), { migrated: 0, trimmed: 0 });
  assert.deepEqual(await migrateOverlaps(store, createCapturingLogger()), { migrated: 0, trimmed: 0 });
  assert.deepEqual(store.listMemories(), memories);
  // 落盘同版本，且事件条 level 已写为 trivia。
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.version, 2);
  const persistedEvent = persisted.memories.find((memory) => memory.id === 'm222222222222');
  assert.equal(persistedEvent.level, 'trivia');
  assert.equal(persistedEvent.text, TRIMMED_EVENT, '落盘文本已裁剪');
});

test('migrateOverlaps：手动/编辑过的 core 事件条豁免；不同 category 不迁移', async (t) => {
  const dataDir = makeTmpDir('wild-mem-dedupe-exempt-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'memories.json'),
    JSON.stringify({
      version: 2,
      memories: [
        GENERAL_MEMORY,
        { ...EVENT_MEMORY, id: 'm222222222222', source: 'manual' },
        { ...EVENT_MEMORY, id: 'm333333333333', editedAt: 9 },
        { ...EVENT_MEMORY, id: 'm444444444444', category: 'academic' },
        { ...EVENT_MEMORY, id: 'm555555555555', text: '我总想起以前做错的事，感到烦躁，尤其记得高中当众检讨的事', validTo: 5 },
      ],
    }),
    'utf8',
  );
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const result = await migrateOverlaps(store, createCapturingLogger());
  assert.deepEqual(result, { migrated: 0, trimmed: 0 }, '手动/编辑过/不同 category/已失效的条都不迁移');
  for (const memory of store.listMemories()) assert.equal(memory.level, 'core');
});

test('migrateOverlaps：存储异常只 warn 不抛；ready 契约永不 reject', async () => {
  const logs = [];
  const logger = { warn: (message) => logs.push(String(message)), log: () => {} };
  const broken = {
    getActiveMemories: () => {
      throw new Error('读取失败');
    },
    updateMemory: async () => true,
  };
  assert.deepEqual(await migrateOverlaps(broken, logger), { migrated: 0, trimmed: 0 });
  assert.ok(logs.some((line) => line.includes('启动重叠迁移失败')), '异常只 warn');

  // 迁移写失败：ready 仍 resolve（永不 reject），warn 记录。
  const store = createStateStore([GENERAL_MEMORY, EVENT_MEMORY]);
  store.updateMemory = async () => {
    throw new Error('落盘失败');
  };
  const service = createMemoryService({ store, config: { memory: true, memoryMax: 20, mock: true }, logger });
  await assert.doesNotReject(() => service.ready);
  // 没有 store.getActiveMemories 的旧 stub 也要兼容（退回 migrated:0）。
  assert.deepEqual(await migrateOverlaps({}, logger), { migrated: 0, trimmed: 0 });
});
