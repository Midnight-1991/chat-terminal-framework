// store.mjs 单元测试：落盘/重载、上限裁剪、损坏文件容错、降级模式、记忆软失效、单实例锁。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createStore, deriveTitle, STORE_LIMITS } from '../../server/store.mjs';
import { createCapturingLogger, makeTmpDir } from './helpers.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeConversationFile(dataDir, record) {
  const dir = path.join(dataDir, 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));
}

function message(role, text, createdAt = Date.now()) {
  return { role, text, createdAt };
}

test('createStore：初始化目录、health 字段、无文件也能启动', async () => {
  const dataDir = makeTmpDir('wild-store-');
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  assert.ok(fs.existsSync(dataDir));
  assert.ok(fs.existsSync(path.join(dataDir, 'conversations')));
  assert.deepEqual(store.health(), { ok: true, conversations: 0, memories: 0 });
  assert.equal(store.degraded(), false);
  assert.deepEqual(store.listConversations(), []);
});

test('createConversation / appendMessage：落盘后可被新 store 重载', async () => {
  const dataDir = makeTmpDir('wild-store-');
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const summary = await store.createConversation({ title: '睡眠' });
  assert.equal(summary.title, '睡眠');
  await store.appendMessage(summary.id, message('user', '我最近睡不好'));
  await store.appendMessage(summary.id, message('assistant', '先做呼吸练习。'));

  const index = readJson(path.join(dataDir, 'index.json'));
  assert.equal(index.conversations[0].id, summary.id);
  const record = readJson(path.join(dataDir, 'conversations', `${summary.id}.json`));
  assert.equal(record.messages.length, 2);

  const reloaded = await createStore({ dataDir, logger: createCapturingLogger() });
  const detail = reloaded.getConversation(summary.id);
  assert.equal(detail.conversation.title, '睡眠');
  assert.deepEqual(
    detail.messages.map((item) => item.text),
    ['我最近睡不好', '先做呼吸练习。'],
  );
  assert.equal(reloaded.listConversations()[0].turnCount, 1); // 1 轮 = 1 条 user
});

test('appendMessage：首条 user 自动生成标题；后续 user 不改标题', async () => {
  const dataDir = makeTmpDir('wild-store-');
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const { id } = await store.createConversation();
  const first = await store.appendMessage(id, message('user', '我最近总是睡不好，凌晨三点会醒'));
  assert.equal(first.autoTitled, true);
  assert.equal(first.summary.title, deriveTitle('我最近总是睡不好，凌晨三点会醒'));
  const second = await store.appendMessage(id, message('user', '还有一个问题'));
  assert.equal(second.autoTitled, false);
  assert.equal(second.summary.title, first.summary.title);
});

test('appendMessage：单会话超过 200 条时保留最近 200 条，首条为 user', async () => {
  const dataDir = makeTmpDir('wild-store-');
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const { id } = await store.createConversation();
  // 直接写一个超长会话文件，验证加载时的裁剪（避免 250 次磁盘写）。
  const messages = [];
  for (let i = 0; i < 250; i += 1) messages.push(message(i % 2 === 0 ? 'user' : 'assistant', `第${i}条`));
  await store.deleteConversation(id);
  writeConversationFile(dataDir, {
    id,
    title: '超长',
    createdAt: 1,
    updatedAt: 2,
    messages,
  });
  const reloaded = await createStore({ dataDir, logger: createCapturingLogger() });
  const detail = reloaded.getConversation(id);
  assert.equal(detail.messages.length, STORE_LIMITS.MAX_MESSAGES);
  assert.equal(detail.messages[0].role, 'user');
  assert.equal(detail.messages.at(-1).text, '第249条');
});

