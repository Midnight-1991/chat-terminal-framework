//  /  / 契约 2.1：restore 归档成员安全校验（RESTORE_UNSAFE_ARCHIVE）测试。
// 覆盖：成员名规则矩阵、tar 清单解析（GNU/BSD/symlink/hardlink/空格名）、条目数与体积上限、
// 恶意归档在解包前被拒绝（绝对路径/`..`/symlink/hardlink/fifo）、合法归档通过、
// createRestore 端到端拒绝且现有数据不动、secrets 归档同样校验。
// 全部在 os.tmpdir 沙盒执行（真实 tar 子进程，仅本地文件；不 sleep、不联网）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createBackup, sha256File } from '../../scripts/backup-data.mjs';
import {
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_TOTAL_BYTES,
  RESTORE_UNSAFE_ARCHIVE,
  assertSafeArchive,
  createRestore,
  parseTarVerboseListing,
  validateArchiveEntryName,
} from '../../scripts/restore-data.mjs';
import { makeTmpDir } from './helpers.mjs';

const KEY_MATERIAL = 'ctf-test-key-material-0123456789\n';

/* -------------------------------- 测试工具 -------------------------------- */

function writeFileDeep(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function makeTar(archivePath, { cwd, entries = [], extraFlags = [] }) {
  execFileSync('tar', [...extraFlags, '-czf', archivePath, ...entries], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return archivePath;
}

async function makeBackupDir(rootDir, { dataArchive, secretsArchive = null, name = '20261107-101010' }) {
  const backupDir = path.join(rootDir, 'backups', name);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(dataArchive, path.join(backupDir, 'data.tar.gz'));
  if (secretsArchive) fs.copyFileSync(secretsArchive, path.join(backupDir, 'secrets.tar.gz'));
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), `${JSON.stringify({ ts: name })}\n`);
  const names = ['data.tar.gz', ...(secretsArchive ? ['secrets.tar.gz'] : []), 'manifest.json'];
  const lines = [];
  for (const name2 of names) {
    lines.push(`${await sha256File(path.join(backupDir, name2))}  ${name2}`);
  }
  fs.writeFileSync(path.join(backupDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return backupDir;
}

function listing(archivePath) {
  return execFileSync('tar', ['-tvzf', archivePath], { encoding: 'utf8' });
}

/* ------------------------------ 成员名规则矩阵 ------------------------------ */

test('validateArchiveEntryName：合法成员名（普通/相对前缀/空格）通过', () => {
  const names = [
    'plain.txt',
    './index.json',
    './',
    '.',
    'users/u111111111111/memories.json',
    'a/./b.txt',
    'file with space.txt',
    '带中文-目录/文件.json',
    'conversations/c1.json',
  ];
  for (const name of names) {
    const result = validateArchiveEntryName(name);
    assert.equal(result.ok, true, `应通过：${JSON.stringify(name)} → ${result.reason}`);
  }
});

test('validateArchiveEntryName：绝对路径/盘符/NUL/`..`/归一化空 一律拒绝并带 reason', () => {
  const rejected = [
    ['', '空'],
    ['/etc/passwd', '绝对'],
    ['//evil', '绝对'],
    ['\\\\evil', '绝对'],
    ['C:\\evil.txt', '盘符'],
    ['C:/evil.txt', '盘符'],
    ['C:evil.txt', '盘符'],
    ['a\0b', 'NUL'],
    ['..', '..'],
    ['../evil.txt', '..'],
    ['a/../../etc/passwd', '..'],
    ['a\\..\\evil.txt', '..'],
    ['x/..\\y', '..'],
    ['././../evil', '..'],
  ];
  for (const [name, keyword] of rejected) {
    const result = validateArchiveEntryName(name);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(name)}`);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
    assert.ok(result.reason.includes(keyword), `reason 应含 ${keyword}：${result.reason}`);
  }
});

test('parseTarVerboseListing：GNU/BSD 行、目录、符号链接、硬链接、空格名均可解析', () => {
  const text = [
    'drwxr-xr-x  0 user wheel       0 11  7 22:56 ./',
    '-rw-r--r--  0 user wheel     137 2026-11-07 12:00 ./index.json',
    '-rw-r--r--  0 user wheel       2 11  7 22:56 ./file with space.txt',
    'lrwxr-xr-x  0 user wheel       0 11  7 22:56 ./link -> /etc/passwd',
    'hrw-r--r--  0 user wheel       0 11  7 22:56 ./hf link to ./hard',
    'lrwxr-xr-x  0 user wheel       0 Oct 30  2024 ./old-link -> target',
  ].join('\n');
  const entries = parseTarVerboseListing(text);
  assert.deepEqual(entries, [
    { type: 'dir', name: './', sizeBytes: 0 },
    { type: 'file', name: './index.json', sizeBytes: 137 },
    { type: 'file', name: './file with space.txt', sizeBytes: 2 },
    { type: 'symlink', name: './link', sizeBytes: 0 },
    { type: 'hardlink', name: './hf', sizeBytes: 0 },
    { type: 'symlink', name: './old-link', sizeBytes: 0 },
  ]);
});

test('parseTarVerboseListing：无法解析的行保守拒绝（error.code=RESTORE_UNSAFE_ARCHIVE）', () => {
  assert.throws(
    () => parseTarVerboseListing('这不是 tar -tvzf 的输出'),
    (error) => error?.code === RESTORE_UNSAFE_ARCHIVE,
  );
});

test('parseTarVerboseListing：BSD/macOS 旧文件「MM DD  YYYY」日期列（B1 回归）', () => {
  // mtime 早于约 6 个月时 bsdtar 输出 `11 15  2023`（数字月+日+年），此前未识别 → 合法归档被误拒。
  const text = [
    'drwxr-xr-x  0 liangbin wheel       0 11  8 00:26 ./',
    '-rw-r--r--  0 liangbin wheel      88 11  8 00:26 ./users.json',
    '-rw-r--r--  0 liangbin wheel      26 11 15  2023 ./conversations/c1.json',
    '-rw-r--r--  0 liangbin wheel    1234 11 15  2023 ./big.bin',
  ].join('\n');
  assert.deepEqual(parseTarVerboseListing(text), [
    { type: 'dir', name: './', sizeBytes: 0 },
    { type: 'file', name: './users.json', sizeBytes: 88 },
    { type: 'file', name: './conversations/c1.json', sizeBytes: 26 },
    { type: 'file', name: './big.bin', sizeBytes: 1234 },
  ]);
});

/* ------------------------------- 归档整体校验 ------------------------------- */

test('assertSafeArchive：合法备份归档通过（不解压、targetDir 保持为空），返回统计信息', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-guard-');
  const src = path.join(tmp, 'src');
  writeFileDeep(src, 'index.json', '{"version":1}\n');
  writeFileDeep(src, 'users/u111111111111/memories.json', '{"version":2}\n');
  writeFileDeep(src, 'conversations/c1.json', '{"id":"c1"}\n');
  const archive = makeTar(path.join(tmp, 'data.tar.gz'), { cwd: src, entries: ['.'] });
  const targetDir = path.join(tmp, 'target');
  fs.mkdirSync(targetDir, { recursive: true });

  const result = await assertSafeArchive(archive, { targetDir });
  assert.equal(result.ok, true);
  assert.equal(result.entryCount, 7); // './' + users/ + users/u…/ + conversations/ 等 7 个条目
  assert.ok(result.totalBytes > 0);
  assert.deepEqual(fs.readdirSync(targetDir), [], 'assert 阶段不应写目标目录');
});

test('assertSafeArchive：`..` 遍历归档解包前拒绝，错误码/message 符合契约', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-guard-');
  const src = path.join(tmp, 'src');
  writeFileDeep(src, 'sub/inner.txt', 'inner\n');
  writeFileDeep(src, 'evil.txt', 'evil\n');
  const archive = makeTar(path.join(tmp, 'parent.tar.gz'), {
    cwd: path.join(src, 'sub'),
    entries: ['../evil.txt'],
  });
  const targetDir = path.join(tmp, 'target');
  fs.mkdirSync(targetDir, { recursive: true });

  await assert.rejects(
    assertSafeArchive(archive, { targetDir }),
    (error) => {
      assert.equal(error.code, RESTORE_UNSAFE_ARCHIVE);
      assert.match(error.message, /^RESTORE_UNSAFE_ARCHIVE: /);
      assert.match(error.message, /\.\.\/evil\.txt/);
      return true;
    },
  );
});

test('assertSafeArchive：绝对路径 / symlink / hardlink / fifo 归档解包前拒绝', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-guard-');
  const targetDir = path.join(tmp, 'target');
  fs.mkdirSync(targetDir, { recursive: true });

  // 绝对路径（tar -P 保留前导 `/`）
  const absFile = writeFileDeep(tmp, 'abs/evil.txt', 'evil\n');
  const absArchive = path.join(tmp, 'abs.tar.gz');
  execFileSync('tar', ['-P', '-czf', absArchive, absFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  await assert.rejects(
    assertSafeArchive(absArchive, { targetDir }),
    (error) => error.code === RESTORE_UNSAFE_ARCHIVE && /绝对路径/.test(error.message),
  );

  // 符号链接
  const linkSrc = path.join(tmp, 'link-src');
  fs.mkdirSync(linkSrc, { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(linkSrc, 'passwd'));
  const linkArchive = makeTar(path.join(tmp, 'link.tar.gz'), { cwd: linkSrc, entries: ['.'] });
  await assert.rejects(
    assertSafeArchive(linkArchive, { targetDir }),
    (error) => error.code === RESTORE_UNSAFE_ARCHIVE && /symlink/.test(error.message),
  );

  // 硬链接
  const hardSrc = path.join(tmp, 'hard-src');
  fs.mkdirSync(hardSrc, { recursive: true });
  fs.writeFileSync(path.join(hardSrc, 'a.txt'), 'a\n');
  fs.linkSync(path.join(hardSrc, 'a.txt'), path.join(hardSrc, 'b.txt'));
  const hardArchive = makeTar(path.join(tmp, 'hard.tar.gz'), { cwd: hardSrc, entries: ['.'] });
  await assert.rejects(
    assertSafeArchive(hardArchive, { targetDir }),
    (error) => error.code === RESTORE_UNSAFE_ARCHIVE && /hardlink/.test(error.message),
  );

  // fifo（设备/管道一律拒绝；平台不支持 mkfifo 时跳过）
  try {
    const fifoSrc = path.join(tmp, 'fifo-src');
    fs.mkdirSync(fifoSrc, { recursive: true });
    execFileSync('mkfifo', [path.join(fifoSrc, 'pipe')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const fifoArchive = makeTar(path.join(tmp, 'fifo.tar.gz'), { cwd: fifoSrc, entries: ['.'] });
    await assert.rejects(
      assertSafeArchive(fifoArchive, { targetDir }),
      (error) => error.code === RESTORE_UNSAFE_ARCHIVE && /不支持的条目类型/.test(error.message),
    );
  } catch (error) {
    if (error?.code !== RESTORE_UNSAFE_ARCHIVE) t.diagnostic(`跳过 fifo 用例：${error.message}`);
  }
});

test('assertSafeArchive：条目数/总体积超限拒绝；tarRunner 可注入且调用参数正确', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-guard-');
  const targetDir = path.join(tmp, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  const src = path.join(tmp, 'src');
  writeFileDeep(src, 'a.txt', 'aaaaa\n');
  writeFileDeep(src, 'b.txt', 'bbbbb\n');
  const archive = makeTar(path.join(tmp, 'data.tar.gz'), { cwd: src, entries: ['.'] });

  await assert.rejects(
    assertSafeArchive(archive, { targetDir, maxEntries: 1 }),
    (error) => error.code === RESTORE_UNSAFE_ARCHIVE && /条目数/.test(error.message),
  );
  await assert.rejects(
    assertSafeArchive(archive, { targetDir, maxTotalBytes: 1 }),
    (error) => error.code === RESTORE_UNSAFE_ARCHIVE && /解压体积/.test(error.message),
  );

  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args);
    return '-rw-r--r--  0 user wheel       3 11  7 22:56 ./ok.txt\n';
  };
  const result = await assertSafeArchive('/tmp/fake-backup.tar.gz', {
    targetDir,
    tarRunner: fakeRunner,
  });
  assert.deepEqual(calls, [['-tvzf', '/tmp/fake-backup.tar.gz']]);
  assert.equal(result.entryCount, 1);
  assert.equal(ARCHIVE_MAX_ENTRIES, 200_000);
  assert.equal(ARCHIVE_MAX_TOTAL_BYTES, 2 * 1024 ** 3);
});

/* ------------------------------ createRestore 集成 ------------------------------ */

test('createRestore：恶意 data.tar.gz 拒绝且现有数据不动、无 staging 残留', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-guard-');
  const src = path.join(tmp, 'src');
  writeFileDeep(src, 'sub/inner.txt', 'inner\n');
  writeFileDeep(src, 'evil.txt', 'evil\n');
  const maliciousTar = makeTar(path.join(tmp, 'evil.tar.gz'), {
    cwd: path.join(src, 'sub'),
    entries: ['../evil.txt'],
  });
  const backupDir = await makeBackupDir(tmp, { dataArchive: maliciousTar });
  const dataDir = path.join(tmp, 'prod-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'keep.json'), '{"keep":true}\n');

  await assert.rejects(
    createRestore({ backupDir, dataDir, keyFile: null, force: true }),
    (error) => error.code === RESTORE_UNSAFE_ARCHIVE,
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'keep.json'), 'utf8'), '{"keep":true}\n');
  assert.deepEqual(
    fs.readdirSync(path.dirname(dataDir)).filter((name) => name.includes('.restore-staging-')),
    [],
    '失败后不应残留 staging 目录',
  );
  assert.equal(fs.existsSync(path.join(path.dirname(dataDir), 'evil.txt')), false, '不应写出目标目录之外');
});

test('createRestore：恶意 symlink 归档拒绝；恶意 secrets.tar.gz 同样拒绝且 data 不动', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-guard-');
  const dataSrc = path.join(tmp, 'data-src');
  writeFileDeep(dataSrc, 'index.json', '{"version":1}\n');
  const goodDataTar = makeTar(path.join(tmp, 'good-data.tar.gz'), {
    cwd: dataSrc,
    entries: ['.'],
  });

  // 恶意 data：symlink
  const linkSrc = path.join(tmp, 'link-src');
  fs.mkdirSync(linkSrc, { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(linkSrc, 'passwd'));
  const symTar = makeTar(path.join(tmp, 'sym.tar.gz'), { cwd: linkSrc, entries: ['.'] });
  const backupDir = await makeBackupDir(tmp, { dataArchive: symTar, name: '20261107-101010' });
  const dataDir = path.join(tmp, 'prod-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'keep.json'), '{"keep":true}\n');
  await assert.rejects(
    createRestore({ backupDir, dataDir, keyFile: null, force: true }),
    (error) => error.code === RESTORE_UNSAFE_ARCHIVE,
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'keep.json'), 'utf8'), '{"keep":true}\n');

  // 恶意 secrets：含 `..` 成员；data 合法 → 必须在替换数据前拒绝
  const secretSrc = path.join(tmp, 'secret-src', 'sub');
  writeFileDeep(secretSrc, 'inner.txt', 'inner\n');
  writeFileDeep(path.join(tmp, 'secret-src'), 'evil.txt', 'evil\n');
  const maliciousSecrets = makeTar(path.join(tmp, 'evil-secrets.tar.gz'), {
    cwd: secretSrc,
    entries: ['../evil.txt'],
  });
  const backupDir2 = await makeBackupDir(tmp, {
    dataArchive: goodDataTar,
    secretsArchive: maliciousSecrets,
    name: '20261107-111111',
  });
  const keyFile = path.join(tmp, 'data.key');
  fs.writeFileSync(keyFile, KEY_MATERIAL, { mode: 0o600 });
  const dataDir2 = path.join(tmp, 'prod-data-2');
  fs.mkdirSync(dataDir2, { recursive: true });
  fs.writeFileSync(path.join(dataDir2, 'keep.json'), '{"keep":true}\n');

  await assert.rejects(
    createRestore({ backupDir: backupDir2, dataDir: dataDir2, keyFile, force: true }),
    (error) => error.code === RESTORE_UNSAFE_ARCHIVE,
  );
  assert.equal(fs.readFileSync(path.join(dataDir2, 'keep.json'), 'utf8'), '{"keep":true}\n');
});

test('createRestore：旧 mtime（2023-11-15）合法归档可恢复且保留 mtime（B1 回归）', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-guard-');
  const dataSrc = path.join(tmp, 'data-src');
  writeFileDeep(dataSrc, 'users.json', '{"version":1,"users":[{"id":"u111111111111"}]}\n');
  writeFileDeep(dataSrc, 'index.json', '{"version":1,"conversations":["c1"]}\n');
  writeFileDeep(dataSrc, 'conversations/c1.json', '{"id":"c1","title":"旧文件"}\n');
  const oldWhen = new Date('2023-11-15T12:00:00');
  fs.utimesSync(path.join(dataSrc, 'conversations/c1.json'), oldWhen, oldWhen);

  const outDir = path.join(tmp, 'backups');
  const backup = await createBackup({
    dataDir: dataSrc,
    outDir,
    keyFile: null,
    keep: 7,
    now: () => new Date('2026-11-07T12:00:00Z'),
    repoRoot: path.resolve(import.meta.dirname, '../..'),
  });
  assert.equal(backup.ok, true);
  // 归档内确实包含旧 mtime 文件（本机 bsdtar 会输出「MM DD  YYYY」日期列；GNU tar 输出 ISO 全日期，均合法）。
  const listing = execFileSync('tar', ['-tvzf', path.join(backup.backupDir, 'data.tar.gz')], {
    encoding: 'utf8',
  });
  assert.match(listing, /conversations\/c1\.json/);

  const restoredDir = path.join(tmp, 'restored');
  const result = await createRestore({ backupDir: backup.backupDir, dataDir: restoredDir, force: true });
  assert.equal(result.ok, true);
  assert.equal(
    fs.readFileSync(path.join(restoredDir, 'conversations', 'c1.json'), 'utf8'),
    '{"id":"c1","title":"旧文件"}\n',
  );
  // tar 会保留 mtime：恢复后的旧文件仍是 2023 年（证明归档里旧日期列被正确接受）。
  assert.equal(fs.statSync(path.join(restoredDir, 'conversations', 'c1.json')).mtime.getFullYear(), 2023);
});

test('createRestore：合法归档仍可正常恢复（逐字节一致）', async (t) => {
  const tmp = makeTmpDir('Chat Terminal-m45-guard-');
  const dataSrc = path.join(tmp, 'data-src');
  writeFileDeep(dataSrc, 'index.json', '{"version":1,"conversations":[]}\n');
  writeFileDeep(dataSrc, 'users/u111111111111/memories.json', '{"version":2}\n');
  writeFileDeep(dataSrc, 'conversations/c1.json', '{"id":"c1"}\n');
  const goodTar = makeTar(path.join(tmp, 'good-data.tar.gz'), { cwd: dataSrc, entries: ['.'] });
  const backupDir = await makeBackupDir(tmp, { dataArchive: goodTar });
  const dataDir = path.join(tmp, 'restored-data');
  const result = await createRestore({ backupDir, dataDir, keyFile: null, force: true });
  assert.equal(result.ok, true);
  for (const relativePath of ['index.json', 'users/u111111111111/memories.json', 'conversations/c1.json']) {
    assert.equal(
      fs.readFileSync(path.join(dataDir, relativePath), 'utf8'),
      fs.readFileSync(path.join(dataSrc, relativePath), 'utf8'),
      `恢复后内容应一致：${relativePath}`,
    );
  }
});
