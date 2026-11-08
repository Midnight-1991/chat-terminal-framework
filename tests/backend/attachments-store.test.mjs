// 附件存储单元测试（内容寻址、原子写权限、容量、鉴权读、sweep、enabled=false）。
// 纯本地临时目录，不发网络请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ATTACHMENT_ID_RE,
  attachmentIdFor,
  collectReferencedAttachmentIds,
  createAttachmentStore,
  sweepStoreAttachments,
} from '../../server/index.mjs';
import { makeTmpDir } from './helpers.mjs';

function captureLogger() {
  const warnings = [];
  return {
    warnings,
    log() {},
    warn(...args) {
      warnings.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
    },
    error() {},
    debug() {},
  };
}

function bytes(label, size = 64) {
  // 单元测试不校验 magic bytes（那是 vision.normalizeAttachments 的职责），这里只测存储层。
  return Buffer.alloc(size, label);
}

async function listAttachmentDir(dataDir) {
  try {
    return (await fs.promises.readdir(path.join(dataDir, 'attachments'))).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

test('persistImage：内容寻址 → a<24hex>.<ext>，目录 0700 / 文件 0600，.tmp 原子落盘，同内容去重', async () => {
  const dataDir = makeTmpDir('wild-attach-');
  const store = createAttachmentStore({ dataDir, logger: captureLogger() });
  const buffer = Buffer.from('fake-png-payload-for-addressing');

  const first = await store.persistImage({ buffer, mime: 'image/png' });
  assert.ok(first, '有效图片应落盘');
  assert.match(first.id, ATTACHMENT_ID_RE);
  assert.equal(first.id, attachmentIdFor(buffer));
  assert.equal(first.ext, 'png');
  assert.equal(first.size, buffer.length);

  const dir = path.join(dataDir, 'attachments');
  const fileName = `${first.id}.png`;
  assert.deepEqual(await listAttachmentDir(dataDir), [fileName], '不得残留 *.tmp');
  const dirStat = await fs.promises.stat(dir);
  assert.equal(dirStat.mode & 0o777, 0o700);
  const fileStat = await fs.promises.stat(path.join(dir, fileName));
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.deepEqual(await fs.promises.readFile(path.join(dir, fileName)), buffer);

  const again = await store.persistImage({ buffer, mime: 'image/png' });
  assert.equal(again.id, first.id);
  assert.deepEqual(await listAttachmentDir(dataDir), [fileName], '同内容只保留一个文件');

  const stats = await store.stats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.count, 1);
  assert.equal(stats.bytes, buffer.length);
});

test('persistImage：仅接受四种图片 MIME；空/非法输入返回 null', async () => {
  const dataDir = makeTmpDir('wild-attach-');
  const store = createAttachmentStore({ dataDir, logger: captureLogger() });
  const buffer = bytes('x');

  assert.equal(await store.persistImage({ buffer, mime: 'image/tiff' }), null);
  assert.equal(await store.persistImage({ buffer, mime: 'text/plain' }), null);
  assert.equal(await store.persistImage({ buffer: Buffer.alloc(0), mime: 'image/png' }), null);
  assert.equal(await store.persistImage({ buffer: 'not-a-buffer', mime: 'image/png' }), null);
  assert.equal(await store.persistImage({}), null);
  assert.deepEqual(await listAttachmentDir(dataDir), []);

  // 四种格式各自写一个（不同内容避免去重）。
  for (const [mime, ext] of [
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ]) {
    const persisted = await store.persistImage({ buffer: bytes(mime), mime });
    assert.equal(persisted.ext, ext);
  }
  assert.equal((await store.stats()).count, 4);
});

test('persistImage：超过 ATTACHMENT_MAX_MB 容量 → warn 且返回 null（不写文件）', async () => {
  const dataDir = makeTmpDir('wild-attach-');
  const logger = captureLogger();
  // 上限 1MB，用两个 700KB 文件触发第二次超限。
  const store = createAttachmentStore({ dataDir, maxTotalMb: 1, logger });
  assert.ok(await store.persistImage({ buffer: bytes('a', 700 * 1024), mime: 'image/png' }));
  assert.equal(
    await store.persistImage({ buffer: bytes('b', 700 * 1024), mime: 'image/png' }),
    null,
  );
  assert.equal((await store.stats()).count, 1);
  assert.ok(logger.warnings.some((line) => line.includes('容量已达上限')));
});

test('read：合法 id 返回二进制；非法/不存在/路径穿越/符号链接逃逸 → null', async () => {
  const dataDir = makeTmpDir('wild-attach-');
  const store = createAttachmentStore({ dataDir, logger: captureLogger() });
  const buffer = Buffer.from('image-bytes-to-read-back');
  const { id } = await store.persistImage({ buffer, mime: 'image/png' });

  const found = await store.read(id);
  assert.ok(found);
  assert.deepEqual(found.buffer, buffer);
  assert.equal(found.mime, 'image/png');
  assert.equal(found.size, buffer.length);

  assert.equal(await store.read(`${id}x`), null);
  assert.equal(await store.read('b' + '0'.repeat(24)), null);
  assert.equal(await store.read('a' + '0'.repeat(23)), null);
  assert.equal(await store.read('a' + '0'.repeat(24)), null, '合法格式但不存在 → null');
  assert.equal(await store.read('../../etc/passwd'), null);
  assert.equal(await store.read('../attachments/' + id), null);

  // 符号链接伪装成附件文件名、指向目录外文件：realpath 校验必须拒绝。
  const outsidePath = path.join(dataDir, 'outside-secret.png');
  await fs.promises.writeFile(outsidePath, 'TOP-SECRET');
  const symlinkId = 'a' + 'f'.repeat(24);
  await fs.promises.symlink(outsidePath, path.join(dataDir, 'attachments', `${symlinkId}.png`));
  const freshStore = createAttachmentStore({ dataDir, logger: captureLogger() });
  assert.equal(await freshStore.read(symlinkId), null);
  assert.equal(await fs.promises.readFile(outsidePath, 'utf8'), 'TOP-SECRET', '不得读走目录外内容');
});

test('sweep：保留被引用文件，删除未引用文件与残留 *.tmp', async () => {
  const dataDir = makeTmpDir('wild-attach-');
  const store = createAttachmentStore({ dataDir, logger: captureLogger() });
  const kept = await store.persistImage({ buffer: bytes('kept'), mime: 'image/png' });
  const dropped = await store.persistImage({ buffer: bytes('dropped'), mime: 'image/png' });

  const dir = path.join(dataDir, 'attachments');
  await fs.promises.writeFile(path.join(dir, `${dropped.id}.png.tmp`), 'tmp');

  const conversations = [
    { id: 'c000000000001', messages: [{ role: 'user', text: 'hi', attachments: [{ id: kept.id }] }] },
  ];
  const { removed } = await store.sweep({ conversations, memories: [] });
  assert.equal(removed, 2, '删除 1 个孤儿文件 + 1 个 tmp');
  const names = await listAttachmentDir(dataDir);
  assert.equal(names.length, 1);
  assert.ok(names[0].startsWith(kept.id));

  // 记忆引用同样保留。
  const memories = [{ id: 'm000000000001', attachments: [{ id: kept.id, kind: 'image' }] }];
  assert.equal((await store.sweep({ conversations: [], memories })).removed, 0);
  assert.equal((await listAttachmentDir(dataDir)).length, 1);

  // 无引用 → 全删。
  assert.equal((await store.sweep({ conversations: [], memories: [] })).removed, 1);
  assert.deepEqual(await listAttachmentDir(dataDir), []);

  // 目录不存在时 sweep 不崩。
  const emptyStore = createAttachmentStore({ dataDir: makeTmpDir('wild-attach-empty-'), logger: captureLogger() });
  assert.deepEqual(await emptyStore.sweep({ conversations: [], memories: [] }), { removed: 0 });
});

test('enabled=false：不写/不读/不清理，stats 反映关闭状态', async () => {
  const dataDir = makeTmpDir('wild-attach-');
  const dir = path.join(dataDir, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const orphan = 'a' + '1'.repeat(24);
  fs.writeFileSync(path.join(dir, `${orphan}.png`), 'existing');

  const store = createAttachmentStore({ dataDir, enabled: false, logger: captureLogger() });
  assert.equal(await store.persistImage({ buffer: bytes('x'), mime: 'image/png' }), null);
  assert.equal(await store.read(orphan), null);
  assert.deepEqual(await store.sweep({ conversations: [], memories: [] }), { removed: 0 });
  assert.equal(fs.existsSync(path.join(dir, `${orphan}.png`)), true, '关闭时不得清理任何文件');
  const stats = await store.stats();
  assert.equal(stats.enabled, false);
  assert.equal(stats.count, 0);
  assert.equal(stats.bytes, 0);
});

test('collectReferencedAttachmentIds：会话消息 + 记忆，过滤非法 id', () => {
  const valid = 'a' + '2'.repeat(24);
  const ids = collectReferencedAttachmentIds({
    conversations: [
      { messages: [{ attachments: [{ id: valid }, { id: 'bad' }, { id: 'dataBase64' }] }] },
      [{ attachments: [{ id: 'a' + '3'.repeat(24) }] }, { attachments: [] }],
      { messages: 'not-array' },
    ],
    memories: [{ attachments: [{ id: valid }, {}] }, { attachments: null }],
  });
  assert.deepEqual([...ids].sort(), [valid, 'a' + '3'.repeat(24)].sort());
});

test('sweepStoreAttachments：按 store 读取接口收集引用；store 异常只 warn 不抛', async () => {
  const dataDir = makeTmpDir('wild-attach-');
  const logger = captureLogger();
  const store = createAttachmentStore({ dataDir, logger });
  const referenced = await store.persistImage({ buffer: bytes('ref'), mime: 'image/png' });
  const orphan = await store.persistImage({ buffer: bytes('orphan'), mime: 'image/png' });

  const fakeStore = {
    listConversations: () => [{ id: 'c000000000001', title: 't', turnCount: 1 }],
    getConversation: (id) => ({
      conversation: { id },
      messages: [{ role: 'user', text: 'x', attachments: [{ id: referenced.id }] }],
    }),
    listMemories: () => [],
  };
  assert.deepEqual(
    await sweepStoreAttachments({ attachments: store, store: fakeStore, logger }),
    { removed: 1 },
  );
  const names = await listAttachmentDir(dataDir);
  assert.equal(names.length, 1);
  assert.ok(names[0].startsWith(referenced.id));

  const brokenStore = {
    listConversations() {
      throw new Error('store 挂了');
    },
    listMemories: () => [],
  };
  const result = await sweepStoreAttachments({ attachments: store, store: brokenStore, logger });
  assert.deepEqual(result, { removed: 0 });
  assert.ok(logger.warnings.some((line) => line.includes('清理孤儿附件失败')));

  // 无附件服务（例如老 context）时安全返回。
  assert.deepEqual(await sweepStoreAttachments({ attachments: null, store: fakeStore, logger }), {
    removed: 0,
  });
});
