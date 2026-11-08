import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { startServer, createFakeRetriever, createFetchMock, sseResponse, standardUpstreamEvents, postChat, makeTmpDir, writeFile } from './helpers.mjs';
import { readApiKeyFromCredentials, resolveApiKey } from '../../server/config.mjs';

function credentialFile(content) {
  const dir = makeTmpDir('wild-cred-');
  return writeFile(dir, '.credentials.yaml', content);
}

test('凭据文件解析：取 DEEPSEEK_API_KEY（兼容引号/注释）', () => {
  const file = credentialFile(
    ['# 本地凭据，勿提交', 'refs:', '  DEEPSEEK_API_KEY: test-key-cred-abc123  # 行内注释', '  OTHER_KEY: xyz'].join('\n'),
  );
  assert.equal(readApiKeyFromCredentials(file), 'test-key-cred-abc123');
  assert.equal(readApiKeyFromCredentials('/no/such/file.yaml'), null);

  const quoted = credentialFile('refs:\n  DEEPSEEK_API_KEY: "test-key-quoted-1"\n');
  assert.equal(readApiKeyFromCredentials(quoted), 'test-key-quoted-1');
});

test('resolveApiKey：env 优先于凭据文件；都缺省时为空', () => {
  const file = credentialFile('refs:\n  DEEPSEEK_API_KEY: test-key-from-file\n');
  assert.deepEqual(resolveApiKey({ DEEPSEEK_API_KEY: 'test-key-from-env' }, { credentialPath: file }), {
    apiKey: 'test-key-from-env',
    source: 'env',
  });
  assert.deepEqual(resolveApiKey({ DEEPSEEK_API_KEY: '  ' }, { credentialPath: file }), {
    apiKey: 'test-key-from-file',
    source: 'credentials',
  });
  assert.deepEqual(resolveApiKey({}, { credentialPath: '/no/such/file.yaml' }), {
    apiKey: '',
    source: 'none',
  });
});

test('环境变量为空时回退凭据文件，上游请求使用该 key', async (t) => {
  const credentialPath = credentialFile('refs:\n  DEEPSEEK_API_KEY: test-key-cred-file-777\n');
  const mock = createFetchMock(() => sseResponse(standardUpstreamEvents()));
  const { baseUrl, ctx, logger } = await startServer(t, {
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([]),
    env: { DEEPSEEK_API_KEY: '' },
    credentialPath,
  });

  assert.equal(ctx.config.apiKeySource, 'credentials');
  const { events, text } = await postChat(baseUrl, { message: '孤独' });
  assert.equal(events.at(-1).event, 'done');
  assert.equal(mock.last().init.headers['x-api-key'], 'test-key-cred-file-777');

  const logs = logger.logs.map((entry) => entry.text).join('\n');
  assert.ok(!text.includes('test-key-cred-file-777'), 'SSE 响应不得泄漏 key');
  assert.ok(!logs.includes('test-key-cred-file-777'), '日志不得泄漏 key');
});

test('环境变量存在时优先使用 env key（不读凭据文件）', async (t) => {
  const credentialPath = credentialFile('refs:\n  DEEPSEEK_API_KEY: test-key-should-not-be-used\n');
  const mock = createFetchMock(() => sseResponse(standardUpstreamEvents()));
  const { baseUrl, ctx } = await startServer(t, {
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([]),
    env: { DEEPSEEK_API_KEY: 'test-key-env-wins' },
    credentialPath: path.join(credentialPath, '..', '.credentials.yaml'),
  });

  assert.equal(ctx.config.apiKeySource, 'env');
  await postChat(baseUrl, { message: '孤独' });
  assert.equal(mock.last().init.headers['x-api-key'], 'test-key-env-wins');
});

test('env 与凭据都缺失时：key 为空，chat 返回 UPSTREAM error 事件（不发上游请求）', async (t) => {
  const mock = createFetchMock(() => assert.fail('缺 key 不应发上游请求'));
  const { baseUrl, ctx } = await startServer(t, {
    fetchImpl: mock.fetchImpl,
    retriever: createFakeRetriever([]),
    env: { DEEPSEEK_API_KEY: '' },
  });
  assert.equal(ctx.config.apiKeySource, 'none');
  const { events } = await postChat(baseUrl, { message: '孤独' });
  assert.equal(mock.calls.length, 0);
  assert.equal(events[0].event, 'meta');
  const errorEvent = events.find((event) => event.event === 'error');
  assert.ok(errorEvent);
  assert.match(errorEvent.data.message, /DEEPSEEK_API_KEY/);
});
