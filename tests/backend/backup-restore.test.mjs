//  /  / 契约 2：scripts/backup-data.mjs + scripts/restore-data.mjs 往返测试。
// 全部在 os.tmpdir 沙盒执行（真实 tar 子进程，仅本地文件；不 sleep、不联网）。
// 覆盖：备份产物/SHA256/manifest、no-key、dry-run 无副作用、keep 轮转、
// restore 往返（含 key 0600）、--force 与 pre-restore、篡改拒绝、非空拒绝、
// 缺 SHA256SUMS、失败清理、CLI --help 与参数解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  BACKUP_DATA_FILE,
  BACKUP_DIR_PATTERN,
  BACKUP_MANIFEST_FILE,
  BACKUP_SECRETS_FILE,
  BACKUP_SUMS_FILE,
  createBackup,
  formatTimestamp,
  parseArgs as parseBackupArgs,
  sha256File,
} from '../../scripts/backup-data.mjs';
import {
  createRestore,
  parseArgs as parseRestoreArgs,
  readChecksums,
  verifyBackup,
} from '../../scripts/restore-data.mjs';
import { makeTmpDir } from './helpers.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const KEY_MATERIAL = 'ctf-test-key-material-0123456789\n';

function writeDataFixture(dir) {
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'users', 'u111111111111'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), '{"version":1,"conversations":["c1"]}\n');
  fs.writeFileSync(path.join(dir, 'conversations', 'c1.json'), '{"id":"c1","title":"本地测试"}\n');
  fs.writeFileSync(path.join(dir, 'users', 'u111111111111', 'memories.json'), '{"version":2,"memories":[]}\n');
}

function writeKeyFixture(dir) {
  const keyPath = path.join(dir, 'data.key');
  fs.writeFileSync(keyPath, KEY_MATERIAL);
  fs.chmodSync(keyPath, 0o600);
  return keyPath;
}

