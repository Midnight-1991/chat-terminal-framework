//  /  / 契约 2.2：恢复演练（drill-restore）测试。
// 覆盖：参数解析、最新备份发现、合法备份成功演练（含信封加密密文全量解密）、报告落盘权限、
// 沙盒清理/--keep、明文备份、损坏备份 DRILL_SHA_FAILED、无备份 DRILL_NO_BACKUP、
// users.json 缺失/损坏、错误密钥解密失败、旧 v1 KEK 密文回退、CLI 退出码。
// 全部在 os.tmpdir 沙盒执行（真实 tar/文件；不 sleep、不联网、不打印明文密钥）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { encodePayload } from '../../server/at-rest.mjs';
import { ENVELOPE_DEK_FILE_NAME, wrapDek } from '../../server/envelope.mjs';
import { BACKUP_DIR_PATTERN, createBackup } from '../../scripts/backup-data.mjs';
import {
  DRILL_ERROR_CODES,
  DRILL_MAX_FILES_SCAN,
  DRILL_REPORT_PREFIX,
  DRILL_REQUIRED_PLAIN_FILES,
  DRILL_VERSION,
  findLatestBackup,
  parseArgs,
  runRestoreDrill,
} from '../../scripts/drill-restore.mjs';
import { makeTmpDir } from './helpers.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const DRILL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'drill-restore.mjs');
const RESTORE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'restore-data.mjs');
const UID = 'u111111111111';
const KEK = Buffer.alloc(32, 7);
const DEK = Buffer.alloc(32, 9);

/* -------------------------------- 测试工具 -------------------------------- */

function writeDeep(rootDir, relativePath, content, options = {}) {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, options);
  return filePath;
}

function writeKeyFile(dir) {
  const keyFile = path.join(dir, 'data.key');
  fs.writeFileSync(keyFile, `${KEK.toString('base64')}\n`, { mode: 0o600 });
  return keyFile;
}

/** 造一个「信封加密」数据目录：根文件 KEK、用户文件 DEK、byok.secret.enc KEK+AAD。 */
function writeEncryptedFixture(dataDir) {
  writeDeep(dataDir, 'users.json', `${JSON.stringify({ version: 1, users: [{ id: UID }] })}\n`);
  writeDeep(dataDir, 'sessions.json', `${JSON.stringify({ version: 1, sessions: {} })}\n`);
  writeDeep(
    dataDir,
    'index.json',
    encodePayload(KEK, 'index.json', Buffer.from(JSON.stringify({ version: 1, conversations: [] }))),
  );
  writeDeep(dataDir, `users/${UID}/${ENVELOPE_DEK_FILE_NAME}`, wrapDek(KEK, UID, DEK));
  writeDeep(
    dataDir,
    `users/${UID}/memories.json`,
    encodePayload(DEK, 'memories.json', Buffer.from(JSON.stringify({ version: 2, memories: [] }))),
  );
  writeDeep(
    dataDir,
    `users/${UID}/conversations/c1.json`,
    encodePayload(DEK, 'conversations/c1.json', Buffer.from('{"id":"c1"}')),
  );
  writeDeep(
    dataDir,
    `users/${UID}/byok.secret.enc`,
    encodePayload(
      KEK,
      `byok:v1:${UID}`,
      Buffer.from(JSON.stringify({ apiKey: 'test-key-test-A1b2', baseUrl: 'https://api.example.com/v1' })),
    ),
  );
}

/** 造一个纯明文数据目录（AUTH=off 旧数据语义；无密钥文件）。 */
function writePlainFixture(dataDir, { usersJson = '{"version":1,"users":[{"id":"u111111111111"}]}' } = {}) {
  if (usersJson !== null) writeDeep(dataDir, 'users.json', `${usersJson}\n`);
  writeDeep(dataDir, 'sessions.json', '{"version":1,"sessions":{}}\n');
  writeDeep(dataDir, 'index.json', '{"version":1,"conversations":[]}\n');
  writeDeep(dataDir, 'memories.json', '{"version":2,"memories":[]}\n');
}