test('加载时容忍损坏文件：坏 JSON / 缺字段跳过并 warn，其余会话正常', async () => {
  const dataDir = makeTmpDir('wild-store-');
  const logger = createCapturingLogger();
  fs.mkdirSync(path.join(dataDir, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'conversations', 'c000000000001.json'), '{"id": "broken'); // 坏 JSON
  fs.writeFileSync(path.join(dataDir, 'conversations', 'c000000000002.json'), JSON.stringify({ id: 'x' })); // 缺字段
  const good = {
    id: 'c000000000003',
    title: '正常',
    createdAt: 10,
    updatedAt: 20,
    messages: [message('user', '你好')],
  };
  fs.writeFileSync(path.join(dataDir, 'conversations', `${good.id}.json`), JSON.stringify(good));
  fs.writeFileSync(path.join(dataDir, 'index.json'), 'not json');
  fs.writeFileSync(path.join(dataDir, 'memories.json'), 'not json');

  const store = await createStore({ dataDir, logger });
  assert.equal(store.listConversations().length, 1);
  assert.equal(store.listConversations()[0].id, good.id);
  assert.ok(logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('损坏')));
});

test('加载时会话数量超限：只保留最近 200 个（其余文件删除）', async () => {
  const dataDir = makeTmpDir('wild-store-');
  for (let i = 0; i < STORE_LIMITS.MAX_CONVERSATIONS + 5; i += 1) {
    writeConversationFile(dataDir, {
      id: `c${String(i).padStart(12, '0')}`,
      title: `会话${i}`,
      createdAt: i,
      updatedAt: i,
      messages: [
        { role: 'user', text: `问题${i}`, createdAt: i },
        { role: 'assistant', text: '回答。', createdAt: i },
      ],
    });
  }
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  assert.equal(store.listConversations().length, STORE_LIMITS.MAX_CONVERSATIONS);
  const files = fs.readdirSync(path.join(dataDir, 'conversations')).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, STORE_LIMITS.MAX_CONVERSATIONS);
});

test('记忆：v2 core 同类最近优先；软失效 / 复活 / 删除 / 清空均落盘', async () => {
  const dataDir = makeTmpDir('wild-store-');
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const profile = await store.addMemory({ text: '用户叫小林', kind: 'profile' });
  const factOld = await store.addMemory({ text: '用户常熬夜', kind: 'fact', sleep: 1 });
  const factNew = await store.addMemory({ text: '用户养了一只猫', kind: 'fact' });

  // v2 默认 level=core / category=other：同类按最近优先（养猫最新，小林最早）
  assert.deepEqual(
    store.listMemories().map((memory) => memory.text),
    ['用户养了一只猫', '用户常熬夜', '用户叫小林'],
  );
  assert.ok(store.listMemories().every((memory) => memory.level === 'core' && memory.source === 'manual'));
  assert.equal(store.getActiveMemories().length, 3);

  await store.invalidateMemory(factOld.id);
  assert.deepEqual(
    store.getActiveMemories().map((memory) => memory.text),
    ['用户养了一只猫', '用户叫小林'],
  );
  await store.reactivateMemory(factOld.id);
  assert.equal(store.getActiveMemories().length, 3);

  const reloaded = await createStore({ dataDir, logger: createCapturingLogger() });
  assert.equal(reloaded.listMemories().length, 3);
  assert.equal(reloaded.listMemories().find((memory) => memory.id === factNew.id).validTo, null);

  assert.equal(await reloaded.deleteMemory(profile.id), true);
  assert.equal(await reloaded.deleteMemory('m000000000000'), false);
  assert.equal(await reloaded.clearMemories(), 2);
  assert.deepEqual(reloaded.listMemories(), []);
  assert.deepEqual(readJson(path.join(dataDir, 'memories.json')).memories, []);
});

test('deriveTitle：去换行、20 字内原样、超长截断加省略号', () => {
  assert.equal(deriveTitle('短标题'), '短标题');
  assert.equal(deriveTitle('第一行\n第二行'), '第一行 第二行');
  const twenty = '一二三四五六七八九十一二三四五六七八九十';
  assert.equal([...twenty].length, 20);
  assert.equal(deriveTitle(twenty), twenty);
  assert.equal(deriveTitle(`${twenty}多`), `${twenty}…`);
});

test('降级模式：数据目录不可写时不崩溃，操作仍走内存', async () => {
  const parent = makeTmpDir('wild-store-');
  const filePath = path.join(parent, 'not-a-dir');
  fs.writeFileSync(filePath, 'x');
  const logger = createCapturingLogger();
  const store = await createStore({ dataDir: path.join(filePath, 'data'), logger });
  assert.equal(store.degraded(), true);
  assert.equal(store.health().ok, false);
  assert.ok(logger.logs.some((entry) => entry.warn === undefined || entry.text.includes('降级')));

  const { id } = await store.createConversation();
  await store.appendMessage(id, message('user', '内存模式'));
  assert.equal(store.getConversation(id).messages.length, 1);
  await store.addMemory({ text: '内存记忆' });
  assert.equal(store.listMemories().length, 1);
});

