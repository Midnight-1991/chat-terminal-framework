// / docs/briefs/m45-interface-contract.md 2.2：恢复演练（restore drill）。
//
// 语义：取最新备份 → SHA256 校验 → 在 mkdtemp 沙盒里真实恢复（含 data.key）→ 校验
//   ① 恢复出的数据非空、文件数不超上限；
//   ② 明文 JSON 可解析（users.json 必须存在；sessions/invites/feedback/audit 存在则校验）；
//   ③ 所有 CTFENC001 密文都能用「恢复出的密钥 + 对应 AAD」解密（0 失败）：
//        - 全局根文件 / 根 conversations/attachments：KEK，AAD=相对 DATA_DIR 的 posix 路径；
//        - users/<uid>/<file>（除 byok.secret.enc）：用户 DEK（users/<uid>/.dek，KEK 包裹），
//          AAD=相对用户目录的 posix 路径；无 .dek（旧 v1 单密钥）回退 KEK + 同一 AAD；
//        - users/<uid>/byok.secret.enc：KEK，AAD=`byok:v1:<uid>`（ 24）。
//   → 报告写到 <备份根>/drills/restore-drill-<ts>.json（0700/0600）→ 默认清理沙盒。
//
// 安全约束：只写 workDir 与报告目录，绝不触碰生产 DATA_DIR；不打印/落盘明文密钥；
// 数据文件只读；无第三方依赖；不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  decodePayload,
  isEncryptedBuffer,
  readEncryptionKeyFile,
} from '../server/at-rest.mjs';
import { ENVELOPE_DEK_FILE_NAME, unwrapDek } from '../server/envelope.mjs';
import {
  BACKUP_DATA_FILE,
  BACKUP_DIR_PATTERN,
  BACKUP_MANIFEST_FILE,
  BACKUP_SECRETS_FILE,
  formatTimestamp,
} from './backup-data.mjs';
import { createRestore, verifyBackup } from './restore-data.mjs';

/** 报告文件名前缀（契约 2.2 冻结）。 */
export const DRILL_REPORT_PREFIX = 'restore-drill-';
/** 必须存在且可 JSON.parse 的明文数据文件（契约 2.2 冻结）。 */
export const DRILL_REQUIRED_PLAIN_FILES = ['users.json'];
/** 扫描文件数上限（防异常数据目录把演练跑成无限循环）。 */
export const DRILL_MAX_FILES_SCAN = 200_000;
/** 工具名/版本（写进报告，供测试断言）。 */
export const DRILL_TOOL_NAME = 'drill-restore';
export const DRILL_VERSION = 'm45';
/** 演练错误码（main 据此打印，测试据此断言）。 */
export const DRILL_ERROR_CODES = Object.freeze({
  NO_BACKUP: 'DRILL_NO_BACKUP',
  SHA_FAILED: 'DRILL_SHA_FAILED',
});

/** 已知的「全局顺层 / 用户层」数据文件名（ 11.1 + 信封加密）。 */
const DRILL_KNOWN_DATA_FILES = [
  'index.json',
  'health.json',
  'memories.json',
  'marks.json',
  'scales-history.json',
];
/** 存在则解析的明文 JSON 文件（契约 2.2）。 */
const DRILL_OPTIONAL_PLAIN_JSON_FILES = ['sessions.json', 'invites.json', 'feedback.json'];
/** 存在则逐行解析的 JSONL 文件（契约 2.2）。 */
const DRILL_PLAIN_JSONL_FILES = ['audit.jsonl'];
/** 密文解密抽样报告里最多保留的样本数。 */
const DRILL_DECRYPT_SAMPLE_LIMIT = 20;
/** 默认备份根（与 backup-data.mjs 的 outDir 默认值保持一致）。 */
const DEFAULT_BACKUP_DIR = '/var/backups/ctf';

const DRILL_USAGE = `用法: node scripts/drill-restore.mjs [选项]

从最新备份做一次隔离恢复演练（不触碰生产 DATA_DIR）。

选项:
  --backup PATH        指定某个备份目录（默认取 --backup-dir 下最新）
  --backup-dir DIR     备份根目录（默认 $BACKUP_DIR 或 ${DEFAULT_BACKUP_DIR}）
  --work-dir DIR       演练沙盒目录（默认 mkdtemp）
  --report-dir DIR     报告输出目录（默认 <备份根>/drills/）
  --keep               保留演练沙盒（默认清理）
  --json               机器可读输出（同为单行 JSON）
  -h, --help           显示本帮助`;

