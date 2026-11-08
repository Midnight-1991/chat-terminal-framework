#!/usr/bin/env node
// Chat Terminal后端启动入口。
// 配置：PORT / HOST / MODEL / MAX_TOKENS / DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / CHAT_MOCK
// 启动日志：监听地址、模型、语料统计（docs/chunks）、mock 状态、prompt / key 来源（绝不打印 key）。
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, SCALE_IDS } from '../server/index.mjs';
import { EFFORT_MAX_TOKENS, resolveMaxTokens } from '../server/config.mjs';
import { migrateMultiuser, resolveDataDir } from '../scripts/migrate-multiuser.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_PREFIX = '[chat-terminal]';

/** 读取仓库根目录 .env（存在才读；只补空缺，不覆盖已有环境变量；不打印值）。 */
async function loadDotEnv(rootDir) {
  const filePath = path.join(rootDir, '.env');
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`${LOG_PREFIX} [env] 读取 .env 失败：${error.message}`);
    }
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[key] = value;
  }
  return true;
}

function lanAddresses(port) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}

function keyDescription(config) {
  if (config.apiKeySource === 'env') return '环境变量 DEEPSEEK_API_KEY';
  if (config.apiKeySource === 'credentials') return '~/.config/chat-terminal/credentials.yaml';
  return '未配置（chat 将返回 error 事件；可 CHAT_MOCK=1 启动）';
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

const envLoaded = await loadDotEnv(repoRoot);

// AUTH=on 时先把 legacy 单用户数据迁移为按用户分区（幂等；AUTH=off 直接跳过）。
// 必须在 createServer 之前执行：失败则 fail-fast，绝不带着半迁移状态启动。
try {
  const migration = await migrateMultiuser({
    dataDir: resolveDataDir(process.env, { repoRoot }),
    env: process.env,
    repoRoot,
    logger: console,
  });
  if (migration?.migrated) {
    const moved = Array.isArray(migration.files) ? migration.files.length : 0;
    console.log(
      `${LOG_PREFIX} 数据迁移完成：${moved} 个文件 → users/${migration.adminUserId}/（管理员 ${migration.adminUsername}；备份 ${migration.backupDir ?? '保留'}）`,
    );
  }
} catch (error) {
  console.error(`${LOG_PREFIX} 启动失败：数据迁移失败：${error?.message ?? error}`);
  process.exit(1);
}

let server;
try {
  server = await createServer({ repoRoot });
} catch (error) {
  console.error(`${LOG_PREFIX} 启动失败：${error?.stack ?? error}`);
  process.exit(1);
}

const { config, prompts, corpusStats, dataDir, store, marks, reranker, library, atRest } = server.ctx;
const stats = await corpusStats();
const promptDesc = prompts.files
  .map((file) => {
    if (file.skipped) return `${file.name}(缺失跳过)`;
    return `${file.name}(${file.chars}${file.fallback ? ' 占位' : ''})`;
  })
  .join(' + ');

try {
  await listen(server, config.port, config.host);
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`${LOG_PREFIX} 端口被占用：${config.host}:${config.port}（可用 PORT=xxxx 换端口）`);
  } else {
    console.error(`${LOG_PREFIX} 监听失败：${error.message}`);
  }
  process.exit(1);
}

const address = server.address();
const port = typeof address === 'object' && address ? address.port : config.port;
const lanUrls = lanAddresses(port);

console.log(`${LOG_PREFIX} 监听 http://${config.host}:${port}`);
for (const url of lanUrls) console.log(`${LOG_PREFIX} 局域网访问：${url}`);
const maxTokensDesc =
  config.maxTokens === null
    ? `auto（按 effort 分档 off ${EFFORT_MAX_TOKENS.off} / low ${EFFORT_MAX_TOKENS.low} / high ${EFFORT_MAX_TOKENS.high} / max ${EFFORT_MAX_TOKENS.max}；默认档 ${resolveMaxTokens(config, config.defaultEffort)}）`
    : `${config.maxTokens}（MAX_TOKENS 显式覆盖，所有档位）`;
console.log(
  `${LOG_PREFIX} 模型 ${config.model} · 默认 effort ${config.defaultEffort} · max_tokens ${maxTokensDesc} · mock=${config.mock}`,
);
console.log(`${LOG_PREFIX} 语料 docs=${stats.docs} chunks=${stats.chunks}`);
const librarySummary = library.summary();
const libraryClassDesc =
  typeof librarySummary.disciplines === 'number'
    ? `分类 v1：${librarySummary.disciplines} 个学科 / ${librarySummary.topics} 个主题`
    : `${librarySummary.groups} 组`;