/** 生成一个真实备份（data.tar.gz[+secrets.tar.gz]+manifest+SHA256SUMS）。 */
async function makeBackup({ tmp, dataDir, keyFile = null, now = () => new Date('2026-11-07T10:20:30Z') }) {
  const outDir = path.join(tmp, 'backups');
  const result = await createBackup({ dataDir, outDir, keyFile, keep: 7, now, repoRoot: REPO_ROOT });
  assert.equal(result.ok, true);
  return { outDir, backupDir: result.backupDir };
}

function readReport(reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

/* --------------------------------- 参数解析 --------------------------------- */

test('parseArgs：默认值 / 全参数 / 未知参数与缺值报错', () => {
  assert.deepEqual(parseArgs([]), {
    backup: null,
    backupDir: null,
    workDir: null,
    reportDir: null,
    keep: false,
    json: false,
    help: false,
  });
  const options = parseArgs([
    '--backup',
    '/tmp/bk',
    '--backup-dir',
    '/tmp/root',
    '--work-dir',
    '/tmp/work',
    '--report-dir',
    '/tmp/report',
    '--keep',
    '--json',
  ]);
  assert.equal(options.backup, '/tmp/bk');
  assert.equal(options.backupDir, '/tmp/root');
  assert.equal(options.workDir, '/tmp/work');
  assert.equal(options.reportDir, '/tmp/report');
  assert.equal(options.keep, true);
  assert.equal(options.json, true);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
  assert.throws(() => parseArgs(['--backup']), /需要参数值/);
  assert.throws(() => parseArgs(['--report-dir', '--keep']), /需要参数值/);
  assert.equal(parseArgs(['-h']).help, true);
  assert.deepEqual(DRILL_REQUIRED_PLAIN_FILES, ['users.json']);
  assert.equal(DRILL_MAX_FILES_SCAN, 200_000);
});

test('findLatestBackup：不存在返回 null；只挑「YYYYMMDD-HHmmss」目录并取最新', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const root = path.join(tmp, 'backups');
  assert.equal(await findLatestBackup(root), null);
  fs.mkdirSync(root, { recursive: true });
  assert.equal(await findLatestBackup(root), null);
  for (const name of ['20261107-090000', '20261107-101010', 'not-a-backup', '20261107-111111']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
  fs.writeFileSync(path.join(root, '20261107-120000'), 'file-not-dir');
  const latest = await findLatestBackup(root);
  assert.ok(latest);
  assert.equal(latest.ts, '20261107-111111');
  assert.equal(latest.path, path.join(root, '20261107-111111'));
  assert.match(latest.ts, BACKUP_DIR_PATTERN);
});

/* ---------------------------------- 成功路径 ---------------------------------- */

test('runRestoreDrill：信封加密备份成功演练，密文全量解密、报告落盘 0600、沙盒清理', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const dataDir = path.join(tmp, 'prod-data');
  writeEncryptedFixture(dataDir);
  const keyFile = writeKeyFile(tmp);
  const before = new Map();
  for (const relative of ['index.json', `users/${UID}/memories.json`, `users/${UID}/byok.secret.enc`]) {
    before.set(relative, fs.readFileSync(path.join(dataDir, relative)));
  }
  const { outDir } = await makeBackup({ tmp, dataDir, keyFile });

  const reportDir = path.join(tmp, 'reports');
  const result = await runRestoreDrill({ backupDir: outDir, reportDir });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.shaVerified, true);
  assert.equal(result.tool, 'drill-restore');
  assert.equal(result.version, DRILL_VERSION);
  assert.equal(result.failures.length, 0);
  assert.equal(result.files.encrypted, 4);
  assert.equal(result.files.decrypted, 4);
  assert.equal(result.files.failed, 0);
  assert.equal(result.decrypt.attempted, 4);
  assert.equal(result.decrypt.ok, 4);
  assert.equal(result.decrypt.failed, 0);
  for (const sample of result.decrypt.samples) assert.equal(sample.ok, true);
  assert.ok(result.decrypt.samples.some((sample) => sample.file.endsWith('byok.secret.enc')));
  assert.ok(path.basename(result.reportPath).startsWith(DRILL_REPORT_PREFIX));
  assert.match(path.basename(result.reportPath), /^restore-drill-\d{8}-\d{6}\.json$/);
  assert.equal(path.dirname(result.reportPath), path.resolve(reportDir));
  assert.equal(fs.statSync(result.reportPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(reportDir).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(result.workDir), false, '默认应清理沙盒');
  assert.equal(result.workDirCleaned, true);

  const report = readReport(result.reportPath);
  assert.equal(report.ok, true);
  assert.equal(report.tool, 'drill-restore');
  assert.equal(report.shaVerified, true);
  assert.equal(report.files.encrypted, 4);
  assert.equal(report.decrypt.failed, 0);
  assert.ok(report.manifest && typeof report.manifest === 'object');
  // 报告/输出不得含明文密钥
  const reportText = fs.readFileSync(result.reportPath, 'utf8');
  assert.equal(reportText.includes(KEK.toString('base64')), false);
  assert.equal(reportText.includes(DEK.toString('base64')), false);
  assert.equal(reportText.includes('test-key-test-A1b2'), false);
  // 演练不触碰生产 DATA_DIR
  for (const [relative, content] of before) {
    assert.deepEqual(fs.readFileSync(path.join(dataDir, relative)), content, `生产数据被改动：${relative}`);
  }
});

