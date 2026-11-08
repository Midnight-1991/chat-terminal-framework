// pinned HTTP 传输层单测（DNS 钉扎 / 地址校验 / 不跟随重定向 / 超时中止）。
// 真实网络仅限本机 127.0.0.1 假上游（BYOK_ALLOW_LOOPBACK 语义）：验证连接实际落在已校验 IP。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ByokError } from '../../server/byok-providers.mjs';
import {
  createAddressValidator,
  createPinnedLookup,
  createPinnedTransport,
  isAllowedAddress,
  isForbiddenHostname,
  isForbiddenIPv4,
  isForbiddenIPv6,
  isLoopbackAddress,
  parseIPv6Bytes,
  pinnedReadText,
  pinnedRequest,
} from '../../server/pinned-http.mjs';

/* ------------------------------ 地址级校验 ------------------------------ */

test('地址校验：私网/回环/元数据/CGNAT/组播 IPv4 全部拒绝，公网放行', () => {
  const rejected = [
    '0.0.0.0',
    '10.0.0.5',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ];
  for (const address of rejected) assert.equal(isAllowedAddress(address), false, `${address} 应拒绝`);
  const allowed = ['9.9.9.9', '8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1'];
  for (const address of allowed) assert.equal(isAllowedAddress(address), true, `${address} 应放行`);
  assert.equal(isForbiddenIPv4([10, 0, 0, 1]), true);
  assert.equal(isForbiddenIPv4([93, 184, 216, 34]), false);
});

test('地址校验：IPv6 回环/ULA/链路本地/组播/NAT64/6to4/Teredo 与 IPv4 映射全部拒绝', () => {
  const rejected = [
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:10.0.0.5',
    '::ffff:a00:5',
    '::ffff:192.168.1.1',
    '64:ff9b::a00:5',
    '64:ff9b:1::1',
    '2002:0a00:0001::1',
    '2001:0:1234::1',
  ];
  for (const address of rejected) assert.equal(isAllowedAddress(address), false, `${address} 应拒绝`);
  const allowed = ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808'];
  for (const address of allowed) assert.equal(isAllowedAddress(address), true, `${address} 应放行`);
  // WHATWG URL 会把 [::ffff:127.0.0.1] 规范化为 [::ffff:7f00:1]：两种形式都必须识别。
  assert.deepEqual(parseIPv6Bytes('::ffff:7f00:1')?.slice(12), [127, 0, 0, 1]);
  assert.deepEqual(parseIPv6Bytes('::ffff:127.0.0.1')?.slice(12), [127, 0, 0, 1]);
  assert.equal(isForbiddenIPv6('::ffff:7f00:1'), true);
  assert.equal(isForbiddenIPv6('2606:4700:4700::1111'), false);
});

test('主机名静态规则：localhost/.internal/.local/metadata 拒绝', () => {
  for (const hostname of ['localhost', 'app.localhost', 'metadata.google.internal', 'db.internal', 'printer.local']) {
    assert.equal(isForbiddenHostname(hostname), true, `${hostname} 应拒绝`);
  }
  assert.equal(isForbiddenHostname('api.example.com'), false);
});

test('回环校验：127/8、::1、::ffff:127/8 识别（仅 BYOK_ALLOW_LOOPBACK 例外使用）', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isLoopbackAddress(address), true, `${address} 应识别为回环`);
  }
  for (const address of ['10.0.0.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isLoopbackAddress(address), false, `${address} 不应识别为回环`);
  }
  const strict = createAddressValidator();
  const allowLoopback = createAddressValidator({ allowLoopback: true });
  assert.equal(strict('127.0.0.1'), false);
  assert.equal(allowLoopback('127.0.0.1'), true);
  assert.equal(allowLoopback('10.0.0.1'), false, '回环例外不得放行内网');
  assert.equal(allowLoopback('169.254.169.254'), false, '回环例外不得放行云元数据');
});

/* ------------------------------ DNS 钉扎 lookup ------------------------------ */

function callLookup(lookup, hostname, options = {}) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else if (Array.isArray(address)) resolve(address); // options.all=true：cb(null, addresses)
      else resolve({ address, family });
    });
  });
}

