// 静态文件服务：`/` → public/index.html，带 content-type，禁止路径穿越。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sendText } from './http-utils.mjs';

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
});

export function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 把 URL pathname 解析为 public 目录内的绝对路径；越界返回 null。
 * @returns {string|null}
 */
export function resolveStaticPath(staticDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  let relative = decoded.replace(/^\/+/, '');
  if (relative === '') relative = 'index.html';
  else if (relative.endsWith('/')) relative += 'index.html';

  const base = path.resolve(staticDir);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return null;
  return resolved;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} staticDir
 * @param {string} pathname
 */
/**
 * 404 兜底页。优先返回 public/error.html（rp 风格统一错误页），
 * 缺失/读取失败时退回纯文本，保证静态服务在最小部署下仍可用。
 */
async function sendErrorPage(req, res, staticDir) {
  try {
    const data = await readFile(path.join(staticDir, 'error.html'));
    res.writeHead(404, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
    return;
  } catch {
    sendText(res, 404, 'Not Found');
  }
}

export async function handleStatic(req, res, staticDir, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
    return;
  }
  const filePath = resolveStaticPath(staticDir, pathname);
  if (!filePath) {
    await sendErrorPage(req, res, staticDir);
    return;
  }
  let data;
  try {
    data = await readFile(filePath);
  } catch {
    await sendErrorPage(req, res, staticDir);
    return;
  }
  res.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': data.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}
