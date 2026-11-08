// / 契约 6：密钥轮换脚本的信封扩展（--envelope / rewrapUserDeks）。
// 覆盖：参数解析、DEK rewrap（dry-run/实跑/错误旧 key）、rotateDataKey(envelope) 的
// 「用户数据文件不重写」核心收益、旧单密钥护栏、CLI 端到端、无 --envelope 保持旧行为。
// 全部用临时目录，不触网、不打印明文密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import {
  listUserDekFiles,
  parseArgs,
  rewrapUserDeks,
  rotateDataKey,
  usage,
} from '../../scripts/rotate-data-key.mjs';
import {
  ENVELOPE_DEK_FILE_NAME,
  ENVELOPE_ERROR_CODES,
  loadUserDek,
  unwrapDek,
  wrapDek,
} from '../../server/envelope.mjs';
import { AT_REST_ERROR_CODES, decodePayload, encodePayload } from '../../server/at-rest.mjs';
import { makeTmpDir } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ROTATE_SCRIPT = path.join(ROOT, 'scripts/rotate-data-key.mjs');
const OLD_KEY = crypto.createHash('sha256').update('m43-rotate-old-key').digest();
const NEW_KEY = crypto.createHash('sha256').update('m43-rotate-new-key').digest();
const OTHER_KEY = crypto.createHash('sha256').update('m43-rotate-other-key').digest();
const BYOK_AAD = 'byok:v1:u1';

const QUIET_LOGGER = { log() {}, warn() {}, debug() {} };

/* --------------------------------- 工具 --------------------------------- */

