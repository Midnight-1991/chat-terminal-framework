// DATA_DIR 静态数据加密（at-rest）单元测试。
// 覆盖：文件格式/编解码、篡改与 AAD 搬运、密钥解析（env / 600 key file）、迁移幂等与 fail-fast、
// 5 个 store 的加密读写变体、健康接口字段、密钥轮换脚本。全部用临时目录，不触网。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import {
  AT_REST_DATA_FILES,
  AT_REST_ERROR_CODES,
  AT_REST_MAGIC,
  AT_REST_OVERHEAD_BYTES,
  AtRestError,
  createAtRest,
  createAttachmentStore,
  createDocStore,
  createHealthStore,
  createMarksStore,
  createScaleHistoryStore,
  createStore,
  decodeKeyBase64,
  decodePayload,
  encodePayload,
  isAtRestError,
  isEncryptedBuffer,
  listDataFiles,
  listDirFiles,
  listKnownDataFilesInDir,
  hasEncryptedDataFiles,
  loadEncryptionKey,
  migrateDataDir,
  setupAtRest,
  readEncryptionKeyFile,
} from '../../server/index.mjs';
import { FIXTURE_CORPUS, createCapturingLogger, makeTmpDir, startServer } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ROTATE_SCRIPT = path.join(ROOT, 'scripts/rotate-data-key.mjs');
const KEY = crypto.createHash('sha256').update('at-rest-test-key-1').digest();
const KEY2 = crypto.createHash('sha256').update('at-rest-test-key-2').digest();

function makeKey() {
  return crypto.randomBytes(32);
}

function readRaw(filePath) {
  return fs.readFileSync(filePath);
}

function hasMagic(filePath) {
  const raw = readRaw(filePath);
  return isEncryptedBuffer(raw) && raw.subarray(0, AT_REST_MAGIC.length).toString('latin1') === AT_REST_MAGIC;
}

