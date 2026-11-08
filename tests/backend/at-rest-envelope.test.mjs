// / 契约 2：at-rest 信封加密（KEK→DEK）单元测试。
// 覆盖：格式与常量、wrap/unwrap/AAD、错误分类、loadUserDek 幂等与 fail-fast、
// 迁移（KEK 密文→DEK 密文、AAD 不变、明文/空文件语义、幂等、错误 key fail-fast）、
// 迁移前整库备份只一次、ensureUserEnvelope 一站式、迁移后重启可读。
// 全部用临时目录，不触网、不打印明文密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  ENVELOPE_BACKUP_PREFIX,
  ENVELOPE_DEK_AAD_PREFIX,
  ENVELOPE_DEK_BYTES,
  ENVELOPE_DEK_FILE_NAME,
  ENVELOPE_DEK_PAYLOAD_BYTES,
  ENVELOPE_ERROR_CODES,
  ENVELOPE_FORMAT_VERSION,
  ENVELOPE_MAGIC,
  EnvelopeError,
  backupDataDirOnce,
  ensureUserEnvelope,
  isEnvelopeError,
  loadUserDek,
  migrateUserDirToEnvelope,
  unwrapDek,
  wrapDek,
} from '../../server/envelope.mjs';
import {
  AT_REST_ERROR_CODES,
  createAtRest,
  decodePayload,
  encodePayload,
  isAtRestError,
  setupAtRest,
} from '../../server/at-rest.mjs';
import { makeTmpDir } from './helpers.mjs';

const KEK = crypto.createHash('sha256').update('m43-envelope-kek-1').digest();
const KEK2 = crypto.createHash('sha256').update('m43-envelope-kek-2').digest();
const OTHER_KEY = crypto.createHash('sha256').update('m43-envelope-unknown-key').digest();

/* --------------------------------- 工具 --------------------------------- */

