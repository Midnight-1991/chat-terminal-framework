// ..BYOK 服务单测（存储/加密/校验/SSRF/探活/脱敏）。
// 网络全 mock：fetchImpl / dnsLookup 均由测试注入，绝不发起真实请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ByokError } from '../../server/byok-providers.mjs';
import {
  BYOK_CHECK_WINDOW_MS,
  BYOK_SECRET_AAD_PREFIX,
  BYOK_SECRET_ENC_FILE_NAME,
  BYOK_SECRET_PLAIN_FILE_NAME,
  createByokService,
  redactSecrets,
  resolveChatModelSource,
} from '../../server/byok.mjs';
import { createFetchTransport } from '../../server/pinned-http.mjs';
import { createCapturingLogger, makeTmpDir } from './helpers.mjs';

const KEY = Buffer.alloc(32, 7);
const USER_A = 'u111111111111';
const USER_B = 'u222222222222';
const API_KEY = 'test-key-test-A1b2';

function defaultConfig(overrides = {}) {
  return {
    byokEnabled: true,
    byokAllowLoopback: false,
    byokCheckPerMinute: 3,
    byokTimeoutMs: 120_000,
    byokMaxKeyChars: 512,
    byokMaxModelChars: 128,
    byokMaxBaseUrlChars: 512,
    ...overrides,
  };
}

function makeHarness({ atRestKey = KEY, config = {}, fetchImpl, dnsLookup, now } = {}) {
  const dataDir = makeTmpDir('wild-byok-');
  const logger = createCapturingLogger();
  const fakeFetch =
    fetchImpl ??
    (async () => {
      throw new Error('测试不应发起网络请求');
    });
  const fakeDns = dnsLookup ?? (async () => [{ address: '93.184.216.34' }]);
  const service = createByokService({
    baseDataDir: dataDir,
    atRestKey,
    config: defaultConfig(config),
    logger,
    // 探活出站改走 pinned 传输；单测注入 fetch→transport 适配器（仍不发真实网络）。
    transport: createFetchTransport(fakeFetch),
    now: now ?? (() => new Date()),
    dnsLookup: fakeDns,
  });
  return { service, dataDir, logger };
}

function assertByokError(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof ByokError, `应抛 ByokError（实际 ${error?.name}）`);
    assert.equal(error.code, code);
    return true;
  });
}

function modeOf(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

test('set/getMeta/getSecret：元数据明文、密钥加密落盘且不含明文', async () => {
  const { service, dataDir, logger } = makeHarness({ config: { byokAllowLoopback: true } });
  const meta = await service.set(USER_A, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: API_KEY,
    baseUrl: 'http://127.0.0.1:18099/v1',
  });
  assert.equal(meta.configured, true);
  assert.deepEqual(meta.provider, { id: 'custom', label: '自定义（OpenAI 兼容）', protocol: 'openai' });
  assert.equal(meta.model, 'gpt-4o-mini');
  assert.equal(meta.keyHint, 'test-key-…A1b2');
  assert.equal(meta.baseUrlOrigin, 'http://127.0.0.1:18099');

  const userDir = path.join(dataDir, 'users', USER_A);
  const metaPath = path.join(userDir, 'byok.json');
  const encPath = path.join(userDir, BYOK_SECRET_ENC_FILE_NAME);
  assert.equal(modeOf(userDir), 0o700);
  assert.equal(modeOf(metaPath), 0o600);
  assert.equal(modeOf(encPath), 0o600);

  const metaText = fs.readFileSync(metaPath, 'utf8');
  const stored = JSON.parse(metaText);
  assert.equal(stored.provider, 'custom');
  assert.equal(stored.protocol, 'openai');
  assert.equal(stored.model, 'gpt-4o-mini');
  assert.ok(!metaText.includes(API_KEY), 'byok.json 不得含明文 key');
  assert.ok(!metaText.includes('/v1'), 'byok.json 不得含 baseUrl 路径');

  const encRaw = fs.readFileSync(encPath);
  assert.ok(encRaw.subarray(0, 9).toString('latin1').startsWith('CTFENC001'), '密文应以 CTFENC001 开头');
  assert.ok(!encRaw.toString('latin1').includes(API_KEY), '密文不得含明文 key');
  assert.ok(!fs.existsSync(path.join(userDir, BYOK_SECRET_PLAIN_FILE_NAME)));

  const secret = await service.getSecret(USER_A);
  assert.equal(secret.apiKey, API_KEY);
  assert.equal(secret.baseUrl, 'http://127.0.0.1:18099/v1');
  assert.equal(secret.protocol, 'openai');
  assert.equal(secret.model, 'gpt-4o-mini');

  // 对外视图/日志均不含明文。
  assert.ok(!JSON.stringify(await service.getMeta(USER_A)).includes(API_KEY));
  assert.ok(!JSON.stringify(logger.records ?? []).includes(API_KEY));
});

