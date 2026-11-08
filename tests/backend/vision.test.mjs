// 单测：附件校验（magic bytes）、flash 解析器、mock 摘要、超时/重试/并发、配置。
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, DEFAULTS } from '../../server/config.mjs';
import {
  ALLOWED_IMAGE_MIMES,
  AttachmentError,
  VISION_CONCURRENCY,
  VISION_IMAGE_MAX_BYTES,
  VISION_MAX_IMAGES,
  VISION_MAX_TEXTS,
  VISION_PROMPT,
  VISION_SUMMARY_MAX_CHARS,
  buildVisionRequestBody,
  extractVisionText,
  mockAttachmentSummary,
  normalizeAttachments,
  parseAttachments,
  persistedAttachmentMeta,
  publicAttachmentMeta,
  sniffImageMime,
  truncateSummary,
} from '../../server/vision.mjs';

const CREDENTIAL_PATH = '/no/such/credentials.yaml';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function testConfig(overrides = {}) {
  return {
    ...loadConfig({}, { credentialPath: CREDENTIAL_PATH }),
    mock: false,
    apiKey: 'test-vision-key',
    ...overrides,
  };
}

function imageAttachment(overrides = {}) {
  return { kind: 'image', name: '测试.png', mime: 'image/png', dataBase64: PNG_BASE64, ...overrides };
}

function textAttachment(overrides = {}) {
  return { kind: 'text', name: '笔记.txt', mime: 'text/plain', text: '这是一段测试文本。', ...overrides };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bufferWithMagic(prefix, length = 64) {
  const buffer = Buffer.alloc(length);
  Buffer.from(prefix, 'binary').copy(buffer, 0);
  return buffer;
}

test('loadConfig：VISION_* 默认值、env 覆盖、非法回退', () => {
  const defaults = loadConfig({}, { credentialPath: CREDENTIAL_PATH });
  assert.equal(defaults.visionModel, 'deepseek-flash');
  assert.equal(defaults.visionTimeoutMs, 30_000);
  assert.equal(defaults.visionMaxTokens, 800);
  assert.equal(DEFAULTS.VISION_MODEL, 'deepseek-flash');

  const custom = loadConfig(
    { VISION_MODEL: ' deepseek-vl ', VISION_TIMEOUT_MS: '1234', VISION_MAX_TOKENS: '999' },
    { credentialPath: CREDENTIAL_PATH },
  );
  assert.equal(custom.visionModel, 'deepseek-vl');
  assert.equal(custom.visionTimeoutMs, 1234);
  assert.equal(custom.visionMaxTokens, 999);

  const invalid = loadConfig(
    { VISION_TIMEOUT_MS: 'abc', VISION_MAX_TOKENS: '0' },
    { credentialPath: CREDENTIAL_PATH },
  );
  assert.equal(invalid.visionTimeoutMs, 30_000);
  assert.equal(invalid.visionMaxTokens, 800);
});

test('sniffImageMime：按内容识别 JPEG/PNG/GIF/WebP，其余返回 null', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const gif = Buffer.from('GIF89a000000', 'binary');
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');

  assert.equal(sniffImageMime(jpeg), 'image/jpeg');
  assert.equal(sniffImageMime(png), 'image/png');
  assert.equal(sniffImageMime(gif), 'image/gif');
  assert.equal(sniffImageMime(webp), 'image/webp');
  assert.equal(sniffImageMime(Buffer.alloc(16)), null);
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8])), null, '过短不识别');
  assert.equal(sniffImageMime('not a buffer'), null);
  assert.deepEqual(ALLOWED_IMAGE_MIMES, ['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
});

