// 管理员审计日志模块单元测试。
// 覆盖：JSONL 0600 追加、字段归一化、detail 白名单、时间倒序分页 + 不透明游标、
// 180 天保留（启动 prune）、损坏行降级、跨实例重载、非法输入 400。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AUDIT_FILE_NAME, AUDIT_RETENTION_DAYS, createAuditLog } from '../../server/audit.mjs';

const FIXED_NOW = new Date('2026-11-07T00:00:00.000Z');
const DAY_MS = 86_400_000;

function createCapturingLogger() {
  const lines = [];
  const push = (level) => (text) => lines.push({ level, text: String(text) });
  return {
    lines,
    log: push('log'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  };
}

async function makeTmpDir(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audit-test-'));
  t.after(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeLog(dataDir, { now = FIXED_NOW, logger = createCapturingLogger() } = {}) {
  return { log: createAuditLog({ dataDir, logger, now: () => now }), logger };
}

function readLines(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function assertRejectsHttp(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test('append/list：JSONL 追加、字段归一化、时间倒序、文件 0600', async (t) => {
  const dir = await makeTmpDir(t);
  const { log } = makeLog(dir);
  const first = await log.append({
    ts: '2026-11-07T00:00:00.000Z',
    actorId: 'u_admin',
    actorUsername: 'root',
    action: 'settings.update',
    targetType: 'settings',
    detail: { fields: ['byokEnabled'] },
  });
  const second = await log.append({
    ts: '2026-11-07T00:00:01.000Z',
    actorId: 'u_admin',
    actorUsername: 'root',
    action: 'user.update',
    targetType: 'user',
    targetId: 'u1',
    detail: { fields: ['status'] },
  });
  assert.match(first.id, /^a[0-9a-f]{8}$/);
  assert.equal(first.ts, '2026-11-07T00:00:00.000Z');
  assert.deepEqual(first.detail, { fields: ['byokEnabled'] });

  const page = await log.list({ limit: 10 });
  assert.deepEqual(
    page.entries.map((entry) => entry.id),
    [second.id, first.id],
    '时间倒序（最新在前）',
  );
  assert.equal(page.nextCursor, null);

  const filePath = path.join(dir, AUDIT_FILE_NAME);
  const mode = fs.statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600, 'audit.jsonl 权限 0600');
  const stored = readLines(filePath);
  assert.equal(stored.length, 2);
  assert.equal(stored[1].action, 'user.update');
  assert.equal(stored[1].actorUsername, 'root');
});

test('append：detail 白名单（嵌套对象/数字数组被丢弃），id 自动生成且唯一', async (t) => {
  const dir = await makeTmpDir(t);
  const { log } = makeLog(dir);
  const entry = await log.append({
    ts: '2026-11-07T00:00:00.000Z',
    action: 'noop.check',
    detail: {
      fields: ['a', 'b'],
      count: 3,
      enabled: true,
      empty: null,
      nested: { secret: 'x' },
      numbers: [1, 2],
    },
  });
  assert.deepEqual(entry.detail, { fields: ['a', 'b'], count: 3, enabled: true, empty: null });
  const other = await log.append({ ts: '2026-11-07T00:00:01.000Z', action: 'noop.other' });
  assert.notEqual(entry.id, other.id);
  assert.equal(entry.targetType, null);
  assert.equal(entry.targetId, null);
});

test('append：缺少 action → 400 INVALID_INPUT（不落盘）', async (t) => {
  const dir = await makeTmpDir(t);
  const { log } = makeLog(dir);
  await assertRejectsHttp(log.append({ actorId: 'u_admin' }), 400, 'INVALID_INPUT');
  await assertRejectsHttp(log.append({ action: '   ' }), 400, 'INVALID_INPUT');
  const page = await log.list({});
  assert.equal(page.entries.length, 0);
  assert.equal(fs.existsSync(path.join(dir, AUDIT_FILE_NAME)), false);
});

test('list：limit 默认 20、上限 100、非法 limit 不抛错（钳制）', async (t) => {
  const dir = await makeTmpDir(t);
  const { log } = makeLog(dir);
  for (let index = 0; index < 3; index += 1) {
    await log.append({ ts: `2026-11-07T00:00:0${index}.000Z`, action: 'noop.check' });
  }
  assert.equal((await log.list({})).entries.length, 3);
  assert.equal((await log.list({ limit: 0 })).entries.length, 3, 'limit<1 回落默认 20');
  assert.equal((await log.list({ limit: 101 })).entries.length, 3, 'limit>100 钳制为 100');
});

test('list：cursor = 上一页最后 entry.id，逐页翻完 nextCursor=null；非法 cursor 400 INVALID_CURSOR', async (t) => {
  const dir = await makeTmpDir(t);
  const { log } = makeLog(dir);
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    const entry = await log.append({ ts: `2026-11-07T00:00:0${index}.000Z`, action: 'noop.check' });
    ids.push(entry.id);
  }
  const page1 = await log.list({ limit: 2 });
  assert.deepEqual(
    page1.entries.map((entry) => entry.id),
    [ids[4], ids[3]],
  );
  assert.equal(page1.nextCursor, ids[3]);
  const page2 = await log.list({ limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(
    page2.entries.map((entry) => entry.id),
    [ids[2], ids[1]],
  );
  assert.equal(page2.nextCursor, ids[1]);
  const page3 = await log.list({ limit: 2, cursor: page2.nextCursor });
  assert.deepEqual(
    page3.entries.map((entry) => entry.id),
    [ids[0]],
  );
  assert.equal(page3.nextCursor, null);
  const empty = await log.list({ limit: 2, cursor: ids[0] });
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.nextCursor, null);
  await assertRejectsHttp(log.list({ cursor: 'aNOTREAL1' }), 400, 'INVALID_CURSOR');
});

test('list：同一 ts 时按追加顺序倒序（最新插入在前），翻页稳定', async (t) => {
  const dir = await makeTmpDir(t);
  const { log } = makeLog(dir);
  const sameTs = '2026-11-07T00:00:00.000Z';
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    ids.push((await log.append({ ts: sameTs, action: 'noop.same' })).id);
  }
  const page = await log.list({ limit: 10 });
  assert.deepEqual(
    page.entries.map((entry) => entry.id),
    [ids[2], ids[1], ids[0]],
  );
});

test('启动 prune：超过 180 天的条目被移除并重写文件；损坏行跳过并 warn', async (t) => {
  const dir = await makeTmpDir(t);
  const filePath = path.join(dir, AUDIT_FILE_NAME);
  const oldTs = new Date(FIXED_NOW.getTime() - (AUDIT_RETENTION_DAYS + 1) * DAY_MS).toISOString();
  const recentTs = new Date(FIXED_NOW.getTime() - DAY_MS).toISOString();
  const lines = [
    JSON.stringify({ id: 'aOLD00001', ts: oldTs, action: 'noop.old' }),
    '{ this is not json',
    JSON.stringify({ id: 'aNEW00001', ts: recentTs, action: 'noop.recent' }),
  ];
  await fs.promises.writeFile(filePath, `${lines.join('\n')}\n`, { mode: 0o600 });
  const logger = createCapturingLogger();
  const { log } = makeLog(dir, { logger });
  const page = await log.list({});
  assert.deepEqual(
    page.entries.map((entry) => entry.action),
    ['noop.recent'],
    '旧条目被 prune，损坏行被跳过',
  );
  assert.ok(
    logger.lines.some((line) => line.level === 'warn' && /跳过 1 行非法记录/.test(line.text)),
    '损坏行应 warn',
  );
  const stored = readLines(filePath);
  assert.equal(stored.length, 1, '文件被重写为仅保留期内的条目');
  assert.equal(stored[0].action, 'noop.recent');
});

test('跨实例重载：新实例 list 能看到已落盘条目；flush 等待写入完成', async (t) => {
  const dir = await makeTmpDir(t);
  const { log: first } = makeLog(dir);
  await first.append({ ts: '2026-11-07T00:00:00.000Z', action: 'noop.persist' });
  await first.flush();

  const { log: second } = makeLog(dir);
  const page = await second.list({});
  assert.deepEqual(
    page.entries.map((entry) => entry.action),
    ['noop.persist'],
  );
  await second.append({ ts: '2026-11-07T00:00:01.000Z', action: 'noop.second' });
  await second.flush();
  // 进程内应为单实例（app.mjs 只建一个），这里用第三个实例验证第二个实例的写入已持久化。
  const { log: third } = makeLog(dir);
  const reloaded = await third.list({});
  assert.deepEqual(
    reloaded.entries.map((entry) => entry.action),
    ['noop.second', 'noop.persist'],
  );
});

test('无数据目录时自动创建；明文 JSONL 每行可独立解析', async (t) => {
  const root = await makeTmpDir(t);
  const dir = path.join(root, 'nested', 'data');
  const { log } = makeLog(dir);
  await log.append({ ts: '2026-11-07T00:00:00.000Z', action: 'noop.dir' });
  const filePath = path.join(dir, AUDIT_FILE_NAME);
  assert.equal(fs.existsSync(filePath), true);
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  assert.equal(raw.split('\n').length, 1);
  assert.equal(JSON.parse(raw).action, 'noop.dir');
});