test('无 atRestKey（明文模式）：降级 byok.secret.json（0600），不生成密文文件', async () => {
  const { service, dataDir } = makeHarness({ atRestKey: null });
  await service.set(USER_A, { provider: 'deepseek', model: 'deepseek-chat', apiKey: API_KEY });
  const userDir = path.join(dataDir, 'users', USER_A);
  const plainPath = path.join(userDir, BYOK_SECRET_PLAIN_FILE_NAME);
  assert.equal(fs.existsSync(plainPath), true);
  assert.equal(fs.existsSync(path.join(userDir, BYOK_SECRET_ENC_FILE_NAME)), false);
  assert.equal(modeOf(plainPath), 0o600);
  const secret = await service.getSecret(USER_A);
  assert.equal(secret.apiKey, API_KEY);
  assert.equal(secret.baseUrl, 'https://api.deepseek.com/v1');
});

test('密钥 AAD 绑定 userId：密文拷到其他用户目录无法解密（按未配置处理）', async () => {
  const { service, dataDir } = makeHarness();
  await service.set(USER_A, { provider: 'deepseek', model: 'deepseek-chat', apiKey: API_KEY });
  const dirA = path.join(dataDir, 'users', USER_A);
  const dirB = path.join(dataDir, 'users', USER_B);
  fs.mkdirSync(dirB, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(dirA, 'byok.json'), path.join(dirB, 'byok.json'));
  fs.copyFileSync(path.join(dirA, BYOK_SECRET_ENC_FILE_NAME), path.join(dirB, BYOK_SECRET_ENC_FILE_NAME));
  assert.equal(await service.getSecret(USER_B), null);
  assert.ok(BYOK_SECRET_AAD_PREFIX.endsWith(':'));
});

