// / docs/briefs/m43-interface-contract.md 2：at-rest 信封加密（KEK→DEK）内核。
//
// 密钥层次：
//   KEK = 现有 DATA_ENCRYPTION_KEY / DATA_ENCRYPTION_KEY_FILE（32B，保持不变）；
//   DEK = 每用户随机 32B，只以「KEK 包裹」形态落盘 DATA_DIR/users/<uid>/.dek（0600）；
//   用户数据文件用 DEK 加密，AAD 仍是「相对用户目录的路径」（与  11.1 完全一致）；
//   全局根文件与 users/<uid>/byok.secret.enc 继续用 KEK（24 / 26.3，不在本模块处理）。
//
// `.dek` 文件格式（固定 70B，AES-256-GCM）：
//   magic(9B)=`CTFDEK001` + version(1B) + IV(12B) + auth tag(16B) + wrapped DEK(32B)
//   AAD = `dek:v1:<userId>`（固定语义，不随目录移动失效）。
//
// 迁移语义（migrateUserDirToEnvelope）：
//   旧 v1 单密钥密文（KEK + AAD=相对路径）→ 首次访问用户作用域时重加密为 DEK 密文（同 AAD）：
//   先全量「预检」再「写入」，任一文件既不能 DEK 也不能 KEK 解密 → fail-fast，不改动任何文件；
//   已迁移（DEK 可解）文件跳过；明文/空文件按「DEK 解密透传」语义视为已迁移（读取兼容，store
//   下次写入时自然加密），迁移前整个 DATA_DIR 备份一次（backupDataDirOnce）。
//
// 安全约束：不新增依赖；不打印/落盘明文密钥；迁移写盘一律 tmp+rename 原子替换 + 0600。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  decodePayload,
  encodePayload,
  isEncryptedBuffer,
  listKnownDataFilesInDir,
} from './at-rest.mjs';

/** `.dek` 文件魔数（9 字节 ASCII）。 */
export const ENVELOPE_MAGIC = 'CTFDEK001';
/** `.dek` 文件格式版本。 */
export const ENVELOPE_FORMAT_VERSION = 1;
/** 用户 DEK 字节数。 */
export const ENVELOPE_DEK_BYTES = 32;
/** 每用户 DEK 文件名（users/<uid>/.dek）。 */
export const ENVELOPE_DEK_FILE_NAME = '.dek';
/** 包裹 DEK 时使用的 AAD 前缀（完整 AAD = `dek:v1:<userId>`）。 */
export const ENVELOPE_DEK_AAD_PREFIX = 'dek:v1:';
/** 迁移前整库备份目录前缀（DATA_DIR/.migration-backup-envelope-<ISO>/）。 */
export const ENVELOPE_BACKUP_PREFIX = '.migration-backup-envelope-';

/** AES-256-GCM 参数（与 at-rest 文件格式一致）。 */
export const ENVELOPE_ALGO = 'aes-256-gcm';
export const ENVELOPE_IV_BYTES = 12;
export const ENVELOPE_TAG_BYTES = 16;
/** magic + version。 */
export const ENVELOPE_HEADER_BYTES = ENVELOPE_MAGIC.length + 1;
/** `.dek` 文件固定长度：header + IV + tag + wrapped(32B)。 */
export const ENVELOPE_DEK_PAYLOAD_BYTES =
  ENVELOPE_HEADER_BYTES + ENVELOPE_IV_BYTES + ENVELOPE_TAG_BYTES + ENVELOPE_DEK_BYTES;

/** 信封加密相关错误码（测试/启动日志据此判断，不依赖 message）。 */
export const ENVELOPE_ERROR_CODES = Object.freeze({
  DEK_MISSING: 'DEK_MISSING',
  DEK_CORRUPT: 'DEK_CORRUPT',
  KEK_MISMATCH: 'KEK_MISMATCH',
});

export class EnvelopeError extends Error {
  /**
   * @param {string} code ENVELOPE_ERROR_CODES 之一
   * @param {string} message 面向运维的中文说明（不得包含密钥/明文）
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'EnvelopeError';
    this.code = code;
  }
}

/** 是否信封加密错误（跨实例判断；启动路径必须 fail-fast，不能静默降级）。 */
export function isEnvelopeError(error) {
  return (
    error instanceof EnvelopeError ||
    (error?.name === 'EnvelopeError' && typeof error.code === 'string')
  );
}

/* --------------------------------- 内部工具 --------------------------------- */

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
}

function dekAad(userId) {
  return `${ENVELOPE_DEK_AAD_PREFIX}${userId}`;
}