test('normalizeAttachments：合法图片按内容修正 mime，文本附件归一化', () => {
  // 客户端把 GIF 声明成 image/png：以内容为准（官方 flash 按文件内容判断）。
  const gifBuffer = Buffer.from('GIF89a0000000000000000000', 'binary');
  const normalized = normalizeAttachments([
    imageAttachment({ dataBase64: gifBuffer.toString('base64'), mime: 'image/png' }),
    textAttachment(),
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].kind, 'image');
  assert.equal(normalized[0].mime, 'image/gif');
  assert.equal(normalized[0].bytes, gifBuffer.length);
  assert.equal(normalized[0].size, gifBuffer.length);
  assert.equal(normalized[1].kind, 'text');
  assert.equal(normalized[1].text, '这是一段测试文本。');
  assert.equal(normalized[1].bytes, Buffer.byteLength('这是一段测试文本。', 'utf8'));

  // data URL 前缀与空白兼容；默认 name 兜底。
  const withDataUrl = normalizeAttachments([
    { kind: 'image', mime: 'image/png', dataBase64: ` data:image/png;base64,${PNG_BASE64.replace(/(.{20})/g, '$1\n')} ` },
  ]);
  assert.equal(withDataUrl[0].name, '图片 1');
  assert.equal(withDataUrl[0].mime, 'image/png');
  assert.equal(withDataUrl[0].dataBase64, PNG_BASE64);
});

test('normalizeAttachments：声明的 mime 不受支持时拒收（即使内容合法；实际格式仍按内容）', () => {
  try {
    normalizeAttachments([imageAttachment({ mime: 'image/tiff' })]);
    assert.fail('应拒绝不支持的声明 mime');
  } catch (error) {
    assert.ok(error instanceof AttachmentError);
    assert.equal(error.code, 'INVALID_ATTACHMENT');
    assert.match(error.message, /image\/tiff 不受支持/);
  }
  // mime 合法但与内容不一致：以内容为准（声明 image/png、内容 GIF → image/gif）。
  const gif = Buffer.from('GIF89a0000000000000000000', 'binary').toString('base64');
  const [normalized] = normalizeAttachments([imageAttachment({ mime: 'image/png', dataBase64: gif })]);
  assert.equal(normalized.mime, 'image/gif');
});

test('normalizeAttachments：数量/文本/大小/内容校验（含 HEIC 与非图片内容拒绝）', () => {
  assert.throws(() => normalizeAttachments('x'), AttachmentError);
  assert.throws(() => normalizeAttachments([{ kind: 'video' }]), /kind 必须是/);
  assert.throws(
    () => normalizeAttachments(Array.from({ length: VISION_MAX_IMAGES + 1 }, () => imageAttachment())),
    /最多上传 3 张图片/,
  );
  assert.throws(
    () => normalizeAttachments(Array.from({ length: VISION_MAX_TEXTS + 1 }, () => textAttachment())),
    /最多上传 1 个文本文件/,
  );
  assert.throws(() => normalizeAttachments([imageAttachment({ dataBase64: '####' })]), /不是合法 base64/);
  assert.throws(() => normalizeAttachments([imageAttachment({ dataBase64: '' })]), /缺少 dataBase64/);
  assert.throws(
    () => normalizeAttachments([textAttachment({ text: '   ' })]),
    /内容不能为空/,
  );
  assert.throws(
    () => normalizeAttachments([textAttachment({ text: 'a'.repeat(100 * 1024 + 1) })]),
    /超过 100KB/,
  );
  // 非图片内容（纯字节）→ 400 INVALID_ATTACHMENT。
  const junk = Buffer.alloc(64, 7);
  try {
    normalizeAttachments([imageAttachment({ dataBase64: junk.toString('base64') })]);
    assert.fail('应抛错');
  } catch (error) {
    assert.ok(error instanceof AttachmentError);
    assert.equal(error.code, 'INVALID_ATTACHMENT');
    assert.match(error.message, /不是支持的图片格式/);
  }
  // HEIC/HEIF：明确提示先转换。
  const heic = Buffer.alloc(32);
  heic.write('ftyp', 4, 'ascii');
  heic.write('heic', 8, 'ascii');
  try {
    normalizeAttachments([imageAttachment({ dataBase64: heic.toString('base64') })]);
    assert.fail('HEIC 应被拒绝');
  } catch (error) {
    assert.equal(error.code, 'INVALID_ATTACHMENT');
    assert.match(error.message, /HEIC\/HEIF/);
  }
  // 超过 4MB（带合法 PNG magic，保证先通过格式校验再撞大小上限）。
  const oversized = Buffer.alloc(VISION_IMAGE_MAX_BYTES + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversized, 0);
  assert.throws(
    () => normalizeAttachments([imageAttachment({ dataBase64: oversized.toString('base64') })]),
    /超过 4MB 上限/,
  );
  // maxTotal（memory 用）：1 个图片 + 1 个文本也超。
  assert.throws(
    () => normalizeAttachments([imageAttachment(), textAttachment()], { maxImages: 1, maxTexts: 1, maxTotal: 1 }),
    /附件最多 1 个/,
  );
});