test('set 校验：未知厂商/非法模型/key 长度/自定义缺 baseUrl', async () => {
  const { service } = makeHarness({ config: { byokMaxKeyChars: 20 } });
  await assertByokError(service.set(USER_A, { provider: 'nope', model: 'm1', apiKey: API_KEY }), 'INVALID_PROVIDER');
  await assertByokError(service.set(USER_A, { provider: 'deepseek', model: 'bad model', apiKey: API_KEY }), 'INVALID_MODEL');
  await assertByokError(
    service.set(USER_A, { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'short' }),
    'BYOK_KEY_INVALID',
  );
  await assertByokError(
    service.set(USER_A, { provider: 'deepseek', model: 'deepseek-chat', apiKey: `test-key-${'a'.repeat(30)}` }),
    'BYOK_KEY_INVALID',
  );
  await assertByokError(
    service.set(USER_A, { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key-test has space' }),
    'BYOK_KEY_INVALID',
  );
  await assertByokError(
    service.set(USER_A, { provider: 'custom', model: 'gpt-4o-mini', apiKey: API_KEY }),
    'BYOK_URL_INVALID',
  );
});

test('SSRF：非法 baseUrl 变体全部拒绝（https/端口/凭据/query/内网/元数据）', async () => {
  const { service } = makeHarness();
  const invalid = [
    'http://api.example.com/v1', // 非 https
    'https://api.example.com:8443/v1', // 非 443 端口
    'https://api.example.com/v1?x=1', // query
    'https://api.example.com/v1#frag', // fragment
    'https://user:pass@api.example.com/v1', // userinfo
    'ftp://api.example.com/v1', // 协议
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.1/v1',
    'https://172.16.5.5/v1',
    'https://192.168.1.1/v1',
    'https://169.254.169.254/latest',
    'https://0.0.0.0/v1',
    'https://[::1]/v1',
    'https://metadata.google.internal/v1',
    'https://api.example.com@evil.com/v1',
    'not-a-url',
    '',
  ];
  for (const baseUrl of invalid) {
    await assertByokError(
      service.set(USER_A, { provider: 'custom', model: 'gpt-4o-mini', apiKey: API_KEY, baseUrl }),
      'BYOK_URL_INVALID',
    );
  }
});

test('SSRF：IPv4-mapped / IPv4-compatible / NAT64 / 6to4 / Teredo 等 IPv6 变体不得绕过', async () => {
  const { service } = makeHarness();
  // WHATWG URL 会把 [::ffff:127.0.0.1] 规范化为 [::ffff:7f00:1]，仅匹配 dotted 形式会漏判（verifier B1）。
  const invalid = [
    'https://[::ffff:127.0.0.1]/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://[::ffff:169.254.169.254]/v1',
    'https://[::ffff:a9fe:a9fe]/v1',
    'https://[::ffff:10.0.0.5]/v1',
    'https://[::ffff:a00:5]/v1',
    'https://[::ffff:0:0]/v1',
    'https://[::]/v1',
    'https://[::1]/v1',
    'https://[fe80::1]/v1',
    'https://[fe80::]/v1',
    'https://[fc00::1]/v1',
    'https://[fd12:3456:789a::1]/v1',
    'https://[ff02::1]/v1',
    'https://[::127.0.0.1]/v1',
    'https://[::7f00:1]/v1',
    'https://[::a00:5]/v1',
    'https://[64:ff9b::7f00:1]/v1',
    'https://[64:ff9b::a9fe:a9fe]/v1',
    'https://[2002:7f00:1::]/v1',
    'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/v1',
  ];
  for (const baseUrl of invalid) {
    await assertByokError(
      service.set(USER_A, { provider: 'custom', model: 'gpt-4o-mini', apiKey: API_KEY, baseUrl }),
      'BYOK_URL_INVALID',
    );
  }

  // 公网地址（含 IPv4-mapped 的公网 IPv4、公网 IPv6）仍应放行，避免误杀。
  for (const baseUrl of [
    'https://[::ffff:93.184.216.34]/v1',
    'https://[2606:4700:4700::1111]/v1',
    'https://93.184.216.34/v1',
  ]) {
    const meta = await service.set(USER_A, { provider: 'custom', model: 'gpt-4o-mini', apiKey: API_KEY, baseUrl });
    assert.equal(meta.provider.id, 'custom');
    await service.remove(USER_A);
  }
});

test('SSRF：DNS 二次解析逐地址复查（防 rebinding），解析失败 → BYOK_URL_INVALID', async () => {
  // 解析到公网 → 通过
  {
    const { service } = makeHarness({ dnsLookup: async () => [{ address: '93.184.216.34' }] });
    const meta = await service.set(USER_A, {
      provider: 'custom',
      model: 'gpt-4o-mini',
      apiKey: API_KEY,
      baseUrl: 'https://api.example.com/v1/',
    });
    assert.equal(meta.baseUrlOrigin, 'https://api.example.com');
    assert.equal((await service.getSecret(USER_A)).baseUrl, 'https://api.example.com/v1');
  }
  // 解析到内网/混合 → 拒绝
  for (const addresses of [[{ address: '10.0.0.5' }], [{ address: '93.184.216.34' }, { address: '127.0.0.1' }]]) {
    const { service } = makeHarness({ dnsLookup: async () => addresses });
    await assertByokError(
      service.set(USER_A, { provider: 'custom', model: 'gpt-4o-mini', apiKey: API_KEY, baseUrl: 'https://rebind.example.com/v1' }),
      'BYOK_URL_INVALID',
    );
  }
  // 解析失败 → 拒绝
  {
    const { service } = makeHarness({
      dnsLookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await assertByokError(
      service.set(USER_A, { provider: 'custom', model: 'gpt-4o-mini', apiKey: API_KEY, baseUrl: 'https://nx.example.com/v1' }),
      'BYOK_URL_INVALID',
    );
  }
});

test('BYOK_ALLOW_LOOPBACK：仅测试环境允许 http 回环+任意端口', async () => {
  const { service } = makeHarness({ config: { byokAllowLoopback: true } });
  const meta = await service.set(USER_A, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: API_KEY,
    baseUrl: 'http://127.0.0.1:18099/v1',
  });
  assert.equal(meta.configured, true);
  const secret = await service.getSecret(USER_A);
  assert.equal(secret.baseUrl, 'http://127.0.0.1:18099/v1');

  // 允许回环并不放开其他 SSRF 限制。
  await assertByokError(
    service.set(USER_A, {
      provider: 'custom',
      model: 'gpt-4o-mini',
      apiKey: API_KEY,
      baseUrl: 'http://127.0.0.1:18099/v1?x=1',
    }),
    'BYOK_URL_INVALID',
  );
  await assertByokError(
    service.set(USER_A, {
      provider: 'custom',
      model: 'gpt-4o-mini',
      apiKey: API_KEY,
      baseUrl: 'http://10.0.0.9:18099/v1',
    }),
    'BYOK_URL_INVALID',
  );
});

test('探活：openai 协议 GET /models，成功返回 modelCount/latencyMs，失败错误归一化', async () => {
  const calls = [];
  const makeFetch = (status, body) => async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body ?? '', { status, headers: { 'content-type': 'application/json' } });
  };
  const { service } = makeHarness({
    config: { byokAllowLoopback: true, byokCheckPerMinute: 10 },
    fetchImpl: makeFetch(200, JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })),
  });
  await service.set(USER_A, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: API_KEY,
    baseUrl: 'http://127.0.0.1:18099/v1',
  });
  const result = await service.check(USER_A);
  assert.equal(result.ok, true);
  assert.equal(result.modelCount, 3);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/v1/models'), `应请求 models 端点（实际 ${calls[0].url}）`);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${API_KEY}`);

  const cases = [
    [401, 'BYOK_KEY_INVALID'],
    [403, 'BYOK_KEY_INVALID'],
    [404, 'BYOK_ENDPOINT_INVALID'],
    [500, 'BYOK_CHECK_FAILED'],
  ];
  for (const [status, expected] of cases) {
    const harness = makeHarness({ config: { byokAllowLoopback: true, byokCheckPerMinute: 10 }, fetchImpl: makeFetch(status) });
    await harness.service.set(USER_A, {
      provider: 'custom',
      model: 'gpt-4o-mini',
      apiKey: API_KEY,
      baseUrl: 'http://127.0.0.1:18100/v1',
    });
    const failed = await harness.service.check(USER_A);
    assert.equal(failed.ok, false);
    assert.equal(failed.errorCode, expected, `HTTP ${status} 应映射 ${expected}`);
  }
});