/** 校验 KEK/DEK 形状（失败即 fail-fast，不打印密钥内容）。 */
function assertKek(kek) {
  if (!Buffer.isBuffer(kek) || kek.length !== ENVELOPE_DEK_BYTES) {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.KEK_MISMATCH, 'KEK 必须是 32 字节 Buffer');
  }
}

function assertDek(dek) {
  if (!Buffer.isBuffer(dek) || dek.length !== ENVELOPE_DEK_BYTES) {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.DEK_CORRUPT, 'DEK 必须是 32 字节 Buffer');
  }
}

function assertUserId(userId) {
  if (typeof userId !== 'string' || userId === '') {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.DEK_CORRUPT, 'DEK 需要非空 userId（用作 AAD）');
  }
}

/** 原子写文件（tmp + rename，0600；目录不存在时创建 0700）。 */
export function writeFileAtomic(filePath, buffer, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, buffer, { mode });
  try {
    fs.chmodSync(tmpPath, mode);
  } catch {
    /* 非 POSIX 时忽略 */
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* 非 POSIX 时忽略 */
  }
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------- 包裹 / 解包 ------------------------------- */

/**
 * 用 KEK 包裹用户 DEK（AES-256-GCM；AAD=`dek:v1:<userId>`）。
 * @param {Buffer} kek 32 字节 KEK
 * @param {string} userId 用户 id（AAD 语义串的一部分）
 * @param {Buffer} dek 32 字节 DEK
 * @returns {Buffer} 固定 70 字节 `.dek` 文件内容
 */
export function wrapDek(kek, userId, dek) {
  assertKek(kek);
  assertUserId(userId);
  assertDek(dek);
  const iv = crypto.randomBytes(ENVELOPE_IV_BYTES);
  const cipher = crypto.createCipheriv(ENVELOPE_ALGO, kek, iv);
  cipher.setAAD(Buffer.from(dekAad(userId), 'utf8'));
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(ENVELOPE_MAGIC, 'latin1'),
    Buffer.from([ENVELOPE_FORMAT_VERSION]),
    iv,
    tag,
    wrapped,
  ]);
}

/**
 * 用 KEK 解开 `.dek` 文件内容，返回用户 DEK。
 *
 * 失败语义（契约 2：失败抛 EnvelopeError）：
 *   - 结构损坏（长度/魔数/版本不符）→ DEK_CORRUPT（能确定是文件坏了）；
 *   - GCM 校验失败 → KEK_MISMATCH（密钥不对与密文被篡改在密码学上不可区分，
 *     按更常见的「KEK 不匹配」归因；不返回任何明文字节）。
 * @param {Buffer} kek 32 字节 KEK
 * @param {string} userId 用户 id（必须与包裹时一致）
 * @param {Buffer} payload `.dek` 文件内容
 * @returns {Buffer} 32 字节 DEK
 */
export function unwrapDek(kek, userId, payload) {
  assertKek(kek);
  assertUserId(userId);
  if (!Buffer.isBuffer(payload)) {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.DEK_CORRUPT, '.dek 内容必须是 Buffer');
  }
  const buffer = payload;
  if (buffer.length !== ENVELOPE_DEK_PAYLOAD_BYTES) {
    throw new EnvelopeError(
      ENVELOPE_ERROR_CODES.DEK_CORRUPT,
      `.dek 长度异常（${buffer.length} 字节，应为 ${ENVELOPE_DEK_PAYLOAD_BYTES}），文件可能被截断或损坏`,
    );
  }
  if (buffer.subarray(0, ENVELOPE_MAGIC.length).toString('latin1') !== ENVELOPE_MAGIC) {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.DEK_CORRUPT, '.dek 魔数不符（不是受支持的信封格式）');
  }
  const version = buffer[ENVELOPE_MAGIC.length];
  if (version !== ENVELOPE_FORMAT_VERSION) {
    throw new EnvelopeError(
      ENVELOPE_ERROR_CODES.DEK_CORRUPT,
      `.dek 格式版本 ${version} 不受支持（当前 ${ENVELOPE_FORMAT_VERSION}）`,
    );
  }
  const ivStart = ENVELOPE_HEADER_BYTES;
  const tagStart = ivStart + ENVELOPE_IV_BYTES;
  const bodyStart = tagStart + ENVELOPE_TAG_BYTES;
  const iv = buffer.subarray(ivStart, tagStart);
  const tag = buffer.subarray(tagStart, bodyStart);
  const wrapped = buffer.subarray(bodyStart);
  let dek;
  try {
    const decipher = crypto.createDecipheriv(ENVELOPE_ALGO, kek, iv);
    decipher.setAAD(Buffer.from(dekAad(userId), 'utf8'));
    decipher.setAuthTag(tag);
    dek = Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch (error) {
    throw new EnvelopeError(
      ENVELOPE_ERROR_CODES.KEK_MISMATCH,
      '无法用当前 KEK 解开用户 DEK：KEK 不匹配或 .dek 被篡改（GCM 校验失败）',
      { cause: error },
    );
  }
  if (dek.length !== ENVELOPE_DEK_BYTES) {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.DEK_CORRUPT, '解开后的 DEK 长度异常');
  }
  return dek;
}

