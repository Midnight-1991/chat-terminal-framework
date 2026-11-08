// 多用户迁移脚本 + at-rest users/ 分区扩展测试。
// 全部用临时目录，不触网；密码/密钥不落日志。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  MIGRATION_FILE_NAME,
  migrateMultiuser,
  resolveAdminBootstrap,
  resolveDataDir,
} from '../../scripts/migrate-multiuser.mjs';
import {
  AT_REST_ERROR_CODES,
  createAtRest,
  decodePayload,
  encodePayload,
  hasEncryptedDataFiles,
  isEncryptedBuffer,
  listDataFiles,
  setupAtRest,
} from '../../server/at-rest.mjs';
import { createUserService, verifyPassword } from '../../server/users.mjs';
import { createCapturingLogger, makeTmpDir } from './helpers.mjs';

const ADMIN_PASSWORD = 'migration-admin-pass-9';
const ADMIN_USERNAME = 'admin';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function b64Key(key) {
  return key.toString('base64');
}

function writePlain(dir, relativePath, content) {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function makeAdminEnv(dir, { password = ADMIN_PASSWORD, username = ADMIN_USERNAME, extra = {} } = {}) {
  const passwordFile = path.join(dir, 'admin-password.txt');
  fs.writeFileSync(passwordFile, `${password}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    AUTH: 'on',
    ADMIN_USERNAME: username,
    ADMIN_INITIAL_PASSWORD_FILE: passwordFile,
    ...extra,
  };
}

/** 写入 7 个 legacy 数据文件（与 at-rest 测试同构）。 */
function seedLegacyData(dir) {
  writePlain(dir, 'index.json', `${JSON.stringify({ version: 1, conversations: [{ id: 'c1' }] })}\n`);
  writePlain(dir, 'memories.json', `${JSON.stringify({ version: 2, memories: [{ id: 'm1' }] })}\n`);
  writePlain(dir, 'marks.json', `${JSON.stringify({ version: 1, excerpt: [], favorites: [] })}\n`);
  writePlain(dir, 'health.json', `${JSON.stringify({ version: 1, updatedAt: 1, days: {} })}\n`);
  writePlain(dir, 'scales-history.json', `${JSON.stringify({ version: 1, updatedAt: 1, entries: [] })}\n`);
  writePlain(dir, 'conversations/c1.json', `${JSON.stringify({ id: 'c1', title: '旧会话', messages: [] })}\n`);
  const png = Buffer.from('legacy-png-bytes');
  writePlain(dir, 'attachments/akeep0000000000000000000.png', png);
  return { png };
}

function listBackupDirs(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('.migration-backup-'))
    .sort();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/* ------------------------------ 参数解析 ------------------------------ */

test('resolveDataDir：绝对路径原样、相对路径按 repoRoot 解析', () => {
  assert.equal(resolveDataDir({ DATA_DIR: '/tmp/abs-data' }), '/tmp/abs-data');
  assert.equal(resolveDataDir({}, { repoRoot: '/repo' }), path.join('/repo', 'data'));
  assert.equal(resolveDataDir({ DATA_DIR: 'persist-x' }, { repoRoot: '/repo' }), path.join('/repo', 'persist-x'));
});

test('resolveAdminBootstrap：缺 env / 读不到文件 / 空文件 / 过短 → 明确报错且不回显密码', () => {
  const dir = makeTmpDir('wild-mig-admin-');
  assert.throws(() => resolveAdminBootstrap({ AUTH: 'on' }, { repoRoot: dir }), /ADMIN_INITIAL_PASSWORD_FILE/);
  assert.throws(
    () => resolveAdminBootstrap({ AUTH: 'on', ADMIN_INITIAL_PASSWORD_FILE: path.join(dir, 'nope.txt') }, { repoRoot: dir }),
    /无法读取 ADMIN_INITIAL_PASSWORD_FILE/,
  );
  const emptyFile = path.join(dir, 'empty.txt');
  fs.writeFileSync(emptyFile, '   \n', { mode: 0o600 });
  assert.throws(
    () => resolveAdminBootstrap({ AUTH: 'on', ADMIN_INITIAL_PASSWORD_FILE: emptyFile }, { repoRoot: dir }),
    /内容为空/,
  );
  const shortFile = path.join(dir, 'short.txt');
  fs.writeFileSync(shortFile, 'short\n', { mode: 0o600 });
  assert.throws(
    () => resolveAdminBootstrap({ AUTH: 'on', ADMIN_INITIAL_PASSWORD_FILE: shortFile }, { repoRoot: dir }),
    /不符合密码规则/,
  );
  const goodFile = path.join(dir, 'good.txt');
  fs.writeFileSync(goodFile, `${ADMIN_PASSWORD}\n`, { mode: 0o600 });
  const admin = resolveAdminBootstrap(
    { AUTH: 'on', ADMIN_USERNAME: 'root', ADMIN_INITIAL_PASSWORD_FILE: goodFile },
    { repoRoot: dir, logger: createCapturingLogger() },
  );
  assert.equal(admin.username, 'root');
  assert.equal(admin.initialPassword, ADMIN_PASSWORD);
});

/* ------------------------------ 幂等/跳过 ------------------------------ */

test('migrateMultiuser：AUTH=off → 跳过，不建任何文件', async () => {
  const dir = makeTmpDir('wild-mig-off-');
  seedLegacyData(dir);
  const result = await migrateMultiuser({ dataDir: dir, env: { AUTH: 'off' }, logger: createCapturingLogger() });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'auth-off');
  assert.equal(fs.existsSync(path.join(dir, 'users.json')), false);
  assert.equal(fs.existsSync(path.join(dir, MIGRATION_FILE_NAME)), false);
  assert.equal(fs.existsSync(path.join(dir, 'memories.json')), true, 'off 模式不得动数据');
});

test('migrateMultiuser：users.json 已存在或 migration.json 已存在 → 幂等跳过（不再要求密码文件）', async () => {
  const dir = makeTmpDir('wild-mig-idempotent-');
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ version: 1, users: [] }));
  const usersResult = await migrateMultiuser({ dataDir: dir, env: { AUTH: 'on' }, logger: createCapturingLogger() });
  assert.equal(usersResult.reason, 'users-exist');

  const dir2 = makeTmpDir('wild-mig-idempotent2-');
  fs.writeFileSync(path.join(dir2, MIGRATION_FILE_NAME), JSON.stringify({ version: 1 }));
  const migrationResult = await migrateMultiuser({
    dataDir: dir2,
    env: { AUTH: 'on' },
    logger: createCapturingLogger(),
  });
  assert.equal(migrationResult.reason, 'already-migrated');
});

/* ------------------------------ 明文迁移 ------------------------------ */

test('migrateMultiuser：明文 legacy 数据 → users/<admin>/ + migration.json + 备份 SHA256 清单', async () => {
  const dir = makeTmpDir('wild-mig-plain-');
  const { png } = seedLegacyData(dir);
  const originals = new Map();
  for (const relative of [
    'index.json',
    'memories.json',
    'marks.json',
    'health.json',
    'scales-history.json',
    'conversations/c1.json',
    'attachments/akeep0000000000000000000.png',
  ]) {
    originals.set(relative, fs.readFileSync(path.join(dir, relative)));
  }
  const logger = createCapturingLogger();
  const result = await migrateMultiuser({
    dataDir: dir,
    env: makeAdminEnv(dir),
    repoRoot: dir,
    logger,
  });

  assert.equal(result.migrated, true);
  assert.equal(result.encryption, false);
  assert.equal(result.files, 7);
  assert.match(result.adminUserId, /^u[0-9a-f]{12}$/);
  assert.equal(result.adminUsername, ADMIN_USERNAME);

  // migration.json 记录
  const record = readJson(path.join(dir, MIGRATION_FILE_NAME));
  assert.equal(record.version, 1);
  assert.equal(record.adminUserId, result.adminUserId);
  assert.equal(record.adminUsername, ADMIN_USERNAME);
  assert.equal(record.encryption, false);
  assert.equal(record.files.length, 7);
  for (const entry of record.files) {
    assert.equal(entry.to.startsWith(`users/${result.adminUserId}/`), true);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
  // 目标文件落位 + 源文件删除
  const userDir = path.join(dir, 'users', result.adminUserId);
  for (const [relative, raw] of originals) {
    const target = path.join(userDir, relative);
    assert.equal(fs.existsSync(target), true, `${relative} 应迁移到用户分区`);
    assert.equal(fs.existsSync(path.join(dir, relative)), false, `${relative} 源文件应删除`);
    assert.deepEqual(fs.readFileSync(target), raw, `${relative} 明文内容应逐字节一致`);
  }
  assert.deepEqual(fs.readFileSync(path.join(userDir, 'attachments/akeep0000000000000000000.png')), png);
  // 文件权限 600
  assert.equal(fs.statSync(path.join(userDir, 'memories.json')).mode & 0o777, 0o600);

  // 管理员密码可校验（users.json 存 hash，不存明文）
  const users = createUserService({ dataDir: dir, logger: createCapturingLogger() });
  const admin = await users.getByUsername(ADMIN_USERNAME);
  assert.ok(admin);
  assert.equal(admin.role, 'admin');
  assert.equal(verifyPassword(ADMIN_PASSWORD, admin), true);
  assert.equal(JSON.stringify(readJson(path.join(dir, 'users.json'))).includes(ADMIN_PASSWORD), false);

  // 备份目录 + manifest SHA256 与源文件一致
  const backups = listBackupDirs(dir);
  assert.equal(backups.length, 1);
  const backupDir = path.join(dir, backups[0]);
  const manifest = readJson(path.join(backupDir, 'manifest.json'));
  assert.equal(manifest.files.length, 7);
  for (const entry of manifest.files) {
    assert.equal(entry.sha256, sha256(originals.get(entry.path)));
    assert.deepEqual(fs.readFileSync(path.join(backupDir, entry.path)), originals.get(entry.path));
  }

  // 日志不含明文密码
  for (const line of logger.logs) {
    assert.equal(String(line.text).includes(ADMIN_PASSWORD), false, `日志不得含明文密码：${line.text}`);
  }

  // 幂等：第二次调用跳过
  const second = await migrateMultiuser({
    dataDir: dir,
    env: { AUTH: 'on' },
    logger: createCapturingLogger(),
  });
  assert.equal(second.migrated, false);
  assert.equal(second.reason, 'already-migrated');
});

test('migrateMultiuser：无 legacy 数据也建管理员 + 空备份清单 + migration.json', async () => {
  const dir = makeTmpDir('wild-mig-empty-');
  const result = await migrateMultiuser({
    dataDir: dir,
    env: makeAdminEnv(dir),
    repoRoot: dir,
    logger: createCapturingLogger(),
  });
  assert.equal(result.migrated, true);
  assert.equal(result.files, 0);
  assert.equal(fs.existsSync(path.join(dir, 'users.json')), true);
  assert.equal(fs.existsSync(path.join(dir, MIGRATION_FILE_NAME)), true);
  const manifest = readJson(path.join(dir, listBackupDirs(dir)[0], 'manifest.json'));
  assert.deepEqual(manifest.files, []);
});

/* ------------------------------ 加密迁移 ------------------------------ */

test('migrateMultiuser：at-rest 密文 legacy → per-user AAD 重加密（unseal→seal，不 rename）', async () => {
  const dir = makeTmpDir('wild-mig-enc-');
  const key = crypto.randomBytes(32);
  const memoriesPlain = Buffer.from(JSON.stringify({ version: 2, memories: [{ id: 'm1' }] }));
  const conversationPlain = Buffer.from(JSON.stringify({ id: 'c1', title: '旧会话' }));
  writePlain(dir, 'memories.json', encodePayload(key, 'memories.json', memoriesPlain));
  writePlain(dir, 'conversations/c1.json', encodePayload(key, 'conversations/c1.json', conversationPlain));
  const sealedMemoriesBefore = fs.readFileSync(path.join(dir, 'memories.json'));

  const result = await migrateMultiuser({
    dataDir: dir,
    env: makeAdminEnv(dir, { extra: { DATA_ENCRYPTION_KEY: b64Key(key) } }),
    repoRoot: dir,
    logger: createCapturingLogger(),
  });
  assert.equal(result.migrated, true);
  assert.equal(result.encryption, true);
  assert.equal(result.files, 2);
  const userDir = path.join(dir, 'users', result.adminUserId);
  // 目标文件是密文，且 AAD 相对用户目录（per-user atRest）
  const sealedMemories = fs.readFileSync(path.join(userDir, 'memories.json'));
  assert.equal(isEncryptedBuffer(sealedMemories), true);
  assert.deepEqual(decodePayload(key, 'memories.json', sealedMemories), memoriesPlain);
  const sealedConversation = fs.readFileSync(path.join(userDir, 'conversations/c1.json'));
  assert.deepEqual(decodePayload(key, 'conversations/c1.json', sealedConversation), conversationPlain);
  // 若错用根 AAD（users/<uid>/memories.json）则无法解密
  assert.throws(() => decodePayload(key, `users/${result.adminUserId}/memories.json`, sealedMemories));
  // 源文件删除
  assert.equal(fs.existsSync(path.join(dir, 'memories.json')), false);
  // 备份保留原始密文
  const backupDir = path.join(dir, listBackupDirs(dir)[0]);
  assert.deepEqual(fs.readFileSync(path.join(backupDir, 'memories.json')), sealedMemoriesBefore);
});

/* ------------------------------ 失败还原 ------------------------------ */

test('migrateMultiuser：迁移中途失败 → 从备份还原、清理半成品、保留备份目录', async () => {
  const dir = makeTmpDir('wild-mig-rollback-');
  const key = crypto.randomBytes(32);
  // index.json 正常密文；memories.json 是合法魔数 + 垃圾内容 → 迁移中途解密失败
  const indexPlain = Buffer.from(JSON.stringify({ version: 1, conversations: [] }));
  writePlain(dir, 'index.json', encodePayload(key, 'index.json', indexPlain));
  const corrupt = Buffer.concat([
    Buffer.from('CTFENC001', 'latin1'),
    Buffer.from([1]),
    Buffer.alloc(12),
    Buffer.alloc(16),
    Buffer.from('garbage'),
  ]);
  writePlain(dir, 'memories.json', corrupt);
  const before = new Map();
  for (const relative of ['index.json', 'memories.json']) {
    before.set(relative, fs.readFileSync(path.join(dir, relative)));
  }

  await assert.rejects(
    () =>
      migrateMultiuser({
        dataDir: dir,
        env: makeAdminEnv(dir, { extra: { DATA_ENCRYPTION_KEY: b64Key(key) } }),
        repoRoot: dir,
        logger: createCapturingLogger(),
      }),
    (error) => error?.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
  // 源文件原样还原
  for (const [relative, raw] of before) {
    assert.deepEqual(fs.readFileSync(path.join(dir, relative)), raw, `${relative} 必须原样还原`);
  }
  // 半成品清理
  assert.equal(fs.existsSync(path.join(dir, 'users.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'users')), false);
  assert.equal(fs.existsSync(path.join(dir, MIGRATION_FILE_NAME)), false);
  // 备份保留供诊断
  assert.equal(listBackupDirs(dir).length, 1);

  // 修复 corrupt 文件后重试可成功（幂等可恢复）
  writePlain(dir, 'memories.json', encodePayload(key, 'memories.json', Buffer.from(JSON.stringify({ version: 2, memories: [] }))));
  const retry = await migrateMultiuser({
    dataDir: dir,
    env: makeAdminEnv(dir, { extra: { DATA_ENCRYPTION_KEY: b64Key(key) } }),
    repoRoot: dir,
    logger: createCapturingLogger(),
  });
  assert.equal(retry.migrated, true);
  assert.equal(retry.files, 2);
});

test('migrateMultiuser：缺 ADMIN_INITIAL_PASSWORD_FILE → 启动中止且不动数据、不建备份', async () => {
  const dir = makeTmpDir('wild-mig-noenv-');
  seedLegacyData(dir);
  await assert.rejects(
    () => migrateMultiuser({ dataDir: dir, env: { AUTH: 'on' }, repoRoot: dir, logger: createCapturingLogger() }),
    /ADMIN_INITIAL_PASSWORD_FILE/,
  );
  assert.equal(fs.existsSync(path.join(dir, 'users.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'memories.json')), true);
  assert.deepEqual(listBackupDirs(dir), []);
});

test('migrateMultiuser：users/ 存在但 users.json 缺失 → 半迁移状态 fail-fast', async () => {
  const dir = makeTmpDir('wild-mig-partial-');
  writePlain(dir, 'users/u123/memories.json', JSON.stringify({ version: 2, memories: [] }));
  await assert.rejects(
    () =>
      migrateMultiuser({
        dataDir: dir,
        env: makeAdminEnv(dir),
        repoRoot: dir,
        logger: createCapturingLogger(),
      }),
    /疑似半迁移状态/,
  );
  assert.equal(fs.existsSync(path.join(dir, 'users.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'users/u123/memories.json')), true, '不得改动半迁移数据');
});

test('migrateMultiuser：无 key + 已有密文 → MISSING_KEY 且不改动文件', async () => {
  const dir = makeTmpDir('wild-mig-missingkey-');
  const key = crypto.randomBytes(32);
  writePlain(dir, 'memories.json', encodePayload(key, 'memories.json', Buffer.from('{}')));
  const before = fs.readFileSync(path.join(dir, 'memories.json'));
  await assert.rejects(
    () =>
      migrateMultiuser({
        dataDir: dir,
        env: makeAdminEnv(dir),
        repoRoot: dir,
        logger: createCapturingLogger(),
      }),
    (error) => error?.code === AT_REST_ERROR_CODES.MISSING_KEY,
  );
  assert.deepEqual(fs.readFileSync(path.join(dir, 'memories.json')), before);
  assert.equal(fs.existsSync(path.join(dir, 'users.json')), false);
});

/* --------------------- at-rest：users/ 分区递归扫描 --------------------- */

test('listDataFiles / hasEncryptedDataFiles：递归 users/<uid>/，跳过 . 前缀目录', () => {
  const dir = makeTmpDir('wild-atrest-users-');
  writePlain(dir, 'index.json', '{}');
  writePlain(dir, 'users/u000000000001/memories.json', '{}');
  writePlain(dir, 'users/u000000000001/conversations/c1.json', '{}');
  writePlain(dir, 'users/other-user/marks.json', '{}');
  writePlain(dir, '.migration-backup-x/users/u9/memories.json', '{}');
  const files = listDataFiles(dir).map((filePath) => path.relative(dir, filePath));
  assert.deepEqual(files.sort(), [
    'index.json',
    'users/other-user/marks.json',
    'users/u000000000001/conversations/c1.json',
    'users/u000000000001/memories.json',
  ]);
  assert.equal(hasEncryptedDataFiles(dir), false);
  const key = crypto.randomBytes(32);
  writePlain(dir, 'users/u000000000001/memories.json', encodePayload(key, 'memories.json', Buffer.from('{}')));
  assert.equal(hasEncryptedDataFiles(dir), true, '分区密文也必须被 hasEncryptedDataFiles 发现');
});

test('setupAtRest：启动自动把 users/<uid>/ 明文加密为 per-user AAD 密文（幂等）', () => {
  const dir = makeTmpDir('wild-atrest-users-migrate-');
  const key = crypto.randomBytes(32);
  const plain = Buffer.from(JSON.stringify({ version: 2, memories: [{ id: 'm1' }] }));
  writePlain(dir, 'users/u000000000001/memories.json', plain);
  writePlain(dir, 'users/u000000000001/conversations/c1.json', Buffer.from('{"id":"c1"}'));

  const setup = setupAtRest({
    dataDir: dir,
    config: { dataEncryptionKey: b64Key(key) },
    env: {},
    logger: createCapturingLogger(),
  });
  assert.equal(setup.atRest.enabled, true);
  assert.equal(setup.migration.migrated, 2);
  assert.ok(Buffer.isBuffer(setup.key), 'setupAtRest 必须暴露 key 供 per-user atRest 使用');
  const sealed = fs.readFileSync(path.join(dir, 'users/u000000000001/memories.json'));
  assert.equal(isEncryptedBuffer(sealed), true);
  assert.deepEqual(decodePayload(key, 'memories.json', sealed), plain);

  const second = setupAtRest({
    dataDir: dir,
    config: { dataEncryptionKey: b64Key(key) },
    env: {},
    logger: createCapturingLogger(),
  });
  assert.equal(second.migration.migrated, 0);
  assert.equal(second.migration.skipped, 2);
});

test('createAtRest per-user：同一把 key、不同 dataDir → AAD 互相独立', () => {
  const dir = makeTmpDir('wild-atrest-peruser-');
  const key = crypto.randomBytes(32);
  const root = createAtRest({ key, dataDir: dir });
  const userDir = path.join(dir, 'users', 'u1');
  fs.mkdirSync(userDir, { recursive: true });
  const user = createAtRest({ key, dataDir: userDir });
  const payload = Buffer.from('{"version":1}');
  const sealed = user.seal(path.join(userDir, 'memories.json'), payload);
  assert.deepEqual(user.unseal(path.join(userDir, 'memories.json'), sealed), payload);
  // 用根 codec 解用户密文（AAD 不同）必须失败
  assert.throws(() => root.unseal(path.join(dir, 'users', 'u1', 'memories.json'), sealed));
});
