//  / 契约 2.1：restore-data.mjs 增补测试（dry-run 计划、往返、pre-restore、参数/CLI）。
// 护栏矩阵与恶意归档用例见 restore-guard.test.mjs；本文件只覆盖 createRestore 正常语义回归，
// 避免与 的 tests/backend/backup-restore.test.mjs 重复。
// 全部在 os.tmpdir 沙盒执行（真实 tar 子进程，仅本地文件；不 sleep、不联网）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createBackup } from '../../scripts/backup-data.mjs';
import {
  RESTORE_UNSAFE_ARCHIVE,
  createRestore,
  parseArgs,
  verifyBackup,
} from '../../scripts/restore-data.mjs';
import { makeTmpDir } from './helpers.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const RESTORE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'restore-data.mjs');
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

function snapshotTree(rootDir) {
  const result = new Map();
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else result.set(path.relative(rootDir, child), fs.readFileSync(child));
    }
  }
  return result;
}

async function makeBackup({ tmp, dataDir, keyFile = null, now = () => new Date('2026-11-07T09:30:00Z') }) {
  const outDir = path.join(tmp, 'backups');
  const result = await createBackup({ dataDir, outDir, keyFile, keep: 7, now, repoRoot: REPO_ROOT });
  assert.equal(result.ok, true);
  return result.backupDir;
}

test('parseArgs / --help：参数组合与 CLI 帮助可用', () => {
  assert.deepEqual(parseArgs([]), {
    backupDir: null,
    dataDir: null,
    keyFile: null,
    force: false,
    dryRun: false,
    help: false,
  });
  const options = parseArgs(['--backup', '/b', '--data-dir', '/d', '--key-file', '/k', '--force', '--dry-run']);
  assert.equal(options.backupDir, '/b');
  assert.equal(options.dataDir, '/d');
  assert.equal(options.keyFile, '/k');
  assert.equal(options.force, true);
  assert.equal(options.dryRun, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.throws(() => parseArgs(['--bogus']), /未知参数/);

  const help = spawnSync(process.execPath, [RESTORE_SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法：node scripts\/restore-data\.mjs/);
  assert.equal(RESTORE_UNSAFE_ARCHIVE, 'RESTORE_UNSAFE_ARCHIVE');
});

test('createRestore dry-run：返回计划且零副作用（非空目录也不报错）', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-restore-');
  const dataDir = path.join(tmp, 'data');
  writeDataFixture(dataDir);
  const keyFile = writeKeyFixture(tmp);
  const backupDir = await makeBackup({ tmp, dataDir, keyFile });
  const targetDir = path.join(tmp, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'existing.json'), '{"existing":true}\n');
  const before = snapshotTree(targetDir);

  const plan = await createRestore({
    backupDir,
    dataDir: targetDir,
    keyFile: path.join(tmp, 'restored.key'),
    dryRun: true,
    now: () => new Date('2026-11-07T10:00:00Z'),
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.nonEmpty, true);
  assert.equal(plan.requiresForce, true);
  assert.equal(plan.keyFileIncluded, true);
  assert.equal(plan.willRestoreKey, true);
  assert.ok(plan.entries.includes('data.tar.gz'));
  assert.deepEqual(snapshotTree(targetDir), before, 'dry-run 不得改动目标目录');
  assert.equal(fs.existsSync(path.join(tmp, 'restored.key')), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(targetDir)).filter((name) => name.includes('.restore-')),
    [],
    'dry-run 不得创建 staging/pre-restore 目录',
  );

  const emptyTarget = path.join(tmp, 'empty-target');
  fs.mkdirSync(emptyTarget, { recursive: true });
  const emptyPlan = await createRestore({ backupDir, dataDir: emptyTarget, dryRun: true });
  assert.equal(emptyPlan.nonEmpty, false);
  assert.equal(emptyPlan.requiresForce, false);
});

