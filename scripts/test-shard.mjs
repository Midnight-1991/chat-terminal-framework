#!/usr/bin/env node
// 把 tests/**/*.test.mjs 按文件分片并行跑，缩短本地全量测试墙钟（默认 2 片）。
// 用法：node scripts/test-shard.mjs [--shards N=2] [--shard K] [--pattern tests]
//   --shard K（1 基）只跑第 K 片（CI 矩阵用）；缺省则并发跑全部分片并汇总退出码。
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const out = { shards: 2, shard: 0, pattern: 'tests' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--shards') out.shards = Number.parseInt(argv[++i], 10);
    else if (arg === '--shard') out.shard = Number.parseInt(argv[++i], 10);
    else if (arg === '--pattern') out.pattern = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/test-shard.mjs [--shards N=2] [--shard K] [--pattern tests]');
      process.exit(0);
    }
  }
  if (!Number.isInteger(out.shards) || out.shards < 1) throw new Error('--shards 需正整数');
  if (!Number.isInteger(out.shard) || out.shard < 0 || out.shard > out.shards) throw new Error('--shard 需 0..--shards');
  return out;
}

function collectTests(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith('.test.mjs')) files.push(full);
    }
  };
  walk(path.join(repoRoot, dir));
  return files.sort();
}

function runShard(files, label) {
  return new Promise((resolve) => {
    if (files.length === 0) {
      console.log(`[shard] ${label}: 无测试文件`);
      resolve(0);
      return;
    }
    const child = spawn(process.execPath, ['--test', ...files], {
      cwd: repoRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = collectTests(args.pattern);
  if (files.length === 0) {
    console.error(`[shard] 未找到 ${args.pattern}/**/*.test.mjs`);
    process.exit(2);
  }
  const buckets = Array.from({ length: args.shards }, () => []);
  files.forEach((file, index) => buckets[index % args.shards].push(file));
  const startedAt = Date.now();
  if (args.shard > 0) {
    const code = await runShard(buckets[args.shard - 1], `${args.shard}/${args.shards}`);
    console.log(`[shard] 完成 shard ${args.shard}/${args.shards}，exit=${code}`);
    process.exit(code);
  }
  const labels = buckets.map((_, index) => `${index + 1}/${args.shards}`);
  console.log(`[shard] 共 ${files.length} 个测试文件，分 ${args.shards} 片：${buckets.map((b, i) => `#${labels[i]}=${b.length}`).join(', ')}`);
  const codes = await Promise.all(buckets.map((bucket, index) => runShard(bucket, labels[index])));
  const failed = codes.filter((code) => code !== 0).length;
  console.log(`[shard] 全部完成：${args.shards} 片，失败 ${failed} 片，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[shard] 失败：${error.message}`);
  process.exit(2);
});