function writeKeyFile(dir, name, key, mode = 0o600) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${key.toString('base64')}\n`, { encoding: 'utf8', mode });
  return filePath;
}

/**
 * 造一个「已启用信封加密并完成迁移」的 DATA_DIR：
 *   index.json（KEK 密文）、users/u1/.dek（KEK 包裹）、
 *   users/u1/memories.json + conversations/c1.json（DEK 密文）、users/u2（无 .dek）、
 *   users/u1/byok.secret.enc（KEK 密文，AAD byok:v1:u1）。
 * @returns {{dataDir:string, userDir:string, dek:Buffer, userDataBytes:{memories:Buffer, conversation:Buffer}}}
 */
async function seedEnvelopeDataDir({ withByokSecret = false } = {}) {
  const dataDir = makeTmpDir('m43-rotate-');
  fs.writeFileSync(path.join(dataDir, 'index.json'), encodePayload(OLD_KEY, 'index.json', Buffer.from('{"v":1}')), {
    mode: 0o600,
  });
  const userDir = path.join(dataDir, 'users', 'u1');
  fs.mkdirSync(path.join(userDir, 'conversations'), { recursive: true, mode: 0o700 });
  const { dek } = await loadUserDek({ kek: OLD_KEY, userDir, userId: 'u1', logger: QUIET_LOGGER });
  const memoriesBytes = encodePayload(dek, 'memories.json', Buffer.from('{"memories":["信封记忆"]}'));
  const conversationBytes = encodePayload(dek, 'conversations/c1.json', Buffer.from('{"id":"c1"}'));
  fs.writeFileSync(path.join(userDir, 'memories.json'), memoriesBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(userDir, 'conversations', 'c1.json'), conversationBytes, { mode: 0o600 });
  if (withByokSecret) {
    const secret = encodePayload(OLD_KEY, BYOK_AAD, Buffer.from('{"apiKey":"test-key-***"}'));
    fs.writeFileSync(path.join(userDir, 'byok.secret.enc'), secret, { mode: 0o600 });
  }
  // 另一个没有信封的用户：rewrap 时应计入 skipped。（真实场景中该用户尚未登录过、目录里不会有数据文件；
  // 若仍有旧 KEK 密文数据，下面的护栏会拒绝轮换，提示先完成迁移。）
  fs.mkdirSync(path.join(dataDir, 'users', 'u2'), { recursive: true, mode: 0o700 });
  return { dataDir, userDir, dek, userDataBytes: { memories: memoriesBytes, conversation: conversationBytes } };
}

function readBytes(filePath) {
  return fs.readFileSync(filePath);
}

function listBackupEntryNames(dir) {
  return fs.readdirSync(dir).sort();
}

/* ------------------------------- 参数解析 ------------------------------- */

test('parseArgs：--envelope 默认 false；可组合 --dry-run/--data-dir/--new-key-file；未知参数抛错', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.envelope, false);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.help, false);
  assert.equal(defaults.dataDir, path.join(ROOT, 'data'));

  const parsed = parseArgs([
    '--envelope',
    '--dry-run',
    '--data-dir',
    '/tmp/x',
    '--old-key-file',
    '/tmp/old',
    '--new-key-file',
    '/tmp/new',
  ]);
  assert.equal(parsed.envelope, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.dataDir, '/tmp/x');
  assert.equal(parsed.oldKeyFile, '/tmp/old');
  assert.equal(parsed.newKeyFile, '/tmp/new');
  assert.equal(parseArgs(['--envelope']).envelope, true);
  assert.equal(parseArgs(['--dry-run']).envelope, false);
  assert.throws(() => parseArgs(['--nope']), /未知参数：--nope/);
  assert.throws(() => parseArgs(['--data-dir']), /缺少值/);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
});

test('usage()：帮助文本包含 --envelope 与「用户数据文件不重写」说明', () => {
  const text = usage();
  assert.match(text, /--envelope/);
  assert.match(text, /DEK/);
  assert.match(text, /用户数据文件不重写/);
  assert.match(text, /--dry-run/);
});

/* ---------------------------- rewrapUserDeks ---------------------------- */

test('listUserDekFiles：只列 users/<uid>/.dek（跳过无 .dek 用户与点目录）', async () => {
  const { dataDir } = await seedEnvelopeDataDir();
  const files = listUserDekFiles(dataDir);
  assert.equal(files.length, 1);
  assert.equal(files[0].userId, 'u1');
  assert.equal(files[0].dekPath, path.join(dataDir, 'users', 'u1', ENVELOPE_DEK_FILE_NAME));
  assert.deepEqual(listUserDekFiles(path.join(dataDir, 'no-users-dir')), []);
});

test('rewrapUserDeks dry-run：只统计（rewrapped 1/skipped 1），不写盘且旧 KEK 仍可解开', async () => {
  const { userDir, dek } = await seedEnvelopeDataDir();
  const dekPath = path.join(userDir, ENVELOPE_DEK_FILE_NAME);
  const before = readBytes(dekPath);

  const summary = await rewrapUserDeks({
    dataDir: path.dirname(path.dirname(userDir)),
    oldKey: OLD_KEY,
    newKey: NEW_KEY,
    dryRun: true,
    logger: QUIET_LOGGER,
  });
  assert.deepEqual(summary, { rewrapped: 1, skipped: 1, failed: 0 });
  assert.equal(readBytes(dekPath).equals(before), true, 'dry-run 不得写盘');
  assert.equal(unwrapDek(OLD_KEY, 'u1', readBytes(dekPath)).equals(dek), true);
});

test('rewrapUserDeks 实跑：旧 KEK 打不开 .dek、新 KEK 打开且等于原 DEK；用户数据文件字节不变', async () => {
  const { dataDir, userDir, dek, userDataBytes } = await seedEnvelopeDataDir();
  const dekPath = path.join(userDir, ENVELOPE_DEK_FILE_NAME);
  const memoriesPath = path.join(userDir, 'memories.json');
  const conversationPath = path.join(userDir, 'conversations', 'c1.json');
  const logs = [];
  const logger = { log: (...args) => logs.push(args.join(' ')), warn() {}, debug() {} };

  const summary = await rewrapUserDeks({ dataDir, oldKey: OLD_KEY, newKey: NEW_KEY, logger });
  assert.deepEqual(summary, { rewrapped: 1, skipped: 1, failed: 0 });

  const rewrapped = readBytes(dekPath);
  assert.equal(rewrapped.equals(wrapDek(OLD_KEY, 'u1', dek)), false, '.dek 必须已改写');
  assert.throws(
    () => unwrapDek(OLD_KEY, 'u1', rewrapped),
    (error) => error.code === ENVELOPE_ERROR_CODES.KEK_MISMATCH,
    '旧 KEK 必须打不开 rewrap 后的 .dek',
  );
  assert.equal(unwrapDek(NEW_KEY, 'u1', rewrapped).equals(dek), true, '新 KEK 解出的 DEK 必须与原 DEK 相同');
  // 信封核心收益：用户数据文件不重写（字节完全不变，仍可用 DEK 解）。
  assert.equal(readBytes(memoriesPath).equals(userDataBytes.memories), true);
  assert.equal(readBytes(conversationPath).equals(userDataBytes.conversation), true);
  assert.equal(decodePayload(dek, 'memories.json', readBytes(memoriesPath)).toString(), '{"memories":["信封记忆"]}');
  assert.ok(logs.some((line) => /用户数据文件未重写/.test(line)));
});

test('rewrapUserDeks：旧 KEK 解不开某个 .dek 时必须 fail-fast 且不改写任何 .dek', async () => {
  const { dataDir, userDir } = await seedEnvelopeDataDir();
  const dekPath = path.join(userDir, ENVELOPE_DEK_FILE_NAME);
  // 用未知 key 包裹 .dek（模拟旧 KEK 不匹配）。
  const originalDek = unwrapDek(OLD_KEY, 'u1', readBytes(dekPath));
  fs.writeFileSync(dekPath, wrapDek(OTHER_KEY, 'u1', originalDek), { mode: 0o600 });
  const before = readBytes(dekPath);

  await assert.rejects(
    () => rewrapUserDeks({ dataDir, oldKey: OLD_KEY, newKey: NEW_KEY, logger: QUIET_LOGGER }),
    /旧密钥无法解开用户 u1 的 DEK/,
  );
  assert.equal(readBytes(dekPath).equals(before), true, '失败时不得改写 .dek');
});

/* ------------------------------ rotateDataKey ------------------------------ */

test('rotateDataKey(envelope)：dry-run 只统计（deksRewrapped 1）且不写盘', async () => {
  const { dataDir, userDir } = await seedEnvelopeDataDir({ withByokSecret: true });
  const dekPath = path.join(userDir, ENVELOPE_DEK_FILE_NAME);
  const indexBefore = readBytes(path.join(dataDir, 'index.json'));
  const dekBefore = readBytes(dekPath);
  const byokBefore = readBytes(path.join(userDir, 'byok.secret.enc'));

  const summary = await rotateDataKey({
    dataDir,
    oldKey: OLD_KEY,
    newKey: NEW_KEY,
    dryRun: true,
    envelope: true,
    logger: QUIET_LOGGER,
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.deksRewrapped, 1);
  assert.equal(readBytes(path.join(dataDir, 'index.json')).equals(indexBefore), true);
  assert.equal(readBytes(dekPath).equals(dekBefore), true);
  assert.equal(readBytes(path.join(userDir, 'byok.secret.enc')).equals(byokBefore), true);
});

test('rotateDataKey(envelope) 实跑：全局文件/ byok secret 换新 key，DEK rewrap，用户数据文件字节不变', async () => {
  const { dataDir, userDir, dek, userDataBytes } = await seedEnvelopeDataDir({ withByokSecret: true });
  const dekPath = path.join(userDir, ENVELOPE_DEK_FILE_NAME);
  const memoriesPath = path.join(userDir, 'memories.json');
  const byokPath = path.join(userDir, 'byok.secret.enc');

  const summary = await rotateDataKey({
    dataDir,
    oldKey: OLD_KEY,
    newKey: NEW_KEY,
    envelope: true,
    logger: QUIET_LOGGER,
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.deksRewrapped, 1);
  // 全局文件：新 key 可解、旧 key 不可解。
  const indexRaw = readBytes(path.join(dataDir, 'index.json'));
  assert.equal(decodePayload(NEW_KEY, 'index.json', indexRaw).toString(), '{"v":1}');
  assert.throws(
    () => decodePayload(OLD_KEY, 'index.json', indexRaw),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
  // byok secret 仍按 byok:v1:<uid> AAD 用新 key 轮换。
  const byokRaw = readBytes(byokPath);
  assert.equal(decodePayload(NEW_KEY, BYOK_AAD, byokRaw).toString(), '{"apiKey":"test-key-***"}');
  // DEK rewrap：旧 KEK 打不开、新 KEK 打开等于原 DEK。
  const rewrappedDek = readBytes(dekPath);
  assert.equal(unwrapDek(NEW_KEY, 'u1', rewrappedDek).equals(dek), true);
  assert.throws(
    () => unwrapDek(OLD_KEY, 'u1', rewrappedDek),
    (error) => error.code === ENVELOPE_ERROR_CODES.KEK_MISMATCH,
  );
  // 信封核心收益：用户数据文件字节不变。
  assert.equal(readBytes(memoriesPath).equals(userDataBytes.memories), true);
  assert.equal(
    readBytes(path.join(userDir, 'conversations', 'c1.json')).equals(userDataBytes.conversation),
    true,
  );
});

test('rotateDataKey(envelope) 护栏：用户数据仍是旧单密钥密文时拒绝轮换且不改动任何文件', async () => {
  // 场景：用户目录有 .dek，但数据文件尚未迁移（仍是 KEK 密文）。
  const dataDir = makeTmpDir('m43-rotate-legacy-');
  fs.writeFileSync(path.join(dataDir, 'index.json'), encodePayload(OLD_KEY, 'index.json', Buffer.from('{"v":1}')), {
    mode: 0o600,
  });
  const userDir = path.join(dataDir, 'users', 'u1');
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  await loadUserDek({ kek: OLD_KEY, userDir, userId: 'u1', logger: QUIET_LOGGER });
  fs.writeFileSync(
    path.join(userDir, 'memories.json'),
    encodePayload(OLD_KEY, 'memories.json', Buffer.from('{}')),
    { mode: 0o600 },
  );
  const snapshot = new Map(
    ['index.json', 'users/u1/.dek', 'users/u1/memories.json'].map((relative) => [
      relative,
      readBytes(path.join(dataDir, ...relative.split('/'))),
    ]),
  );

  await assert.rejects(
    () =>
      rotateDataKey({ dataDir, oldKey: OLD_KEY, newKey: NEW_KEY, envelope: true, logger: QUIET_LOGGER }),
    /仍是旧单密钥（KEK）密文.*AT_REST_ENVELOPE=on/,
  );
  for (const [relative, before] of snapshot) {
    assert.equal(
      readBytes(path.join(dataDir, ...relative.split('/'))).equals(before),
      true,
      `${relative} 必须保持原字节（护栏失败即不写盘）`,
    );
  }
});

test('rotateDataKey 无 --envelope：保持旧行为（全局文件用 KEK 轮换，不 rewrap DEK）', async () => {
  const dataDir = makeTmpDir('m43-rotate-plain-');
  fs.writeFileSync(path.join(dataDir, 'index.json'), encodePayload(OLD_KEY, 'index.json', Buffer.from('{"v":1}')), {
    mode: 0o600,
  });

  const summary = await rotateDataKey({ dataDir, oldKey: OLD_KEY, newKey: NEW_KEY, logger: QUIET_LOGGER });
  assert.equal(summary.deksRewrapped, 0);
  assert.equal(summary.total, 1, '无信封模式只轮换 listDataFiles 白名单文件（不含用户 DEK）');
  const indexRaw = readBytes(path.join(dataDir, 'index.json'));
  assert.equal(decodePayload(NEW_KEY, 'index.json', indexRaw).toString(), '{"v":1}');
  assert.throws(
    () => decodePayload(OLD_KEY, 'index.json', indexRaw),
    (error) => error.code === AT_REST_ERROR_CODES.AUTH_FAILED,
  );
});

/* ---------------------------------- CLI ---------------------------------- */

test('CLI --envelope：--dry-run 与实跑均 exit 0，输出含 DEK rewrap；实跑后新 key 可开 .dek、用户数据字节不变', async () => {
  const keysDir = makeTmpDir('m43-rotate-keys-');
  const oldKeyFile = writeKeyFile(keysDir, 'old.key', OLD_KEY);
  const newKeyFile = writeKeyFile(keysDir, 'new.key', NEW_KEY);
  const { dataDir, userDir, dek, userDataBytes } = await seedEnvelopeDataDir();
  const dekPath = path.join(userDir, ENVELOPE_DEK_FILE_NAME);
  const memoriesPath = path.join(userDir, 'memories.json');
  const dekBefore = readBytes(dekPath);
  const args = [
    ROTATE_SCRIPT,
    '--data-dir',
    dataDir,
    '--old-key-file',
    oldKeyFile,
    '--new-key-file',
    newKeyFile,
    '--envelope',
  ];

  const dry = spawnSync(process.execPath, [...args, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, `dry-run 应 exit 0，实际 stderr=${dry.stderr}`);
  assert.match(dry.stdout, /dry-run/);
  assert.match(dry.stdout, /用户 DEK 1 个/);
  assert.equal(readBytes(dekPath).equals(dekBefore), true, 'dry-run 不写盘');
  assert.equal(unwrapDek(OLD_KEY, 'u1', readBytes(dekPath)).equals(dek), true);

  const real = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(real.status, 0, `实跑应 exit 0，实际 stderr=${real.stderr}`);
  assert.match(real.stdout, /DEK rewrap 1 个/);
  assert.equal(unwrapDek(NEW_KEY, 'u1', readBytes(dekPath)).equals(dek), true);
  assert.equal(readBytes(memoriesPath).equals(userDataBytes.memories), true, '用户数据文件字节不变');
  // 幂等重跑（新 key 已生效）：再次跑应因旧 key 解不开而失败？—— 不重跑，避免把「已轮换」误判。
  assert.deepEqual(listBackupEntryNames(keysDir), ['new.key', 'old.key']);
});

test('CLI 无 --envelope：轮换后用户数据文件用新 key 可读（旧行为兼容）', async () => {
  const keysDir = makeTmpDir('m43-rotate-keys-plain-');
  const oldKeyFile = writeKeyFile(keysDir, 'old.key', OLD_KEY);
  const newKeyFile = writeKeyFile(keysDir, 'new.key', NEW_KEY);
  const dataDir = makeTmpDir('m43-rotate-cli-plain-');
  fs.writeFileSync(path.join(dataDir, 'index.json'), encodePayload(OLD_KEY, 'index.json', Buffer.from('{}')), {
    mode: 0o600,
  });
  const run = spawnSync(
    process.execPath,
    [ROTATE_SCRIPT, '--data-dir', dataDir, '--old-key-file', oldKeyFile, '--new-key-file', newKeyFile],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `应 exit 0，实际 stderr=${run.stderr}`);
  assert.doesNotMatch(run.stdout, /DEK rewrap/);
  assert.equal(decodePayload(NEW_KEY, 'index.json', readBytes(path.join(dataDir, 'index.json'))).toString(), '{}');
});