function makeUserDir(root, userId = 'u1') {
  const userDir = path.join(root, 'users', userId);
  fs.mkdirSync(path.join(userDir, 'conversations'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(userDir, 'attachments'), { recursive: true, mode: 0o700 });
  return userDir;
}

/** 用 KEK（旧单密钥）按「相对用户目录路径」AAD 写一个 v1 密文用户文件。 */
function seedKekUserFile(userDir, relative, plaintext, key = KEK) {
  const filePath = path.join(userDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const sealed = encodePayload(key, relative, Buffer.from(plaintext));
  fs.writeFileSync(filePath, sealed, { mode: 0o600 });
  return filePath;
}

/** 造一个「时代」的用户目录：3 个 KEK 密文 + 1 个明文 + 1 个空文件。 */
function seedLegacyUserDir(userDir) {
  seedKekUserFile(userDir, 'memories.json', '{"memories":["旧记忆"]}');
  seedKekUserFile(userDir, 'conversations/c1.json', '{"id":"c1","title":"旧会话"}');
  seedKekUserFile(userDir, 'attachments/a1.png', 'fake-png-bytes');
  fs.writeFileSync(path.join(userDir, 'marks.json'), '{"marks":[]}', { mode: 0o600 });
  fs.writeFileSync(path.join(userDir, 'health.json'), '', { mode: 0o600 });
}

function readFileBytes(filePath) {
  return fs.readFileSync(filePath);
}

function listBackupDirs(dataDir) {
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(ENVELOPE_BACKUP_PREFIX))
    .map((entry) => entry.name);
}

/* ------------------------------ 格式与常量 ------------------------------ */

test('常量与 .dek 格式：magic/版本/固定 70 字节/AAD 前缀/错误码冻结', () => {
  assert.equal(ENVELOPE_MAGIC, 'CTFDEK001');
  assert.equal(ENVELOPE_FORMAT_VERSION, 1);
  assert.equal(ENVELOPE_DEK_BYTES, 32);
  assert.equal(ENVELOPE_DEK_FILE_NAME, '.dek');
  assert.equal(ENVELOPE_DEK_AAD_PREFIX, 'dek:v1:');
  assert.equal(ENVELOPE_BACKUP_PREFIX, '.migration-backup-envelope-');
  assert.equal(ENVELOPE_DEK_PAYLOAD_BYTES, 70, 'magic(9)+ver(1)+iv(12)+tag(16)+wrapped(32)');
  assert.deepEqual({ ...ENVELOPE_ERROR_CODES }, { DEK_MISSING: 'DEK_MISSING', DEK_CORRUPT: 'DEK_CORRUPT', KEK_MISMATCH: 'KEK_MISMATCH' });
  assert.equal(Object.isFrozen(ENVELOPE_ERROR_CODES), true);

  const dek = crypto.randomBytes(ENVELOPE_DEK_BYTES);
  const wrapped = wrapDek(KEK, 'u1', dek);
  assert.equal(Buffer.isBuffer(wrapped), true);
  assert.equal(wrapped.length, ENVELOPE_DEK_PAYLOAD_BYTES);
  assert.equal(wrapped.subarray(0, ENVELOPE_MAGIC.length).toString('latin1'), ENVELOPE_MAGIC);
  assert.equal(wrapped[ENVELOPE_MAGIC.length], ENVELOPE_FORMAT_VERSION);
  assert.equal(unwrapDek(KEK, 'u1', wrapped).equals(dek), true);
});

test('wrapDek 每次随机 IV（同 KEK/用户/DEK 两次包裹字节不同）；AAD 绑定 userId', () => {
  const dek = crypto.randomBytes(ENVELOPE_DEK_BYTES);
  const a = wrapDek(KEK, 'u1', dek);
  const b = wrapDek(KEK, 'u1', dek);
  assert.equal(a.equals(b), false, '每次包裹必须使用新随机 IV');
  assert.equal(unwrapDek(KEK, 'u1', a).equals(dek), true);

  // AAD = dek:v1:<userId>：换 userId 解不开（即使 KEK 正确）。
  assert.throws(
    () => unwrapDek(KEK, 'u2', a),
    (error) => isEnvelopeError(error) && error.code === ENVELOPE_ERROR_CODES.KEK_MISMATCH,
  );
  // 换 KEK 解不开。
  assert.throws(
    () => unwrapDek(KEK2, 'u1', a),
    (error) => isEnvelopeError(error) && error.code === ENVELOPE_ERROR_CODES.KEK_MISMATCH,
  );
});

test('unwrapDek：结构损坏→DEK_CORRUPT；GCM 校验失败（tag 篡改）→KEK_MISMATCH', () => {
  const dek = crypto.randomBytes(ENVELOPE_DEK_BYTES);
  const wrapped = wrapDek(KEK, 'u1', dek);

  const expectCode = (payload, code) =>
    assert.throws(
      () => unwrapDek(KEK, 'u1', payload),
      (error) => isEnvelopeError(error) && error.code === code,
    );

  // 魔数不符
  const badMagic = Buffer.from(wrapped);
  badMagic[0] = 0x42;
  expectCode(badMagic, ENVELOPE_ERROR_CODES.DEK_CORRUPT);
  // 版本不符
  const badVersion = Buffer.from(wrapped);
  badVersion[ENVELOPE_MAGIC.length] = 99;
  expectCode(badVersion, ENVELOPE_ERROR_CODES.DEK_CORRUPT);
  // 截断/超长
  expectCode(wrapped.subarray(0, 10), ENVELOPE_ERROR_CODES.DEK_CORRUPT);
  expectCode(Buffer.concat([wrapped, Buffer.from([0])]), ENVELOPE_ERROR_CODES.DEK_CORRUPT);
  // 非 Buffer
  expectCode('CTFDEK001-not-a-buffer', ENVELOPE_ERROR_CODES.DEK_CORRUPT);
  // GCM tag 篡改：密码学上与「KEK 不匹配」不可区分，按 KEK_MISMATCH 归因（不返回明文）。
  const badTag = Buffer.from(wrapped);
  badTag[badTag.length - ENVELOPE_DEK_BYTES - 1] ^= 0xff;
  expectCode(badTag, ENVELOPE_ERROR_CODES.KEK_MISMATCH);
  // 非法 KEK/DEK 参数
  assert.throws(
    () => unwrapDek(Buffer.alloc(16), 'u1', wrapped),
    (error) => isEnvelopeError(error) && error.code === ENVELOPE_ERROR_CODES.KEK_MISMATCH,
  );
  assert.throws(
    () => wrapDek(Buffer.alloc(16), 'u1', dek),
    (error) => error.code === ENVELOPE_ERROR_CODES.KEK_MISMATCH,
  );
  assert.throws(
    () => wrapDek(KEK, 'u1', Buffer.alloc(16)),
    (error) => error.code === ENVELOPE_ERROR_CODES.DEK_CORRUPT,
  );
  // EnvelopeError 基础契约
  const error = new EnvelopeError(ENVELOPE_ERROR_CODES.DEK_MISSING, '缺少 DEK');
  assert.equal(error.name, 'EnvelopeError');
  assert.equal(error.code, ENVELOPE_ERROR_CODES.DEK_MISSING);
  assert.equal(isEnvelopeError(error), true);
  assert.equal(isEnvelopeError(new Error('x')), false);
});

/* ------------------------------ loadUserDek ------------------------------ */

test('loadUserDek：不存在则创建（0700/0600、70B、created:true），第二次加载 created:false 且同一 DEK', async () => {
  const root = makeTmpDir('m43-dek-');
  const userDir = makeUserDir(root);
  const first = await loadUserDek({ kek: KEK, userDir, userId: 'u1' });
  assert.equal(first.created, true);
  assert.equal(Buffer.isBuffer(first.dek), true);
  assert.equal(first.dek.length, ENVELOPE_DEK_BYTES);

  const dekPath = path.join(userDir, ENVELOPE_DEK_FILE_NAME);
  const raw = readFileBytes(dekPath);
  assert.equal(raw.length, ENVELOPE_DEK_PAYLOAD_BYTES);
  assert.equal(raw.subarray(0, ENVELOPE_MAGIC.length).toString('latin1'), ENVELOPE_MAGIC);
  assert.equal(fs.statSync(dekPath).mode & 0o777, 0o600, '.dek 必须是 0600');
  assert.equal(fs.statSync(userDir).mode & 0o777, 0o700, '用户目录必须是 0700');

  const second = await loadUserDek({ kek: KEK, userDir, userId: 'u1' });
  assert.equal(second.created, false);
  assert.equal(second.dek.equals(first.dek), true);
  assert.equal(readFileBytes(dekPath).equals(raw), true, '已存在的 .dek 不得被重写');
});

test('loadUserDek：错误 KEK / 损坏 .dek 必须 fail-fast，且不重建覆盖', async () => {
  const root = makeTmpDir('m43-dek-fail-');
  const userDir = makeUserDir(root);
  const { dek } = await loadUserDek({ kek: KEK, userDir, userId: 'u1' });
  const dekPath = path.join(userDir, ENVELOPE_DEK_FILE_NAME);
  const raw = readFileBytes(dekPath);

  await assert.rejects(
    () => loadUserDek({ kek: KEK2, userDir, userId: 'u1' }),
    (error) => isEnvelopeError(error) && error.code === ENVELOPE_ERROR_CODES.KEK_MISMATCH,
  );
  assert.equal(readFileBytes(dekPath).equals(raw), true, '错误 KEK 时不得改写 .dek');

  fs.writeFileSync(dekPath, raw.subarray(0, 20), { mode: 0o600 }); // 截断损坏
  await assert.rejects(
    () => loadUserDek({ kek: KEK, userDir, userId: 'u1' }),
    (error) => isEnvelopeError(error) && error.code === ENVELOPE_ERROR_CODES.DEK_CORRUPT,
  );
  assert.equal(readFileBytes(dekPath).length, 20, '损坏 .dek 不得被静默重建覆盖');
  assert.equal(unwrapDek(KEK, 'u1', wrapDek(KEK, 'u1', dek)).equals(dek), true);
});

/* ---------------------------- backupDataDirOnce ---------------------------- */

test('backupDataDirOnce：复制整个 DATA_DIR（跳过 *.tmp/自身），只备一次；DATA_DIR 不存在返回 null', async () => {
  const dataDir = makeTmpDir('m43-backup-');
  fs.writeFileSync(path.join(dataDir, 'index.json'), 'iv-root', { mode: 0o600 });
  fs.mkdirSync(path.join(dataDir, 'users', 'u1', 'attachments'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'users', 'u1', 'memories.json'), 'iv-user', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'users', 'u1', 'attachments', 'a1.png'), 'png', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'pending.tmp'), 'tmp', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, ENVELOPE_DEK_FILE_NAME), 'not-really-a-dek', { mode: 0o600 });

  const backupDir = await backupDataDirOnce({ dataDir, logger: { log() {}, warn() {} } });
  assert.equal(typeof backupDir, 'string');
  assert.equal(fs.existsSync(backupDir), true);
  assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700, '备份目录 0700');
  // 内容完整（含隐藏文件，如 .dek），但不含 *.tmp 与备份自身。
  assert.equal(readFileBytes(path.join(backupDir, 'index.json')).toString(), 'iv-root');
  assert.equal(readFileBytes(path.join(backupDir, 'users', 'u1', 'memories.json')).toString(), 'iv-user');
  assert.equal(readFileBytes(path.join(backupDir, 'users', 'u1', 'attachments', 'a1.png')).toString(), 'png');
  assert.equal(fs.existsSync(path.join(backupDir, ENVELOPE_DEK_FILE_NAME)), true);
  assert.equal(fs.existsSync(path.join(backupDir, 'pending.tmp')), false, '*.tmp 不备份');
  assert.equal(listBackupDirs(dataDir).length, 1);
  assert.equal(fs.existsSync(path.join(backupDir, ENVELOPE_BACKUP_PREFIX)), false, '备份不递归包含自身');
  assert.equal(fs.statSync(path.join(backupDir, 'index.json')).mode & 0o777, 0o600, '备份文件 0600');

  // 只备一次：已有备份目录 → null，不再新建。
  assert.equal(await backupDataDirOnce({ dataDir, logger: { log() {}, warn() {} } }), null);
  assert.equal(listBackupDirs(dataDir).length, 1);

  // DATA_DIR 不存在（从未初始化）→ 无需备份，返回 null。
  assert.equal(await backupDataDirOnce({ dataDir: path.join(dataDir, 'nope') }), null);
});

