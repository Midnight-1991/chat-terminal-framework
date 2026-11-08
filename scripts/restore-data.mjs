#!/usr/bin/env node
//  /  / 契约 2：从 backup-data.mjs 产物恢复 DATA_DIR（零第三方依赖，调用系统 tar）。
//
// 用法：
//   node scripts/restore-data.mjs --backup PATH --data-dir DIR [--key-file FILE] [--force] [--dry-run]
//
// 安全顺序：先按 SHA256SUMS 校验全部文件（全部通过才继续）→ 解到 <data-dir>.restore-staging-<ts>
// → 现有数据 mv 到 <data-dir>.pre-restore-<ts> → staging mv 为 data-dir → 恢复 key 文件（0600）。
// 非空 data-dir 无 --force 拒绝；任一步失败则回滚（原数据恢复、staging 清理）。
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BACKUP_DATA_FILE,
  BACKUP_SECRETS_FILE,
  BACKUP_SUMS_FILE,
  formatTimestamp,
  sha256File,
} from './backup-data.mjs';

const SHA256_LINE_RE = /^([0-9a-f]{64})\s+\*?(.+)$/;

/* ----------------------  / 归档成员安全护栏 ---------------------- */

/** 恢复护栏错误码（CLI/测试按 error.code 判断；HTTP 层不感知）。 */
export const RESTORE_UNSAFE_ARCHIVE = 'RESTORE_UNSAFE_ARCHIVE';
/** 归档条目数上限（防 zip bomb；可用 options 覆盖）。 */
export const ARCHIVE_MAX_ENTRIES = 200_000;
/** 归档解压总体积上限（2 GiB；可用 options 覆盖）。 */
export const ARCHIVE_MAX_TOTAL_BYTES = 2 * 1024 ** 3;

/** 构造带错误码的护栏错误（message 里带 RESTORE_UNSAFE_ARCHIVE，便于运维 grep）。 */
function unsafeArchiveError(name, reason) {
  const error = new Error(`${RESTORE_UNSAFE_ARCHIVE}: ${name} (${reason})`);
  error.code = RESTORE_UNSAFE_ARCHIVE;
  return error;
}

/** 把归档成员名归一化为 posix 相对路径（去掉空段与 `.` 段；不做平台转换）。 */
function normalizeArchiveEntryName(name) {
  return String(name)
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/**
 * 校验单个归档成员名是否安全（契约 2.1）。
 * 规则：非空、无 NUL、非绝对路径、非盘符路径、无任意 `..` 段；
 * 只允许「根目录条目」（`.`/`./` 归一化后为空）之外的成员名含 `.` 段。
 * @param {string} name 归档成员名
 * @param {{platform?:string}} [options]
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateArchiveEntryName(name, { platform = process.platform } = {}) {
  void platform; // 盘符/反斜杠规则在所有平台都拒绝（归档可能在别的系统生成）
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, reason: '条目名为空' };
  }
  if (name.includes('\0')) {
    return { ok: false, reason: '包含 NUL 字节' };
  }
  if (name.startsWith('/') || name.startsWith('\\')) {
    return { ok: false, reason: '绝对路径' };
  }
  if (/^[A-Za-z]:/.test(name)) {
    return { ok: false, reason: 'Windows 盘符路径' };
  }
  const segments = name.split(/[\\/]+/);
  const firstSegment = segments[0] ?? '';
  if (firstSegment.length === 2 && firstSegment.includes(':')) {
    return { ok: false, reason: 'Windows 盘符路径' };
  }
  for (const segment of segments) {
    if (segment === '..') {
      return { ok: false, reason: '包含 `..` 段' };
    }
  }
  const normalized = normalizeArchiveEntryName(name);
  if (normalized === '') {
    // 仅允许 tar 的根条目（`.`、`./`）归一化为空；其余空路径条目一律拒绝。
    if (!/^[./\\]+$/.test(name)) {
      return { ok: false, reason: '归一化后为空' };
    }
  }
  return { ok: true };
}

/**
 * tar -tvzf 的日期/时间分隔模式（按 `MM DD HH:MM`、`MM DD YYYY` 等列格式）。
 * 注意：BSD/macOS tar 对 mtime 早于约 6 个月的文件用「MM DD  YYYY」（数字月+日+年，无时间），
 * 而近期文件用「MM DD HH:MM」；GNU tar 统一用 ISO 全日期。三种都必须支持，
 * 否则旧文件会让合法归档被误判为不安全（B1）。
 */
const TAR_DATE_PATTERNS = [
  // GNU tar：2026-11-07 19:00 或 2026-11-07 19:00:30
  /\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?/,
  // 传统/BSD：Mon DD HH:MM 或 Mon DD  YYYY
  /[A-Za-z]{3}\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2})/,
  // BSD/macOS 数字月 + 日 + 时间：11  7 22:56
  /\d{1,2}\s+\d{1,2}\s+\d{1,2}:\d{2}/,
  // BSD/macOS 数字月 + 日 + 年（mtime 早于约 6 个月）：11 15  2023
  /\d{1,2}\s+\d{1,2}\s+\d{4}/,
];