/* --------------------------------- 错误类型 --------------------------------- */

/** 带 code 的演练错误（main 统一打印 code + message，便于测试 grep）。 */
export function drillError(code, message, options = {}) {
  const error = new Error(message, options.cause !== undefined ? { cause: options.cause } : undefined);
  error.name = 'DrillRestoreError';
  error.code = code;
  return error;
}

/* --------------------------------- 参数解析 --------------------------------- */

/** 解析 CLI 参数（未知参数直接报错，不静默忽略）。 */
export function parseArgs(argv = []) {
  const options = {
    backup: null,
    backupDir: null,
    workDir: null,
    reportDir: null,
    keep: false,
    json: false,
    help: false,
  };
  const needValue = (index, flag) => {
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('-')) {
      throw new Error(`${flag} 需要参数值`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--backup':
        options.backup = needValue(index, arg);
        index += 1;
        break;
      case '--backup-dir':
        options.backupDir = needValue(index, arg);
        index += 1;
        break;
      case '--work-dir':
        options.workDir = needValue(index, arg);
        index += 1;
        break;
      case '--report-dir':
        options.reportDir = needValue(index, arg);
        index += 1;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

/* ---------------------------------- 工具函数 --------------------------------- */

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function isRegularFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function pathExists(target) {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在一个目录（备份根）里找最新的一个「YYYYMMDD-HHmmss」备份目录。
 * 返回 null 表示没有可用备份，绝不抛 ENOENT。
 */
export async function findLatestBackup(backupDir) {
  if (typeof backupDir !== 'string' || backupDir === '') return null;
  const resolved = path.resolve(backupDir);
  let entries;
  try {
    entries = await fs.promises.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && BACKUP_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) return null;
  const ts = names[names.length - 1];
  return { path: path.join(resolved, ts), ts };
}

/** 把 --backup（具体备份目录）或 --backup-dir（备份根）解析成具体备份目录。 */
async function resolveBackupDir(backupDir) {
  if (!backupDir) {
    const latest = await findLatestBackup(process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR);
    return latest ? latest.path : null;
  }
  const resolved = path.resolve(backupDir);
  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  if (BACKUP_DIR_PATTERN.test(path.basename(resolved)) || (await pathExists(path.join(resolved, BACKUP_DATA_FILE)))) {
    return resolved;
  }
  const latest = await findLatestBackup(resolved);
  return latest ? latest.path : null;
}

/**
 * 递归扫描数据目录（跳过 '.' 前缀目录与 '*.tmp' 临时文件，不跟随符号链接）。
 * 返回 {files:[{filePath,rel}], truncated:boolean, symlinks:string[]}。
 */
async function scanDataDir(rootDir) {
  const files = [];
  const symlinks = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    if (files.length > DRILL_MAX_FILES_SCAN) break;
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(child);
        continue;
      }
      if (entry.isDirectory()) {
        if (current === rootDir && entry.name.startsWith('.')) continue; // 迁移备份等隐藏目录不参与演练
        stack.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.tmp')) continue;
      files.push({ filePath: child, rel: toPosix(path.relative(rootDir, child)) });
      if (files.length > DRILL_MAX_FILES_SCAN) break;
    }
  }
  return {
    files,
    truncated: files.length > DRILL_MAX_FILES_SCAN,
    symlinks,
  };
}

/** 读取恢复出的 KEK（data.key）；缺失/权限异常不抛，交给上层计入 failures。 */
async function readDrillKey(keyFile, failures) {
  if (!(await isRegularFile(keyFile))) {
    return null;
  }
  try {
    return readEncryptionKeyFile(keyFile);
  } catch (error) {
    failures.push({
      kind: 'key',
      file: path.basename(keyFile),
      reason: `恢复密钥不可用：${error?.message ?? error}`,
    });
    return null;
  }
}

/** 用户 DEK 缓存（每个 uid 只解一次 .dek；失败缓存 null 避免重复刷错误）。 */
function createUserDekResolver({ dataDir, kek, failures }) {
  const cache = new Map();
  return function resolveUserDek(uid) {
    if (cache.has(uid)) return cache.get(uid);
    if (!kek) {
      cache.set(uid, null);
      return null;
    }
    const dekPath = path.join(dataDir, 'users', uid, ENVELOPE_DEK_FILE_NAME);
    let raw;
    try {
      raw = fs.readFileSync(dekPath);
    } catch (error) {
      // 没有 .dek 是旧 v1 单密钥数据的正常形态（由调用方回退 KEK），不记失败。
      if (error?.code === 'ENOENT') {
        cache.set(uid, null);
        return null;
      }
      failures.push({
        kind: 'dek',
        file: toPosix(path.relative(dataDir, dekPath)),
        reason: `用户 DEK 读取失败：${error?.code ?? error?.message ?? error}`,
      });
      cache.set(uid, null);
      return null;
    }
    let dek = null;
    try {
      dek = unwrapDek(kek, uid, raw);
    } catch (error) {
      failures.push({
        kind: 'dek',
        file: toPosix(path.relative(dataDir, dekPath)),
        reason: `用户 DEK 解包失败：${error?.code ?? error?.message ?? error}`,
      });
      dek = null;
    }
    cache.set(uid, dek);
    return dek;
  };
}

/**
 * 按路径决定「解密用密钥 + AAD」（ 11.1 /  24）。
 * 返回 {key, aad, source} 或 {error}。
 */
function resolveDecryptMaterial(rel, { kek, resolveUserDek }) {
  const segments = rel.split('/');
  if (segments[0] === 'users' && segments.length >= 3) {
    const uid = segments[1];
    const fileRel = segments.slice(2).join('/');
    if (fileRel === ENVELOPE_DEK_FILE_NAME) {
      // .dek 是 KEK 包裹的密钥信封，不是数据密文；无需解密（其自身解密由 resolveUserDek 完成）。
      return { skipped: true, reason: 'DEK 信封文件' };
    }
    if (fileRel === 'byok.secret.enc') {
      if (!kek) return { error: '缺少恢复密钥' };
      return { key: kek, aad: `byok:v1:${uid}`, source: 'kek' };
    }
    const dek = resolveUserDek(uid);
    if (dek) return { key: dek, aad: fileRel, source: 'dek' };
    if (!kek) return { error: '缺少恢复密钥' };
    // 旧 v1 单密钥密文：AAD 同样是「相对用户目录路径」。
    return { key: kek, aad: fileRel, source: 'kek-legacy' };
  }
  if (!kek) return { error: '缺少恢复密钥' };
  return { key: kek, aad: rel, source: 'kek' };
}

/** 明文 JSON 校验（users.json 必须存在且可解析；其它存在则校验）。 */
async function validatePlainJsonFiles(dataDir, failures) {
  for (const name of DRILL_REQUIRED_PLAIN_FILES) {
    const filePath = path.join(dataDir, name);
    if (!(await isRegularFile(filePath))) {
      failures.push({ kind: 'json', file: name, reason: '缺少必需的明文 JSON 文件' });
      continue;
    }
    try {
      const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') {
        failures.push({ kind: 'json', file: name, reason: 'JSON 顶层不是对象/数组' });
      } else if (!Array.isArray(parsed) && parsed.users !== undefined && !Array.isArray(parsed.users)) {
        failures.push({ kind: 'json', file: name, reason: 'users 字段不是数组' });
      }
    } catch (error) {
      failures.push({ kind: 'json', file: name, reason: `JSON 解析失败：${error?.message ?? error}` });
    }
  }
  for (const name of DRILL_OPTIONAL_PLAIN_JSON_FILES) {
    const filePath = path.join(dataDir, name);
    if (!(await isRegularFile(filePath))) continue;
    try {
      JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch (error) {
      failures.push({ kind: 'json', file: name, reason: `JSON 解析失败：${error?.message ?? error}` });
    }
  }
  for (const name of DRILL_PLAIN_JSONL_FILES) {
    const filePath = path.join(dataDir, name);
    if (!(await isRegularFile(filePath))) continue;
    try {
      const lines = (await fs.promises.readFile(filePath, 'utf8')).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line === '') continue;
        try {
          JSON.parse(line);
        } catch {
          failures.push({ kind: 'jsonl', file: name, reason: `第 ${index + 1} 行不是合法 JSON` });
          break;
        }
      }
    } catch (error) {
      failures.push({ kind: 'jsonl', file: name, reason: `读取失败：${error?.message ?? error}` });
    }
  }
}