test('createRestore --force 往返：数据一致、key 0600、二次恢复保留 pre-restore', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-restore-');
  const sourceDir = path.join(tmp, 'source');
  writeDataFixture(sourceDir);
  const keyFile = writeKeyFixture(tmp);
  const backupDir = await makeBackup({ tmp, dataDir: sourceDir, keyFile });

  const targetDir = path.join(tmp, 'target');
  const restoredKey = path.join(tmp, 'restored.key');
  const first = await createRestore({
    backupDir,
    dataDir: targetDir,
    keyFile: restoredKey,
    force: true,
    now: () => new Date('2026-11-07T10:00:00Z'),
  });
  assert.equal(first.ok, true);
  assert.equal(first.keyRestored, true);
  assert.equal(fs.statSync(restoredKey).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(restoredKey, 'utf8'), KEY_MATERIAL);
  const sourceTree = snapshotTree(sourceDir);
  const restoredTree = snapshotTree(targetDir);
  assert.deepEqual([...restoredTree.keys()].sort(), [...sourceTree.keys()].sort());
  for (const [relativePath, content] of sourceTree) {
    assert.deepEqual(restoredTree.get(relativePath), content, `逐字节一致：${relativePath}`);
  }

  // 改坏目标数据，再 force 恢复：旧数据进入 pre-restore。
  fs.writeFileSync(path.join(targetDir, 'index.json'), '{"broken":true}\n');
  const second = await createRestore({
    backupDir,
    dataDir: targetDir,
    keyFile: null,
    force: true,
    now: () => new Date('2026-11-07T10:30:00Z'),
  });
  assert.equal(second.ok, true);
  assert.ok(second.preRestoreDir);
  assert.equal(
    fs.readFileSync(path.join(second.preRestoreDir, 'index.json'), 'utf8'),
    '{"broken":true}\n',
  );
  assert.equal(fs.readFileSync(path.join(targetDir, 'index.json'), 'utf8'), '{"version":1,"conversations":["c1"]}\n');
});

test('createRestore：非空目标无 --force 拒绝且不动数据；SHA256 篡改拒绝', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-restore-');
  const sourceDir = path.join(tmp, 'source');
  writeDataFixture(sourceDir);
  const backupDir = await makeBackup({ tmp, dataDir: sourceDir });

  const targetDir = path.join(tmp, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'keep.json'), '{"keep":true}\n');
  const before = snapshotTree(targetDir);
  await assert.rejects(
    createRestore({ backupDir, dataDir: targetDir, force: false }),
    /非空/,
  );
  assert.deepEqual(snapshotTree(targetDir), before);

  const corruptDir = path.join(tmp, 'corrupt');
  fs.cpSync(backupDir, corruptDir, { recursive: true });
  const dataTar = path.join(corruptDir, 'data.tar.gz');
  const buffer = fs.readFileSync(dataTar);
  buffer[0] ^= 0xff;
  fs.writeFileSync(dataTar, buffer);
  await assert.rejects(verifyBackup(corruptDir), /SHA256 校验失败/);
  await assert.rejects(createRestore({ backupDir: corruptDir, dataDir: path.join(tmp, 't2'), force: true }), /SHA256/);
});

test('CLI：合法备份真实恢复 exit 0；恢复后文件在且 key 权限 0600', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-restore-');
  const sourceDir = path.join(tmp, 'source');
  writeDataFixture(sourceDir);
  const keyFile = writeKeyFixture(tmp);
  const backupDir = await makeBackup({ tmp, dataDir: sourceDir, keyFile });
  const targetDir = path.join(tmp, 'cli-target');
  const restoredKey = path.join(tmp, 'cli-restored.key');
  const result = spawnSync(
    process.execPath,
    [RESTORE_SCRIPT, '--backup', backupDir, '--data-dir', targetDir, '--key-file', restoredKey, '--force'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.keyRestored, true);
  assert.equal(fs.existsSync(path.join(targetDir, 'index.json')), true);
  assert.equal(fs.statSync(restoredKey).mode & 0o777, 0o600);
  assert.ok(payload.entries.includes('data.tar.gz'));
});
