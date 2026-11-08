#!/usr/bin/env node
// DATA_DIR 静态数据密钥轮换（旧 key 解密 → 新 key 加密全部文件）。
//
// 用法：
//   node scripts/rotate-data-key.mjs --data-dir ./data \
//     --old-key-file /etc/ctf/data.key --new-key-file /etc/ctf/data-new.key [--dry-run]
//
// 行为：
//   1) 第一遍：用旧 key 全部解密校验（错误 key / 损坏 / 搬运 → 报错退出，不改写任何文件）；
//   2) 第二遍：用新 key 原地重加密（tmp+rename 原子替换，文件 0600），随后逐文件回读校验。
//   明文文件也会被加密（相当于顺带迁移）；--dry-run 只统计，不写盘。
//   轮换完成后请把服务端密钥切换为新 key（env/key file），再重启服务。
//
// 退出码：0 = 成功/演练成功；1 = 运行错误；2 = 参数错误。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AT_REST_MAGIC,
  createAtRest,
  decodeKeyBase64,
  decodePayload,
  encodePayload,
  isEncryptedBuffer,
  listDataFiles,
  readEncryptionKeyFile,
  userDataDirFor,
} from '../server/at-rest.mjs';
import { ENVELOPE_DEK_FILE_NAME, unwrapDek, wrapDek, writeFileAtomic } from '../server/envelope.mjs';
import { BYOK_SECRET_AAD_PREFIX, BYOK_SECRET_ENC_FILE_NAME } from '../server/byok.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_PREFIX = '[rotate-data-key]';

export function usage() {
  return `用法：node scripts/rotate-data-key.mjs [选项]

选项：
  --data-dir <dir>        DATA_DIR 目录（默认 ./data；相对路径按仓库根解析）
  --old-key-file <file>   旧密钥文件（600；省略时读 DATA_ENCRYPTION_KEY_FILE / DATA_ENCRYPTION_KEY）
  --new-key-file <file>   新密钥文件（600，必填）
  --envelope              同时 rewrap 每用户 DEK（信封加密 KEK→DEK；需先启用 AT_REST_ENVELOPE=on 完成迁移；用户数据文件不重写）
  --dry-run               只校验并统计，不写盘
  -h, --help              显示帮助
`;
}

/**
 * 解析命令行参数。
 * @param {string[]} argv
 * @returns {{dataDir:string, oldKeyFile:string|null, newKeyFile:string|null, dryRun:boolean, envelope:boolean, help:boolean}}
 */
export function parseArgs(argv = []) {
  const options = {
    dataDir: path.join(ROOT, 'data'),
    oldKeyFile: null,
    newKeyFile: null,
    dryRun: false,
    envelope: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`参数 ${arg} 缺少值`);
      return argv[index];
    };
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--envelope') options.envelope = true;
    else if (arg === '--data-dir') options.dataDir = next();
    else if (arg === '--old-key-file') options.oldKeyFile = next();
    else if (arg === '--new-key-file') options.newKeyFile = next();
    else throw new Error(`未知参数：${arg}`);
  }
  options.dataDir = path.isAbsolute(options.dataDir)
    ? options.dataDir
    : path.resolve(ROOT, options.dataDir);
  return options;
}

/** 解析旧 key（--old-key-file 优先，其次进程环境变量）。 */
export function resolveOldKey(options, env = process.env) {
  if (options.oldKeyFile) return readEncryptionKeyFile(options.oldKeyFile);
  const keyFile = typeof env.DATA_ENCRYPTION_KEY_FILE === 'string' ? env.DATA_ENCRYPTION_KEY_FILE.trim() : '';
  if (keyFile) return readEncryptionKeyFile(keyFile);
  const rawKey = typeof env.DATA_ENCRYPTION_KEY === 'string' ? env.DATA_ENCRYPTION_KEY.trim() : '';
  if (rawKey) return decodeKeyBase64(rawKey, 'DATA_ENCRYPTION_KEY');
  throw new Error('缺少旧密钥：请传 --old-key-file，或设置 DATA_ENCRYPTION_KEY_FILE / DATA_ENCRYPTION_KEY');
}

