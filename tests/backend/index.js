// 兼容垫片：Node 22/24 的 `node --test <目录>` 会把目录本身当作模块加载并报
// MODULE_NOT_FOUND（目录展开行为在较新版本才恢复）。此文件让
// `node --test tests/backend/` 在 Node 24 上也能跑完整套后端测试；
// 正常用法：`node --test 'tests/backend/*.test.mjs'`（或 npm run test:backend）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testFiles = fs
  .readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

for (const name of testFiles) {
  await import(new URL(`./${name}`, import.meta.url).href);
}
