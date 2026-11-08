// 多用户迁移：AUTH=on 首次启动时，把单用户 DATA_DIR 的 legacy 数据迁到 users/<adminId>/。
//
// 幂等：migration.json 或 users.json 已存在 → 跳过（重启不再依赖 ADMIN_INITIAL_PASSWORD_FILE）。
// 加密：at-rest 开启时，逐文件 unseal（AAD=相对 DATA_DIR 的路径）→ seal（AAD=相对用户目录的路径，
//   即 per-user atRest，dataDir=users/<uid>）；不得 rename（AAD 与路径绑定）。
// 安全：先全量备份（含 SHA256 清单）再动数据；失败自动还原并抛错；绝不打印明文密码。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AtRestError,
  AT_REST_ERROR_CODES,
  createAtRest,
  hasEncryptedDataFiles,
  isEncryptedBuffer,
  listDataFiles,
  loadEncryptionKey,
} from '../server/at-rest.mjs';
import { createUserService, PASSWORD_MAX, PASSWORD_MIN, USERS_FILE_NAME } from '../server/users.mjs';

export const MIGRATION_FILE_NAME = 'migration.json';
export const MIGRATION_FILE_VERSION = 1;
export const BACKUP_DIR_PREFIX = '.migration-backup-';
const LOG_PREFIX = '[migration]';

/** AUTH 是否是 on（与 config.loadConfig 的 choiceFromEnv 语义一致：只认 'on'）。 */
export function isAuthOn(env = process.env) {
  return String(env?.AUTH ?? '').trim().toLowerCase() === 'on';
}

/** 解析 DATA_DIR：绝对路径原样，相对路径按 repoRoot 解析（与 createContext 一致）。 */
export function resolveDataDir(env = process.env, { repoRoot = process.cwd() } = {}) {
  const raw = typeof env?.DATA_DIR === 'string' ? env.DATA_DIR.trim() : '';
  const dataDir = raw || './data';
  return path.isAbsolute(dataDir) ? dataDir : path.resolve(repoRoot, dataDir);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function writeFileAtomic(filePath, data, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* 权限设置失败不阻断 */
  }
}

function removeFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* 清理失败不掩盖原始错误 */
  }
}

function removeDirIfExists(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    /* 清理失败不掩盖原始错误 */
  }
}

/**
 * 读取初始管理员配置（只读，不打印密码）。
 * @returns {{username:string, initialPassword:string, passwordFile:string}}
 */
export function resolveAdminBootstrap(env = process.env, { repoRoot = process.cwd(), logger = console } = {}) {
  const username = (typeof env?.ADMIN_USERNAME === 'string' && env.ADMIN_USERNAME.trim()) || 'admin';
  const rawFile = typeof env?.ADMIN_INITIAL_PASSWORD_FILE === 'string' ? env.ADMIN_INITIAL_PASSWORD_FILE.trim() : '';
  if (!rawFile) {
    throw new Error(
      'AUTH=on 首次启动需要 ADMIN_INITIAL_PASSWORD_FILE（初始管理员密码文件，内容为明文密码，权限 600）。未配置，启动中止。',
    );
  }
  const passwordFile = path.isAbsolute(rawFile) ? rawFile : path.resolve(repoRoot, rawFile);
  let content;
  try {
    content = fs.readFileSync(passwordFile, 'utf8');
  } catch (error) {
    throw new Error(
      `无法读取 ADMIN_INITIAL_PASSWORD_FILE（${passwordFile}）：${error?.code ?? error?.message ?? error}。启动中止。`,
    );
  }
  const initialPassword = content.trim();
  if (initialPassword.length === 0) {
    throw new Error('ADMIN_INITIAL_PASSWORD_FILE 内容为空，启动中止。');
  }
  if (initialPassword.length < PASSWORD_MIN || initialPassword.length > PASSWORD_MAX) {
    throw new Error(`ADMIN_INITIAL_PASSWORD_FILE 内容不符合密码规则（需 ${PASSWORD_MIN}–${PASSWORD_MAX} 位），启动中止。`);
  }
  try {
    const mode = fs.statSync(passwordFile).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      // 只告警不阻断（部分平台/ACL 语义不同）；提示收紧权限。
      // 注意：这里不打印密码，只打印路径与权限。
      logger?.warn?.(`${LOG_PREFIX} 初始密码文件权限过宽（${mode.toString(8)}），建议 chmod 600：${passwordFile}`);
    }
  } catch {
    /* stat 失败不阻断（已成功读取） */
  }
  return { username, initialPassword, passwordFile };
}