console.log(
  `${LOG_PREFIX} 文档库 ${librarySummary.books} 本 / ${libraryClassDesc}${
    library.warning ? ` · ⚠ ${library.warning}` : ''
  }（构建 ${library.buildMs}ms）`,
);
console.log(`${LOG_PREFIX} 自评问卷 ${SCALE_IDS.length} 份（${SCALE_IDS.join(' / ')}；服务端计分，回答不落盘）`);
console.log(`${LOG_PREFIX} 人格提示词 ${promptDesc}`);
const marksStats = marks.stats();
console.log(
  `${LOG_PREFIX} 持久化 data/ ${dataDir} · 会话 ${store.health().conversations} · 记忆 ${store.health().memories} · 收藏 ${marksStats.favorites} / 摘录 ${marksStats.excerpts} · at-rest 加密 ${atRest?.enabled ? 'on' : 'off'}${
    store.degraded() || marks.degraded() ? ' · ⚠ 降级为内存模式' : ''
  }`,
);
console.log(
  `${LOG_PREFIX} 记忆 memory=${config.memory ? 'on' : 'off'}（注入上限 ${config.memoryMax}，抽取 ${
    config.mock ? 'mock 规则' : config.memoryExtractModel || config.model
  }） · 重排 RERANK=${config.rerank}${reranker ? '（已加载）' : ''} · 查询扩展 QUERY_EXPAND=${config.queryExpand}`,
);
console.log(`${LOG_PREFIX} API key：${keyDescription(config)}`);
if (envLoaded) console.log(`${LOG_PREFIX} 已加载仓库根目录 .env（不覆盖已有环境变量）`);

//  2 / 优雅关停。
// 顺序：SIGTERM/SIGINT → server.close() 停止接收新连接 → await ctx.flushAll()（app.mjs 里的
// lifecycle.shutdown，总超时由 SHUTDOWN_TIMEOUT_MS 控制）→ 等连接自然结束（最多同超时）→ 退出码 0；
// flush 失败/超时 = 1。日志固定带 [shutdown] 前缀（测试  快速验证断言）。
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 5000);
const shutLingerMs =
  Number.isFinite(SHUTDOWN_TIMEOUT_MS) && SHUTDOWN_TIMEOUT_MS > 0 ? SHUTDOWN_TIMEOUT_MS : 5000;
let shuttingDown = false;

function waitServerClosed(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      resolve(closed);
    };
    server.close(() => finish(true));
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${LOG_PREFIX} [shutdown] 收到 ${signal}，停止接收新请求并 flush 挂起写入…`);
  const closePromise = waitServerClosed(shutLingerMs);
  const flushAll = typeof server.ctx?.flushAll === 'function' ? server.ctx.flushAll : null;

  let flushResult = null;
  let flushError = null;
  if (flushAll) {
    try {
      flushResult = await flushAll();
    } catch (error) {
      flushError = error;
    }
  } else {
    console.log(`${LOG_PREFIX} [shutdown] 未提供 ctx.flushAll，跳过写队列 flush`);
  }

  const closed = await closePromise;
  if (!closed) {
    console.log(`${LOG_PREFIX} [shutdown] 仍有连接未结束，强制断开`);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }

  const timeout = flushResult?.ok === false;
  const flushFailed = Number.isFinite(flushResult?.failed) && flushResult.failed > 0;
  const ok = !flushError && !timeout && !flushFailed;
  const detail = flushResult
    ? ` flushed=${flushResult.flushed} failed=${flushResult.failed} elapsedMs=${flushResult.elapsedMs}`
    : '';
  const errorDesc = flushError ? ` error=${flushError?.message ?? flushError}` : '';
  console.log(
    `${LOG_PREFIX} [shutdown] 完成 signal=${signal}${detail}${errorDesc} exit=${ok ? 0 : 1}${
      timeout ? '（flush 超时）' : ''
    }`,
  );
  process.exit(ok ? 0 : 1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    gracefulShutdown(signal).catch((error) => {
      console.error(`${LOG_PREFIX} [shutdown] 异常：${error?.stack ?? error}`);
      process.exit(1);
    });
  });
}
