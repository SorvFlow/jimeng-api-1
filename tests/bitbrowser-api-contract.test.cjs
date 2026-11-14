const assert = require('node:assert/strict');
const { test } = require('node:test');
const loader = require('./helpers/load-ts.cjs');

function clientFor({ apiBase = 'http://127.0.0.1:54345', openData = {}, openError, profiles, extraEnv = {}, createResponses = [] } = {}) {
  const calls = [];
  const stubs = {
    ws: class WebSocket {},
    axios: {
      create: options => ({
        defaults: { baseURL: options.baseURL },
        post: async (endpoint, body) => {
          calls.push({ endpoint, body });
          if (endpoint === '/browser/list') {
            const start = (body.page - 1) * body.pageSize;
            return { status: 200, data: { success: true, data: { list: (profiles || []).slice(start, start + body.pageSize) } } };
          }
          if (endpoint === '/browser/update' && createResponses.length) {
            const response = createResponses.shift();
            return response;
          }
          if (openError) return { status: 400, data: { success: false, msg: openError } };
          return { status: 200, data: { success: true, data: openData } };
        },
      }),
    },
    '@/lib/database.ts': { getSetting: (_key, fallback = '') => fallback },
    '@/lib/logger.ts': { info() {}, warn() {}, error() {}, debug() {} },
    '@/lib/browser-fetch.ts': {
      cdpCall: async () => ({}),
      getCdpHttpBase: () => 'http://127.0.0.1:64896',
      getCdpTargets: async () => [],
      getGeneratePageWs: async () => '',
      rewriteCdpWsUrl: value => value,
    },
  };
  const load = loader(stubs, { process: { ...process, env: { ...process.env, BITBROWSER_API_BASE: apiBase, BITBROWSER_OPEN_ARGS: undefined, ...extraEnv } } });
  const mod = load('@/lib/bitbrowser.ts');
  return { client: new mod.BitBrowserClient(apiBase), calls };
}

test('BitBrowser open 使用官方 Local API 路径和对象参数并解析 http/ws 地址', async () => {
  const api = clientFor({
    openData: {
      http: 'http://127.0.0.1:39123',
      ws: 'ws://127.0.0.1:39123/devtools/browser/profile-1',
      seq: 7,
      name: 'profile-1',
    },
  });
  const result = await api.client.open('profile-1');
  assert.equal(api.calls[0].endpoint, '/browser/open');
  assert.equal(api.calls[0].body.id, 'profile-1');
  assert.ok(Array.isArray(api.calls[0].body.args));
  assert.equal(api.calls[0].body.args.includes('--remote-debugging-address=127.0.0.1'), true);
  assert.equal(result.cdpPort, 39123);
  assert.equal(result.seq, 7);
});

test('BitBrowser open 兼容 CDP 端口及 debuggerAddress 响应字段', async () => {
  for (const openData of [
    { cdpPort: 39231 },
    { cdp_port: 39232 },
    { debuggerAddress: '192.168.1.22:39234' },
    { debugger_address: '192.168.1.22:39235' },
  ]) {
    const api = clientFor({ openData });
    const result = await api.client.open('profile-2');
    assert.equal(result.cdpPort, Object.values(openData)[0] && Number(String(Object.values(openData)[0]).match(/(\d+)$/)[1]));
  }
});

test('远程 API 的 CDP 监听只绑定其明确 IPv4 地址，保留显式参数优先级', async () => {
  const api = clientFor({ apiBase: 'http://192.168.10.20:54345', openData: { http: '192.168.10.20:39124' } });
  await api.client.open('profile-3');
  assert.ok(api.calls[0].body.args.includes('--remote-debugging-address=192.168.10.20'));
  assert.ok(!api.calls[0].body.args.includes('--remote-debugging-address=0.0.0.0'));

  const explicit = clientFor({
    apiBase: 'http://192.168.10.20:54345',
    openData: { http: '192.168.10.20:39125' },
    extraEnv: { BITBROWSER_OPEN_ARGS: '--proxy-server=http://127.0.0.1:9000,--remote-debugging-address=10.0.0.5' },
  });
  await explicit.client.open('profile-3');
  assert.ok(explicit.calls[0].body.args.includes('--remote-debugging-address=10.0.0.5'));
  assert.ok(!explicit.calls[0].body.args.includes('--remote-debugging-address=192.168.10.20'));

  const publicHost = clientFor({ apiBase: 'https://203.0.113.5:54345', openData: { http: '203.0.113.5:39126' } });
  await publicHost.client.open('profile-3');
  assert.ok(!publicHost.calls[0].body.args.some(arg => arg.startsWith('--remote-debugging-address=')),
    'public API addresses must not cause an unauthenticated public CDP listener');
});

