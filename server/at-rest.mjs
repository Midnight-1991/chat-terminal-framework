// DATA_DIR 静态数据加密（at-rest，服务端 AES-256-GCM）。
//
// 设计要点（docs/DATA-CONTRACT.md 24 / docs/DEPLOY.md）：
//   - 只加密「磁盘静态数据」：index.json / conversations/*.json / memories.json / marks.json /
//     health.json / scales-history.json / attachments/*；运行时进程内仍是明文。
//   - 文件格式：魔数 `CTFENC001`(9B) + version(1B) + IV(12B) + auth tag(16B) + ciphertext，
//     AES-256-GCM；AAD = 文件语义名（相对 DATA_DIR、统一 `/`，如 `conversations/<id>.json`），
//     防止把 A 文件搬到 B 位置后仍能解密。
//   - 密钥（二选一，FILE 优先）：DATA_ENCRYPTION_KEY（base64 32B）或
//     DATA_ENCRYPTION_KEY_FILE（权限必须 600 或更严格，建议放 DATA_DIR 之外）。
//     密钥不写入 DATA_DIR / 备份 / 日志。
//   - 无 key：保持明文（模式 off，启动 WARN）；有 key：启动时把既有明文迁移为密文（幂等，
//     迁移前备份到 `DATA_DIR/.migration-backup-<时间戳>/`）。
//   - 错误 key / 密文损坏 / AAD 不匹配：一律 fail-fast，明确报错，绝不静默覆盖或清空。
//   - 明文兼容：读取时遇到非密文按原样返回（支持「密钥不对但数据是明文」的迁移场景）。
//   - 限制：密钥与数据同机时，防不了云厂商 root / 磁盘快照 / 进程内存 dump；
//     它不是 E2EE，服务端在请求处理时必然会解密。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 加密文件魔数（9 字节 ASCII）。 */
export const AT_REST_MAGIC = 'CTFENC001';
/** 文件格式版本（目前仅 1）。 */
export const AT_REST_FORMAT_VERSION = 1;
/** 加密算法标识（仅用于文档/诊断）。 */
export const AT_REST_ALGO = 'aes-256-gcm';
export const AT_REST_KEY_BYTES = 32;
export const AT_REST_IV_BYTES = 12;
export const AT_REST_TAG_BYTES = 16;
/** 魔数 + version 的长度。 */
export const AT_REST_HEADER_BYTES = AT_REST_MAGIC.length + 1;
/** 密文相对明文的固定额外字节数（header + IV + tag）。 */
export const AT_REST_OVERHEAD_BYTES = AT_REST_HEADER_BYTES + AT_REST_IV_BYTES + AT_REST_TAG_BYTES;

/** 需要加密的 DATA_DIR 单文件（路径相对 DATA_DIR）。 */
export const AT_REST_DATA_FILES = Object.freeze([
  'index.json',
  'memories.json',
  'marks.json',
  'health.json',
  'scales-history.json',
]);

const KEY_FILE_MIN_MODE = 0o600;

/** at-rest 相关错误的稳定错误码（CLI/测试/日志据此判断，不依赖 message）。 */
export const AT_REST_ERROR_CODES = Object.freeze({
  INVALID_KEY: 'INVALID_KEY',
  MISSING_KEY: 'MISSING_KEY',
  KEY_FILE_UNREADABLE: 'KEY_FILE_UNREADABLE',
  KEY_PERMISSIONS: 'KEY_PERMISSIONS',
  AUTH_FAILED: 'AUTH_FAILED',
  CORRUPT: 'CORRUPT',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  AAD_INVALID: 'AAD_INVALID',
});

export class AtRestError extends Error {
  /**
   * @param {string} code AT_REST_ERROR_CODES 之一
   * @param {string} message 面向运维的中文说明（不含密钥/文件内容）
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AtRestError';
    this.code = code;
  }
}

/** 是否 at-rest 错误（各 store 读到密文错误时必须 fail-fast，不能当损坏跳过）。 */
export function isAtRestError(error) {
  return error instanceof AtRestError || (error?.name === 'AtRestError' && typeof error.code === 'string');
}

/* ----------------------------------- 编解码 ----------------------------------- */

/** 判断 buffer 是否是 at-rest 密文（只看魔数）。 */
export function isEncryptedBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < AT_REST_MAGIC.length) return false;
  return buffer.subarray(0, AT_REST_MAGIC.length).toString('latin1') === AT_REST_MAGIC;
}

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload === null || payload === undefined) return Buffer.alloc(0);
  return Buffer.from(String(payload), 'utf8');
}