test('探活：网络异常 → BYOK_CHECK_FAILED；超时 → BYOK_TIMEOUT；响应无模型 → BYOK_CHECK_FAILED', async () => {
  const setup = async (fetchImpl) => {
    const harness = makeHarness({ config: { byokAllowLoopback: true, byokCheckPerMinute: 10 }, fetchImpl });
    await harness.service.set(USER_A, {
      provider: 'custom',
      model: 'gpt-4o-mini',
      apiKey: API_KEY,
      baseUrl: 'http://127.0.0.1:18099/v1',
    });
    return harness.service;
  };
  const networkFail = await setup(async () => {
    throw new Error('连接被拒绝');
  });
  assert.equal((await networkFail.check(USER_A)).errorCode, 'BYOK_CHECK_FAILED');

  const timeoutFail = await setup(async () => {
    const error = new Error('aborted');
    error.name = 'TimeoutError';
    throw error;
  });
  assert.equal((await timeoutFail.check(USER_A)).errorCode, 'BYOK_TIMEOUT');

  const emptyModels = await setup(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  assert.equal((await emptyModels.check(USER_A)).errorCode, 'BYOK_CHECK_FAILED');
});

test('探活限流：每用户 3 次/分钟（滑动窗口），未配置 → BYOK_NOT_CONFIGURED', async () => {
  let clock = Date.parse('2026-11-07T10:00:00Z');
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 });
  const { service } = makeHarness({
    config: { byokAllowLoopback: true, byokCheckPerMinute: 2 },
    fetchImpl,
    now: () => new Date(clock),
  });
  await assertByokError(service.check(USER_A), 'BYOK_NOT_CONFIGURED');

  await service.set(USER_A, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: API_KEY,
    baseUrl: 'http://127.0.0.1:18099/v1',
  });
  assert.equal((await service.check(USER_A)).ok, true);
  assert.equal((await service.check(USER_A)).ok, true);
  await assertByokError(service.check(USER_A), 'BYOK_CHECK_RATE_LIMITED');
  // 窗口过去后恢复。
  clock += BYOK_CHECK_WINDOW_MS + 1000;
  assert.equal((await service.check(USER_A)).ok, true);
});