test('BitBrowser API 错误响应按 msg 失败，不伪装成空窗口', async () => {
  const api = clientFor({ openError: 'profile is already opening' });
  await assert.rejects(api.client.open('profile-4'), /profile is already opening/);
});

test('无代理 Profile 遇到 dynamicIpUrl 要求时省略代理字段重试', async () => {
  const api = clientFor({ createResponses: [
    { status: 400, data: { success: false, msg: '请填写提取URL: dynamicIpUrl' } },
    { status: 200, data: { success: true, data: { id: 'auto-created' } } },
  ] });

  const result = await api.client.createProfileForAccount({
    login_username: 'manual@example.com',
  });

  assert.equal(result.id, 'auto-created');
  const createCalls = api.calls.filter(call => call.endpoint === '/browser/update');
  assert.equal(createCalls.length, 2);
  assert.equal(createCalls[0].body.proxyMethod, 3);
  assert.equal(createCalls[0].body.proxyType, 'noproxy');
  assert.equal(Object.hasOwn(createCalls[1].body, 'proxyMethod'), false);
  assert.equal(Object.hasOwn(createCalls[1].body, 'proxyType'), false);
  assert.equal(Object.hasOwn(createCalls[1].body, 'dynamicIpUrl'), false);
});

test('显式代理遇到 dynamicIpUrl 不会被重试为无代理', async () => {
  const api = clientFor({ createResponses: [
    { status: 400, data: { success: false, msg: '请填写提取URL: dynamicIpUrl' } },
  ] });

  await assert.rejects(
    api.client.createProfileForAccount({
      login_username: 'proxy@example.com',
      proxy_url: 'http://proxy-user:proxy-pass@127.0.0.1:8080',
    }),
    /dynamicIpUrl/,
  );

  const createCalls = api.calls.filter(call => call.endpoint === '/browser/update');
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].body.proxyMethod, 2);
  assert.equal(createCalls[0].body.host, '127.0.0.1');
});

test('无代理 Profile 遇到其他 BitBrowser 错误不会触发第二次创建', async () => {
  const api = clientFor({ createResponses: [
    { status: 400, data: { success: false, msg: 'invalid profile name' } },
  ] });

  await assert.rejects(
    api.client.createProfileForAccount({ login_username: 'invalid@example.com' }),
    /invalid profile name/,
  );
  assert.equal(api.calls.filter(call => call.endpoint === '/browser/update').length, 1);
});

test('Profile 自动绑定只接受唯一精确匹配，不按相似名称猜账号', async () => {
  const unique = clientFor({ profiles: [
    { id: 'other', name: 'manual@example.com-archive' },
    { id: 'exact', name: 'manual@example.com' },
  ] });
  assert.equal((await unique.client.findProfileForAccount({ login_username: 'Manual@example.com' })).id, 'exact');

  const ambiguous = clientFor({ profiles: [
    { id: 'one', userName: 'manual@example.com' },
    { id: 'two', name: 'manual@example.com' },
  ] });
  await assert.rejects(
    ambiguous.client.findProfileForAccount({ login_username: 'manual@example.com' }),
    /多个 Profile 精确匹配/,
  );

  const partial = clientFor({ profiles: [{ id: 'partial', name: 'manual@example.com-archive' }] });
  assert.equal(await partial.client.findProfileForAccount({ login_username: 'manual@example.com' }), null);
});