/**
 * 加密一段字节（返回完整文件内容）。
 * @param {Buffer} key 32 字节密钥
 * @param {string} aad 文件语义名（相对 DATA_DIR，`/` 分隔）
 * @param {Buffer|string} plaintext
 * @returns {Buffer}
 */
export function encodePayload(key, aad, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== AT_REST_KEY_BYTES) {
    throw new AtRestError(AT_REST_ERROR_CODES.INVALID_KEY, '加密密钥必须是 32 字节 Buffer');
  }
  if (typeof aad !== 'string' || aad === '') {
    throw new AtRestError(AT_REST_ERROR_CODES.AAD_INVALID, '加密必须提供文件语义名（AAD）');
  }
  const input = toBuffer(plaintext);
  const iv = crypto.randomBytes(AT_REST_IV_BYTES);
  const cipher = crypto.createCipheriv(AT_REST_ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(AT_REST_MAGIC, 'latin1'),
    Buffer.from([AT_REST_FORMAT_VERSION]),
    iv,
    tag,
    ciphertext,
  ]);
}

/**
 * 解密一段文件内容；非密文（明文）原样返回（明文兼容）。
 * @param {Buffer} key 32 字节密钥
 * @param {string} aad 文件语义名（必须与加密时一致）
 * @param {Buffer|string} payload 文件字节
 * @returns {Buffer} 明文
 */