/* --------------------------------- 读取/创建 -------------------------------- */

/**
 * 读取（不存在则创建）`users/<uid>/.dek`。
 * - 不存在：生成随机 32B DEK，用 KEK 包裹后原子写 0600 → `created:true`；
 * - 已存在：用 KEK 解开（错误 KEK / 损坏 → EnvelopeError fail-fast，绝不覆盖）。
 * @param {{kek:Buffer, userDir:string, userId:string, logger?:object}} options
 * @returns {Promise<{dek:Buffer, created:boolean}>}
 */
export async function loadUserDek({ kek, userDir, userId, logger = console } = {}) {
  assertKek(kek);
  assertUserId(userId);
  if (!userDir || typeof userDir !== 'string') {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.DEK_CORRUPT, 'loadUserDek 需要 userDir');
  }
  const dekPath = path.join(userDir, ENVELOPE_DEK_FILE_NAME);
  let raw;
  try {
    raw = fs.readFileSync(dekPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new EnvelopeError(
        ENVELOPE_ERROR_CODES.DEK_CORRUPT,
        `无法读取 ${ENVELOPE_DEK_FILE_NAME}：${error?.code ?? error?.message ?? error}`,
        { cause: error },
      );
    }
    const dek = crypto.randomBytes(ENVELOPE_DEK_BYTES);
    const wrapped = wrapDek(kek, userId, dek);
    try {
      writeFileAtomic(dekPath, wrapped);
    } catch (writeError) {
      throw new EnvelopeError(
        ENVELOPE_ERROR_CODES.DEK_CORRUPT,
        `无法写入 ${ENVELOPE_DEK_FILE_NAME}：${writeError?.code ?? writeError?.message ?? writeError}`,
        { cause: writeError },
      );
    }
    logger?.debug?.(`[at-rest] 已为用户 ${userId} 创建 DEK 信封（${ENVELOPE_DEK_FILE_NAME}）`);
    return { dek, created: true };
  }
  // 已存在：必须能用当前 KEK 解开，否则 fail-fast（不静默重建/覆盖）。
  const dek = unwrapDek(kek, userId, raw);
  return { dek, created: false };
}

/* --------------------------------- 单次备份 -------------------------------- */

function copyTreeSync(sourceDir, targetDir, { skipPath = null } = {}) {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  let entries;
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    if (skipPath && path.resolve(sourcePath) === skipPath) continue; // 排除备份自身
    if (entry.name.endsWith('.tmp')) continue; // 排除临时文件
    if (entry.isSymbolicLink()) continue; // 不跟随符号链接（防越界/循环）
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeSync(sourcePath, targetPath, { skipPath });
      continue;
    }
    if (!entry.isFile()) continue; // 设备/管道等一律不复制
    fs.copyFileSync(sourcePath, targetPath);
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      /* 非 POSIX 时忽略 */
    }
  }
}

/**
 * 首次信封迁移前，把整个 DATA_DIR 备份到 `.migration-backup-envelope-<ISO>/`（只备一次）。
 * 若 DATA_DIR 下已存在 `.migration-backup-envelope-*` → 跳过并返回 null。
 * 备份目录 0700、文件 0600；排除备份自身与 `*.tmp`（不跟随符号链接）。
 * @param {{dataDir:string, logger?:object}} options
 * @returns {Promise<string|null>} 新建的备份目录绝对路径；已存在则 null
 */
export async function backupDataDirOnce({ dataDir, logger = console } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('backupDataDirOnce 需要 dataDir');
  const rootDir = path.resolve(dataDir);
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null; // 从未初始化过 DATA_DIR：无需备份
    throw error;
  }
  if (entries.some((entry) => entry.name.startsWith(ENVELOPE_BACKUP_PREFIX))) {
    return null; // 已经备份过（幂等：整个进程生命周期只备一次）
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(rootDir, `${ENVELOPE_BACKUP_PREFIX}${stamp}`);
  try {
    copyTreeSync(rootDir, backupDir, { skipPath: path.resolve(backupDir) });
  } catch (error) {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true }); // 失败不留半个备份，避免下次误判「已备份」
    } catch {
      /* 清理失败时忽略，保留原始错误 */
    }
    throw error;
  }
  logger?.log?.(`[at-rest] 信封加密迁移前备份：${path.basename(backupDir)}`);
  return backupDir;
}