/**
 * 解析 `tar -tvzf` 的目录输出（只读，不落盘）。
 * 支持 GNU tar（`2026-11-07 19:00`）与 BSD/macOS tar（`11  7 22:56`）格式，
 * 以及 symlink（`name -> target`）与 hardlink（`name link to target`）后缀。
 * @param {string} text tar -tvzf stdout
 * @returns {Array<{type:'file'|'dir'|'symlink'|'hardlink'|'other', name:string, sizeBytes:number}>}
 */
export function parseTarVerboseListing(text) {
  if (typeof text !== 'string') throw new Error('parseTarVerboseListing 需要字符串');
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') continue;
    const modeMatch = /^([-dlhcbps][rwxStTs-]{9})\s+(.*)$/.exec(line);
    if (!modeMatch) {
      throw unsafeArchiveError(line.slice(0, 80), '无法解析 tar 目录输出');
    }
    const mode = modeMatch[1];
    const rest = modeMatch[2];

    let dateIndex = -1;
    let dateLength = 0;
    for (const pattern of TAR_DATE_PATTERNS) {
      const match = pattern.exec(rest);
      if (match && (dateIndex === -1 || match.index < dateIndex)) {
        dateIndex = match.index;
        dateLength = match[0].length;
      }
    }
    if (dateIndex === -1) {
      throw unsafeArchiveError(line.slice(0, 80), '无法解析 tar 目录输出的日期列');
    }
    const prefix = rest.slice(0, dateIndex).trim();
    const sizeTokens = prefix === '' ? [] : prefix.split(/\s+/);
    let sizeBytes = 0;
    for (let index = sizeTokens.length - 1; index >= 0; index -= 1) {
      if (/^\d+$/.test(sizeTokens[index])) {
        sizeBytes = Number(sizeTokens[index]);
        break;
      }
    }
    let name = rest.slice(dateIndex + dateLength).trim();
    if (name === '') {
      throw unsafeArchiveError(line.slice(0, 80), '无法解析 tar 目录输出的条目名');
    }

    const modeKind = mode[0];
    let type = 'other';
    if (modeKind === '-') type = 'file';
    else if (modeKind === 'd') type = 'dir';
    else if (modeKind === 'l') type = 'symlink';
    else if (modeKind === 'h') type = 'hardlink';

    if (type === 'symlink') {
      const arrow = name.indexOf(' -> ');
      if (arrow === -1) throw unsafeArchiveError(name, '无法解析符号链接目标');
      name = name.slice(0, arrow).trim();
      if (name === '') throw unsafeArchiveError(line.slice(0, 80), '符号链接条目名为空');
    } else if (type === 'hardlink') {
      const marker = name.indexOf(' link to ');
      if (marker !== -1) name = name.slice(0, marker).trim();
      if (name === '') throw unsafeArchiveError(line.slice(0, 80), '硬链接条目名为空');
    } else if (name.includes(' -> ')) {
      // 普通条目里出现 ` -> ` 说明归档类型与布局异常，保守拒绝。
      throw unsafeArchiveError(name, '普通条目包含链接标记');
    }
    entries.push({ type, name, sizeBytes });
  }
  return entries;
}