export function decodePayload(key, aad, payload) {
  if (!Buffer.isBuffer(key) || key.length !== AT_REST_KEY_BYTES) {
    throw new AtRestError(AT_REST_ERROR_CODES.INVALID_KEY, '解密密钥必须是 32 字节 Buffer');
  }
  if (typeof aad !== 'string' || aad === '') {
    throw new AtRestError(AT_REST_ERROR_CODES.AAD_INVALID, '解密必须提供文件语义名（AAD）');
  }
  const buffer = toBuffer(payload);
  if (!isEncryptedBuffer(buffer)) return buffer;
  if (buffer.length < AT_REST_OVERHEAD_BYTES) {
    throw new AtRestError(AT_REST_ERROR_CODES.CORRUPT, `${aad} 的密文长度不足（文件可能被截断）`);
  }
  const version = buffer[AT_REST_MAGIC.length];
  if (version !== AT_REST_FORMAT_VERSION) {
    throw new AtRestError(
      AT_REST_ERROR_CODES.UNSUPPORTED_VERSION,
      `${aad} 的加密格式版本 ${version} 不受支持（当前 ${AT_REST_FORMAT_VERSION}）`,
    );
  }
  const ivStart = AT_REST_HEADER_BYTES;
  const tagStart = ivStart + AT_REST_IV_BYTES;
  const bodyStart = tagStart + AT_REST_TAG_BYTES;
  const iv = buffer.subarray(ivStart, tagStart);
  const tag = buffer.subarray(tagStart, bodyStart);
  const ciphertext = buffer.subarray(bodyStart);
  try {
    const decipher = crypto.createDecipheriv(AT_REST_ALGO, key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new AtRestError(
      AT_REST_ERROR_CODES.AUTH_FAILED,
      `${aad} 解密失败：密钥不匹配、文件被篡改或从其它位置搬运（GCM 校验失败）`,
      { cause: error },
    );
  }
}

/* ----------------------------------- 密钥 ----------------------------------- */

/** 严格 base64 解码 32 字节密钥（拒绝非法字符/长度；错误信息不回显密钥）。 */
export function decodeKeyBase64(raw, source = 'DATA_ENCRYPTION_KEY') {
  const cleaned = String(raw ?? '').trim();
  if (!cleaned) {
    throw new AtRestError(AT_REST_ERROR_CODES.INVALID_KEY, `${source} 为空：没法启用 at-rest 加密`);
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) {
    throw new AtRestError(
      AT_REST_ERROR_CODES.INVALID_KEY,
      `${source} 不是合法的 base64（应为 32 字节密钥的 base64，可用 \`openssl rand -base64 32\` 生成）`,
    );
  }
  const normalized = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  const key = Buffer.from(normalized, 'base64');
  // Node 的 base64 解码很宽松：用 round-trip 校验拒绝「看起来像 base64 的垃圾」。
  const canonical = key.toString('base64').replace(/=+$/, '');
  if (canonical !== normalized.replace(/=+$/, '')) {
    throw new AtRestError(AT_REST_ERROR_CODES.INVALID_KEY, `${source} base64 解码结果不合法`);
  }
  if (key.length !== AT_REST_KEY_BYTES) {
    throw new AtRestError(
      AT_REST_ERROR_CODES.INVALID_KEY,
      `${source} 解码后为 ${key.length} 字节，要求 ${AT_REST_KEY_BYTES} 字节`,
    );
  }
  return key;
}

/**
 * 从密钥文件读取 32 字节密钥（权限必须 ≤600）。
 * @param {string} filePath
 * @returns {Buffer}
 */
export function readEncryptionKeyFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new AtRestError(
      AT_REST_ERROR_CODES.KEY_FILE_UNREADABLE,
      `无法读取密钥文件 ${filePath}：${error?.code ?? error?.message ?? error}`,
      { cause: error },
    );
  }
  if (!stat.isFile()) {
    throw new AtRestError(AT_REST_ERROR_CODES.KEY_FILE_UNREADABLE, `密钥路径不是普通文件：${filePath}`);
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new AtRestError(
      AT_REST_ERROR_CODES.KEY_PERMISSIONS,
      `密钥文件权限过宽（${mode.toString(8)}），要求 ${KEY_FILE_MIN_MODE.toString(8)} 或更严格：${filePath}`,
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new AtRestError(
      AT_REST_ERROR_CODES.KEY_FILE_UNREADABLE,
      `无法读取密钥文件 ${filePath}：${error?.code ?? error?.message ?? error}`,
      { cause: error },
    );
  }
  return decodeKeyBase64(raw, `密钥文件 ${filePath}`);
}

/**
 * 解析启用 at-rest 的密钥（FILE 优先于 env；都没配置 → key=null，模式 off）。
 * @param {{env?: Record<string,string|undefined>}} [options]
 * @returns {{key: Buffer|null, source: 'file'|'env'|'none', keyFile: string|null}}
 */
export function loadEncryptionKey({ env = process.env } = {}) {
  const keyFile = typeof env?.DATA_ENCRYPTION_KEY_FILE === 'string' ? env.DATA_ENCRYPTION_KEY_FILE.trim() : '';
  if (keyFile) return { key: readEncryptionKeyFile(keyFile), source: 'file', keyFile };
  const rawKey = typeof env?.DATA_ENCRYPTION_KEY === 'string' ? env.DATA_ENCRYPTION_KEY.trim() : '';
  if (rawKey) return { key: decodeKeyBase64(rawKey, 'DATA_ENCRYPTION_KEY'), source: 'env', keyFile: null };
  return { key: null, source: 'none', keyFile: null };
}

/* --------------------------------- at-rest 实例 -------------------------------- */

/**
 * 创建 at-rest 编解码器（无 key 时 enabled=false，所有方法退化为明文透传）。
 * @param {{key?: Buffer|null, dataDir: string, logger?: object}} options
 */