/* ---------------------------------- 迁移 ---------------------------------- */

/**
 * 把用户目录里的旧 v1 单密钥密文（KEK + AAD=相对路径）迁移为 DEK 密文（同 AAD）。
 *
 * 两步走：先对所有文件做「DEK 解密 / KEK 解密」预检（任一文件两种都解不开 → fail-fast，
 * 不改动任何文件）；再逐个用 DEK 重加密并原子写回、回读校验。已迁移文件跳过。
 * 明文/空文件按 DEK 解密透传语义视为已迁移（读取兼容；store 下次写入时自然加密）。
 * @param {{kek:Buffer, dek:Buffer, userDir:string, logger?:object}} options
 * @returns {Promise<{migrated:number, skipped:number, failed:number}>}
 */
export async function migrateUserDirToEnvelope({ kek, dek, userDir, logger = console } = {}) {
  assertKek(kek);
  assertDek(dek);
  if (!userDir || typeof userDir !== 'string') {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.DEK_CORRUPT, 'migrateUserDirToEnvelope 需要 userDir');
  }
  const rootDir = path.resolve(userDir);
  const files = listKnownDataFilesInDir(rootDir);
  /** @type {Array<{filePath:string, relative:string, plaintext:Buffer}>} */
  const pending = [];
  let skipped = 0;
  for (const filePath of files) {
    const relative = path.relative(rootDir, filePath).split(path.sep).join('/');
    const raw = fs.readFileSync(filePath);
    let plaintext;
    try {
      plaintext = decodePayload(dek, relative, raw);
    } catch (dekError) {
      // 不是 DEK 密文：可能是旧 v1 KEK 密文（AAD 仍是「相对用户目录路径」）。
      try {
        plaintext = decodePayload(kek, relative, raw);
      } catch (kekError) {
        throw new EnvelopeError(
          ENVELOPE_ERROR_CODES.KEK_MISMATCH,
          `${relative} 既不能用用户 DEK 也不能用当前 KEK 解密（密钥不匹配或文件损坏）；未改动任何文件`,
          { cause: kekError },
        );
      }
      pending.push({ filePath, relative, plaintext });
      continue;
    }
    skipped += 1; // DEK 可解（含明文透传）：已迁移/无需迁移
  }
  // 写入阶段：全部预检通过后才落盘，避免中途失败留下半迁移状态。
  for (const item of pending) {
    const sealed = encodePayload(dek, item.relative, item.plaintext);
    writeFileAtomic(item.filePath, sealed);
    const verify = decodePayload(dek, item.relative, fs.readFileSync(item.filePath));
    if (!verify.equals(item.plaintext)) {
      throw new EnvelopeError(
        ENVELOPE_ERROR_CODES.DEK_CORRUPT,
        `${item.relative} 迁移回读校验失败（内容不一致）`,
      );
    }
  }
  if (pending.length > 0) {
    logger?.log?.(`[at-rest] 信封迁移：${pending.length} 个文件由 KEK 密文改为 DEK 密文（跳过 ${skipped}）`);
  }
  return { migrated: pending.length, skipped, failed: 0 };
}

/* --------------------------------- 一站式入口 -------------------------------- */

/**
 * 一站式：loadUserDek →（首次）backupDataDirOnce → migrateUserDirToEnvelope。
 * 供 app.createUserScopedCtx 使用；任何失败都 fail-fast（由启动/请求入口处理）。
 * @param {{kek:Buffer, dataDir:string, userDir:string, userId:string, logger?:object}} options
 * @returns {Promise<{dek:Buffer, created:boolean, migrated:number}>}
 */
export async function ensureUserEnvelope({
  kek,
  dataDir,
  userDir,
  userId,
  logger = console,
} = {}) {
  assertKek(kek);
  if (!dataDir || typeof dataDir !== 'string') {
    throw new EnvelopeError(ENVELOPE_ERROR_CODES.DEK_CORRUPT, 'ensureUserEnvelope 需要 dataDir');
  }
  const { dek, created } = await loadUserDek({ kek, userDir, userId, logger });
  // 备份幂等：DATA_DIR 下已有 `.migration-backup-envelope-*` 时直接返回 null。
  // 即使 .dek 已存在也调用一次：避免「.dek 已创建但备份未完成」的中断状态漏备份。
  await backupDataDirOnce({ dataDir, logger });
  const result = await migrateUserDirToEnvelope({ kek, dek, userDir, logger });
  return { dek, created, migrated: result.migrated };
}