/**
 * 列出 users/<uid>/byok.secret.enc：该文件用 `byok:v1:<uid>` 作为 AAD，
 * 不能走按文件路径 AAD 的通用 listDataFiles，必须单独轮换（DATA 26.8）。
 * @param {string} rootDir
 * @returns {Array<{filePath:string, aad:string}>}
 */
export function listByokSecretFiles(rootDir) {
  const usersDir = path.join(path.resolve(rootDir), 'users');
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
    const filePath = path.join(usersDir, entry.name, BYOK_SECRET_ENC_FILE_NAME);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      files.push({ filePath, aad: `${BYOK_SECRET_AAD_PREFIX}${entry.name}` });
    }
  }
  return files;
}

/**
 * 列出 users/<uid>/.dek（信封加密）：DEK 用 KEK + AAD `dek:v1:<uid>` 包裹，
 * 轮换时只需 rewrap DEK（不重写用户数据文件），见  / 契约 6。
 * @param {string} rootDir
 * @returns {Array<{userId:string, dekPath:string}>}
 */
export function listUserDekFiles(rootDir) {
  const usersDir = path.join(path.resolve(rootDir), 'users');
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
    const dekPath = path.join(usersDir, entry.name, ENVELOPE_DEK_FILE_NAME);
    let stat;
    try {
      stat = fs.statSync(dekPath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isFile()) files.push({ userId: entry.name, dekPath });
  }
  return files;
}

/**
 * 只 rewrap 每用户 DEK（旧 KEK unwrap → 新 KEK wrap，原子写）；用户数据文件**不重写**（信封加密收益）。
 * 两遍走：先全部用旧 KEK 解包校验（任一失败 → 抛错、不改写任何文件），再逐个用新 KEK 包裹写入并回读校验。
 * @param {{dataDir:string, oldKey:Buffer, newKey:Buffer, dryRun?:boolean, logger?:object}} options
 * @returns {Promise<{rewrapped:number, skipped:number, failed:number}>}
 */
export async function rewrapUserDeks({ dataDir, oldKey, newKey, dryRun = false, logger = console } = {}) {
  const rootDir = path.resolve(dataDir);
  if (!Buffer.isBuffer(oldKey) || oldKey.length !== 32) throw new Error('旧密钥必须是 32 字节 Buffer');
  if (!Buffer.isBuffer(newKey) || newKey.length !== 32) throw new Error('新密钥必须是 32 字节 Buffer');
  const dekFiles = listUserDekFiles(rootDir);
  const items = [];
  let skipped = 0;
  // 用户数 - 有 .dek 的用户数 = 跳过数（无信封的用户无需 rewrap）。
  const usersDir = path.join(rootDir, 'users');
  let userEntries = [];
  try {
    userEntries = fs.readdirSync(usersDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of userEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!dekFiles.some((item) => item.userId === entry.name)) skipped += 1;
  }
  // 第一遍：旧 KEK 必须能解开每个 .dek；失败即退出（此时尚未写盘）。
  for (const item of dekFiles) {
    const raw = fs.readFileSync(item.dekPath);
    let dek;
    try {
      dek = unwrapDek(oldKey, item.userId, raw);
    } catch (error) {
      throw new Error(
        `旧密钥无法解开用户 ${item.userId} 的 DEK（密钥不匹配或 .dek 损坏，未做任何修改）：${error?.message ?? error}`,
      );
    }
    items.push({ ...item, dek });
  }
  const summary = { rewrapped: items.length, skipped, failed: 0 };
  if (dryRun) {
    logger?.log?.(
      `${LOG_PREFIX} dry-run：待 rewrap 用户 DEK ${items.length} 个（跳过 ${skipped} 个无 .dek 用户），未写盘`,
    );
    return summary;
  }
  // 第二遍：新 KEK 重包裹 + 原子写 + 回读校验。
  for (const item of items) {
    const sealed = wrapDek(newKey, item.userId, item.dek);
    writeFileAtomic(item.dekPath, sealed);
    const verify = unwrapDek(newKey, item.userId, fs.readFileSync(item.dekPath));
    if (!verify.equals(item.dek)) {
      throw new Error(`回读校验失败：用户 ${item.userId} 的 DEK 与新 KEK 解出的内容不一致`);
    }
  }
  if (items.length > 0) {
    logger?.log?.(`${LOG_PREFIX} 已 rewrap 用户 DEK ${items.length} 个（用户数据文件未重写）`);
  }
  return summary;
}