/* -------------------------------- 迁移 --------------------------------- */

test('migrateUserDirToEnvelope：KEK 密文→DEK 密文（AAD 不变）、明文/空文件 skipped 且字节不变', async () => {
  const root = makeTmpDir('m43-migrate-');
  const userDir = makeUserDir(root);
  seedLegacyUserDir(userDir);
  const plainMarksBefore = readFileBytes(path.join(userDir, 'marks.json'));
  const emptyHealthBefore = readFileBytes(path.join(userDir, 'health.json'));

  const dek = crypto.randomBytes(ENVELOPE_DEK_BYTES);
  const logger = { log() {}, warn() {} };
  const result = await migrateUserDirToEnvelope({ kek: KEK, dek, userDir, logger });
  assert.deepEqual(result, { migrated: 3, skipped: 2, failed: 0 });

  const migratedFiles = [
    ['memories.json', '{"memories":["旧记忆"]}'],
    ['conversations/c1.json', '{"id":"c1","title":"旧会话"}'],
    ['attachments/a1.png', 'fake-png-bytes'],
  ];
  for (const [relative, expected] of migratedFiles) {
    const raw = readFileBytes(path.join(userDir, ...relative.split('/')));
    assert.equal(decodePayload(dek, relative, raw).toString(), expected, `${relative} 必须能被 DEK 解开`);
    assert.throws(
      () => decodePayload(KEK, relative, raw),
      (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
      `${relative} 迁移后旧 KEK 必须解不开`,
    );
    // AAD 不变：仍按「相对用户目录路径」绑定 → 换路径解不开。
    assert.throws(
      () => decodePayload(dek, `wrong/${relative}`, raw),
      (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
      `${relative} 的 AAD 必须仍是相对用户目录路径`,
    );
  }
  // 明文/空文件：读取兼容视为已迁移，不重写、字节不变。
  assert.equal(readFileBytes(path.join(userDir, 'marks.json')).equals(plainMarksBefore), true);
  assert.equal(readFileBytes(path.join(userDir, 'health.json')).equals(emptyHealthBefore), true);
  assert.equal(fs.existsSync(path.join(userDir, ENVELOPE_DEK_FILE_NAME)), false, '迁移函数本身不创建 .dek');

  // 幂等：第二次迁移 0 个。
  const again = await migrateUserDirToEnvelope({ kek: KEK, dek, userDir, logger });
  assert.deepEqual(again, { migrated: 0, skipped: 5, failed: 0 });
});

test('migrateUserDirToEnvelope：错误 key 双失败必须 fail-fast，任何文件不得改动（无半迁移）', async () => {
  const root = makeTmpDir('m43-migrate-fail-');
  const userDir = makeUserDir(root);
  // memories.json 是合法旧 v1 密文（本可迁移），health.json 是未知密钥密文（必然失败）。
  seedKekUserFile(userDir, 'memories.json', '{"memories":[]}');
  seedKekUserFile(userDir, 'health.json', '{"status":"ok"}', OTHER_KEY);
  const before = new Map(
    ['memories.json', 'health.json'].map((relative) => [
      relative,
      readFileBytes(path.join(userDir, ...relative.split('/'))),
    ]),
  );
  const dek = crypto.randomBytes(ENVELOPE_DEK_BYTES);

  await assert.rejects(
    () => migrateUserDirToEnvelope({ kek: KEK, dek, userDir, logger: { log() {}, warn() {} } }),
    (error) =>
      isEnvelopeError(error) &&
      error.code === ENVELOPE_ERROR_CODES.KEK_MISMATCH &&
      /未改动任何文件/.test(error.message),
  );
  for (const [relative, raw] of before) {
    assert.equal(
      readFileBytes(path.join(userDir, ...relative.split('/'))).equals(raw),
      true,
      `${relative} 必须保持原字节（fail-fast 不得半迁移）`,
    );
  }
  // memories.json 仍是旧 KEK 密文（没被提前改写）。
  assert.equal(
    decodePayload(KEK, 'memories.json', readFileBytes(path.join(userDir, 'memories.json'))).toString(),
    '{"memories":[]}',
  );
});

/* --------------------------- ensureUserEnvelope --------------------------- */

test('ensureUserEnvelope 一站式：创建 DEK + 备份一次 + 迁移；二次调用幂等；错误 KEK fail-fast', async () => {
  const dataDir = makeTmpDir('m43-ensure-');
  fs.writeFileSync(path.join(dataDir, 'index.json'), encodePayload(KEK, 'index.json', Buffer.from('{"v":1}')), {
    mode: 0o600,
  });
  const userDir = makeUserDir(dataDir);
  seedLegacyUserDir(userDir);
  const logger = { log() {}, warn() {}, debug() {} };

  const first = await ensureUserEnvelope({ kek: KEK, dataDir, userDir, userId: 'u1', logger });
  assert.equal(first.created, true);
  assert.equal(first.migrated, 3);
  assert.equal(first.dek.length, ENVELOPE_DEK_BYTES);
  assert.equal(listBackupDirs(dataDir).length, 1, '迁移前整库备份一次');
  assert.equal(fs.existsSync(path.join(userDir, ENVELOPE_DEK_FILE_NAME)), true);
  assert.equal(
    decodePayload(first.dek, 'memories.json', readFileBytes(path.join(userDir, 'memories.json'))).toString(),
    '{"memories":["旧记忆"]}',
    '迁移后用户文件能被 DEK 解开',
  );

  const second = await ensureUserEnvelope({ kek: KEK, dataDir, userDir, userId: 'u1', logger });
  assert.equal(second.created, false);
  assert.equal(second.migrated, 0);
  assert.equal(second.dek.equals(first.dek), true);
  assert.equal(listBackupDirs(dataDir).length, 1, '备份只做一次（幂等）');

  // 错误 KEK：fail-fast，且不新建 DEK/备份、不改动任何数据。
  // 场景与测试实例 B 一致：用户目录已完成信封迁移（已有 DEK），换错 KEK 后必须解不开而 fail-fast。
  const root2 = makeTmpDir('m43-ensure-fail-');
  const userDir2 = makeUserDir(root2);
  seedLegacyUserDir(userDir2);
  const { dek: dek2 } = await loadUserDek({ kek: KEK, userDir: userDir2, userId: 'u1', logger });
  await migrateUserDirToEnvelope({ kek: KEK, dek: dek2, userDir: userDir2, logger });
  const dekPath2 = path.join(userDir2, ENVELOPE_DEK_FILE_NAME);
  const dekBytesBefore = readFileBytes(dekPath2);
  const memoriesBefore = readFileBytes(path.join(userDir2, 'memories.json'));
  await assert.rejects(
    () => ensureUserEnvelope({ kek: KEK2, dataDir: root2, userDir: userDir2, userId: 'u1', logger }),
    (error) => isEnvelopeError(error) && error.code === ENVELOPE_ERROR_CODES.KEK_MISMATCH,
  );
  assert.equal(readFileBytes(dekPath2).equals(dekBytesBefore), true, '错误 KEK 下不得改写 .dek');
  assert.equal(readFileBytes(path.join(userDir2, 'memories.json')).equals(memoriesBefore), true);
  assert.equal(listBackupDirs(root2).length, 0, '错误 KEK 下不得产生备份');
});

test('迁移后重启兼容：createAtRest({key:dek,dataDir:userDir}) 可读；旧 KEK 不可读', async () => {
  const dataDir = makeTmpDir('m43-restart-');
  const userDir = makeUserDir(dataDir);
  seedLegacyUserDir(userDir);
  const { dek } = await ensureUserEnvelope({
    kek: KEK,
    dataDir,
    userDir,
    userId: 'u1',
    logger: { log() {}, warn() {}, debug() {} },
  });

  // 模拟重启：用 DEK 构造用户作用域的 at-rest（AAD=相对用户目录路径）。
  const atRest = createAtRest({ key: dek, dataDir: userDir, logger: { warn() {}, log() {} } });
  assert.equal(atRest.enabled, true);
  assert.equal(
    atRest.readFileSync(path.join(userDir, 'memories.json')).toString(),
    '{"memories":["旧记忆"]}',
  );
  assert.equal(
    atRest.readFileSync(path.join(userDir, 'conversations', 'c1.json')).toString(),
    '{"id":"c1","title":"旧会话"}',
  );
  // 旧 KEK 读 DEK 密文 → fail-fast（AUTH_FAILED）。
  const oldAtRest = createAtRest({ key: KEK, dataDir: userDir, logger: { warn() {}, log() {} } });
  assert.throws(
    () => oldAtRest.readFileSync(path.join(userDir, 'memories.json')),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
});

/* -------------------- 启动迁移 × 信封模式的混合态（ 回归） -------------------- */

test('setupAtRest(envelope:true)：二次启动跳过 users/** 的 DEK 密文（不 fail-fast），根文件仍按 KEK 迁移', async () => {
  const dataDir = makeTmpDir('m43-setup-envelope-');
  const quiet = { log() {}, warn() {}, debug() {} };
  // 根目录全局文件仍是明文（模拟升级前历史），用户 u1 已迁移为 DEK 密文，u2 尚未迁移（旧 KEK 密文）。
  fs.writeFileSync(path.join(dataDir, 'index.json'), '{"v":1}', { mode: 0o600 });
  const userDir = makeUserDir(dataDir, 'u1');
  seedKekUserFile(userDir, 'memories.json', '{"memories":["信封记忆"]}');
  const { dek } = await ensureUserEnvelope({ kek: KEK, dataDir, userDir, userId: 'u1', logger: quiet });
  const userDir2 = makeUserDir(dataDir, 'u2');
  seedKekUserFile(userDir2, 'memories.json', '{"memories":["旧用户"]}');
  const u1Before = readFileBytes(path.join(userDir, 'memories.json'));
  const u2Before = readFileBytes(path.join(userDir2, 'memories.json'));
  const env = { DATA_ENCRYPTION_KEY: KEK.toString('base64') };

  // 首次启动：只迁移根目录全局文件，users/** 一律跳过（混合态安全）。
  const first = setupAtRest({ dataDir, config: { atRestEnvelope: true }, env, logger: quiet });
  assert.equal(first.atRest.enabled, true);
  assert.equal(first.migration.migrated, 1, '只应迁移根目录 index.json');
  assert.equal(
    decodePayload(KEK, 'index.json', readFileBytes(path.join(dataDir, 'index.json'))).toString(),
    '{"v":1}',
  );
  assert.equal(readFileBytes(path.join(userDir, 'memories.json')).equals(u1Before), true, 'u1 DEK 密文不得被改动');
  assert.equal(decodePayload(dek, 'memories.json', readFileBytes(path.join(userDir, 'memories.json'))).toString(), '{"memories":["信封记忆"]}');
  assert.equal(readFileBytes(path.join(userDir2, 'memories.json')).equals(u2Before), true, 'u2 旧 KEK 密文保持原样待懒迁移');

  // 二次启动（同 KEK）： 的 idempotent 场景 —— 不得因 users/** 的 DEK 密文 fail-fast。
  const second = setupAtRest({ dataDir, config: { atRestEnvelope: true }, env, logger: quiet });
  assert.equal(second.migration.migrated, 0);
  assert.equal(second.migration.skipped, 1, '根目录密文校验通过；users/** 跳过');
  assert.equal(readFileBytes(path.join(userDir, 'memories.json')).equals(u1Before), true);
});

test('setupAtRest(envelope:false) 回归：users/** 仍按 KEK 校验（DEK 密文 → fail-fast 且不改动任何文件）', async () => {
  const dataDir = makeTmpDir('m43-setup-legacy-');
  const quiet = { log() {}, warn() {}, debug() {} };
  const userDir = makeUserDir(dataDir);
  seedKekUserFile(userDir, 'memories.json', '{"memories":["历史"]}');
  await ensureUserEnvelope({ kek: KEK, dataDir, userDir, userId: 'u1', logger: quiet });
  const memoriesBefore = readFileBytes(path.join(userDir, 'memories.json'));
  const dekBefore = readFileBytes(path.join(userDir, ENVELOPE_DEK_FILE_NAME));
  const env = { DATA_ENCRYPTION_KEY: KEK.toString('base64') };

  // envelope=off 且 users/** 已是 DEK 密文：KEK 校验必然失败 → 必须 fail-fast（回滚需恢复迁移前备份）。
  assert.throws(
    () => setupAtRest({ dataDir, config: { atRestEnvelope: false }, env, logger: quiet }),
    (error) =>
      isAtRestError(error) &&
      error.code === AT_REST_ERROR_CODES.AUTH_FAILED &&
      /已有密文但当前密钥无法解密/.test(error.message),
  );
  assert.equal(readFileBytes(path.join(userDir, 'memories.json')).equals(memoriesBefore), true);
  assert.equal(readFileBytes(path.join(userDir, ENVELOPE_DEK_FILE_NAME)).equals(dekBefore), true);
});
