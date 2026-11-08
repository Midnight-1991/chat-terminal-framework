#!/usr/bin/env node
// overlay 通用版（docs/open-source/templates/oss-overlay）：
// 与仓库 scripts/backup-data.mjs 的唯一差异：默认备份目录改为仓库内 ./backups（去掉生产主机路径特征）。
// 其余逻辑逐字保留（MIT/Apache-2.0 开源框架通用运维脚本）。
//  /  / 契约 2：DATA_DIR 备份脚本（零第三方依赖，调用系统 tar）。
//
// 用法：
//   node scripts/backup-data.mjs [--data-dir DIR] [--out DIR] [--key-file FILE] [--keep N] [--dry-run]
//
// 产物：<out>/<YYYYMMDD-HHmmss>/
//   data.tar.gz     DATA_DIR 整体
//   secrets.tar.gz  仅 key-file（存在时；0600，文件扁平化为原 basename）
//   manifest.json   {ts,versionFromPackage,dataDir,files:[{path,sha256,bytes}],keyFileIncluded}
//   SHA256SUMS      上述产物的 sha256 清单（sha256sum -c 可校验）
//
// stdout 单行 JSON 摘要；dry-run 只打印计划、不产生任何文件。轮转只删 <out> 下形如 YYYYMMDD-HHmmss 的旧目录。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 备份目录名（本地时区）：YYYYMMDD-HHmmss。 */
export const BACKUP_DIR_PATTERN = /^\d{8}-\d{6}$/;

export const DEFAULT_KEEP = 7;
export const BACKUP_DATA_FILE = 'data.tar.gz';
export const BACKUP_SECRETS_FILE = 'secrets.tar.gz';
export const BACKUP_MANIFEST_FILE = 'manifest.json';
export const BACKUP_SUMS_FILE = 'SHA256SUMS';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 生成 <YYYYMMDD-HHmmss>（本地时区，与运维习惯一致）。 */
export function formatTimestamp(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  return (
    `${value.getFullYear()}${pad2(value.getMonth() + 1)}${pad2(value.getDate())}` +
    `-${pad2(value.getHours())}${pad2(value.getMinutes())}${pad2(value.getSeconds())}`
  );
}

/** 解析 CLI 参数；未知参数抛错（由 main 统一打印 exit 1）。 */
export function parseArgs(argv = []) {
  const options = {
    dataDir: null,
    outDir: null,
    keyFile: null,
    keep: DEFAULT_KEEP,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--data-dir' || arg === '--out' || arg === '--key-file' || arg === '--keep') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`参数 ${arg} 需要一个值`);
      }
      index += 1;
      if (arg === '--data-dir') options.dataDir = value;
      else if (arg === '--out') options.outDir = value;
      else if (arg === '--key-file') options.keyFile = value;
      else {
        const keep = Number(value);
        if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep 必须是 ≥1 的整数');
        options.keep = keep;
      }
      continue;
    }
    throw new Error(`未知参数：${arg}（--help 查看用法）`);
  }
  return options;
}