/**
 * 执行轮换（供 CLI 与测试复用；不打印密钥）。
 * @param {{dataDir:string, oldKey:Buffer, newKey:Buffer, dryRun?:boolean, envelope?:boolean, logger?:object}} options
 * @returns {Promise<{ok:true, dryRun:boolean, total:number, encrypted:number, plaintext:number, bytes:number, deksRewrapped:number}>}
 */
export async function rotateDataKey({
  dataDir,
  oldKey,
  newKey,
  dryRun = false,
  envelope = false,
  logger = console,
} = {}) {
  const rootDir = path.resolve(dataDir);
  if (!fs.existsSync(rootDir)) throw new Error(`DATA_DIR 不存在：${rootDir}`);
  const allFiles = listDataFiles(rootDir);
  const userFiles = envelope ? allFiles.filter((filePath) => userDataDirFor(rootDir, filePath) !== null) : [];
  // 信封模式的核心收益：用户数据文件由 DEK 加密、**不参与** KEK 重加密（只 rewrap DEK）。
  const files = envelope
    ? allFiles.filter((filePath) => userDataDirFor(rootDir, filePath) === null)
    : allFiles;
  if (envelope) {
    // 安全护栏：用户数据仍是旧单密钥（KEK）密文说明 DEK 迁移尚未完成；此时跳过它们会导致
    // 轮换后旧数据无法用任何新密钥解开。检测到即 fail-fast（未做任何修改），要求先启动迁移。
    const legacy = [];
    for (const filePath of userFiles) {
      const raw = fs.readFileSync(filePath);
      if (!isEncryptedBuffer(raw)) continue; // 明文/空文件由 store 后续写入时加密
      const userDir = userDataDirFor(rootDir, filePath);
      const aad = path.relative(userDir, filePath).split(path.sep).join('/');
      try {
        decodePayload(oldKey, aad, raw);
        legacy.push(path.relative(rootDir, filePath));
      } catch {
        /* 旧 KEK 解不开：要么已是 DEK 密文，要么损坏；损坏会在后续/独立校验中暴露 */
      }
    }
    if (legacy.length > 0) {
      throw new Error(
        `检测到 ${legacy.length} 个用户数据文件仍是旧单密钥（KEK）密文：请先以 AT_REST_ENVELOPE=on 启动完成 DEK 迁移，再执行 --envelope 轮换（未做任何修改）`,
      );
    }
  }
  // envelope=true 时先 rewrap 每用户 DEK（用户数据文件本身不重写）。
  const dekSummary = envelope
    ? await rewrapUserDeks({ dataDir: rootDir, oldKey, newKey, dryRun, logger })
    : { rewrapped: 0, skipped: 0, failed: 0 };
  const oldAtRest = createAtRest({ key: oldKey, dataDir: rootDir, logger });
  const newAtRest = createAtRest({ key: newKey, dataDir: rootDir, logger });

  const byokSecrets = listByokSecretFiles(rootDir);
  const items = [];
  let encrypted = 0;
  let plaintext = 0;
  let bytes = 0;
  for (const filePath of files) {
    const relative = path.relative(rootDir, filePath).split(path.sep).join('/');
    const raw = fs.readFileSync(filePath);
    let payload;
    if (isEncryptedBuffer(raw)) {
      // 第一遍：旧 key 必须能解开；失败即退出，不改写任何文件。
      try {
        payload = oldAtRest.unseal(filePath, raw);
      } catch (error) {
        throw new Error(`旧密钥无法解密 ${relative}（密钥不匹配或文件损坏，未做任何修改）：${error?.message ?? error}`);
      }
      encrypted += 1;
    } else {
      payload = raw;
      plaintext += 1;
    }
    bytes += payload.length;
    items.push({ filePath, payload, aad: null });
  }
  for (const { filePath, aad } of byokSecrets) {
    const relative = path.relative(rootDir, filePath).split(path.sep).join('/');
    const raw = fs.readFileSync(filePath);
    let payload;
    if (isEncryptedBuffer(raw)) {
      try {
        payload = decodePayload(oldKey, aad, raw);
      } catch (error) {
        throw new Error(`旧密钥无法解密 ${relative}（byok AAD 不匹配或文件损坏，未做任何修改）：${error?.message ?? error}`);
      }
      encrypted += 1;
    } else {
      // 无密钥降级模式下遗留的明文（理论上轮换仅在启用加密时执行）：按明文一并加密。
      payload = raw;
      plaintext += 1;
    }
    bytes += payload.length;
    items.push({ filePath, payload, aad });
  }

  const total = files.length + byokSecrets.length;
  const summary = { ok: true, dryRun, total, encrypted, plaintext, bytes, deksRewrapped: dekSummary.rewrapped };
  if (dryRun) {
    logger?.log?.(
      `${LOG_PREFIX} dry-run：共 ${total} 个文件（密文 ${encrypted} / 明文 ${plaintext}），明文合计 ${bytes} 字节，未写盘`,
    );
    return summary;
  }
  if (total === 0) {
    logger?.log?.(`${LOG_PREFIX} DATA_DIR 下没有需要轮换的数据文件`);
    return summary;
  }

  // 第二遍：新 key 重加密 + 原子替换。
  for (const item of items) {
    const sealed = item.aad
      ? encodePayload(newKey, item.aad, item.payload)
      : newAtRest.seal(item.filePath, item.payload);
    const tmpPath = `${item.filePath}.tmp`;
    fs.writeFileSync(tmpPath, sealed, { mode: 0o600 });
    fs.renameSync(tmpPath, item.filePath);
    try {
      fs.chmodSync(item.filePath, 0o600);
    } catch {
      /* 非 POSIX 时忽略 */
    }
  }

  // 回读校验：每个文件都必须能用新 key 解开，且内容是预期明文。
  for (const item of items) {
    const raw = fs.readFileSync(item.filePath);
    if (raw.subarray(0, AT_REST_MAGIC.length).toString('latin1') !== AT_REST_MAGIC) {
      throw new Error(`回读校验失败：${path.relative(rootDir, item.filePath)} 不是受支持的加密格式`);
    }
    const plain = item.aad ? decodePayload(newKey, item.aad, raw) : newAtRest.unseal(item.filePath, raw);
    if (!plain.equals(item.payload)) {
      throw new Error(`回读校验失败：${path.relative(rootDir, item.filePath)} 解密内容与预期不一致`);
    }
  }
  const dekSuffix = envelope ? `；DEK rewrap ${dekSummary.rewrapped} 个` : '';
  logger?.log?.(
    `${LOG_PREFIX} 轮换完成：共 ${total} 个文件（密文 ${encrypted} / 明文 ${plaintext}，其中 BYOK secret ${byokSecrets.length} 个）已改用新密钥${dekSuffix}；请切换服务端密钥并重启`,
  );
  return summary;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${LOG_PREFIX} 参数错误：${error?.message ?? error}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  let oldKey;
  let newKey;
  try {
    oldKey = resolveOldKey(options);
    if (!options.newKeyFile) throw new Error('缺少 --new-key-file');
    newKey = readEncryptionKeyFile(options.newKeyFile);
    if (oldKey.equals(newKey)) {
      console.error(`${LOG_PREFIX} 新旧密钥相同：轮换没有意义，已拒绝（未做任何修改）`);
      return 1;
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} 密钥错误：${error?.message ?? error}`);
    return 1;
  }
  try {
    await rotateDataKey({
      dataDir: options.dataDir,
      oldKey,
      newKey,
      dryRun: options.dryRun,
      envelope: options.envelope,
    });
    return 0;
  } catch (error) {
    console.error(`${LOG_PREFIX} 轮换失败：${error?.message ?? error}`);
    return 1;
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const code = await main();
  process.exit(code);
}