/**
 * 解压前校验归档（契约 2.1）：条目类型（只允许 file/dir）、成员名（防穿越/绝对路径/盘符）、
 * 条目数与解压体积上限（防 zip bomb）。失败抛 error.code = RESTORE_UNSAFE_ARCHIVE。
 * @param {string} archivePath
 * @param {{targetDir:string, maxEntries?:number, maxTotalBytes?:number,
 *   tarRunner?:((args:string[]) => string|Promise<string>)|null}} options
 * @returns {Promise<{ok:true, entryCount:number, totalBytes:number}>}
 */
export async function assertSafeArchive(archivePath, options = {}) {
  const {
    targetDir,
    maxEntries = ARCHIVE_MAX_ENTRIES,
    maxTotalBytes = ARCHIVE_MAX_TOTAL_BYTES,
    tarRunner = null,
  } = options;
  if (typeof archivePath !== 'string' || archivePath === '') {
    throw new Error('assertSafeArchive 需要 archivePath');
  }
  if (typeof targetDir !== 'string' || targetDir === '') {
    throw new Error('assertSafeArchive 需要 targetDir');
  }
  const resolvedTargetDir = path.resolve(targetDir);
  const targetPrefix = resolvedTargetDir.endsWith(path.sep)
    ? resolvedTargetDir
    : `${resolvedTargetDir}${path.sep}`;
  const runListing =
    typeof tarRunner === 'function'
      ? tarRunner
      : (args) => execFileSync('tar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  let listing;
  try {
    listing = await runListing(['-tvzf', archivePath]);
  } catch (error) {
    throw unsafeArchiveError(archivePath, `无法列出归档内容（tar 失败：${error?.message ?? error}）`);
  }
  const entries = parseTarVerboseListing(String(listing));

  if (entries.length > maxEntries) {
    throw unsafeArchiveError(archivePath, `条目数 ${entries.length} 超过上限 ${maxEntries}`);
  }
  let totalBytes = 0;
  for (const entry of entries) totalBytes += Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : 0;
  if (totalBytes > maxTotalBytes) {
    throw unsafeArchiveError(archivePath, `解压体积 ${totalBytes} 字节超过上限 ${maxTotalBytes}`);
  }

  for (const entry of entries) {
    if (entry.type !== 'file' && entry.type !== 'dir') {
      throw unsafeArchiveError(entry.name, `不支持的条目类型 ${entry.type}`);
    }
    const validation = validateArchiveEntryName(entry.name);
    if (!validation.ok) {
      throw unsafeArchiveError(entry.name, validation.reason ?? '条目名不安全');
    }
    const normalized = normalizeArchiveEntryName(entry.name);
    if (normalized === '') {
      if (entry.type !== 'dir') {
        throw unsafeArchiveError(entry.name, '空路径条目必须是目录');
      }
      continue;
    }
    const resolved = path.resolve(resolvedTargetDir, normalized);
    if (resolved === resolvedTargetDir) continue;
    if (!resolved.startsWith(targetPrefix)) {
      throw unsafeArchiveError(entry.name, '归一化后逃出目标目录');
    }
  }
  return { ok: true, entryCount: entries.length, totalBytes };
}

/**
 * 解包后的防御性二次校验：目录内不允许 symlink/设备/管道，且每个条目 realpath 必须仍在目录内。
 * @param {string} rootDir 解包目标目录
 */
async function verifyExtractedTree(rootDir) {
  const root = path.resolve(rootDir);
  // 部分平台（如 macOS /var → /private/var）的祖先路径本身是符号链接：统一用 realpath 作为比较基准。
  const rootReal = await fs.realpath(root);
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw unsafeArchiveError(child, '解包后出现符号链接');
      if (!entry.isFile() && !entry.isDirectory()) {
        throw unsafeArchiveError(child, '解包后出现非普通文件/目录');
      }
      const real = await fs.realpath(child);
      if (real !== rootReal && !real.startsWith(prefix)) {
        throw unsafeArchiveError(child, '解包后 realpath 逃出目标目录');
      }
      seen += 1;
      if (seen > ARCHIVE_MAX_ENTRIES) {
        throw unsafeArchiveError(root, `解包后条目数超过上限 ${ARCHIVE_MAX_ENTRIES}`);
      }
      if (entry.isDirectory()) stack.push(child);
    }
  }
}