test('runRestoreDrill：--keep 保留沙盒且报告默认写到备份根 drills/', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const dataDir = path.join(tmp, 'prod-data');
  writePlainFixture(dataDir);
  const { outDir } = await makeBackup({ tmp, dataDir });
  const result = await runRestoreDrill({ backupDir: outDir, keep: true });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.workDir), true, '--keep 应保留沙盒');
  assert.equal(result.workDirCleaned, false);
  assert.equal(path.dirname(result.reportPath), path.join(outDir, 'drills'));
  assert.equal(fs.existsSync(result.reportPath), true);
  assert.equal(fs.existsSync(path.join(result.workDir, 'data', 'users.json')), true);
  fs.rmSync(result.workDir, { recursive: true, force: true });
});

test('runRestoreDrill：明文（无密钥）备份也能演练成功，密文计数为 0', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const dataDir = path.join(tmp, 'prod-data');
  writePlainFixture(dataDir);
  const { outDir } = await makeBackup({ tmp, dataDir });
  const result = await runRestoreDrill({ backupDir: outDir, reportDir: path.join(tmp, 'reports') });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.files.encrypted, 0);
  assert.equal(result.decrypt.attempted, 0);
  assert.equal(result.decrypt.failed, 0);
  assert.equal(result.shaVerified, true);
});

test('runRestoreDrill：backupDir 传备份根时自动选择最新备份', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const dataDir = path.join(tmp, 'prod-data');
  writePlainFixture(dataDir);
  const outDir = path.join(tmp, 'backups');
  await createBackup({
    dataDir,
    outDir,
    keyFile: null,
    now: () => new Date('2026-11-07T10:00:00Z'),
    repoRoot: REPO_ROOT,
  });
  await createBackup({
    dataDir,
    outDir,
    keyFile: null,
    now: () => new Date('2026-11-07T11:00:00Z'),
    repoRoot: REPO_ROOT,
  });
  const result = await runRestoreDrill({ backupDir: outDir, reportDir: path.join(tmp, 'reports') });
  assert.equal(result.ok, true);
  const backupNames = fs
    .readdirSync(outDir)
    .filter((name) => BACKUP_DIR_PATTERN.test(name))
    .sort();
  assert.equal(path.basename(result.backupDir), backupNames[backupNames.length - 1]);
});

/* ---------------------------------- 失败路径 ---------------------------------- */

test('runRestoreDrill：损坏备份 → DRILL_SHA_FAILED；无备份 → DRILL_NO_BACKUP', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const dataDir = path.join(tmp, 'prod-data');
  writePlainFixture(dataDir);
  const { backupDir } = await makeBackup({ tmp, dataDir });
  const corruptDir = path.join(tmp, 'corrupt-backup');
  fs.cpSync(backupDir, corruptDir, { recursive: true });
  const dataTar = path.join(corruptDir, 'data.tar.gz');
  const buffer = fs.readFileSync(dataTar);
  buffer[Math.floor(buffer.length / 2)] ^= 0xff;
  fs.writeFileSync(dataTar, buffer);

  await assert.rejects(
    runRestoreDrill({ backupDir: corruptDir, reportDir: path.join(tmp, 'reports') }),
    (error) => error.code === DRILL_ERROR_CODES.SHA_FAILED,
  );
  await assert.rejects(
    runRestoreDrill({ backupDir: path.join(tmp, 'no-such-dir') }),
    (error) => error.code === DRILL_ERROR_CODES.NO_BACKUP,
  );
});