test('anthropic 协议：探活带 x-api-key/anthropic-version 头', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const { service } = makeHarness({ fetchImpl, config: { byokCheckPerMinute: 10 } });
  await service.set(USER_A, { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: API_KEY });
  const result = await service.check(USER_A);
  assert.equal(result.ok, true);
  assert.equal(result.modelCount, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models');
  assert.equal(calls[0].init.headers['x-api-key'], API_KEY);
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal((await service.getSecret(USER_A)).protocol, 'anthropic');
});

test('remove 幂等；损坏的密钥文件按未配置处理；无配置 getMeta 为未配置', async () => {
  const { service, dataDir } = makeHarness();
  assert.equal((await service.getMeta(USER_A)).configured, false);
  assert.equal(await service.getSecret(USER_A), null);

  await service.set(USER_A, { provider: 'deepseek', model: 'deepseek-chat', apiKey: API_KEY });
  assert.deepEqual(await service.remove(USER_A), { removed: true });
  assert.deepEqual(await service.remove(USER_A), { removed: false });
  assert.equal((await service.getMeta(USER_A)).configured, false);
  assert.equal(await service.getSecret(USER_A), null);

  await service.set(USER_A, { provider: 'deepseek', model: 'deepseek-chat', apiKey: API_KEY });
  fs.writeFileSync(path.join(dataDir, 'users', USER_A, BYOK_SECRET_ENC_FILE_NAME), Buffer.from('corrupted'));
  assert.equal(await service.getSecret(USER_A), null);
});

test('redactSecrets：test-key-* / Bearer / x-api-key / 显式 key 均脱敏', () => {
  const text = `key=${API_KEY} header=Bearer ${API_KEY} x-api-key: ${API_KEY}`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(API_KEY));
  assert.ok(redacted.includes('test-key-***'));
  assert.ok(redacted.includes('Bearer ***'));
  assert.equal(redactSecrets(`raw ${API_KEY}`, API_KEY), 'raw ***');
});

test('resolveChatModelSource：AUTH=off / 非 byok 用户 / 开关关闭 / 无配置 → official；配置完整 → byok', async () => {
  const { service } = makeHarness();
  await service.set(USER_A, { provider: 'deepseek', model: 'deepseek-chat', apiKey: API_KEY });

  const base = {
    authMode: 'on',
    userId: USER_A,
    user: { id: USER_A, modelSource: 'byok' },
    byok: service,
    config: { byokEnabled: true },
    logger: createCapturingLogger(),
  };
  assert.equal((await resolveChatModelSource({ ...base, authMode: 'off' })).kind, 'official');
  assert.equal((await resolveChatModelSource({ ...base, user: { modelSource: 'official' } })).kind, 'official');
  assert.equal(
    (await resolveChatModelSource({ ...base, getByokEnabled: async () => false })).kind,
    'official',
  );
  assert.equal((await resolveChatModelSource({ ...base, byok: null })).kind, 'official');
  assert.equal((await resolveChatModelSource({ ...base, userId: USER_B })).kind, 'official');

  const resolved = await resolveChatModelSource({ ...base, getByokEnabled: async () => true });
  assert.equal(resolved.kind, 'byok');
  assert.equal(resolved.model, 'deepseek-chat');
  assert.equal(resolved.apiKey, API_KEY);
  assert.equal(resolved.baseUrl, 'https://api.deepseek.com/v1');
});

/* --------------------- 出站前 DNS 重校验（assertRequestUrl） --------------------- */