test('原子写：会话/记忆写入后 DATA_DIR 内不残留 .tmp 文件', async () => {
  const dataDir = makeTmpDir('wild-store-tmp-');
  const store = await createStore({ dataDir, logger: createCapturingLogger() });
  const { id } = await store.createConversation();
  await store.appendMessage(id, message('user', '第一条'));
  await store.appendMessage(id, message('assistant', '第二条'));
  await store.updateConversationTitle(id, '新标题');
  await store.addMemory({ text: '用户喜欢清晨散步', kind: 'fact' });

  const leftovers = [];
  for (const dir of [dataDir, path.join(dataDir, 'conversations')]) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.tmp')) leftovers.push(path.join(dir, name));
    }
  }
  assert.deepEqual(leftovers, [], '原子写应 rename 掉所有 .tmp');
  assert.ok(fs.existsSync(path.join(dataDir, 'conversations', `${id}.json`)));
});

test('空白会话：不进入历史列表；超过保留窗口的空白会话重启时清理', async () => {
  const { EMPTY_CONVERSATION_TTL_MS } = await import('../../server/store.mjs');
  const dataDir = makeTmpDir('wild-store-');
  await createStore({ dataDir, logger: createCapturingLogger() });
  const oldEmpty = {
    id: 'c0000000000a',
    title: '新对话',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
  const recentEmpty = {
    id: 'c0000000000b',
    title: '新对话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  writeConversationFile(dataDir, oldEmpty);
  writeConversationFile(dataDir, recentEmpty);

  const reloaded = await createStore({ dataDir, logger: createCapturingLogger() });
  assert.deepEqual(reloaded.listConversations(), []);
  assert.equal(reloaded.health().conversations, 0);
  assert.equal(
    fs.existsSync(path.join(dataDir, 'conversations', `${oldEmpty.id}.json`)),
    false,
    `超过 ${EMPTY_CONVERSATION_TTL_MS}ms 的空白会话应被清理`,
  );
  assert.equal(
    fs.existsSync(path.join(dataDir, 'conversations', `${recentEmpty.id}.json`)),
    true,
    '刚创建的空白会话先保留（正在输入），只是不出现在历史里',
  );
});

test('单实例锁：全新 DATA_DIR 首次启动不告警并创建锁文件（内容为当前 pid）', async () => {
  const dataDir = makeTmpDir('wild-store-lock-');
  const logger = createCapturingLogger();
  const store = await createStore({ dataDir, logger });
  assert.equal(store.degraded(), false);
  assert.ok(
    !logger.logs.some((entry) => entry.text.includes('实例锁创建失败')),
    `首次启动不应因 .lock 不存在而告警，实际日志：${JSON.stringify(logger.logs)}`,
  );
  const lockFile = path.join(dataDir, '.lock');
  assert.ok(fs.existsSync(lockFile), '首次启动应创建 .lock');
  assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), String(process.pid));
});

test('单实例锁：DATA_DIR 被运行中进程占用时第二个实例拒绝启动', async (t) => {
  const dataDir = makeTmpDir('wild-store-lock2-');
  fs.mkdirSync(path.join(dataDir, 'conversations'), { recursive: true });
  // 用一个真实存活的子进程模拟「另一个实例」。
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  });
  assert.equal(typeof child.pid, 'number');
  fs.writeFileSync(path.join(dataDir, '.lock'), `${child.pid}\n`);

  const logger = createCapturingLogger();
  await assert.rejects(
    () => createStore({ dataDir, logger }),
    /DATA_DIR 已被运行中的进程（pid \d+）占用/,
    '第二个实例应被实例锁拒绝',
  );
  assert.equal(fs.readFileSync(path.join(dataDir, '.lock'), 'utf8').trim(), String(child.pid), '拒绝时不得改写锁文件');
});