test('truncateSummary：压缩空白并截断到 800 字', () => {
  assert.equal(truncateSummary('  a  b \n\n\n c  '), 'a b\n\nc');
  const long = truncateSummary('字'.repeat(900));
  assert.equal(Array.from(long).length, VISION_SUMMARY_MAX_CHARS + 1);
  assert.ok(long.endsWith('…'));
  assert.equal(truncateSummary('ok'), 'ok');
  assert.equal(truncateSummary(undefined), '');
});

test('buildVisionRequestBody：flash 非流式、thinking disabled、image block + 客观解析提示词', () => {
  const config = testConfig({ visionModel: 'deepseek-flash', visionMaxTokens: 800 });
  const attachment = normalizeAttachments([imageAttachment()])[0];
  const body = buildVisionRequestBody(config, attachment);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.max_tokens, 800);
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  const [imageBlock, textBlock] = body.messages[0].content;
  assert.equal(body.messages[0].role, 'user');
  assert.equal(imageBlock.type, 'image');
  assert.deepEqual(imageBlock.source, { type: 'base64', media_type: 'image/png', data: PNG_BASE64 });
  assert.equal(textBlock.type, 'text');
  assert.equal(textBlock.text, VISION_PROMPT);
  assert.match(textBlock.text, /不要给建议/);
  assert.match(textBlock.text, /800 字/);
});

test('extractVisionText：拼接 text 块并截断，空响应返回空串', () => {
  assert.equal(extractVisionText({ content: [{ type: 'text', text: ' 第一段 ' }, { type: 'text', text: '第二段' }] }), '第一段\n第二段');
  assert.equal(extractVisionText({ content: [] }), '');
  assert.equal(extractVisionText(null), '');
  assert.equal(extractVisionText({ content: [{ type: 'image' }] }), '');
  assert.equal(Array.from(extractVisionText({ content: [{ type: 'text', text: '字'.repeat(900) }] })).length, 801);
});

test('mockAttachmentSummary：确定性 mock 摘要（不调用 API）', () => {
  const attachment = normalizeAttachments([imageAttachment()])[0];
  const first = mockAttachmentSummary(attachment);
  assert.equal(first, mockAttachmentSummary(attachment));
  assert.match(first, /（mock 解析）/);
  assert.match(first, /测试\.png/);
  assert.match(mockAttachmentSummary({ kind: 'text', name: 'a.txt', bytes: 12 }), /（mock 解析）/);
});

test('parseAttachments：CHAT_MOCK=1 不调 fetch，文本附件直接取内容', async () => {
  const fetchImpl = () => {
    throw new Error('CHAT_MOCK=1 时附件解析不得调用真实上游 fetch');
  };
  const config = testConfig({ mock: true });
  const attachments = normalizeAttachments([imageAttachment(), textAttachment()]);
  const parsed = await parseAttachments({ config, apiKey: '', logger: null, attachments, fetchImpl });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].kind, 'image');
  assert.match(parsed[0].summary, /（mock 解析）/);
  assert.equal(typeof parsed[0].ms, 'number');
  assert.equal(parsed[1].kind, 'text');
  assert.equal(parsed[1].summary, '这是一段测试文本。');
  assert.equal(parsed[1].ms, 0);
  assert.ok(!('error' in parsed[0]));
});

test('parseAttachments：成功调 flash（非流式 / thinking disabled / 800 tokens）并返回摘要', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return jsonResponse({ content: [{ type: 'text', text: '  图片中写着「测试文字」。  ' }] });
  };
  const config = testConfig({ mock: false });
  const attachments = normalizeAttachments([imageAttachment()]);
  const [parsed] = await parseAttachments({ config, apiKey: 'test-vision-key', logger: null, attachments, fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-vision-key');
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.equal(parsed.summary, '图片中写着「测试文字」。');
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.kind, 'image');
  assert.equal(typeof parsed.ms, 'number');
  assert.ok(!('dataBase64' in parsed), '解析结果不得带二进制');
});