export function createAtRest({ key = null, dataDir, logger = console } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createAtRest 需要 dataDir');
  const rootDir = path.resolve(dataDir);
  const enabled = Buffer.isBuffer(key) && key.length === AT_REST_KEY_BYTES;
  if (key && !enabled) {
    throw new AtRestError(AT_REST_ERROR_CODES.INVALID_KEY, 'createAtRest 的 key 必须是 32 字节 Buffer');
  }
  const mode = enabled ? 'on' : 'off';

  /** 文件 → 相对 DATA_DIR 的语义名（统一 `/`；必须位于 DATA_DIR 内）。 */
  function semanticNameFor(filePath) {
    const relative = path.relative(rootDir, path.resolve(filePath));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AtRestError(
        AT_REST_ERROR_CODES.AAD_INVALID,
        `文件不在 DATA_DIR 内，无法计算加密语义名：${filePath}`,
      );
    }
    return relative.split(path.sep).join('/');
  }

  function seal(filePath, payload) {
    const buffer = toBuffer(payload);
    if (!enabled) return buffer;
    return encodePayload(key, semanticNameFor(filePath), buffer);
  }

  function unseal(filePath, payload) {
    const buffer = toBuffer(payload);
    if (!enabled) return buffer;
    return decodePayload(key, semanticNameFor(filePath), buffer);
  }

  function readFileSync(filePath) {
    return unseal(filePath, fs.readFileSync(filePath));
  }

  /** 对外状态（不含密钥/路径；供 /api/health.storage 与启动日志）。 */
  function status() {
    return { atRest: mode, formatVersion: enabled ? AT_REST_FORMAT_VERSION : null };
  }

  return { enabled, mode, dataDir: rootDir, seal, unseal, readFileSync, semanticNameFor, status };
}

/* ---------------------------------- 迁移 ---------------------------------- */

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 列出目录下的普通文件（可导出：信封加密迁移复用同一白名单语义）。
 * @param {string} dirPath
 * @param {{ext?: string|null, allowOther?: boolean}} [options]
 * @returns {string[]}
 */
