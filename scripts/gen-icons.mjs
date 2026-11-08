#!/usr/bin/env node
// gen-icons.mjs — 用本机 Chrome headless 从内联 SVG 生成 PWA 图标（零依赖）。
//
// 用法：
//   node scripts/gen-icons.mjs          生成 public/icons/ 下的图标
//   node scripts/gen-icons.mjs --check  只校验既有 PNG 的尺寸与可读性（不启动 Chrome）
//
// 产物：
//   public/icons/icon-192.png           192x192（any）
//   public/icons/icon-512.png           512x512（any）
//   public/icons/icon-maskable-512.png  512x512（maskable，图形收进 80% 安全区）
//   public/icons/apple-touch-icon.png   180x180（apple-touch，index.html <link> 引用）
//
// 图形沿用 v3 画册风（BG #F4EFE4 / INK #211D16 / VERMILLION #8C4A2F），
// 与 public/icons/favicon.svg 同一个 chevron + 光标印章构图。

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'icons');

const BG = '#F4EFE4';
const INK = '#211D16';
const VERMILLION = '#8C4A2F';

/** 180 坐标系下的 v3 图形；maskable 时把内容收进 80% 安全区（背景仍满幅）。 */
function svgMarkup(maskable) {
  const art = `<path d=" 48 L106 90 L54 132" fill="none" stroke="${INK}" stroke-width="14" stroke-linecap="square" /><rect x="118" y="76" width="24" height="28" fill="${VERMILLION}" />`;
  const body = maskable ? `<g transform="translate(18 18) scale(0.8)">${art}</g>` : art;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="180" height="180"><rect width="180" height="180" fill="${BG}" />${body}</svg>`;
}

function htmlFor(size, maskable) {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<style>',
    'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:' + BG + '}',
    'svg{display:block;width:' + size + 'px;height:' + size + 'px}',
    '</style>',
    '</head>',
    '<body>',
    svgMarkup(maskable),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** 读 PNG IHDR（偏移 16/20 为宽高）。返回 {width,height} 或 null。 */
function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function checkExisting() {
  let ok = true;
  for (const target of TARGETS) {
    const filePath = join(OUT_DIR, target.file);
    if (!existsSync(filePath)) {
      console.error(`[gen-icons] 缺少 ${filePath}`);
      ok = false;
      continue;
    }
    const buffer = readFileSync(filePath);
    const size = pngSize(buffer);
    const valid = Boolean(size) && size.width === target.size && size.height === target.size;
    console.log(
      `[gen-icons] ${target.file} ${size ? `${size.width}x${size.height}` : '不是 PNG'} ${valid ? 'OK' : 'FAIL'}`,
    );
    if (!valid) ok = false;
  }
  return ok;
}

function renderIcon(chrome, workDir, target) {
  const htmlPath = join(workDir, `${target.file}.html`);
  const outPath = join(workDir, target.file);
  const profileDir = join(workDir, 'chrome-profile');
  writeFileSync(htmlPath, htmlFor(target.size, target.maskable));
  const result = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=1',
      `--user-data-dir=${profileDir}`,
      `--window-size=${target.size},${target.size}`,
      `--screenshot=${outPath}`,
      `file://${htmlPath}`,
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  if (result.error) throw result.error;
  // macOS 上 Chrome headless 退出时偶发 teardown 非 0；以截图文件是否有效为准。
  if (!existsSync(outPath)) {
    throw new Error(
      `Chrome 生成 ${target.file} 失败（status=${result.status}）\n${(result.stderr || '').slice(-800)}`,
    );
  }
  const buffer = readFileSync(outPath);
  const size = pngSize(buffer);
  if (!size || size.width !== target.size || size.height !== target.size) {
    throw new Error(
      `生成的 ${target.file} 尺寸异常：${size ? `${size.width}x${size.height}` : '不是 PNG'}，应为 ${target.size}x${target.size}`,
    );
  }
  return buffer;
}

function main() {
  if (process.argv.includes('--check')) {
    const ok = checkExisting();
    if (!ok) process.exitCode = 1;
    return;
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error(
      '[gen-icons] 未找到本机 Chrome。可设置 CHROME_PATH 环境变量后重试；已停止，未改动任何文件。',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[gen-icons] Chrome: ${chrome}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), 'ctf-icons-'));
  try {
    for (const target of TARGETS) {
      const buffer = renderIcon(chrome, workDir, target);
      writeFileSync(join(OUT_DIR, target.file), buffer);
      console.log(`[gen-icons] 已生成 public/icons/${target.file}（${target.size}x${target.size}）`);
    }
    console.log('[gen-icons] 完成。');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