/** 逐文件做密文识别 + 解密（任何失败都进 failures，ok 由 failures 汇总）。 */
async function validateEncryptedFiles({ files, dataDir, kek, failures }) {
  const resolveUserDek = createUserDekResolver({ dataDir, kek, failures });
  const stats = { total: files.length, plain: 0, json: 0, encrypted: 0, decrypted: 0, failed: 0 };
  const decrypt = { attempted: 0, ok: 0, failed: 0, samples: [] };
  for (const { filePath, rel } of files) {
    const isJson = rel.endsWith('.json');
    if (isJson) stats.json += 1;
    let head;
    try {
      head = await readHead(filePath, 16);
    } catch (error) {
      stats.failed += 1;
      failures.push({ kind: 'read', file: rel, reason: `读取失败：${error?.message ?? error}` });
      continue;
    }
    if (!isEncryptedBuffer(head)) {
      stats.plain += 1;
      continue;
    }
    stats.encrypted += 1;
    const material = resolveDecryptMaterial(rel, { kek, resolveUserDek });
    if (material.skipped) continue;
    if (material.error) {
      stats.failed += 1;
      decrypt.attempted += 1;
      decrypt.failed += 1;
      failures.push({ kind: 'decrypt', file: rel, reason: material.error });
      appendSample(decrypt.samples, rel, false);
      continue;
    }
    decrypt.attempted += 1;
    try {
      const buffer = await fs.promises.readFile(filePath);
      decodePayload(material.key, material.aad, buffer);
      stats.decrypted += 1;
      decrypt.ok += 1;
      appendSample(decrypt.samples, rel, true);
    } catch (error) {
      stats.failed += 1;
      decrypt.failed += 1;
      failures.push({
        kind: 'decrypt',
        file: rel,
        reason: `解密失败（source=${material.source}）：${error?.code ?? error?.message ?? error}`,
      });
      appendSample(decrypt.samples, rel, false);
    }
  }
  return { stats, decrypt };
}