function writeKeyFile(dir, name, key, mode = 0o600) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${key.toString('base64')}\n`, { encoding: 'utf8', mode });
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* 非 POSIX 时忽略 */
  }
  return filePath;
}

function writePlain(dir, relative, payload = '{}') {
  const filePath = path.join(dir, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, payload, 'utf8');
  return filePath;
}

/** 7 类待加密文件的明文样例（index/conversations/memories/marks/health/scales-history/attachments）。 */
function seedPlainDataDir(dir) {
  writePlain(dir, 'index.json', `${JSON.stringify({ version: 1, conversations: [] })}\n`);
  writePlain(dir, 'memories.json', `${JSON.stringify({ version: 2, memories: [] })}\n`);
  writePlain(dir, 'marks.json', `${JSON.stringify({ version: 1, excerpt: [], favorites: [] })}\n`);
  writePlain(dir, 'health.json', `${JSON.stringify({ version: 1, updatedAt: 1, days: {} })}\n`);
  writePlain(dir, 'scales-history.json', `${JSON.stringify({ version: 1, updatedAt: 1, entries: [] })}\n`);
  writePlain(dir, 'conversations/c1.json', `${JSON.stringify({ id: 'c1', title: '明文会话', messages: [] })}\n`);
  const png = Buffer.from('fake-png-bytes-not-real-image');
  writePlain(dir, 'attachments/akeep0000000000000000000.png', png);
  return { png };
}

const DEMO_META = { scaleId: 'demo-scale-1', name: '演示问卷', category: '情绪', kind: 'band', maxScore: 27 };
function demo1Result() {
  return {
    scaleId: 'demo-scale-1',
    score: 9,
    maxScore: 27,
    band: { key: 'mild', label: '轻度' },
    answered: 9,
    complete: true,
    computedAt: new Date().toISOString(),
    disclaimer: '不构成诊断',
    safetyAdvisory: '不应落盘 SECRET-ADVISORY',
  };
}

/* --------------------------- 编解码 / 文件格式 --------------------------- */

test('encodePayload/decodePayload：魔数+version+IV+tag+密文，roundtrip 与随机 IV；明文原样透传', () => {
  const plain = Buffer.from('{"hello":"世界"}', 'utf8');
  const first = encodePayload(KEY, 'index.json', plain);
  const second = encodePayload(KEY, 'index.json', plain);

  assert.equal(first.subarray(0, AT_REST_MAGIC.length).toString('latin1'), 'CTFENC001');
  assert.equal(first[AT_REST_MAGIC.length], 1, '格式版本=1');
  assert.equal(first.length, plain.length + AT_REST_OVERHEAD_BYTES);
  assert.notDeepEqual(first, second, '每次加密 IV 随机（密文不同）');
  assert.equal(isEncryptedBuffer(first), true);
  assert.deepEqual(decodePayload(KEY, 'index.json', first), plain);
  // 明文兼容：非密文原样返回（支持「数据为明文」的旧库/迁移场景）。
  assert.deepEqual(decodePayload(KEY, 'index.json', plain), plain);
  assert.ok(AT_REST_DATA_FILES.length >= 5);
});

test('decodePayload：密文篡改/截断/AAD 搬运/错误版本/错误 key → 稳定错误码且不返回明文', () => {
  const plain = Buffer.from('{"secret":"内容"}');
  const sealed = encodePayload(KEY, 'conversations/c1.json', plain);

  const flipLast = Buffer.from(sealed);
  flipLast[flipLast.length - 1] ^= 0xff;
  assert.throws(() => decodePayload(KEY, 'conversations/c1.json', flipLast), (error) => {
    assert.ok(isAtRestError(error));
    assert.equal(error.code, AT_REST_ERROR_CODES.AUTH_FAILED);
    return true;
  });

  const flipTag = Buffer.from(sealed);
  flipTag[AT_REST_MAGIC.length + 1 + 12] ^= 0x01; // tag 首字节
  assert.throws(() => decodePayload(KEY, 'conversations/c1.json', flipTag), (error) => {
    assert.equal(error.code, AT_REST_ERROR_CODES.AUTH_FAILED);
    return true;
  });

  // 截断到小于固定头部 → CORRUPT
  assert.throws(() => decodePayload(KEY, 'conversations/c1.json', sealed.subarray(0, 20)), (error) => {
    assert.equal(error.code, AT_REST_ERROR_CODES.CORRUPT);
    return true;
  });

  // 不安全版本号
  const badVersion = Buffer.from(sealed);
  badVersion[AT_REST_MAGIC.length] = 99;
  assert.throws(() => decodePayload(KEY, 'conversations/c1.json', badVersion), (error) => {
    assert.equal(error.code, AT_REST_ERROR_CODES.UNSUPPORTED_VERSION);
    return true;
  });

  // AAD 搬运：把 c1 的密文放到 c2 位置 → 解密失败（防文件挪动）
  assert.throws(() => decodePayload(KEY, 'conversations/c2.json', sealed), (error) => {
    assert.equal(error.code, AT_REST_ERROR_CODES.AUTH_FAILED);
    return true;
  });

  // 错误 key
  assert.throws(() => decodePayload(KEY2, 'conversations/c1.json', sealed), (error) => {
    assert.equal(error.code, AT_REST_ERROR_CODES.AUTH_FAILED);
    return true;
  });

  // 空 AAD / 非 32B key
  assert.throws(() => decodePayload(KEY, '', sealed), (error) => error.code === AT_REST_ERROR_CODES.AAD_INVALID);
  assert.throws(
    () => encodePayload(crypto.randomBytes(16), 'index.json', plain),
    (error) => error.code === AT_REST_ERROR_CODES.INVALID_KEY,
  );
});

/* --------------------------------- 密钥 --------------------------------- */

test('密钥解析：base64 严格校验；key file 必须 600；FILE 优先于 env', () => {
  const key = makeKey();
  assert.deepEqual(decodeKeyBase64(key.toString('base64')), key);
  // URL-safe base64 也接受
  assert.deepEqual(decodeKeyBase64(key.toString('base64url')), key);
  assert.throws(() => decodeKeyBase64('not-base64!!'), (error) => error.code === AT_REST_ERROR_CODES.INVALID_KEY);
  assert.throws(
    () => decodeKeyBase64(crypto.randomBytes(16).toString('base64')),
    (error) => error.code === AT_REST_ERROR_CODES.INVALID_KEY,
  );

  const dir = makeTmpDir('wild-atrest-key-');
  const keyFile = writeKeyFile(dir, 'data.key', key, 0o600);
  assert.deepEqual(readEncryptionKeyFile(keyFile), key);

  const looseFile = writeKeyFile(dir, 'data-loose.key', key, 0o644);
  assert.throws(() => readEncryptionKeyFile(looseFile), (error) => {
    assert.equal(error.code, AT_REST_ERROR_CODES.KEY_PERMISSIONS);
    return true;
  });

  assert.throws(
    () => readEncryptionKeyFile(path.join(dir, 'missing.key')),
    (error) => error.code === AT_REST_ERROR_CODES.KEY_FILE_UNREADABLE,
  );

  // 未配置 → off（key=null，明文模式）
  assert.deepEqual(loadEncryptionKey({ env: {} }), { key: null, source: 'none', keyFile: null });
  // env base64
  const fromEnv = loadEncryptionKey({ env: { DATA_ENCRYPTION_KEY: key.toString('base64') } });
  assert.equal(fromEnv.source, 'env');
  assert.deepEqual(fromEnv.key, key);
  // FILE 优先
  const key2 = makeKey();
  const file2 = writeKeyFile(dir, 'data2.key', key2, 0o600);
  const both = loadEncryptionKey({
    env: { DATA_ENCRYPTION_KEY: key.toString('base64'), DATA_ENCRYPTION_KEY_FILE: file2 },
  });
  assert.equal(both.source, 'file');
  assert.deepEqual(both.key, key2);
});

/* --------------------------------- 迁移 --------------------------------- */

test('migrateDataDir：明文 7 类文件 → 密文 + 迁移前备份；幂等；备份为明文快照', () => {
  const dir = makeTmpDir('wild-atrest-migrate-');
  const { png } = seedPlainDataDir(dir);
  const atRest = createAtRest({ key: KEY, dataDir: dir, logger: createCapturingLogger() });

  const first = migrateDataDir({ dataDir: dir, atRest, logger: createCapturingLogger() });
  assert.equal(first.enabled, true);
  assert.equal(first.migrated, 7, 'index/conversations/memories/marks/health/scales-history/attachments 共 7 个');
  assert.equal(first.skipped, 0);
  assert.ok(first.backupDir && fs.existsSync(first.backupDir), '迁移前必须有备份目录');
  // 全部加密且附件仍按原文件名
  for (const relative of [
    'index.json',
    'memories.json',
    'marks.json',
    'health.json',
    'scales-history.json',
    'conversations/c1.json',
    'attachments/akeep0000000000000000000.png',
  ]) {
    assert.equal(hasMagic(path.join(dir, relative)), true, `${relative} 应为密文`);
  }
  // 备份目录里是迁移前的明文快照（可用于回滚）。
  assert.deepEqual(
    readRaw(path.join(first.backupDir, 'attachments/akeep0000000000000000000.png')),
    png,
  );
  assert.match(readRaw(path.join(first.backupDir, 'index.json')).toString('utf8'), /"conversations"/);
  // 解密内容与原文一致
  assert.deepEqual(atRest.readFileSync(path.join(dir, 'attachments/akeep0000000000000000000.png')), png);

  // 幂等：再跑一次不迁移、不重复备份
  const second = migrateDataDir({ dataDir: dir, atRest, logger: createCapturingLogger() });
  assert.equal(second.migrated, 0);
  assert.equal(second.skipped, 7);
  assert.equal(second.backupDir, null);
  // listDataFiles 只列数据文件（不进入 .migration-backup-*）
  assert.equal(listDataFiles(dir).length, 7);
});

test('migrateDataDir：已有密文但错误 key / 密文损坏 → fail-fast 且不改动任何文件', () => {
  const dir = makeTmpDir('wild-atrest-migrate-bad-');
  seedPlainDataDir(dir);
  const atRest = createAtRest({ key: KEY, dataDir: dir, logger: createCapturingLogger() });
  migrateDataDir({ dataDir: dir, atRest, logger: createCapturingLogger() });
  const before = readRaw(path.join(dir, 'memories.json'));

  const wrong = createAtRest({ key: KEY2, dataDir: dir, logger: createCapturingLogger() });
  assert.throws(() => migrateDataDir({ dataDir: dir, atRest: wrong, logger: createCapturingLogger() }), (error) => {
    assert.ok(isAtRestError(error));
    assert.equal(error.code, AT_REST_ERROR_CODES.AUTH_FAILED);
    return true;
  });
  assert.deepEqual(readRaw(path.join(dir, 'memories.json')), before, '错误 key 不得覆盖/清空原文件');

  // 密文损坏（合法魔数 + 垃圾内容）
  const corrupt = Buffer.concat([
    Buffer.from(AT_REST_MAGIC, 'latin1'),
    Buffer.from([1]),
    Buffer.alloc(12),
    Buffer.alloc(16),
    Buffer.from('garbage'),
  ]);
  fs.writeFileSync(path.join(dir, 'health.json'), corrupt);
  assert.throws(
    () => migrateDataDir({ dataDir: dir, atRest, logger: createCapturingLogger() }),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
  assert.deepEqual(readRaw(path.join(dir, 'health.json')), corrupt, '损坏密文不得被静默覆盖');
});

test('createAtRest：off 模式所有方法退化为明文透传（无 key 时行为不变）', () => {
  const dir = makeTmpDir('wild-atrest-off-');
  const off = createAtRest({ key: null, dataDir: dir });
  assert.equal(off.enabled, false);
  assert.equal(off.mode, 'off');
  assert.deepEqual(off.status(), { atRest: 'off', formatVersion: null });
  const plain = Buffer.from('plain');
  assert.deepEqual(off.seal(path.join(dir, 'index.json'), plain), plain);
  assert.deepEqual(off.unseal(path.join(dir, 'index.json'), plain), plain);
});

/* ---------- -E/C6：无 key + 已有密文 → fail-fast，绝不静默明文覆盖 ---------- */

test('setupAtRest：无 key 但 DATA_DIR 已有密文 → MISSING_KEY fail-fast 且不改写文件', () => {
  const dir = makeTmpDir('wild-atrest-missing-key-');
  const key = crypto.randomBytes(32);
  const encrypted = encodePayload(key, 'index.json', Buffer.from(JSON.stringify({ version: 1 })));
  fs.writeFileSync(path.join(dir, 'index.json'), encrypted);
  assert.equal(hasEncryptedDataFiles(dir), true);
  const before = fs.readFileSync(path.join(dir, 'index.json'));
  assert.throws(
    () => setupAtRest({ dataDir: dir, config: {}, env: {} }),
    (error) => isAtRestError(error) && error.code === AT_REST_ERROR_CODES.MISSING_KEY,
  );
  assert.deepEqual(fs.readFileSync(path.join(dir, 'index.json')), before, '启动失败不得改写密文');
});

test('setupAtRest：无 key + 纯明文 DATA_DIR 仍为 off 模式（既有部署兼容）', () => {
  const dir = makeTmpDir('wild-atrest-plain-');
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1 }));
  fs.writeFileSync(path.join(dir, 'memories.json'), JSON.stringify({ version: 2, memories: [] }));
  assert.equal(hasEncryptedDataFiles(dir), false);
  const setup = setupAtRest({ dataDir: dir, config: {}, env: {} });
  assert.equal(setup.atRest.enabled, false);
  assert.equal(setup.atRest.mode, 'off');
  assert.equal(setup.migration.enabled, false);
  assert.equal(setup.keySource, 'none');
});

/* ---------------------- 各 store 的加密读写变体 ---------------------- */

test('store：会话/消息/记忆落盘为密文且无明文泄漏；重载可读；错误 key fail-fast', async () => {
  const dir = makeTmpDir('wild-atrest-store-');
  const logger = createCapturingLogger();
  const atRest = createAtRest({ key: KEY, dataDir: dir, logger });
  const store = await createStore({ dataDir: dir, logger, atRest });

  const conv = await store.createConversation({ title: '加密会话' });
  await store.appendMessage(conv.id, { role: 'user', text: '我的秘密是蓝色' });
  await store.addMemory({ text: '测试记忆 蓝色', kind: 'fact', level: 'core', category: 'other' });

  assert.equal(hasMagic(path.join(dir, 'index.json')), true);
  assert.equal(hasMagic(path.join(dir, 'memories.json')), true);
  assert.equal(hasMagic(path.join(dir, 'conversations', `${conv.id}.json`)), true);
  // 磁盘上没有明文内容泄漏
  assert.equal(readRaw(path.join(dir, 'memories.json')).includes(Buffer.from('测试记忆 蓝色')), false);
  assert.equal(
    readRaw(path.join(dir, 'conversations', `${conv.id}.json`)).includes(Buffer.from('我的秘密是蓝色')),
    false,
  );

  const reloaded = await createStore({ dataDir: dir, logger, atRest });
  assert.equal(reloaded.getConversation(conv.id)?.messages?.length, 1);
  assert.ok(reloaded.listMemories().some((item) => item.text === '测试记忆 蓝色'));

  await assert.rejects(
    createStore({ dataDir: dir, logger, atRest: createAtRest({ key: KEY2, dataDir: dir }) }),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
});

test('marks：收藏/摘录落盘为密文；重载可读；错误 key fail-fast', async () => {
  const dir = makeTmpDir('wild-atrest-marks-');
  const logger = createCapturingLogger();
  const docStore = await createDocStore({ docsDir: FIXTURE_CORPUS, logger });
  const atRest = createAtRest({ key: KEY, dataDir: dir, logger });
  const marks = await createMarksStore({ dataDir: dir, logger, docStore, atRest });

  const favorite = await marks.addFavorite({ docId: 'seasonal-01' });
  assert.equal(favorite.duplicated, false);
  assert.equal(hasMagic(path.join(dir, 'marks.json')), true);

  const reloaded = await createMarksStore({ dataDir: dir, logger, docStore, atRest });
  assert.equal(reloaded.list().favorites.length, 1);

  await assert.rejects(
    createMarksStore({ dataDir: dir, logger, docStore, atRest: createAtRest({ key: KEY2, dataDir: dir }) }),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
});

test('health：导入数据落盘为密文；重载可读；错误 key fail-fast', async () => {
  const dir = makeTmpDir('wild-atrest-health-');
  const logger = createCapturingLogger();
  const atRest = createAtRest({ key: KEY, dataDir: dir, logger });
  const health = await createHealthStore({ dataDir: dir, config: {}, logger, atRest });
  await health.importPayload({ metrics: { restingHeartRate: 61 } });
  assert.equal(hasMagic(path.join(dir, 'health.json')), true);

  const reloaded = await createHealthStore({ dataDir: dir, config: {}, logger, atRest });
  const payload = reloaded.summaryPayload();
  assert.ok(Object.keys(payload.days).length >= 1);

  await assert.rejects(
    createHealthStore({ dataDir: dir, config: {}, logger, atRest: createAtRest({ key: KEY2, dataDir: dir }) }),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
});

test('scales-history：结果摘要落盘为密文；重载可读；错误 key fail-fast', async () => {
  const dir = makeTmpDir('wild-atrest-scales-');
  const logger = createCapturingLogger();
  const config = { scaleHistory: true, scaleHistoryInject: true, scaleHistoryRetentionDays: 730 };
  const atRest = createAtRest({ key: KEY, dataDir: dir, logger });
  const store = await createScaleHistoryStore({ dataDir: dir, config, logger, atRest });
  await store.record(demo1Result(), { scale: DEMO_META });
  assert.equal(hasMagic(path.join(dir, 'scales-history.json')), true);

  const reloaded = await createScaleHistoryStore({ dataDir: dir, config, logger, atRest });
  assert.equal(reloaded.query({}).total, 1);

  await assert.rejects(
    createScaleHistoryStore({ dataDir: dir, config, logger, atRest: createAtRest({ key: KEY2, dataDir: dir }) }),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
});

test('attachments：图片密文落盘（非原字节）；read 解密返回原字节与明文 size；stats 按明文计', async () => {
  const dir = makeTmpDir('wild-atrest-attach-');
  const logger = createCapturingLogger();
  const atRest = createAtRest({ key: KEY, dataDir: dir, logger });
  const store = createAttachmentStore({ dataDir: dir, logger, atRest });
  const buffer = Buffer.from('fake-png-payload-for-at-rest-test');

  const persisted = await store.persistImage({ buffer, mime: 'image/png' });
  assert.ok(persisted?.id);
  const filePath = path.join(dir, 'attachments', `${persisted.id}.png`);
  assert.equal(hasMagic(filePath), true);
  assert.equal(readRaw(filePath).includes(buffer), false, '磁盘上不得是原始 PNG 字节');

  const read = await store.read(persisted.id);
  assert.deepEqual(read.buffer, buffer);
  assert.equal(read.mime, 'image/png');
  assert.equal(read.size, buffer.length);

  const stats = await store.stats();
  assert.equal(stats.count, 1);
  assert.equal(stats.bytes, buffer.length, '容量统计按明文计');

  // 重载 index 时按密文大小算回明文 size
  const reloaded = createAttachmentStore({ dataDir: dir, logger, atRest });
  const readAgain = await reloaded.read(persisted.id);
  assert.deepEqual(readAgain?.buffer, buffer);

  // 错误 key 读取 → null（不把密文当图片返回）
  const wrong = createAttachmentStore({ dataDir: dir, logger, atRest: createAtRest({ key: KEY2, dataDir: dir }) });
  assert.equal(await wrong.read(persisted.id), null);
});

/* --------------------------- 启动接线 / health --------------------------- */

test('startServer 带 key：启动自动迁移预置明文，health.storage.atRest=on 且记忆可读', async (t) => {
  const dataDir = makeTmpDir('wild-atrest-server-');
  const logger = createCapturingLogger();
  const seedStore = await createStore({ dataDir, logger });
  await seedStore.addMemory({ text: '启动加密测试记忆', kind: 'fact', level: 'core', category: 'other' });
  // 预置 dataDir 里现在是明文 memories.json
  assert.equal(isEncryptedBuffer(readRaw(path.join(dataDir, 'memories.json'))), false);

  const { baseUrl, ctx } = await startServer(t, {
    dataDir,
    env: { DATA_ENCRYPTION_KEY: KEY.toString('base64') },
  });
  const body = await (await fetch(`${baseUrl}/api/health`)).json();
  // health.storage 追加 envelope 字段（旧字段逐字节不变）；本用例 AUTH=off/默认 envelope=off。
  assert.deepEqual(body.storage, { ok: true, conversations: 0, memories: 1, atRest: 'on', envelope: 'off' });
  assert.equal(ctx.atRest.enabled, true);
  assert.equal(ctx.atRestMigration.migrated >= 1, true);
  assert.equal(hasMagic(path.join(dataDir, 'memories.json')), true, '启动时应把明文迁移为密文');
  assert.ok(ctx.store.listMemories().some((item) => item.text === '启动加密测试记忆'));
});

test('startServer 无 key：health.storage.atRest=off（明文兼容，既有行为不变）', async (t) => {
  const { baseUrl } = await startServer(t, {});
  const body = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.deepEqual(body.storage, { ok: true, conversations: 0, memories: 0, atRest: 'off', envelope: 'off' });
});

test('startServer 错误 key：启动必须 fail-fast（不静默覆盖既有密文）', async (t) => {
  const dataDir = makeTmpDir('wild-atrest-server-bad-');
  const logger = createCapturingLogger();
  const atRest = createAtRest({ key: KEY, dataDir, logger });
  const store = await createStore({ dataDir, logger, atRest });
  await store.addMemory({ text: '已被加密的记忆', kind: 'fact', level: 'core', category: 'other' });
  const before = readRaw(path.join(dataDir, 'memories.json'));

  await assert.rejects(
    startServer(t, { dataDir, env: { DATA_ENCRYPTION_KEY: KEY2.toString('base64') } }),
    (error) => isAtRestError(error) && error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
  assert.deepEqual(readRaw(path.join(dataDir, 'memories.json')), before, '启动失败不得修改数据');
});

/* ------------------------------- 密钥轮换 ------------------------------- */

test('rotateDataKey：--dry-run 不写盘；实跑后新 key 可读、旧 key 失效', async () => {
  const dir = makeTmpDir('wild-atrest-rotate-');
  const logger = createCapturingLogger();
  const seed = await createStore({ dataDir: dir, logger });
  await seed.addMemory({ text: '轮换前记忆', kind: 'fact', level: 'core', category: 'other' });
  const atRest = createAtRest({ key: KEY, dataDir: dir, logger });
  migrateDataDir({ dataDir: dir, atRest, logger });
  const snapshot = readRaw(path.join(dir, 'memories.json'));

  const keyDir = makeTmpDir('wild-atrest-rotate-keys-');
  const oldKeyFile = writeKeyFile(keyDir, 'old.key', KEY);
  const newKeyFile = writeKeyFile(keyDir, 'new.key', KEY2);

  const dry = spawnSync(
    process.execPath,
    [ROTATE_SCRIPT, '--data-dir', dir, '--old-key-file', oldKeyFile, '--new-key-file', newKeyFile, '--dry-run'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run/);
  assert.deepEqual(readRaw(path.join(dir, 'memories.json')), snapshot, 'dry-run 不得写盘');

  const real = spawnSync(
    process.execPath,
    [ROTATE_SCRIPT, '--data-dir', dir, '--old-key-file', oldKeyFile, '--new-key-file', newKeyFile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(real.status, 0, real.stderr);
  const newAtRest = createAtRest({ key: KEY2, dataDir: dir, logger });
  const store2 = await createStore({ dataDir: dir, logger, atRest: newAtRest });
  assert.ok(store2.listMemories().some((item) => item.text === '轮换前记忆'));
  await assert.rejects(
    createStore({ dataDir: dir, logger, atRest: createAtRest({ key: KEY, dataDir: dir }) }),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
});

test('rotateDataKey：users/<uid>/byok.secret.enc 按 byok:v1:<uid> AAD 一并轮换', () => {
  const dir = makeTmpDir('wild-atrest-rotate-byok-');
  seedPlainDataDir(dir);
  migrateDataDir({ dataDir: dir, atRest: createAtRest({ key: KEY, dataDir: dir }) });
  const uid = 'u0123456789ab';
  const userDir = path.join(dir, 'users', uid);
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const secret = Buffer.from(
    JSON.stringify({ apiKey: 'test-key-rotate-test-1234', baseUrl: 'https://api.deepseek.com/v1' }),
    'utf8',
  );
  fs.writeFileSync(path.join(userDir, 'byok.secret.enc'), encodePayload(KEY, `byok:v1:${uid}`, secret), {
    mode: 0o600,
  });

  const keyDir = makeTmpDir('wild-atrest-rotate-byok-keys-');
  const oldKeyFile = writeKeyFile(keyDir, 'old.key', KEY);
  const newKeyFile = writeKeyFile(keyDir, 'new.key', KEY2);
  const real = spawnSync(
    process.execPath,
    [ROTATE_SCRIPT, '--data-dir', dir, '--old-key-file', oldKeyFile, '--new-key-file', newKeyFile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /BYOK secret 1 个/);
  const rotated = fs.readFileSync(path.join(userDir, 'byok.secret.enc'));
  const plain = decodePayload(KEY2, `byok:v1:${uid}`, rotated);
  assert.equal(JSON.parse(plain.toString('utf8')).apiKey, 'test-key-rotate-test-1234');
  assert.throws(
    () => decodePayload(KEY, `byok:v1:${uid}`, rotated),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
});

test('rotate 脚本：缺 --new-key-file / 未知参数 / key 文件权限过宽 → 非 0 且不改数据', () => {
  const dir = makeTmpDir('wild-atrest-rotate-cli-');
  seedPlainDataDir(dir);
  const keyDir = makeTmpDir('wild-atrest-rotate-cli-keys-');
  const oldKeyFile = writeKeyFile(keyDir, 'old.key', KEY);
  const looseKeyFile = writeKeyFile(keyDir, 'loose.key', KEY2, 0o644);

  const missingNewKey = spawnSync(
    process.execPath,
    [ROTATE_SCRIPT, '--data-dir', dir, '--old-key-file', oldKeyFile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(missingNewKey.status, 1);

  const unknown = spawnSync(process.execPath, [ROTATE_SCRIPT, '--bogus'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(unknown.status, 2);

  const loose = spawnSync(
    process.execPath,
    [ROTATE_SCRIPT, '--data-dir', dir, '--old-key-file', oldKeyFile, '--new-key-file', looseKeyFile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(loose.status, 1);
  assert.match(`${loose.stderr}${loose.stdout}`, /权限/);
  // 失败不写数据
  assert.equal(isEncryptedBuffer(readRaw(path.join(dir, 'index.json'))), false);
});

test('help：rotate 脚本 --help 输出用法并 exit 0', () => {
  const help = spawnSync(process.execPath, [ROTATE_SCRIPT, '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--old-key-file/);
});

test('AtRestError 基础契约：isAtRestError 识别跨实例错误对象', () => {
  const error = new AtRestError(AT_REST_ERROR_CODES.AUTH_FAILED, 'x');
  assert.equal(isAtRestError(error), true);
  assert.equal(error.name, 'AtRestError');
  assert.equal(isAtRestError(new Error('x')), false);
});

/* ------------------- 加法导出：listKnownDataFilesInDir / listDirFiles ------------------- */

test('加法导出：listKnownDataFilesInDir 只列白名单数据文件；listDirFiles 可配置后缀/其它文件', () => {
  const dir = makeTmpDir('wild-atrest-lists-');
  seedPlainDataDir(dir); // index/memories/marks/health/scales-history + conversations/c1.json + attachments/png
  writePlain(dir, 'notes.json', '{}');
  writePlain(dir, 'other.txt', 'x');
  writePlain(dir, 'ignored.tmp', 'tmp');

  const known = listKnownDataFilesInDir(dir).map((filePath) => path.relative(dir, filePath));
  assert.deepEqual(
    known.sort(),
    [
      'attachments/akeep0000000000000000000.png',
      'conversations/c1.json',
      'health.json',
      'index.json',
      'marks.json',
      'memories.json',
      'scales-history.json',
    ].sort(),
    '白名单语义与此前私有实现一致（不含 notes.json/other.txt/*.tmp）',
  );
  // 用户分区目录同样复用该白名单（信封加密迁移的输入）。
  const userDir = makeTmpDir('wild-atrest-lists-user-');
  writePlain(userDir, 'memories.json', '{}');
  writePlain(userDir, 'byok.secret.enc', 'x');
  assert.deepEqual(
    listKnownDataFilesInDir(userDir).map((filePath) => path.relative(userDir, filePath)),
    ['memories.json'],
  );

  // listDirFiles：默认只列 .json；ext=.png 列附件；allowOther=true 列全部普通文件；.tmp 一律跳过。
  assert.deepEqual(
    listDirFiles(dir).map((filePath) => path.basename(filePath)).sort(),
    ['health.json', 'index.json', 'marks.json', 'memories.json', 'notes.json', 'scales-history.json'],
  );
  assert.deepEqual(
    listDirFiles(path.join(dir, 'attachments'), { allowOther: true }).map((filePath) => path.basename(filePath)),
    ['akeep0000000000000000000.png'],
  );
  assert.deepEqual(listDirFiles(path.join(dir, 'conversations'), { ext: '.json' }), [
    path.join(dir, 'conversations', 'c1.json'),
  ]);
  assert.deepEqual(listDirFiles(path.join(dir, 'does-not-exist')), [], '目录不存在时返回空数组');
});