test('runRestoreDrill：users.json 缺失/JSON 损坏 → ok=false 且 failures 指名文件', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');

  const missingDir = path.join(tmp, 'missing-data');
  writePlainFixture(missingDir, { usersJson: null });
  const missingBackup = await makeBackup({ tmp, dataDir: missingDir, now: () => new Date('2026-11-07T10:00:00Z') });
  const missingResult = await runRestoreDrill({
    backupDir: missingBackup.outDir,
    reportDir: path.join(tmp, 'reports-missing'),
  });
  assert.equal(missingResult.ok, false);
  assert.ok(
    missingResult.failures.some((failure) => failure.kind === 'json' && failure.file === 'users.json'),
    JSON.stringify(missingResult.failures),
  );

  const brokenDir = path.join(tmp, 'broken-data');
  writePlainFixture(brokenDir, { usersJson: '{"users": [ oops' });
  const brokenBackup = await makeBackup({ tmp, dataDir: brokenDir, now: () => new Date('2026-11-07T10:30:00Z') });
  const brokenResult = await runRestoreDrill({
    backupDir: brokenBackup.outDir,
    reportDir: path.join(tmp, 'reports-broken'),
  });
  assert.equal(brokenResult.ok, false);
  assert.ok(brokenResult.failures.some((failure) => failure.kind === 'json' && failure.file === 'users.json'));
});

test('runRestoreDrill：错误密钥导致密文解密失败 → ok=false，且报告不含密钥材料', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const dataDir = path.join(tmp, 'prod-data');
  writeEncryptedFixture(dataDir);
  // 用错误 KEK 备份的 key：数据是用 KEK 加密的，换一个 key 文件 → 解密必须失败。
  const wrongKeyFile = path.join(tmp, 'data.key');
  fs.writeFileSync(wrongKeyFile, `${Buffer.alloc(32, 42).toString('base64')}\n`, { mode: 0o600 });
  const { outDir } = await makeBackup({ tmp, dataDir, keyFile: wrongKeyFile });
  const result = await runRestoreDrill({ backupDir: outDir, reportDir: path.join(tmp, 'reports') });
  assert.equal(result.ok, false);
  assert.ok(result.decrypt.failed >= 1);
  assert.ok(result.failures.some((failure) => failure.kind === 'decrypt'));
  const reportText = fs.readFileSync(result.reportPath, 'utf8');
  assert.equal(reportText.includes(wrongKeyFile && Buffer.alloc(32, 42).toString('base64')), false);
  assert.equal(reportText.includes('test-key-test-A1b2'), false);
});

test('runRestoreDrill：旧 v1 KEK 密文（无 .dek）可回退解密', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const dataDir = path.join(tmp, 'prod-data');
  writeDeep(dataDir, 'users.json', '{"version":1,"users":[{"id":"u111111111111"}]}\n');
  // 无 .dek：用户文件是旧单密钥 KEK 密文，AAD=相对用户目录路径。
  writeDeep(
    dataDir,
    `users/${UID}/memories.json`,
    encodePayload(KEK, 'memories.json', Buffer.from('{"version":2,"memories":[{"id":"m1"}]}')),
  );
  const keyFile = writeKeyFile(tmp);
  const { outDir } = await makeBackup({ tmp, dataDir, keyFile });
  const result = await runRestoreDrill({ backupDir: outDir, reportDir: path.join(tmp, 'reports') });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.decrypt.failed, 0);
  assert.equal(result.files.encrypted, 1);
});

/* ------------------------------------ CLI ------------------------------------ */