function appendSample(samples, file, ok) {
  if (samples.length >= DRILL_DECRYPT_SAMPLE_LIMIT) return;
  samples.push({ file, ok });
}

async function readHead(filePath, byteLength) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/* -------------------------------- 演练主流程 -------------------------------- */

/**
 * 执行一次恢复演练（隔离沙盒；不触碰生产 DATA_DIR）。
 * @param {{backupDir?:string|null, workDir?:string|null, reportDir?:string|null,
 *   keep?:boolean, keyFileName?:string, logger?:object, now?:() => Date}} [options]
 */
export async function runRestoreDrill({
  backupDir = null,
  workDir = null,
  reportDir = null,
  keep = false,
  keyFileName = 'data.key',
  logger = console,
  now = () => new Date(),
} = {}) {
  const startedAt = now();
  const startedMs = Date.now();
  const failures = [];

  // 1) 定位并校验备份（SHA256 不通过则直接失败：不产生任何恢复动作）。
  const resolvedBackup = await resolveBackupDir(backupDir);
  if (!resolvedBackup) {
    throw drillError(
      DRILL_ERROR_CODES.NO_BACKUP,
      backupDir ? `未找到可用的备份：${backupDir}` : `未找到可用的最新备份（${process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR}）`,
    );
  }
  let checksums;
  try {
    checksums = await verifyBackup(resolvedBackup);
  } catch (error) {
    throw drillError(
      DRILL_ERROR_CODES.SHA_FAILED,
      `备份 SHA256 校验失败：${error?.message ?? error}`,
      { cause: error },
    );
  }
  const entryNames = checksums.map((entry) => entry.path);
  if (!entryNames.includes(BACKUP_DATA_FILE)) {
    throw drillError(DRILL_ERROR_CODES.SHA_FAILED, `备份缺少 ${BACKUP_DATA_FILE}，无法演练`);
  }
  const hasSecrets = entryNames.includes(BACKUP_SECRETS_FILE);

  // manifest 可选：损坏只记一条失败，不阻断（报告里带原始元数据便于比对）。
  let manifest = null;
  try {
    manifest = JSON.parse(
      await fs.promises.readFile(path.join(resolvedBackup, BACKUP_MANIFEST_FILE), 'utf8'),
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      failures.push({ kind: 'manifest', file: BACKUP_MANIFEST_FILE, reason: error?.message ?? String(error) });
    }
  }

  // 2) 隔离沙盒 + 真实恢复（key 也恢复到沙盒内）。
  const resolvedWorkDir = workDir
    ? path.resolve(workDir)
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'Chat Terminal-drill-'));
  await fs.promises.mkdir(resolvedWorkDir, { recursive: true, mode: 0o700 });
  const dataDir = path.join(resolvedWorkDir, 'data');
  const keyFile = path.join(resolvedWorkDir, keyFileName);
  let restoreResult = null;
  try {
    restoreResult = await createRestore({
      backupDir: resolvedBackup,
      dataDir,
      keyFile: hasSecrets ? keyFile : null,
      force: true,
      logger,
      now,
    });
  } catch (error) {
    failures.push({ kind: 'restore', reason: error?.message ?? String(error) });
  }

  // 3) 校验恢复结果：文件扫描 + 明文 JSON + 密文全量解密。
  let stats = { total: 0, plain: 0, json: 0, encrypted: 0, decrypted: 0, failed: 0 };
  let decrypt = { attempted: 0, ok: 0, failed: 0, samples: [] };
  if (restoreResult?.ok) {
    const scan = await scanDataDir(dataDir);
    if (scan.truncated) {
      failures.push({
        kind: 'scan',
        reason: `数据文件数超过上限 ${DRILL_MAX_FILES_SCAN}，演练中止`,
      });
    }
    if (scan.files.length === 0) {
      failures.push({ kind: 'restore', reason: '恢复出的数据目录为空' });
    }
    for (const symlink of scan.symlinks) {
      failures.push({ kind: 'scan', file: toPosix(path.relative(dataDir, symlink)), reason: '数据目录包含符号链接' });
    }
    await validatePlainJsonFiles(dataDir, failures);
    const kek = await readDrillKey(keyFile, failures);
    const inspected = await validateEncryptedFiles({
      files: scan.files,
      dataDir,
      kek,
      failures,
    });
    stats = inspected.stats;
    decrypt = inspected.decrypt;
  }

  // 4) 报告落盘（默认 <备份根>/drills/，0700 目录 / 0600 文件）。
  const resolvedReportDir = path.resolve(
    reportDir || path.join(path.dirname(resolvedBackup), 'drills'),
  );
  const finishedAt = now();
  const result = {
    ok: failures.length === 0 && stats.failed === 0,
    tool: DRILL_TOOL_NAME,
    version: DRILL_VERSION,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, Date.now() - startedMs),
    backupDir: resolvedBackup,
    workDir: resolvedWorkDir,
    shaVerified: true,
    manifest,
    files: stats,
    decrypt,
    failures,
  };
  await fs.promises.mkdir(resolvedReportDir, { recursive: true, mode: 0o700 });
  const reportPath = path.join(
    resolvedReportDir,
    `${DRILL_REPORT_PREFIX}${formatTimestamp(finishedAt)}.json`,
  );
  await fs.promises.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.promises.chmod(resolvedReportDir, 0o700);
    await fs.promises.chmod(reportPath, 0o600);
  } catch {
    /* 非 POSIX 时忽略 */
  }
  result.reportPath = reportPath;

  // 5) 清理沙盒（报告目录若恰好位于沙盒内则保留，避免把证据一起删掉）。
  const reportInsideWorkDir =
    reportPath === resolvedWorkDir || reportPath.startsWith(`${resolvedWorkDir}${path.sep}`);
  if (!keep && !reportInsideWorkDir) {
    try {
      await fs.promises.rm(resolvedWorkDir, { recursive: true, force: true });
      result.workDirCleaned = true;
    } catch (error) {
      result.workDirCleaned = false;
      logger?.warn?.(`[drill] 沙盒清理失败（可手工删除）：${resolvedWorkDir} err=${error?.message ?? error}`);
    }
  } else {
    result.workDirCleaned = false;
  }
  return result;
}

/* ----------------------------------- CLI ----------------------------------- */

/** CLI 入口：返回进程退出码（0=演练成功且报告落盘，1=失败）。 */
export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[drill] 参数错误：${error?.message ?? error}`);
    return 1;
  }
  if (options.help) {
    console.log(DRILL_USAGE);
    return 0;
  }
  try {
    const result = await runRestoreDrill({
      backupDir: options.backup ?? options.backupDir,
      workDir: options.workDir,
      reportDir: options.reportDir,
      keep: options.keep,
    });
    console.log(
      JSON.stringify({
        ok: result.ok,
        tool: result.tool,
        version: result.version,
        backupDir: result.backupDir,
        reportPath: result.reportPath,
        shaVerified: result.shaVerified,
        files: result.files,
        decrypt: {
          attempted: result.decrypt.attempted,
          ok: result.decrypt.ok,
          failed: result.decrypt.failed,
        },
        failures: result.failures,
        durationMs: result.durationMs,
      }),
    );
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(
      `[drill] 失败：${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`,
    );
    return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  process.argv[1] !== '' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[drill] 失败：${error?.message ?? error}`);
      process.exitCode = 1;
    });
}
