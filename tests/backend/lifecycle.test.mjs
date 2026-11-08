//  /  / 契约 2：server/lifecycle.mjs 单元测试（离线、零依赖、不 sleep）。
// 覆盖：request id 格式与唯一性、flush 注册/注销/同名覆盖、按注册顺序 flush、
// 单个 flush 失败不中断、总超时 ok:false、shutdown 幂等、isShuttingDown 状态。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLifecycle } from '../../server/lifecycle.mjs';
import { createCapturingLogger } from './helpers.mjs';

const REQUEST_ID_PATTERN = /^r[0-9a-f]{16}$/;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('newRequestId：格式 r+16 hex，且互不相同', () => {
  const lifecycle = createLifecycle({ logger: createCapturingLogger(), timeoutMs: 100 });
  const ids = new Set();
  for (let index = 0; index < 50; index += 1) {
    const id = lifecycle.newRequestId();
    assert.match(id, REQUEST_ID_PATTERN);
    ids.add(id);
  }
  assert.equal(ids.size, 50);
});

test('isShuttingDown：初始 false，shutdown 进行中/结束后 true', async () => {
  const lifecycle = createLifecycle({ logger: createCapturingLogger(), timeoutMs: 100 });
  assert.equal(lifecycle.isShuttingDown(), false);
  const gate = deferred();
  lifecycle.registerFlush('slow', () => gate.promise);
  const shutdownPromise = lifecycle.shutdown('test');
  assert.equal(lifecycle.isShuttingDown(), true);
  gate.resolve();
  await shutdownPromise;
  assert.equal(lifecycle.isShuttingDown(), true);
});

test('shutdown：按注册顺序 flush，返回 ok/flushed/failed/elapsedMs', async () => {
  const lifecycle = createLifecycle({ logger: createCapturingLogger(), timeoutMs: 1000 });
  const order = [];
  lifecycle.registerFlush('first', async () => {
    order.push('first');
  });
  lifecycle.registerFlush('second', async () => {
    await Promise.resolve();
    order.push('second');
  });
  lifecycle.registerFlush('third', async () => {
    order.push('third');
  });
  const result = await lifecycle.shutdown('manual');
  assert.deepEqual(order, ['first', 'second', 'third']);
  assert.equal(result.ok, true);
  assert.equal(result.flushed, 3);
  assert.equal(result.failed, 0);
  assert.equal(typeof result.elapsedMs, 'number');
  assert.ok(result.elapsedMs >= 0);
});

test('单个 flush 失败不中断后续，failed 计数（ok 仅表示未超时）', async () => {
  const logger = createCapturingLogger();
  const lifecycle = createLifecycle({ logger, timeoutMs: 1000 });
  const order = [];
  lifecycle.registerFlush('ok-1', async () => {
    order.push('ok-1');
  });
  lifecycle.registerFlush('boom', async () => {
    order.push('boom');
    throw new Error('boom 写失败');
  });
  lifecycle.registerFlush('ok-2', async () => {
    order.push('ok-2');
  });
  const result = await lifecycle.shutdown('test');
  assert.deepEqual(order, ['ok-1', 'boom', 'ok-2']);
  // 契约：只有总超时才 ok=false；单个 flush 失败通过 failed 计数上报（bin/serve 据此 exit 1）。
  assert.equal(result.ok, true);
  assert.equal(result.flushed, 2);
  assert.equal(result.failed, 1);
  assert.ok(logger.logs.some((entry) => entry.level === 'warn' && entry.text.includes('boom 写失败')));
});