test('pinned lookup：一次解析（all:true）→ 逐地址校验 → 只返回第一个合法地址', async () => {
  const calls = [];
  const lookup = createPinnedLookup({
    dnsLookup: async (hostname, options) => {
      calls.push({ hostname, options });
      return [
        { address: '10.0.0.5', family: 4 }, // 私网，跳过
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.1', family: 4 }, // 私网，跳过
      ];
    },
  });
  const result = await callLookup(lookup, 'api.example.com');
  assert.deepEqual(result, { address: '93.184.216.34', family: 4 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, 'api.example.com');
  assert.equal(calls[0].options.all, true, '必须一次解析全部地址后逐地址校验');
});

test('pinned lookup：全部地址非法 → BYOK_ENDPOINT_INVALID（不发连接）', async () => {
  const privateOnly = createPinnedLookup({
    dnsLookup: async () => [
      { address: '10.0.0.5', family: 4 },
      { address: '::1', family: 6 },
    ],
  });
  await assert.rejects(callLookup(privateOnly, 'api.example.com'), (error) => {
    assert.ok(error instanceof ByokError);
    assert.equal(error.code, 'BYOK_ENDPOINT_INVALID');
    return true;
  });

  // mixed 解析结果里只要有一个合法地址即可连接（钉扎到合法地址，不连非法地址）。
  const mixed = createPinnedLookup({
    dnsLookup: async () => [
      { address: '10.0.0.5', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
  });
  assert.deepEqual(await callLookup(mixed, 'api.example.com'), {
    address: '2606:4700:4700::1111',
    family: 6,
  });
});

test('pinned lookup：options.all=true 返回合法地址数组（兼容 happy-eyeballs）', async () => {
  const lookup = createPinnedLookup({
    dnsLookup: async () => [
      { address: '10.0.0.5', family: 4 },
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
  });
  const result = await callLookup(lookup, 'api.example.com', { all: true });
  assert.deepEqual(result, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
});

test('pinned lookup：IP 字面量不经 DNS，仍按 validator 校验；回环例外只放行回环', async () => {
  const calls = [];
  const lookup = createPinnedLookup({
    dnsLookup: async () => {
      calls.push('dns');
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });
  assert.deepEqual(await callLookup(lookup, '93.184.216.34'), { address: '93.184.216.34', family: 4 });
  assert.equal(calls.length, 0, 'IP 字面量不应发起 DNS 解析');
  await assert.rejects(callLookup(lookup, '10.0.0.5'), (error) => error.code === 'BYOK_ENDPOINT_INVALID');
  await assert.rejects(callLookup(lookup, '::ffff:7f00:1'), (error) => error.code === 'BYOK_ENDPOINT_INVALID');

  const allowLoopback = createPinnedLookup({ validator: createAddressValidator({ allowLoopback: true }) });
  assert.deepEqual(await callLookup(allowLoopback, '127.0.0.1'), { address: '127.0.0.1', family: 4 });
  await assert.rejects(callLookup(allowLoopback, '10.0.0.5'), (error) => error.code === 'BYOK_ENDPOINT_INVALID');
});

test('pinned lookup：DNS 解析失败时透传原始错误（由调用方归一化）', async () => {
  const lookup = createPinnedLookup({
    dnsLookup: async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    },
  });
  await assert.rejects(callLookup(lookup, 'nope.example.com'), (error) => error.code === 'ENOTFOUND');
});

/* ------------------------------ 真实本机 HTTP 传输 ------------------------------ */

function startHttpServer(t, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
    server.once('error', reject);
  });
}

function loopbackTransport() {
  return createPinnedTransport({ allowLoopback: true });
}

test('pinnedRequest（真实本机上游）：Host 保持原 host、连接落在已校验 IP、GET/POST 正文正确', async (t) => {
  const seen = [];
  const upstream = await startHttpServer(t, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        remoteAddress: req.socket.remoteAddress,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/v1/chat') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"ok":true}\n\ndata: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const transport = loopbackTransport();
  const read = await transport.readText({
    url: `${upstream.baseUrl}/v1/models`,
    headers: { authorization: 'Bearer test-key-test-abc' },
  });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), { ok: true });
  assert.equal(seen[0].host, `127.0.0.1:${upstream.port}`, 'Host 头必须保持 URL 原始 host');
  assert.equal(seen[0].remoteAddress, '127.0.0.1', '连接必须落在已校验 IP');
  assert.equal(seen[0].authorization, 'Bearer test-key-test-abc');

  const streamed = await transport.request({
    url: `${upstream.baseUrl}/v1/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.equal(streamed.statusCode, 200);
  const chunks = [];
  for await (const chunk of streamed.stream) chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString('utf8'), /\[DONE\]/);
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].body, JSON.stringify({ hello: 'world' }));
  assert.equal(seen[1].contentLength, String(Buffer.byteLength(JSON.stringify({ hello: 'world' }))));
  assert.equal(seen[1].contentType, 'application/json');
});

test('pinnedRequest：不跟随重定向（3xx 原样返回，重定向目标不会收到请求）', async (t) => {
  let targetHits = 0;
  const target = await startHttpServer(t, (req, res) => {
    targetHits += 1;
    res.writeHead(200);
    res.end('should not be reached');
  });
  const redirector = await startHttpServer(t, (req, res) => {
    res.writeHead(302, { location: `${target.baseUrl}/steal` });
    res.end('redirect');
  });
  const response = await loopbackTransport().readText({ url: `${redirector.baseUrl}/v1/models` });
  assert.equal(response.statusCode, 302);
  assert.equal(response.text, 'redirect');
  assert.equal(targetHits, 0, 'pinned 传输不得跟随重定向');
});

test('pinnedRequest：超时 → ByokError BYOK_TIMEOUT（连接与流读取都覆盖）', async (t) => {
  const neverRespond = await startHttpServer(t, () => {
    /* 不响应，等待超时 */
  });
  const transport = loopbackTransport();
  await assert.rejects(transport.request({ url: `${neverRespond.baseUrl}/v1/models`, timeoutMs: 80 }), (error) => {
    assert.ok(error instanceof ByokError);
    assert.equal(error.code, 'BYOK_TIMEOUT');
    return true;
  });

  const stallBody = await startHttpServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"partial":true}\n\n'); // 已发响应头/部分正文，但永不结束
  });
  await assert.rejects(
    transport.readText({ url: `${stallBody.baseUrl}/v1/chat`, timeoutMs: 80 }),
    (error) => error.code === 'BYOK_TIMEOUT',
  );
});

test('pinnedRequest：外部 signal abort → AbortError（客户端断开场景）', async (t) => {
  const stalling = await startHttpServer(t, (req, res) => {
    res.writeHead(200);
    res.write('partial');
    /* 不结束 */
  });
  const controller = new AbortController();
  const pending = loopbackTransport().readText({
    url: `${stalling.baseUrl}/v1/chat`,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(pending, (error) => {
    assert.equal(error?.name, 'AbortError');
    return true;
  });
});

test('地址级拒绝：未开 BYOK_ALLOW_LOOPBACK 时回环/私网/映射 IPv6 在连接前被拒', async (t) => {
  let hits = 0;
  const upstream = await startHttpServer(t, (req, res) => {
    hits += 1;
    res.writeHead(200);
    res.end('ok');
  });
  const strict = createPinnedTransport();
  // 未开回环例外时 http 协议本身就不允许（BYOK 只允许 https；URL 层先拒）。
  await assert.rejects(strict.request({ url: `${upstream.baseUrl}/v1/models` }), (error) => {
    assert.ok(error instanceof ByokError);
    assert.equal(error.code, 'BYOK_URL_INVALID');
    return true;
  });
  await assert.rejects(strict.request({ url: 'https://127.0.0.1/v1/models' }), (error) => {
    assert.equal(error.code, 'BYOK_ENDPOINT_INVALID');
    return true;
  });
  await assert.rejects(strict.request({ url: 'https://[::ffff:7f00:1]/v1/models' }), (error) => {
    assert.equal(error.code, 'BYOK_ENDPOINT_INVALID');
    return true;
  });
  // 非 loopback 的 http 一律拒绝（BYOK 只允许 https，回环测试例外除外）。
  await assert.rejects(strict.request({ url: 'http://api.example.com/v1' }), (error) => {
    assert.equal(error.code, 'BYOK_URL_INVALID');
    return true;
  });
  assert.equal(hits, 0, '被拒的地址不得建立连接');
});

test('模块级 pinnedRequest/pinnedReadText：默认传输不开回环例外', async (t) => {
  let hits = 0;
  const upstream = await startHttpServer(t, (req, res) => {
    hits += 1;
    res.writeHead(200);
    res.end('ok');
  });
  await assert.rejects(pinnedRequest({ url: `${upstream.baseUrl}/v1` }), (error) => {
    assert.ok(error instanceof ByokError);
    return true;
  });
  await assert.rejects(pinnedReadText({ url: `${upstream.baseUrl}/v1` }), (error) => {
    assert.equal(error.code, 'BYOK_URL_INVALID');
    return true;
  });
  assert.equal(hits, 0);
});