/** 读取已有 users.json 的存在性（不解析内容）。 */
function usersFileExists(dataDir) {
  return fs.existsSync(path.join(dataDir, USERS_FILE_NAME));
}

/** users/ 目录是否存在且非空（半迁移状态检测）。 */
function usersDirState(dataDir) {
  const usersDir = path.join(dataDir, 'users');
  let entries;
  try {
    entries = fs.readdirSync(usersDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, nonEmpty: false };
    throw error;
  }
  return { exists: true, nonEmpty: entries.length > 0 };
}

function backupLegacyFiles(dataDir, files, { now = () => new Date() } = {}) {
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dataDir, `${BACKUP_DIR_PREFIX}${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const manifestFiles = [];
  for (const filePath of files) {
    const relative = path.relative(dataDir, filePath).split(path.sep).join('/');
    const destination = path.join(backupDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(filePath, destination);
    try {
      fs.chmodSync(destination, 0o600);
    } catch {
      /* 非 POSIX 忽略 */
    }
    const raw = fs.readFileSync(filePath);
    manifestFiles.push({ path: relative, sha256: sha256(raw), bytes: raw.length });
  }
  const manifest = {
    version: MIGRATION_FILE_VERSION,
    createdAt: now().toISOString(),
    dataDir,
    files: manifestFiles,
  };
  writeFileAtomic(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { backupDir, manifest };
}

/** 从备份还原被迁移/改动的 legacy 文件（原始字节）。 */
function restoreFromBackup(dataDir, backupDir) {
  const manifestPath = path.join(backupDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return;
  }
  for (const entry of manifest.files ?? []) {
    const source = path.join(backupDir, entry.path);
    const destination = path.join(dataDir, entry.path);
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o600);
    } catch {
      /* 单文件还原失败不阻断其它文件；最终错误仍抛出 */
    }
  }
}

/**
 * 执行多用户迁移（幂等）。
 * @param {{dataDir?:string, env?:object, repoRoot?:string, logger?:object, now?:()=>Date}} options
 * @returns {Promise<{migrated:boolean, skipped?:boolean, reason?:string, adminUserId?:string, adminUsername?:string,
 *   files?:number, backupDir?:string|null, userDir?:string, encryption?:boolean, total?:number}>}
 */
export async function migrateMultiuser({
  dataDir,
  env = process.env,
  repoRoot = process.cwd(),
  logger = console,
  now = () => new Date(),
} = {}) {
  const baseDataDir = path.resolve(dataDir ?? resolveDataDir(env, { repoRoot }));

  if (!isAuthOn(env)) {
    return { migrated: false, skipped: true, reason: 'auth-off' };
  }
  if (fs.existsSync(path.join(baseDataDir, MIGRATION_FILE_NAME))) {
    return { migrated: false, skipped: true, reason: 'already-migrated' };
  }
  if (usersFileExists(baseDataDir)) {
    return { migrated: false, skipped: true, reason: 'users-exist' };
  }
  const usersState = usersDirState(baseDataDir);
  if (usersState.exists && !usersState.nonEmpty) {
    // 空 users/ 目录不影响迁移，顺手清掉即可（不是半迁移）。
    removeDirIfExists(path.join(baseDataDir, 'users'));
  } else if (usersState.exists && usersState.nonEmpty) {
    throw new Error(
      `${LOG_PREFIX} 检测到 ${path.join(baseDataDir, 'users')} 已存在但缺少 users.json，疑似半迁移状态：已中止，请人工检查或从 .migration-backup-* 还原后再启动。`,
    );
  }

  // 1) 预检：管理员 env（必须在动数据之前）。
  const admin = resolveAdminBootstrap(env, { repoRoot, logger });
  // 2) 预检：at-rest 密钥与已有密文护栏（无 key + 已有密文 → MISSING_KEY，绝不覆盖）。
  const keyInfo = loadEncryptionKey({ env });
  if (!keyInfo.key && hasEncryptedDataFiles(baseDataDir)) {
    throw new AtRestError(
      AT_REST_ERROR_CODES.MISSING_KEY,
      `${LOG_PREFIX} DATA_DIR 中检测到 at-rest 密文，但未配置 DATA_ENCRYPTION_KEY / DATA_ENCRYPTION_KEY_FILE：拒绝迁移（避免覆盖或丢失已加密数据）。`,
    );
  }
  const baseAtRest = createAtRest({ key: keyInfo.key, dataDir: baseDataDir, logger });
  const encryption = Boolean(keyInfo.key);

  // 3) 收集 legacy 文件（迁移前 users.json 尚不存在，listDataFiles 不会包含分区）。
  const legacyFiles = listDataFiles(baseDataDir);
  // 4) 全量备份（含 SHA256 清单）。
  fs.mkdirSync(baseDataDir, { recursive: true, mode: 0o700 });
  const { backupDir } = backupLegacyFiles(baseDataDir, legacyFiles, { now });

  const writtenTargets = [];
  let userDirCreated = false;
  let migrationWritten = false;

  try {
    // 5) 建初始管理员（写 users.json）。
    const userService = createUserService({ dataDir: baseDataDir, logger, now });
    const { user: adminUser } = await userService.ensureAdmin({
      username: admin.username,
      initialPassword: admin.initialPassword,
    });
    const userDir = path.join(baseDataDir, 'users', adminUser.id);
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    userDirCreated = true;
    const userAtRest = createAtRest({ key: keyInfo.key, dataDir: userDir, logger });

    // 6) 逐文件解封（旧 AAD）→ 重封（per-user AAD）→ 原子写 → 校验 → 删源。
    const migratedFiles = [];
    for (const sourcePath of legacyFiles) {
      const relative = path.relative(baseDataDir, sourcePath).split(path.sep).join('/');
      const raw = fs.readFileSync(sourcePath);
      const plaintext = isEncryptedBuffer(raw) ? baseAtRest.unseal(sourcePath, raw) : raw;
      const destination = path.join(userDir, ...relative.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      writeFileAtomic(destination, userAtRest.seal(destination, plaintext));
      writtenTargets.push(destination);
      // 回读校验：确保新位置/新 AAD 可解密且内容一致。
      const verifyPlain = userAtRest.unseal(destination, fs.readFileSync(destination));
      if (sha256(verifyPlain) !== sha256(plaintext)) {
        throw new Error(`${LOG_PREFIX} 迁移校验失败（${relative}）：回读内容与源文件不一致`);
      }
      removeFile(sourcePath);
      migratedFiles.push({
        from: relative,
        to: path.relative(baseDataDir, destination).split(path.sep).join('/'),
        sha256: sha256(plaintext),
        encrypted: Boolean(userAtRest.enabled),
        bytes: plaintext.length,
      });
    }

    // 7) 清理 root 下已空的 legacy 子目录（仅 conversations/attachments，且为空时）。
    for (const dirName of ['conversations', 'attachments']) {
      const legacyDir = path.join(baseDataDir, dirName);
      try {
        if (fs.existsSync(legacyDir) && fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
      } catch {
        /* 清理空目录失败不影响迁移 */
      }
    }

    // 8) 写 migration.json（最后写；存在即代表迁移完成）。
    const record = {
      version: MIGRATION_FILE_VERSION,
      migratedAt: now().toISOString(),
      adminUserId: adminUser.id,
      adminUsername: adminUser.username,
      backupDir: path.basename(backupDir),
      dataDir: baseDataDir,
      encryption,
      files: migratedFiles,
    };
    writeFileAtomic(path.join(baseDataDir, MIGRATION_FILE_NAME), `${JSON.stringify(record, null, 2)}\n`);
    migrationWritten = true;

    logger?.log?.(
      `${LOG_PREFIX} 完成：AUTH=on 首次启动，${migratedFiles.length} 个 legacy 文件 → users/${adminUser.id}/（管理员 ${adminUser.username}，加密 ${encryption ? 'on' : 'off'}，备份 ${path.basename(backupDir)}）`,
    );
    return {
      migrated: true,
      adminUserId: adminUser.id,
      adminUsername: adminUser.username,
      files: migratedFiles.length,
      backupDir,
      userDir,
      encryption,
      total: legacyFiles.length,
    };
  } catch (error) {
    // 失败：还原备份 + 清理本次新建文件，保留 backupDir 供诊断。
    logger?.error?.(`${LOG_PREFIX} 迁移失败，正在从备份还原：${error?.message ?? error}`);
    for (const target of writtenTargets) removeFile(target);
    if (migrationWritten) removeFile(path.join(baseDataDir, MIGRATION_FILE_NAME));
    if (userDirCreated) removeDirIfExists(path.join(baseDataDir, 'users'));
    // 预检保证 users.json 在本次迁移前不存在：失败时清掉本次新建的。
    removeFile(path.join(baseDataDir, USERS_FILE_NAME));
    restoreFromBackup(baseDataDir, backupDir);
    throw error;
  }
}