/** 读取 package.json 的 version（读不到时返回 'unknown'，不阻塞备份）。 */
export async function readPackageVersion(rootDir = REPO_ROOT) {
  try {
    const text = await fs.readFile(path.join(rootDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(text);
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 流式计算文件 sha256（大 data.tar.gz 也不占内存）。 */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fileSize(filePath) {
  const stat = await fs.stat(filePath);
  return stat.size;
}

function runTar(args) {
  execFileSync('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 列出 <outDir> 下形如 YYYYMMDD-HHmmss 的目录（新到旧）。 */
async function listBackupDirs(outDir) {
  let entries;
  try {
    entries = await fs.readdir(outDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && BACKUP_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/**
 * 执行一次备份。
 * @param {{dataDir:string, outDir?:string, keyFile?:string|null, keep?:number, dryRun?:boolean,
 *   logger?:object, now?:() => Date, repoRoot?:string}} options
 */
export async function createBackup({
  dataDir,
  outDir = null,
  keyFile = null,
  keep = DEFAULT_KEEP,
  dryRun = false,
  logger = console,
  now = () => new Date(),
  repoRoot = REPO_ROOT,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new Error('缺少 --data-dir（或 BACKUP_DATA_DIR 默认值）');
  }
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedOutDir = path.resolve(outDir ?? process.env.BACKUP_DIR ?? './backups');
  const normalizedKeep =
    Number.isInteger(keep) && keep >= 1 ? keep : DEFAULT_KEEP;
  const versionFromPackage = await readPackageVersion(repoRoot);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      ts: formatTimestamp(now()),
      backupDir: null,
      outDir: resolvedOutDir,
      dataDir: resolvedDataDir,
      versionFromPackage,
      keep: normalizedKeep,
      keyFileIncluded: Boolean(keyFile),
    };
  }

  let stat;
  try {
    stat = await fs.stat(resolvedDataDir);
  } catch {
    throw new Error(`数据目录不存在：${resolvedDataDir}`);
  }
  if (!stat.isDirectory()) throw new Error(`数据目录不是目录：${resolvedDataDir}`);
  if (keyFile) {
    try {
      const keyStat = await fs.stat(path.resolve(keyFile));
      if (!keyStat.isFile()) throw new Error();
    } catch {
      throw new Error(`key 文件不存在或不是文件：${path.resolve(keyFile)}`);
    }
  }

  const ts = formatTimestamp(now());
  const backupDir = path.join(resolvedOutDir, ts);
  await fs.mkdir(resolvedOutDir, { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(backupDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`备份目录已存在（同一秒重复执行？）：${backupDir}`);
    throw error;
  }

  const artifacts = [];
  const dataArchive = path.join(backupDir, BACKUP_DATA_FILE);
  runTar(['-czf', dataArchive, '-C', resolvedDataDir, '.']);
  try {
    await fs.chmod(dataArchive, 0o600);
  } catch {
    /* 非 POSIX 忽略 */
  }
  artifacts.push(BACKUP_DATA_FILE);

  let keyFileIncluded = false;
  if (keyFile) {
    const resolvedKeyFile = path.resolve(keyFile);
    const secretsArchive = path.join(backupDir, BACKUP_SECRETS_FILE);
    runTar([
      '-czf',
      secretsArchive,
      '-C',
      path.dirname(resolvedKeyFile),
      path.basename(resolvedKeyFile),
    ]);
    try {
      await fs.chmod(secretsArchive, 0o600);
    } catch {
      /* 非 POSIX 忽略 */
    }
    artifacts.push(BACKUP_SECRETS_FILE);
    keyFileIncluded = true;
  }

  const files = [];
  for (const name of artifacts) {
    const filePath = path.join(backupDir, name);
    files.push({ path: name, sha256: await sha256File(filePath), bytes: await fileSize(filePath) });
  }

  const manifest = {
    ts,
    versionFromPackage,
    dataDir: resolvedDataDir,
    files,
    keyFileIncluded,
  };
  const manifestPath = path.join(backupDir, BACKUP_MANIFEST_FILE);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const sumsEntries = [...files, { path: BACKUP_MANIFEST_FILE, sha256: await sha256File(manifestPath) }];
  const sumsContent = sumsEntries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
  const sumsPath = path.join(backupDir, BACKUP_SUMS_FILE);
  await fs.writeFile(sumsPath, sumsContent, { mode: 0o600 });

  // 轮转：只删形如 YYYYMMDD-HHmmss 的旧目录，保留最近 keep 份（本次备份必保留）。
  const allDirs = await listBackupDirs(resolvedOutDir);
  const rotated = allDirs.slice(normalizedKeep);
  for (const name of rotated) {
    try {
      await fs.rm(path.join(resolvedOutDir, name), { recursive: true, force: true });
    } catch (error) {
      logger?.warn?.(`[backup] 轮转删除失败（已忽略）dir=${name} err=${error?.message ?? error}`);
    }
  }

  return {
    ok: true,
    ts,
    backupDir,
    outDir: resolvedOutDir,
    dataDir: resolvedDataDir,
    versionFromPackage,
    files: [...files, { path: BACKUP_MANIFEST_FILE }],
    keyFileIncluded,
    keep: normalizedKeep,
    rotated,
  };
}

export const BACKUP_USAGE = `用法：node scripts/backup-data.mjs [--data-dir DIR] [--out DIR] [--key-file FILE] [--keep N] [--dry-run]

选项：
  --data-dir DIR   要备份的数据目录（默认 ./data）
  --out DIR        备份输出根目录（默认 env.BACKUP_DIR 或 ./backups）
  --key-file FILE  DATA_ENCRYPTION_KEY_FILE 指向的密钥文件（存在时单独打包为 secrets.tar.gz）
  --keep N         保留最近 N 份备份（默认 ${DEFAULT_KEEP}，只轮转 YYYYMMDD-HHmmss 目录）
  --dry-run        只打印计划，不创建任何文件
  -h, --help       显示本帮助`;

/** CLI 入口。 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(BACKUP_USAGE);
    return 0;
  }
  const result = await createBackup({
    dataDir: options.dataDir ?? path.join(REPO_ROOT, 'data'),
    outDir: options.outDir,
    keyFile: options.keyFile,
    keep: options.keep,
    dryRun: options.dryRun,
    logger: console,
  });
  // stdout 单行 JSON 摘要（便于运维脚本解析）。
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
      console.error(`[backup] 失败：${error?.message ?? error}`);
      process.exitCode = 1;
    });
}