export function listDirFiles(dirPath, { ext = null, allowOther = false } = {}) {
  let names;
  try {
    names = fs.readdirSync(dirPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const name of names) {
    if (name.endsWith('.tmp')) continue;
    if (ext && !name.endsWith(ext)) continue;
    if (!ext && !allowOther && name.includes('.') && !name.endsWith('.json')) continue;
    const filePath = path.join(dirPath, name);
    if (isRegularFile(filePath)) files.push(filePath);
  }
  return files;
}

/**
 * 列出单个数据目录（DATA_DIR 根或 users/<uid>/）下的已知数据文件。
 * 起导出（信封加密迁移按用户目录复用同一份白名单；语义与 完全一致）。
 * @param {string} dirPath
 * @returns {string[]} 绝对路径列表
 */
export function listKnownDataFilesInDir(dirPath) {
  const files = [];
  for (const name of AT_REST_DATA_FILES) {
    const filePath = path.join(dirPath, name);
    if (isRegularFile(filePath)) files.push(filePath);
  }
  files.push(...listDirFiles(path.join(dirPath, 'conversations'), { ext: '.json' }));
  files.push(...listDirFiles(path.join(dirPath, 'attachments'), { allowOther: true }));
  return files;
}

/** 列出 DATA_DIR/users/<uid>/ 下每个用户分区的数据文件（跳过 '.' 前缀目录）。 */
function listUserDataFiles(rootDir) {
  const usersDir = path.join(rootDir, 'users');
  let entries;
  try {
    entries = fs.readdirSync(usersDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    files.push(...listKnownDataFilesInDir(path.join(usersDir, entry.name)));
  }
  return files;
}

/**
 * 列出 DATA_DIR 下需要加解密的文件（迁移/轮换/诊断共用）。
 * 不进入备份/临时目录；跳过 *.tmp；**递归扫描 users/<uid>/ 分区**（多用户）。
 * 注意：users/<uid>/ 下文件的 AAD 相对该用户目录计算（per-user atRest），见 migrateDataDir。
 * @param {string} dataDir
 * @returns {string[]} 绝对路径列表（index.json、users/<uid>/memories.json、conversations/*.json …）
 */
export function listDataFiles(dataDir) {
  const rootDir = path.resolve(dataDir);
  return [...listKnownDataFilesInDir(rootDir), ...listUserDataFiles(rootDir)];
}

/**
 * 判断文件是否属于 users/<uid>/ 分区；返回该用户目录（否则 null）。
 * @param {string} rootDir
 * @param {string} filePath
 * @returns {string|null}
 */
export function userDataDirFor(rootDir, filePath) {
  const parts = path.relative(path.resolve(rootDir), path.resolve(filePath)).split(path.sep);
  if (parts[0] !== 'users' || parts.length < 3 || parts[1].startsWith('.')) return null;
  return path.join(path.resolve(rootDir), 'users', parts[1]);
}

function backupPlaintextFiles(rootDir, files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(rootDir, `.migration-backup-${stamp}`);
  for (const filePath of files) {
    const relative = path.relative(rootDir, filePath);
    const destination = path.join(backupDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(filePath, destination);
    try {
      fs.chmodSync(destination, 0o600);
    } catch {
      /* 非 POSIX 时忽略 */
    }
  }
  return backupDir;
}

function writeEncryptedFileSync(atRest, filePath, plaintext) {
  const sealed = atRest.seal(filePath, plaintext);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, sealed, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* 非 POSIX 时忽略 */
  }
}

/**
 * 启动迁移：把 DATA_DIR 中既有明文文件加密（幂等）。
 * - 已有密文：先用当前 key 解密校验；失败（错误 key/损坏/搬运）→ 抛错 fail-fast，不改动任何文件。
 * - 明文：统一备份后加密写回（临时文件 + rename 原子替换）。
 * - users/<uid>/ 分区文件用 per-user atRest（AAD 相对用户目录）加解密，因此需要传 key
 *   （setupAtRest 会传）；未传 key 且分区内已有密文时 fail-fast，绝不按错误 AAD 覆盖。
 * - envelope=true 时**跳过 users/** 分区**（用户的 DEK 密文由 per-user
 *   ensureUserEnvelope 懒迁移，绝不能用 KEK 按路径 AAD 校验）；根目录全局文件与 byok secret
 *   仍按 KEK 迁移/校验。混合态（部分用户已迁移、部分仍是 KEK 或尚无 DEK）启动安全。
 * @param {{dataDir: string, atRest: object, key?: Buffer|null, logger?: object, envelope?: boolean}} options
 * @returns {{enabled:boolean, migrated:number, skipped:number, total:number, backupDir:string|null}}
 */
export function migrateDataDir({ dataDir, atRest, key = null, logger = console, envelope = false } = {}) {
  if (!atRest || !atRest.enabled) {
    return { enabled: false, migrated: 0, skipped: 0, total: 0, backupDir: null };
  }
  const rootDir = path.resolve(dataDir);
  const allFiles = listDataFiles(rootDir);
  // 信封加密开启时 users/** 已改用 per-user DEK（AAD 相对用户目录），不属于 KEK 迁移范围。
  const files = envelope
    ? allFiles.filter((filePath) => userDataDirFor(rootDir, filePath) === null)
    : allFiles;
  /** @type {Map<string, object>} userDir → per-user atRest */
  const userCodecs = new Map();
  const codecFor = (filePath) => {
    const userDir = userDataDirFor(rootDir, filePath);
    if (!userDir) return atRest;
    if (!key) {
      throw new AtRestError(
        AT_REST_ERROR_CODES.MISSING_KEY,
        'users/<uid> 分区需要 per-user atRest 计算 AAD，migrateDataDir 必须传入 key（setupAtRest 会自动传入）',
      );
    }
    let codec = userCodecs.get(userDir);
    if (!codec) {
      codec = createAtRest({ key, dataDir: userDir, logger });
      userCodecs.set(userDir, codec);
    }
    return codec;
  };
  const pending = [];
  let skipped = 0;
  for (const filePath of files) {
    const relative = path.relative(rootDir, filePath).split(path.sep).join('/');
    const raw = fs.readFileSync(filePath);
    const codec = codecFor(filePath);
    if (!isEncryptedBuffer(raw)) {
      pending.push({ filePath, raw, codec });
      continue;
    }
    // 已有密文：必须能用当前 key 解开，否则启动失败且不修改文件。
    try {
      codec.unseal(filePath, raw);
    } catch (error) {
      throw new AtRestError(
        AT_REST_ERROR_CODES.AUTH_FAILED,
        `DATA_DIR 中已有密文但当前密钥无法解密（${relative}）：${error?.message ?? error}。原文件未修改，请检查密钥是否正确。`,
        { cause: error },
      );
    }
    skipped += 1;
  }
  if (pending.length === 0) {
    return { enabled: true, migrated: 0, skipped, total: files.length, backupDir: null };
  }
  const backupDir = backupPlaintextFiles(
    rootDir,
    pending.map((item) => item.filePath),
  );
  for (const item of pending) writeEncryptedFileSync(item.codec, item.filePath, item.raw);
  logger?.log?.(
    `[at-rest] 已加密迁移 ${pending.length} 个明文文件（备份 ${path.basename(backupDir)}）`,
  );
  return { enabled: true, migrated: pending.length, skipped, total: files.length, backupDir };
}

/**
 * 一步完成「解析密钥 + 创建编解码器 + 启动迁移」：供 app.createContext 使用。
 * 错误 key / 损坏密文会抛 AtRestError（由启动入口 fail-fast）。
 * @param {{dataDir: string, config: object, env?: object, logger?: object}} options
 */
/** 扫描 DATA_DIR，判断是否已存在至少一个 at-rest 密文文件（只看魔数，不解析内容）。 */
export function hasEncryptedDataFiles(dataDir) {
  for (const filePath of listDataFiles(dataDir)) {
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const head = Buffer.alloc(AT_REST_MAGIC.length);
        const read = fs.readSync(fd, head, 0, head.length, 0);
        if (isEncryptedBuffer(head.subarray(0, read))) return true;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // 单文件不可读时按「非密文」处理：真正的密文/损坏会在各自 store 读取时 fail-fast。
    }
  }
  return false;
}

/**
 * 一步完成「解析密钥 + 创建编解码器 + 启动迁移」：供 app.createContext 使用。
 * 错误 key / 损坏密文 / **无密钥但已有密文** 会抛 AtRestError（由启动入口 fail-fast）。
 * @param {{dataDir: string, config: object, env?: object, logger?: object}} options
 */
export function setupAtRest({ dataDir, config, env = process.env, logger = console } = {}) {
  const keyInfo = loadEncryptionKey({
    env: {
      DATA_ENCRYPTION_KEY: config?.dataEncryptionKey ?? env?.DATA_ENCRYPTION_KEY,
      DATA_ENCRYPTION_KEY_FILE: config?.dataEncryptionKeyFile ?? env?.DATA_ENCRYPTION_KEY_FILE,
    },
  });
  // 安全护栏（-E 独立验证 C6）：无 key 但磁盘上已有密文时，绝不能以明文模式启动，
  // 否则任何一次写操作都会用明文覆盖密文文件，恢复密钥后旧数据不可逆丢失。
  if (!keyInfo.key && hasEncryptedDataFiles(dataDir)) {
    throw new AtRestError(
      AT_REST_ERROR_CODES.MISSING_KEY,
      'DATA_DIR 中检测到 at-rest 密文，但未配置 DATA_ENCRYPTION_KEY / DATA_ENCRYPTION_KEY_FILE：拒绝以明文模式启动（避免覆盖或丢失已加密数据）。请恢复密钥后重启。',
    );
  }
  const atRest = createAtRest({ key: keyInfo.key, dataDir, logger });
  // 信封加密开启时，启动迁移不得递归校验 users/**（那里是 per-user DEK 密文），
  // 否则二次重启会因「KEK 解不开 DEK 密文」误判为错误密钥而 fail-fast。用户分区由
  // app.createUserScopedCtx → ensureUserEnvelope 懒迁移。
  const migration = migrateDataDir({
    dataDir,
    atRest,
    key: keyInfo.key,
    logger,
    envelope: config?.atRestEnvelope === true,
  });
  // key 仅供 app.createContext 构造 per-user at-rest 实例（ 11.1/11.2）；绝不写日志/落盘/响应。
  return {
    atRest,
    migration,
    keySource: keyInfo.source,
    key: keyInfo.key ? Buffer.from(keyInfo.key) : null,
  };
}