test('assertRequestUrl：公网域名/IPv6 通过并返回规范化 baseUrl', async () => {
  const { service } = makeHarness({ dnsLookup: async () => [{ address: '93.184.216.34' }] });
  assert.equal(await service.assertRequestUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
  assert.equal(await service.assertRequestUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(await service.assertRequestUrl('https://93.184.216.34'), 'https://93.184.216.34');
  assert.equal(
    await service.assertRequestUrl('https://[2606:4700:4700::1111]/v1'),
    'https://[2606:4700:4700::1111]/v1',
  );
});

test('assertRequestUrl：私网/回环/元数据/协议/端口/映射 IPv6 全部 → BYOK_ENDPOINT_INVALID', async () => {
  const { service } = makeHarness({ dnsLookup: async () => [{ address: '93.184.216.34' }] });
  const rejected = [
    'https://10.0.0.5/v1',
    'https://192.168.1.1/v1',
    'https://127.0.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://[::ffff:169.254.169.254]/v1',
    'https://[::ffff:a9fe:a9fe]/v1',
    'https://[::ffff:10.0.0.5]/v1',
    'https://[::ffff:a00:5]/v1',
    'http://api.example.com/v1',
    'https://api.example.com:8443/v1',
    'https://user:pass@api.example.com/v1',
    'https://api.example.com/v1?x=1',
  ];
  for (const baseUrl of rejected) {
    await assertByokError(service.assertRequestUrl(baseUrl), 'BYOK_ENDPOINT_INVALID');
  }
});

test('assertRequestUrl：DNS 解析失败 / 解析到私网 → BYOK_ENDPOINT_INVALID', async () => {
  const failing = makeHarness({
    dnsLookup: async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    },
  });
  await assertByokError(failing.service.assertRequestUrl('https://api.example.com/v1'), 'BYOK_ENDPOINT_INVALID');

  const privateDns = makeHarness({ dnsLookup: async () => [{ address: '10.0.0.5' }] });
  await assertByokError(privateDns.service.assertRequestUrl('https://api.example.com/v1'), 'BYOK_ENDPOINT_INVALID');

  const mixed = makeHarness({
    dnsLookup: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }],
  });
  await assertByokError(mixed.service.assertRequestUrl('https://api.example.com/v1'), 'BYOK_ENDPOINT_INVALID');
});

test('assertRequestUrl：DNS rebinding（保存时公网 → 出站时私网）被拒绝', async () => {
  let addresses = ['93.184.216.34'];
  const { service } = makeHarness({
    dnsLookup: async () => addresses.map((address) => ({ address })),
  });
  await service.set(USER_A, {
    provider: 'custom',
    model: 'gpt-test-1',
    apiKey: API_KEY,
    baseUrl: 'https://api.example.com/v1',
  });
  const secret = await service.getSecret(USER_A);
  assert.equal(secret.baseUrl, 'https://api.example.com/v1');

  // 保存后 DNS 被 rebinding 到内网：出站前重校验必须拒绝。
  addresses = ['10.0.0.5'];
  await assertByokError(service.assertRequestUrl(secret.baseUrl), 'BYOK_ENDPOINT_INVALID');

  // 恢复公网后重新放行（每次出站重新解析，不缓存结论）。
  addresses = ['93.184.216.34'];
  assert.equal(await service.assertRequestUrl(secret.baseUrl), 'https://api.example.com/v1');
});