test('总超时：挂起的 flush 不阻塞 shutdown，返回 ok:false 且不抛错', async () => {
  const lifecycle = createLifecycle({ logger: createCapturingLogger(), timeoutMs: 40 });
  const order = [];
  lifecycle.registerFlush('fast', async () => {
    order.push('fast');
  });
  lifecycle.registerFlush('hang', () => new Promise(() => {}));
  lifecycle.registerFlush('after-hang', async () => {
    order.push('after-hang');
  });
  const startedAt = Date.now();
  const result = await lifecycle.shutdown('timeout-test');
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 2000, `超时未生效（耗时 ${elapsed}ms）`);
  // 超时后立即返回：已完成的 fast 计入，被 hang 卡住的 after-hang 不会开始。
  assert.deepEqual(order, ['fast']);
  assert.equal(result.flushed, 1);
  assert.equal(result.failed, 0);
});

test('shutdown 幂等：重复调用返回同一 promise 结果，flush 只执行一次', async () => {
  const lifecycle = createLifecycle({ logger: createCapturingLogger(), timeoutMs: 1000 });
  let calls = 0;
  lifecycle.registerFlush('once', async () => {
    calls += 1;
  });
  const first = lifecycle.shutdown('one');
  const second = lifecycle.shutdown('two');
  const [resultA, resultB] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(resultA, resultB);
  const third = await lifecycle.shutdown('three');
  assert.deepEqual(third, resultA);
});

test('registerFlush 返回 unregister；注销后不再执行', async () => {
  const lifecycle = createLifecycle({ logger: createCapturingLogger(), timeoutMs: 1000 });
  let called = 0;
  const unregister = lifecycle.registerFlush('temporary', async () => {
    called += 1;
  });
  assert.equal(typeof unregister, 'function');
  unregister();
  unregister(); // 二次注销安全
  const result = await lifecycle.shutdown('test');
  assert.equal(called, 0);
  assert.equal(result.flushed, 0);
  assert.equal(result.ok, true);
});

test('同名 flush 覆盖：只保留最后一次注册', async () => {
  const lifecycle = createLifecycle({ logger: createCapturingLogger(), timeoutMs: 1000 });
  const order = [];
  lifecycle.registerFlush('same', async () => {
    order.push('old');
  });
  lifecycle.registerFlush('same', async () => {
    order.push('new');
  });
  const result = await lifecycle.shutdown('test');
  assert.deepEqual(order, ['new']);
  assert.equal(result.flushed, 1);
});

test('空 registry：shutdown 立即 ok', async () => {
  const lifecycle = createLifecycle({ logger: createCapturingLogger(), timeoutMs: 1000 });
  const result = await lifecycle.shutdown('empty');
  assert.equal(result.ok, true);
  assert.equal(result.flushed, 0);
  assert.equal(result.failed, 0);
  assert.equal(typeof result.elapsedMs, 'number');
});

// ---------------------------------------------------------------------------
//  / 契约 2：store.flush() 快速验证（等待写队列清空后可安全退出/重读）
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';

import { createStore } from '../../server/store.mjs';
import { makeTmpDir } from './helpers.mjs';

test('store.flush：等待挂起写队列，落盘完成且可被重读', async () => {
  const dataDir = makeTmpDir('ctf-bk-flush-');
  const logger = createCapturingLogger();
  const store = await createStore({ dataDir, logger });
  assert.equal(typeof store.flush, 'function');
  assert.equal(store.degraded(), false);

  const created = await store.createConversation({ title: 'flush 快速验证会话' });
  await store.appendMessage(created.id, { role: 'user', text: 'flush 快速验证问题' });
  await store.addMemory({ text: 'flush 快速验证记忆' });
  await store.flush();
  await store.flush(); // 无挂起队列时也安全

  const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
  assert.equal(index.version, 1);
  assert.ok(index.conversations.some((item) => item.id === created.id));
  const memories = JSON.parse(fs.readFileSync(path.join(dataDir, 'memories.json'), 'utf8'));
  assert.ok(memories.memories.some((item) => item.text === 'flush 快速验证记忆'));

  // 重开一个 store 能看到刚写入的数据（证明 flush 后磁盘一致）
  const reopened = await createStore({ dataDir, logger });
  assert.ok(reopened.listConversations().some((item) => item.id === created.id));
});