/** 解析 CLI 参数；未知参数抛错（由 main 统一打印 exit 1）。 */
export function parseArgs(argv = []) {
  const options = {
    backupDir: null,
    dataDir: null,
    keyFile: null,
    force: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--backup' || arg === '--data-dir' || arg === '--key-file') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`参数 ${arg} 需要一个值`);
      }
      index += 1;
      if (arg === '--backup') options.backupDir = value;
      else if (arg === '--data-dir') options.dataDir = value;
      else options.keyFile = value;
      continue;
    }
    throw new Error(`未知参数：${arg}（--help 查看用法）`);
  }
  return options;
}

/** 读取并解析 SHA256SUMS；文件缺失/格式非法抛错。 */
export async function readChecksums(backupDir) {
  const sumsPath = path.join(backupDir, BACKUP_SUMS_FILE);
  let text;
  try {
    text = await fs.readFile(sumsPath, 'utf8');
  } catch {
    throw new Error(`备份不完整：找不到 ${BACKUP_SUMS_FILE}（${sumsPath}）`);
  }
  const entries = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = SHA256_LINE_RE.exec(line);
    if (!match) throw new Error(`SHA256SUMS 存在非法行：${line}`);
    entries.push({ sha256: match[1], path: match[2].trim() });
  }
  if (entries.length === 0) throw new Error('SHA256SUMS 为空，拒绝恢复');
  return entries;
}

/**
 * 校验备份目录：SHA256SUMS 中每个文件必须存在且 sha256 匹配（全部通过才返回）。
 * @param {string} backupDir
 */
export async function verifyBackup(backupDir) {
  const entries = await readChecksums(backupDir);
  for (const entry of entries) {
    const filePath = path.join(backupDir, entry.path);
    let actual;
    try {
      actual = await sha256File(filePath);
    } catch {
      throw new Error(`备份文件缺失：${entry.path}`);
    }
    if (actual !== entry.sha256) {
      throw new Error(`SHA256 校验失败：${entry.path}`);
    }
  }
  return entries;
}