test('assertRequestUrl：BYOK_ALLOW_LOOPBACK=on 时回环 http+端口放行（测试例外）', async () => {
  const { service } = makeHarness({
    config: { byokAllowLoopback: true },
    dnsLookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(await service.assertRequestUrl('http://127.0.0.1:18099/v1'), 'http://127.0.0.1:18099/v1');
  assert.equal(await service.assertRequestUrl('http://localhost:8080/v1'), 'http://localhost:8080/v1');

  const strict = makeHarness({ dnsLookup: async () => [{ address: '93.184.216.34' }] });
  await assertByokError(strict.service.assertRequestUrl('http://127.0.0.1:18099/v1'), 'BYOK_ENDPOINT_INVALID');
});

test('check：已存 baseUrl 在 fetch 前重校验，rebinding 时返回 BYOK_ENDPOINT_INVALID 且不发请求', async () => {
  let addresses = ['93.184.216.34'];
  let fetchCalls = 0;
  const { service } = makeHarness({
    dnsLookup: async () => addresses.map((address) => ({ address })),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await service.set(USER_A, {
    provider: 'custom',
    model: 'gpt-test-1',
    apiKey: API_KEY,
    baseUrl: 'https://api.example.com/v1',
  });
  // 正常路径：重校验通过 → 发起探活 fetch。
  const ok = await service.check(USER_A);
  assert.equal(ok.ok, true);
  assert.equal(fetchCalls, 1);

  // rebinding：出站前解析到私网 → 不发起 fetch，返回归一化错误码。
  addresses = ['10.0.0.5'];
  const blocked = await service.check(USER_A);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, 'BYOK_ENDPOINT_INVALID');
  assert.equal(blocked.modelCount, 0);
  assert.equal(fetchCalls, 1, '端点被拒时不得发起探活请求');
});

test('check：DNS 解析失败 → BYOK_ENDPOINT_INVALID（不暴露内部错误）', async () => {
  let fail = false;
  const { service } = makeHarness({
    dnsLookup: async () => {
      if (fail) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return [{ address: '93.184.216.34' }];
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  await service.set(USER_A, {
    provider: 'custom',
    model: 'gpt-test-1',
    apiKey: API_KEY,
    baseUrl: 'https://api.example.com/v1',
  });
  fail = true;
  const result = await service.check(USER_A);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'BYOK_ENDPOINT_INVALID');
  assert.ok(!JSON.stringify(result).includes(API_KEY));
});

/* --------------------- allowlist（BYOK_ALLOWED_MODELS / BYOK_ALLOWED_HOSTS） --------------------- */

test('allowlist：模型/主机不在白名单 → set 抛 BYOK_MODEL_NOT_ALLOWED / BYOK_HOST_NOT_ALLOWED', async () => {
  const service = makeHarness({
    dnsLookup: async () => [{ address: '93.184.216.34' }],
    config: { byokAllowedModels: ['gpt-4o-mini'], byokAllowedHosts: ['api.example.com'] },
  }).service;
  await service.set(USER_A, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: API_KEY,
    baseUrl: 'https://api.example.com/v1',
  });
  await assertByokError(
    service.set(USER_A, {
      provider: 'custom',
      model: 'gpt-4o',
      apiKey: API_KEY,
      baseUrl: 'https://api.example.com/v1',
    }),
    'BYOK_MODEL_NOT_ALLOWED',
  );
  await assertByokError(
    service.set(USER_A, {
      provider: 'custom',
      model: 'gpt-4o-mini',
      apiKey: API_KEY,
      baseUrl: 'https://api.other.com/v1',
    }),
    'BYOK_HOST_NOT_ALLOWED',
  );
  // 白名单为空 = 不限制（原有 set 行为不变）。
  const open = makeHarness({ config: { byokAllowLoopback: true } }).service;
  await open.set(USER_A, {
    provider: 'custom',
    model: 'any-model-1',
    apiKey: API_KEY,
    baseUrl: 'http://127.0.0.1:18099/v1',
  });
});

test('allowlist：check 前复核（管理员收紧白名单后旧配置探活被拒，不占探活窗口）', async () => {
  const dataDir = makeTmpDir('wild-byok-allowlist-');
  const logger = createCapturingLogger();
  const writer = createByokService({
    baseDataDir: dataDir,
    atRestKey: KEY,
    config: defaultConfig(),
    logger,
    transport: createFetchTransport(async () => {
      throw new Error('不应发起网络请求');
    }),
    dnsLookup: async () => [{ address: '93.184.216.34' }],
  });
  await writer.set(USER_A, {
    provider: 'custom',
    model: 'gpt-4o-mini',
    apiKey: API_KEY,
    baseUrl: 'https://api.example.com/v1',
  });

  const strict = createByokService({
    baseDataDir: dataDir,
    atRestKey: KEY,
    config: defaultConfig({ byokAllowedModels: ['gpt-4o'] }),
    logger,
    transport: createFetchTransport(async () => {
      throw new Error('不应发起网络请求');
    }),
    dnsLookup: async () => [{ address: '93.184.216.34' }],
  });
  await assertByokError(strict.check(USER_A), 'BYOK_MODEL_NOT_ALLOWED');

  const hostStrict = createByokService({
    baseDataDir: dataDir,
    atRestKey: KEY,
    config: defaultConfig({ byokAllowedHosts: ['api.other.com'] }),
    logger,
    transport: createFetchTransport(async () => {
      throw new Error('不应发起网络请求');
    }),
    dnsLookup: async () => [{ address: '93.184.216.34' }],
  });
  await assertByokError(hostStrict.check(USER_A), 'BYOK_HOST_NOT_ALLOWED');
});