test('CLI：旧 mtime（2023-11-15）合法备份 restore/drill 均 exit0（B1 回归）', async () => {
  // B1：bsdtar 对 mtime 早于约 6 个月的文件用「MM DD  YYYY」日期列；曾导致合法归档被误拒。
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const dataDir = path.join(tmp, 'prod-data');
  writeDeep(dataDir, 'users.json', '{"version":1,"users":[{"id":"u111111111111"}]}\n');
  writeDeep(dataDir, 'index.json', '{"version":1,"conversations":["c1"]}\n');
  writeDeep(dataDir, 'conversations/c1.json', '{"id":"c1","title":"旧文件"}\n');
  const oldWhen = new Date('2023-11-15T12:00:00');
  fs.utimesSync(path.join(dataDir, 'conversations/c1.json'), oldWhen, oldWhen);
  const keyFile = writeKeyFile(tmp);
  const outDir = path.join(tmp, 'backups');
  await createBackup({
    dataDir,
    outDir,
    keyFile,
    now: () => new Date('2026-11-07T10:20:30Z'),
    repoRoot: REPO_ROOT,
  });
  const backupNames = fs
    .readdirSync(outDir)
    .filter((name) => BACKUP_DIR_PATTERN.test(name))
    .sort();
  const backupDir = path.join(outDir, backupNames[backupNames.length - 1]);
  const listing = spawnSync('tar', ['-tvzf', path.join(backupDir, 'data.tar.gz')], { encoding: 'utf8' });
  assert.match(listing.stdout, /conversations\/c1\.json/);

  // 1) restore CLI：exit 0 且旧文件（含 mtime）恢复。
  const restoredDir = path.join(tmp, 'restored');
  const restore = spawnSync(
    process.execPath,
    [RESTORE_SCRIPT, '--backup', backupDir, '--data-dir', restoredDir, '--force'],
    { encoding: 'utf8' },
  );
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(
    fs.readFileSync(path.join(restoredDir, 'conversations', 'c1.json'), 'utf8'),
    '{"id":"c1","title":"旧文件"}\n',
  );
  assert.equal(fs.statSync(path.join(restoredDir, 'conversations', 'c1.json')).mtime.getFullYear(), 2023);

  // 2) drill CLI：exit 0，报告 ok/shaVerified 且密文 0 失败。
  const reportDir = path.join(tmp, 'drills');
  const drill = spawnSync(
    process.execPath,
    [DRILL_SCRIPT, '--backup', backupDir, '--work-dir', path.join(tmp, 'drill-work'), '--report-dir', reportDir, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(drill.status, 0, drill.stderr);
  const payload = JSON.parse(drill.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.shaVerified, true);
  assert.equal(payload.decrypt.failed, 0);
  assert.equal(fs.existsSync(payload.reportPath), true);
});

test('CLI：--help 0；合法备份 exit 0 输出单行 JSON；损坏备份 exit 1 含 DRILL_SHA_FAILED', async () => {
  const tmp = makeTmpDir('Chat Terminal-m45-drill-');
  const help = spawnSync(process.execPath, [DRILL_SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法: node scripts\/drill-restore\.mjs/);

  const dataDir = path.join(tmp, 'prod-data');
  writePlainFixture(dataDir);
  const { backupDir } = await makeBackup({ tmp, dataDir });
  const reportDir = path.join(tmp, 'cli-reports');
  const ok = spawnSync(
    process.execPath,
    [DRILL_SCRIPT, '--backup', backupDir, '--report-dir', reportDir],
    { encoding: 'utf8' },
  );
  assert.equal(ok.status, 0, ok.stderr);
  const payload = JSON.parse(ok.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.tool, 'drill-restore');
  assert.equal(payload.shaVerified, true);
  assert.equal(fs.existsSync(payload.reportPath), true);

  const corruptDir = path.join(tmp, 'corrupt-backup');
  fs.cpSync(backupDir, corruptDir, { recursive: true });
  const dataTar = path.join(corruptDir, 'data.tar.gz');
  const buffer = fs.readFileSync(dataTar);
  buffer[Math.floor(buffer.length / 3)] ^= 0xff;
  fs.writeFileSync(dataTar, buffer);
  const failed = spawnSync(process.execPath, [DRILL_SCRIPT, '--backup', corruptDir], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /DRILL_SHA_FAILED/);
});