function runTar(args) {
  execFileSync('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isNonEmptyDir(target) {
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return true;
    const entries = await fs.readdir(target);
    return entries.length > 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** 生成不冲突的临时目录名（同一秒重复恢复也不会互相覆盖）。 */
async function uniqueDir(basePath) {
  let candidate = basePath;
  for (let index = 1; index < 100; index += 1) {
    if (!(await pathExists(candidate))) return candidate;
    candidate = `${basePath}-${index}`;
  }
  throw new Error(`无法生成唯一临时目录：${basePath}`);
}

/** 递归找目录下的第一个普通文件（恢复 key 时 tarball 内只有该文件）。 */
async function findFirstFile(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isFile()) return child;
    if (entry.isDirectory()) {
      const nested = await findFirstFile(child);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * 执行恢复。
 * @param {{backupDir:string, dataDir:string, keyFile?:string|null, force?:boolean, dryRun?:boolean,
 *   logger?:object, now?:() => Date}} options
 */
export async function createRestore({
  backupDir,
  dataDir,
  keyFile = null,
  force = false,
  dryRun = false,
  logger = console,
  now = () => new Date(),
} = {}) {
  if (typeof backupDir !== 'string' || backupDir.length === 0) throw new Error('缺少 --backup');
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('缺少 --data-dir');
  const resolvedBackupDir = path.resolve(backupDir);
  const resolvedDataDir = path.resolve(dataDir);

  // 1) 先校验 SHA256（全部通过才继续；dry-run 也校验，保证计划可信）。
  let backupStat;
  try {
    backupStat = await fs.stat(resolvedBackupDir);
  } catch {
    throw new Error(`备份目录不存在：${resolvedBackupDir}`);
  }
  if (!backupStat.isDirectory()) throw new Error(`备份路径不是目录：${resolvedBackupDir}`);
  const checksums = await verifyBackup(resolvedBackupDir);
  const entryNames = checksums.map((entry) => entry.path);
  if (!entryNames.includes(BACKUP_DATA_FILE)) {
    throw new Error(`备份缺少 ${BACKUP_DATA_FILE}，拒绝恢复`);
  }
  const hasSecrets = entryNames.includes(BACKUP_SECRETS_FILE);
  const nonEmpty = await isNonEmptyDir(resolvedDataDir);
  if (dryRun) {
    // dry-run 只读：即使目标目录非空也返回计划（requiresForce 提示需要 --force），不报错。
    return {
      ok: true,
      dryRun: true,
      backupDir: resolvedBackupDir,
      dataDir: resolvedDataDir,
      entries: entryNames,
      nonEmpty,
      requiresForce: nonEmpty && !force,
      willBackupCurrent: nonEmpty,
      keyFileIncluded: hasSecrets,
      willRestoreKey: Boolean(hasSecrets && keyFile),
      keyFile: keyFile ? path.resolve(keyFile) : null,
    };
  }
  if (nonEmpty && !force) {
    throw new Error(`数据目录非空：${resolvedDataDir}（确认覆盖请加 --force）`);
  }

  const ts = formatTimestamp(now());
  const stagingDir = await uniqueDir(`${resolvedDataDir}.restore-staging-${ts}`);
  const preRestoreDir = await uniqueDir(`${resolvedDataDir}.pre-restore-${ts}`);
  const dataArchive = path.join(resolvedBackupDir, BACKUP_DATA_FILE);
  let movedCurrent = false;
  let stagingCreated = false;
  let secretsTempDir = null;

  try {
    // 2) 解压 data.tar.gz 到 staging（不触碰现有数据）。
    await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    stagingCreated = true;
    // 解包前校验归档成员（绝对路径/`..`/symlink/hardlink/设备/超限），解包后二次校验。
    await assertSafeArchive(dataArchive, { targetDir: stagingDir });
    runTar(['-xzf', dataArchive, '-C', stagingDir]);
    await verifyExtractedTree(stagingDir);

    // 3) 先解出 key 文件（若需要），避免数据替换后才发现备份损坏。
    let restoredKeyPath = null;
    if (hasSecrets && keyFile) {
      secretsTempDir = await uniqueDir(`${resolvedDataDir}.restore-secrets-${ts}`);
      await fs.mkdir(secretsTempDir, { recursive: true, mode: 0o700 });
      const secretsArchive = path.join(resolvedBackupDir, BACKUP_SECRETS_FILE);
      // secrets 归档同样先校验；失败走回滚流程（不产生 data 变更）。
      await assertSafeArchive(secretsArchive, { targetDir: secretsTempDir });
      runTar(['-xzf', secretsArchive, '-C', secretsTempDir]);
      await verifyExtractedTree(secretsTempDir);
      restoredKeyPath = await findFirstFile(secretsTempDir);
      if (!restoredKeyPath) throw new Error('secrets.tar.gz 内没有密钥文件');
    }

    // 4) 现有数据转存 → staging 接管 data-dir。
    await fs.mkdir(path.dirname(resolvedDataDir), { recursive: true });
    if (nonEmpty || (await pathExists(resolvedDataDir))) {
      await fs.rename(resolvedDataDir, preRestoreDir);
      movedCurrent = true;
    }
    await fs.mkdir(path.dirname(resolvedDataDir), { recursive: true });
    await fs.rename(stagingDir, resolvedDataDir);
    stagingCreated = false;

    // 5) 恢复 key 文件（0600；先写临时文件再 rename，避免半写）。
    let keyRestored = false;
    if (restoredKeyPath && keyFile) {
      const resolvedKeyFile = path.resolve(keyFile);
      await fs.mkdir(path.dirname(resolvedKeyFile), { recursive: true, mode: 0o700 });
      const tmpKeyPath = `${resolvedKeyFile}.restore-${ts}`;
      await fs.copyFile(restoredKeyPath, tmpKeyPath);
      await fs.chmod(tmpKeyPath, 0o600);
      await fs.rename(tmpKeyPath, resolvedKeyFile);
      keyRestored = true;
    }

    return {
      ok: true,
      backupDir: resolvedBackupDir,
      dataDir: resolvedDataDir,
      stagingDir,
      preRestoreDir: movedCurrent ? preRestoreDir : null,
      keyFileIncluded: hasSecrets,
      keyRestored,
      keyFile: keyFile ? path.resolve(keyFile) : null,
      entries: entryNames,
    };
  } catch (error) {
    // 回滚：尽量恢复到操作前状态（绝不让用户数据停留在半恢复）。
    try {
      if (stagingCreated && (await pathExists(stagingDir))) {
        await fs.rm(stagingDir, { recursive: true, force: true });
      }
      if (movedCurrent) {
        if (await pathExists(resolvedDataDir)) {
          // data-dir 已被 staging 替换：先移除新数据，再把旧数据挪回。
          await fs.rm(resolvedDataDir, { recursive: true, force: true });
        }
        if (await pathExists(preRestoreDir)) {
          await fs.rename(preRestoreDir, resolvedDataDir);
        }
      }
    } catch (rollbackError) {
      logger?.error?.(
        `[restore] 回滚失败，请人工检查：dataDir=${resolvedDataDir} preRestore=${preRestoreDir} err=${rollbackError?.message ?? rollbackError}`,
      );
    }
    throw error;
  } finally {
    if (secretsTempDir) {
      try {
        await fs.rm(secretsTempDir, { recursive: true, force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
}

export const RESTORE_USAGE = `用法：node scripts/restore-data.mjs --backup PATH --data-dir DIR [--key-file FILE] [--force] [--dry-run]

选项：
  --backup PATH     backup-data.mjs 生成的备份目录（含 SHA256SUMS）
  --data-dir DIR    恢复到哪个数据目录
  --key-file FILE   同时恢复密钥文件（备份内含 secrets.tar.gz 时），写入后权限 0600
  --force           数据目录非空时确认覆盖（旧数据转存为 <data-dir>.pre-restore-<ts>）
  --dry-run         只校验并打印计划，不改动任何文件
  -h, --help        显示本帮助`;

/** CLI 入口。 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(RESTORE_USAGE);
    return 0;
  }
  if (!options.backupDir) throw new Error('缺少 --backup PATH');
  if (!options.dataDir) throw new Error('缺少 --data-dir DIR');
  const result = await createRestore({
    backupDir: options.backupDir,
    dataDir: options.dataDir,
    keyFile: options.keyFile,
    force: options.force,
    dryRun: options.dryRun,
    logger: console,
  });
  console.log(JSON.stringify(result));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[restore] 失败：${error?.message ?? error}`);
      process.exitCode = 1;
    });
}