test('parseAttachments：超时重试 1 次后返回 error（不抛错）', async () => {
  let calls = 0;
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      calls += 1;
      init.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  const config = testConfig({ visionTimeoutMs: 20 });
  const attachments = normalizeAttachments([imageAttachment()]);
  const [parsed] = await parseAttachments({ config, apiKey: 'k', logger: null, attachments, fetchImpl });
  assert.equal(calls, 2, '超时属于可重试错误：1 次 + 重试 1 次');
  assert.match(parsed.error, /解析超时（>20ms）/);
  assert.equal(parsed.summary, undefined);
});

test('parseAttachments：5xx 重试 1 次后成功；4xx 不重试；200 非 JSON 不重试', async () => {
  let calls = 0;
  const retryThenOk = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 500 });
    return jsonResponse({ content: [{ type: 'text', text: '第二次成功' }] });
  };
  const config = testConfig();
  const attachments = normalizeAttachments([imageAttachment()]);
  const [retried] = await parseAttachments({ config, apiKey: 'k', logger: null, attachments, fetchImpl: retryThenOk });
  assert.equal(calls, 2);
  assert.equal(retried.summary, '第二次成功');

  calls = 0;
  const clientError = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 });
  };
  const [rejected] = await parseAttachments({ config, apiKey: 'k', logger: null, attachments, fetchImpl: clientError });
  assert.equal(calls, 1, '4xx 不重试');
  assert.match(rejected.error, /解析器请求失败（HTTP 400）/);

  calls = 0;
  const badJson = async () => {
    calls += 1;
    return new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const [invalid] = await parseAttachments({ config, apiKey: 'k', logger: null, attachments, fetchImpl: badJson });
  assert.equal(calls, 1, '200 非 JSON 不重试');
  assert.match(invalid.error, /不是合法 JSON/);
});

test('parseAttachments：并发 ≤3', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return jsonResponse({ content: [{ type: 'text', text: '并发解析完成' }] });
  };
  const config = testConfig();
  const attachments = normalizeAttachments([
    imageAttachment({ name: 'a.png' }),
    imageAttachment({ name: 'b.png' }),
    imageAttachment({ name: 'c.png' }),
  ]);
  const parsed = await parseAttachments({ config, apiKey: 'k', logger: null, attachments, fetchImpl });
  assert.equal(parsed.length, 3);
  assert.ok(parsed.every((item) => item.summary === '并发解析完成'));
  assert.ok(maxInFlight <= VISION_CONCURRENCY, `并发应 ≤3，实际 ${maxInFlight}`);
  assert.ok(maxInFlight >= 2, '三张图应并发解析');
});

test('parseAttachments：无 apiKey 且非 mock → 单条 error，不调 fetch', async () => {
  const fetchImpl = () => {
    throw new Error('不应调用');
  };
  const config = testConfig({ apiKey: '' });
  const attachments = normalizeAttachments([imageAttachment()]);
  const [parsed] = await parseAttachments({ config, apiKey: '', logger: null, attachments, fetchImpl });
  assert.match(parsed.error, /未配置 DEEPSEEK_API_KEY/);
  assert.equal(parsed.summary, undefined);
});

test('publicAttachmentMeta / persistedAttachmentMeta：不含二进制，meta 字段与契约一致', () => {
  const built = publicAttachmentMeta({ name: '图.png', kind: 'image', summary: '摘要', error: undefined, ms: 12 });
  assert.deepEqual(built, { name: '图.png', kind: 'image', summary: '摘要', ms: 12 });

  const failed = publicAttachmentMeta({ name: '图.png', kind: 'image', error: '解析超时', ms: 20 });
  assert.deepEqual(failed, { name: '图.png', kind: 'image', error: '解析超时', ms: 20 });
  assert.ok(!('dataBase64' in failed));

  const attachment = normalizeAttachments([imageAttachment()])[0];
  const persisted = persistedAttachmentMeta({ name: '测试.png', kind: 'image', summary: '摘要', ms: 1 }, attachment);
  assert.deepEqual(persisted, {
    name: '测试.png',
    kind: 'image',
    mime: 'image/png',
    size: attachment.bytes,
    summary: '摘要',
  });
  assert.ok(!('dataBase64' in persisted));
});