function listBackupDirs(outDir) {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BACKUP_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

test('backup：产物齐全、SHA256SUMS 正确、manifest 元数据完整', async (t) => {
  const root = makeTmpDir('ctf-bk-bk-');
  const dataDir = path.join(root, 'data');
  const outDir = path.join(root, 'out');
  writeDataFixture(dataDir);
  const keyPath = writeKeyFixture(root);

  const now = new Date('2026-11-07T10:20:30Z');
  const result = await createBackup({
    dataDir,
    outDir,
    keyFile: keyPath,
    keep: 7,
    now: () => now,
    repoRoot: REPO_ROOT,
  });
  assert.equal(result.ok, true);
  assert.match(path.basename(result.backupDir), BACKUP_DIR_PATTERN);
  assert.equal(result.keyFileIncluded, true);

  for (const name of [BACKUP_DATA_FILE, BACKUP_SECRETS_FILE, BACKUP_MANIFEST_FILE, BACKUP_SUMS_FILE]) {
    assert.ok(fs.existsSync(path.join(result.backupDir, name)), `缺少产物 ${name}`);
  }
  // secrets.tar.gz 权限 0600（含明文 key 备份，必须收紧）
  const secretsMode = fs.statSync(path.join(result.backupDir, BACKUP_SECRETS_FILE)).mode & 0o777;
  assert.equal(secretsMode, 0o600);

  const manifest = JSON.parse(fs.readFileSync(path.join(result.backupDir, BACKUP_MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.ts, formatTimestamp(now));
  assert.equal(manifest.dataDir, dataDir);
  assert.equal(manifest.keyFileIncluded, true);
  assert.equal(typeof manifest.versionFromPackage, 'string');
  const manifestNames = manifest.files.map((entry) => entry.path);
  assert.deepEqual(manifestNames.sort(), [BACKUP_DATA_FILE, BACKUP_SECRETS_FILE].sort());

  // SHA256SUMS 能通过 verifyBackup 校验（即所有行都有对应文件且哈希一致）
  const entries = await verifyBackup(result.backupDir);
  const sumsText = fs.readFileSync(path.join(result.backupDir, BACKUP_SUMS_FILE), 'utf8');
  // SHA256SUMS 覆盖 data/secrets/manifest 三个文件
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.ok(sumsText.includes(entry.sha256));
    assert.equal(await sha256File(path.join(result.backupDir, entry.path)), entry.sha256);
  }
});

test('backup：无 key-file 时不产 secrets.tar.gz，keyFileIncluded=false', async (t) => {
  const root = makeTmpDir('ctf-bk-bk-nokey-');
  const dataDir = path.join(root, 'data');
  writeDataFixture(dataDir);
  const result = await createBackup({ dataDir, outDir: path.join(root, 'out'), keep: 7, repoRoot: REPO_ROOT });
  assert.equal(result.keyFileIncluded, false);
  assert.equal(fs.existsSync(path.join(result.backupDir, BACKUP_SECRETS_FILE)), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backupDir, BACKUP_MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.keyFileIncluded, false);
  // manifest.files 记录归档产物（data.tar.gz），manifest 自身只出现在 SHA256SUMS/返回值里
  assert.deepEqual(manifest.files.map((entry) => entry.path), [BACKUP_DATA_FILE]);
  const sumsEntries = await readChecksums(result.backupDir);
  assert.deepEqual(sumsEntries.map((entry) => entry.path).sort(), [BACKUP_DATA_FILE, BACKUP_MANIFEST_FILE].sort());
});

test('backup：dry-run 零写入，只返回计划', async (t) => {
  const root = makeTmpDir('ctf-bk-bk-dry-');
  const dataDir = path.join(root, 'data');
  const outDir = path.join(root, 'out');
  writeDataFixture(dataDir);
  const result = await createBackup({ dataDir, outDir, keyFile: null, dryRun: true, repoRoot: REPO_ROOT });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.backupDir, null);
  assert.equal(result.keep, 7);
  assert.equal(fs.existsSync(outDir), false, 'dry-run 不应创建输出目录');
});

test('backup：keep 轮转只删形如 YYYYMMDD-HHmmss 的旧目录', async (t) => {
  const root = makeTmpDir('ctf-bk-bk-rotate-');
  const dataDir = path.join(root, 'data');
  const outDir = path.join(root, 'out');
  writeDataFixture(dataDir);
  fs.mkdirSync(path.join(outDir, '20260101-000000'), { recursive: true });
  fs.mkdirSync(path.join(outDir, '20260102-000000'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'manual-keep'), { recursive: true });

  const first = new Date('2026-11-07T10:21:00Z');
  const second = new Date('2026-11-07T10:22:00Z');
  await createBackup({ dataDir, outDir, keep: 2, now: () => first, repoRoot: REPO_ROOT });
  await createBackup({ dataDir, outDir, keep: 2, now: () => second, repoRoot: REPO_ROOT });

  const dirs = listBackupDirs(outDir);
  assert.deepEqual(dirs, [formatTimestamp(first), formatTimestamp(second)].sort());
  assert.ok(fs.existsSync(path.join(outDir, 'manual-keep')), '非备份目录不应被轮转删除');
});

test('backup：data-dir 不存在或 key-file 缺失时清晰报错', async (t) => {
  const root = makeTmpDir('ctf-bk-bk-err-');
  await assert.rejects(
    () => createBackup({ dataDir: path.join(root, 'nope'), outDir: path.join(root, 'out'), repoRoot: REPO_ROOT }),
    /数据目录不存在/,
  );
  const dataDir = path.join(root, 'data');
  writeDataFixture(dataDir);
  await assert.rejects(
    () =>
      createBackup({
        dataDir,
        outDir: path.join(root, 'out'),
        keyFile: path.join(root, 'missing.key'),
        repoRoot: REPO_ROOT,
      }),
    /key 文件不存在/,
  );
});

test('restore：往返恢复数据与 key（内容一致、key 0600、无遗留 staging）', async (t) => {
  const root = makeTmpDir('ctf-bk-rt-');
  const dataDir = path.join(root, 'data');
  const keyPath = writeKeyFixture(root);
  writeDataFixture(dataDir);
  const backup = await createBackup({ dataDir, outDir: path.join(root, 'out'), keyFile: keyPath, repoRoot: REPO_ROOT });

  // 模拟数据丢失
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(keyPath, { force: true });

  const result = await createRestore({
    backupDir: backup.backupDir,
    dataDir,
    keyFile: keyPath,
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.keyRestored, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'), '{"version":1,"conversations":["c1"]}\n');
  assert.equal(
    fs.readFileSync(path.join(dataDir, 'conversations', 'c1.json'), 'utf8'),
    '{"id":"c1","title":"本地测试"}\n',
  );
  assert.equal(fs.readFileSync(keyPath, 'utf8'), KEY_MATERIAL);
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  // 不遗留 staging / secrets 临时目录
  const leftovers = fs.readdirSync(root).filter((name) => /restore-(staging|secrets)/.test(name));
  assert.deepEqual(leftovers, []);
});

test('restore：非空目录无 --force 拒绝；--force 覆盖并把旧数据放进 pre-restore 目录', async (t) => {
  const root = makeTmpDir('ctf-bk-rt-force-');
  const dataDir = path.join(root, 'data');
  writeDataFixture(dataDir);
  const backup = await createBackup({ dataDir, outDir: path.join(root, 'out'), repoRoot: REPO_ROOT });

  // 备份后修改现有数据（会被覆盖）
  fs.writeFileSync(path.join(dataDir, 'index.json'), '{"version":2,"changed":true}\n');
  await assert.rejects(
    () => createRestore({ backupDir: backup.backupDir, dataDir, logger: { info() {}, warn() {}, error() {} } }),
    /数据目录非空/,
  );
  // 拒绝时原数据不动
  assert.equal(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'), '{"version":2,"changed":true}\n');

  const result = await createRestore({
    backupDir: backup.backupDir,
    dataDir,
    force: true,
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.preRestoreDir !== null, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'), '{"version":1,"conversations":["c1"]}\n');
  // pre-restore 保留被替换的旧数据
  assert.equal(
    fs.readFileSync(path.join(result.preRestoreDir, 'index.json'), 'utf8'),
    '{"version":2,"changed":true}\n',
  );
});

test('restore：dry-run 在非空目录不报错、返回 requiresForce、零副作用', async (t) => {
  const root = makeTmpDir('ctf-bk-rt-dry-');
  const dataDir = path.join(root, 'data');
  writeDataFixture(dataDir);
  const backup = await createBackup({ dataDir, outDir: path.join(root, 'out'), repoRoot: REPO_ROOT });
  fs.writeFileSync(path.join(dataDir, 'index.json'), '{"version":9}\n');

  const plan = await createRestore({
    backupDir: backup.backupDir,
    dataDir,
    dryRun: true,
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.nonEmpty, true);
  assert.equal(plan.requiresForce, true);
  assert.ok(plan.entries.includes(BACKUP_DATA_FILE));
  assert.equal(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'), '{"version":9}\n');
  assert.deepEqual(fs.readdirSync(root).filter((name) => /restore-staging/.test(name)), []);
});

test('restore：备份被篡改时 SHA256 校验失败并拒绝恢复，原数据不动', async (t) => {
  const root = makeTmpDir('ctf-bk-rt-tamper-');
  const dataDir = path.join(root, 'data');
  writeDataFixture(dataDir);
  const backup = await createBackup({ dataDir, outDir: path.join(root, 'out'), repoRoot: REPO_ROOT });
  const tampered = path.join(backup.backupDir, BACKUP_DATA_FILE);
  fs.appendFileSync(tampered, 'x');
  fs.writeFileSync(path.join(dataDir, 'index.json'), '{"version":7}\n');

  await assert.rejects(
    () =>
      createRestore({
        backupDir: backup.backupDir,
        dataDir,
        force: true,
        logger: { info() {}, warn() {}, error() {} },
      }),
    /SHA256 校验失败/,
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'), '{"version":7}\n');
});

test('restore：缺 SHA256SUMS / 缺 data.tar.gz / 缺备份目录均清晰报错', async (t) => {
  const root = makeTmpDir('ctf-bk-rt-missing-');
  const dataDir = path.join(root, 'data');
  writeDataFixture(dataDir);
  const backup = await createBackup({ dataDir, outDir: path.join(root, 'out'), repoRoot: REPO_ROOT });

  const noSums = path.join(root, 'no-sums');
  fs.mkdirSync(noSums);
  await assert.rejects(() => readChecksums(noSums), /找不到 SHA256SUMS/);
  await assert.rejects(
    () => createRestore({ backupDir: noSums, dataDir, force: true, logger: { info() {}, warn() {}, error() {} } }),
    /找不到 SHA256SUMS/,
  );

  await assert.rejects(
    () =>
      createRestore({
        backupDir: path.join(root, 'nope'),
        dataDir,
        force: true,
        logger: { info() {}, warn() {}, error() {} },
      }),
    /备份目录不存在/,
  );

  // 有 SHA256SUMS 但漏掉 data.tar.gz：verifyBackup 先报缺失
  const noData = path.join(root, 'no-data');
  fs.mkdirSync(noData);
  const dataSha = await sha256File(path.join(backup.backupDir, BACKUP_DATA_FILE));
  fs.writeFileSync(path.join(noData, BACKUP_SUMS_FILE), `${dataSha}  ${BACKUP_DATA_FILE}\n`);
  await assert.rejects(() => verifyBackup(noData), /备份文件缺失/);
});

test('restore：secrets.tar.gz 内没有 key 文件时失败并清理 staging（原数据不动）', async (t) => {
  const root = makeTmpDir('ctf-bk-rt-badkey-');
  const dataDir = path.join(root, 'data');
  const keyPath = writeKeyFixture(root);
  writeDataFixture(dataDir);
  const backup = await createBackup({ dataDir, outDir: path.join(root, 'out'), keyFile: keyPath, repoRoot: REPO_ROOT });

  // 用空 tar 替换 secrets.tar.gz 并同步 SHA256SUMS（模拟备份损坏但校验通过）
  const secretsPath = path.join(backup.backupDir, BACKUP_SECRETS_FILE);
  const emptyDir = path.join(root, 'empty');
  fs.mkdirSync(emptyDir);
  execFileSync('tar', ['-czf', secretsPath, '-C', emptyDir, '.'], { stdio: 'ignore' });
  const sumsPath = path.join(backup.backupDir, BACKUP_SUMS_FILE);
  const secretsSha = await sha256File(secretsPath);
  const lines = fs
    .readFileSync(sumsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (line.endsWith(BACKUP_SECRETS_FILE) ? `${secretsSha}  ${BACKUP_SECRETS_FILE}` : line));
  fs.writeFileSync(sumsPath, `${lines.join('\n')}\n`);

  await assert.rejects(
    () =>
      createRestore({
        backupDir: backup.backupDir,
        dataDir,
        keyFile: keyPath,
        force: true,
        logger: { info() {}, warn() {}, error() {} },
      }),
    /没有密钥文件/,
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'), '{"version":1,"conversations":["c1"]}\n');
  assert.deepEqual(fs.readdirSync(root).filter((name) => /restore-(staging|secrets)/.test(name)), []);
});

test('CLI：两个脚本 --help 退出码 0 且包含用法', () => {
  const backupHelp = execFileSync('node', [path.join(REPO_ROOT, 'scripts/backup-data.mjs'), '--help'], {
    encoding: 'utf8',
  });
  assert.match(backupHelp, /用法：node scripts\/backup-data\.mjs/);
  const restoreHelp = execFileSync('node', [path.join(REPO_ROOT, 'scripts/restore-data.mjs'), '--help'], {
    encoding: 'utf8',
  });
  assert.match(restoreHelp, /用法：node scripts\/restore-data\.mjs/);
});

test('parseArgs：未知参数报错，合法参数解析正确', () => {
  assert.throws(() => parseBackupArgs(['--unknown']), /未知参数/);
  assert.throws(() => parseBackupArgs(['--keep']), /需要一个值/);
  assert.deepEqual(parseBackupArgs(['--data-dir', '/tmp/d', '--out', '/tmp/o', '--keep', '3', '--dry-run']), {
    dataDir: '/tmp/d',
    outDir: '/tmp/o',
    keyFile: null,
    keep: 3,
    dryRun: true,
    help: false,
  });
  assert.throws(() => parseRestoreArgs(['--bad']), /未知参数/);
  const restoreArgs = parseRestoreArgs([
    '--backup',
    '/tmp/b',
    '--data-dir',
    '/tmp/d',
    '--key-file',
    '/tmp/k',
    '--force',
    '--dry-run',
  ]);
  assert.equal(restoreArgs.backupDir, '/tmp/b');
  assert.equal(restoreArgs.dataDir, '/tmp/d');
  assert.equal(restoreArgs.keyFile, '/tmp/k');
  assert.equal(restoreArgs.force, true);
  assert.equal(restoreArgs.dryRun, true);
});
