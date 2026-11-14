const assert = require('node:assert/strict');
const { test } = require('node:test');
const loader = require('./helpers/load-ts.cjs');

function clientFor({ apiBase = 'http://127.0.0.1:54345', openData = {}, openError, openResponses = [], detailResponse, proxyUpdateResponse, profiles, extraEnv = {}, createResponses = [] } = {}) {
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
          if (endpoint === '/browser/detail') {
            return detailResponse || { status: 200, data: { success: true, data: null } };
          }
          if (endpoint === '/browser/proxy/update') {
            return proxyUpdateResponse || { status: 200, data: { success: true, data: {} } };
          }
          if (endpoint === '/browser/open' && openResponses.length) return openResponses.shift();
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

test('新建直连 Profile 首次使用官方自定义无代理参数', async () => {
  const api = clientFor({ createResponses: [
    { status: 200, data: { success: true, data: { id: 'auto-created' } } },
  ] });

  const result = await api.client.createProfileForAccount({
    login_username: 'manual@example.com',
  });

  assert.equal(result.id, 'auto-created');
  const createCalls = api.calls.filter(call => call.endpoint === '/browser/update');
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].body.proxyMethod, 2);
  assert.equal(createCalls[0].body.proxyType, 'noproxy');
  assert.equal(Object.hasOwn(createCalls[0].body, 'dynamicIpUrl'), false);
});

test('新建直连 Profile 遇到 dynamicIpUrl 不省略代理字段进行第二次创建', async () => {
  const api = clientFor({ createResponses: [
    { status: 400, data: { success: false, msg: '请填写提取URL: dynamicIpUrl' } },
  ] });
  await assert.rejects(api.client.createProfileForAccount({ login_username: 'manual@example.com' }), /dynamicIpUrl/);
  assert.deepEqual(api.calls.map(call => call.endpoint), ['/browser/update']);
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

function legacyNoProxyDetail(overrides = {}) {
  return {
    id: 'legacy-profile',
    remark: 'auto-created by jimeng-api / hk',
    proxyMethod: 3,
    proxyType: 'noproxy',
    host: '',
    port: 0,
    proxyUserName: '',
    proxyPassword: '',
    dynamicIpUrl: '',
    isGlobalProxyInfo: false,
    ...overrides,
  };
}

function legacyProfileClient({ detail = legacyNoProxyDetail(), ...options } = {}) {
  return clientFor({
    openResponses: [
      { status: 400, data: { success: false, msg: '请填写提取URL: dynamicIpUrl' } },
      { status: 200, data: { success: true, data: { http: '127.0.0.1:39140' } } },
    ],
    detailResponse: { status: 200, data: { success: true, data: detail } },
    ...options,
  });
}

test('账号正常打开 Profile 时不读取详情或修改代理', async () => {
  const api = clientFor({ openData: { http: '127.0.0.1:39139' } });
  const result = await api.client.openForAccount('legacy-profile', { proxy_url: '' });
  assert.equal(result.cdpPort, 39139);
  assert.deepEqual(api.calls.map(call => call.endpoint), ['/browser/open']);
});

test('仅修复本系统自动创建的旧直连枚举，保留 Profile 并报告进度', async () => {
  const api = legacyProfileClient({ detail: legacyNoProxyDetail({ ipCheckService: 'ip123in' }) });
  const progress = [];
  const result = await api.client.openForAccount('legacy-profile', { proxy_url: '' }, message => progress.push(message));

  assert.equal(result.cdpPort, 39140);
  assert.deepEqual(api.calls.map(call => call.endpoint), [
    '/browser/open', '/browser/detail', '/browser/proxy/update', '/browser/open',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls[1].body)), { id: 'legacy-profile' });
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls[2].body)), {
    ids: ['legacy-profile'], ipCheckService: 'ip123in', proxyMethod: 2, proxyType: 'noproxy',
  });
  assert.equal(api.calls[3].body.id, 'legacy-profile');
  assert.match(progress.join(' '), /修复/);
});

test('修复旧直连配置时缺少 IP 查询渠道使用官方默认值', async () => {
  const api = legacyProfileClient();
  await api.client.openForAccount('legacy-profile', {});
  assert.equal(api.calls.find(call => call.endpoint === '/browser/proxy/update').body.ipCheckService, 'ip-api');
});

test('账号配置代理或非 dynamicIpUrl 打开错误不会读取详情及修改代理', async () => {
  const proxyAccount = legacyProfileClient();
  await assert.rejects(proxyAccount.client.openForAccount('legacy-profile', { proxy_url: 'http://proxy.example:8080' }), /dynamicIpUrl/);
  assert.deepEqual(proxyAccount.calls.map(call => call.endpoint), ['/browser/open']);

  const otherError = clientFor({ openError: 'profile is already opening' });
  await assert.rejects(otherError.client.openForAccount('legacy-profile', {}), /profile is already opening/);
  assert.deepEqual(otherError.calls.map(call => call.endpoint), ['/browser/open']);
});

test('详情无法证明旧错误直连配置时拒绝自动修改', async t => {
  const cases = [
    ['详情为空', null],
    ['Profile ID 不匹配', legacyNoProxyDetail({ id: 'other-profile' })],
    ['用户手动创建', legacyNoProxyDetail({ remark: 'manual profile' })],
    ['备注并非系统创建前缀', legacyNoProxyDetail({ remark: 'copy auto-created by jimeng-api / hk' })],
    ['已是自定义代理模式', legacyNoProxyDetail({ proxyMethod: 2 })],
    ['实际代理类型', legacyNoProxyDetail({ proxyType: 'http' })],
    ['实际代理主机', legacyNoProxyDetail({ host: 'proxy.example' })],
    ['实际代理端口', legacyNoProxyDetail({ port: 8080 })],
    ['存在代理用户名', legacyNoProxyDetail({ proxyUserName: 'proxy-user' })],
    ['存在代理密码', legacyNoProxyDetail({ proxyPassword: 'proxy-pass' })],
    ['存在动态提取 URL', legacyNoProxyDetail({ dynamicIpUrl: 'https://proxy.example/extract' })],
    ['使用全局代理', legacyNoProxyDetail({ isGlobalProxyInfo: true })],
  ];
  for (const [name, detail] of cases) {
    await t.test(name, async () => {
      const api = legacyProfileClient({ detail });
      await assert.rejects(api.client.openForAccount('legacy-profile', {}), /dynamicIpUrl/);
      assert.deepEqual(api.calls.map(call => call.endpoint), ['/browser/open', '/browser/detail']);
    });
  }
});

test('读取 Profile 详情失败时不会修改代理或重试打开', async () => {
  const api = legacyProfileClient({ detailResponse: { status: 400, data: { success: false, msg: 'detail unavailable' } } });
  await assert.rejects(api.client.openForAccount('legacy-profile', {}));
  assert.deepEqual(api.calls.map(call => call.endpoint), ['/browser/open', '/browser/detail']);
});

test('代理专用修复失败时停止，不回退全量更新或重试打开', async () => {
  const api = legacyProfileClient({ proxyUpdateResponse: { status: 400, data: { success: false, msg: 'proxy update denied' } } });
  await assert.rejects(api.client.openForAccount('legacy-profile', {}), /proxy update denied/);
  assert.deepEqual(api.calls.map(call => call.endpoint), ['/browser/open', '/browser/detail', '/browser/proxy/update']);
});

test('修复后再次打开失败时不会循环修复或再次创建窗口', async () => {
  const api = legacyProfileClient({ openResponses: [
    { status: 400, data: { success: false, msg: '请填写提取URL: dynamicIpUrl' } },
    { status: 400, data: { success: false, msg: 'second open failed: dynamicIpUrl' } },
  ] });
  await assert.rejects(api.client.openForAccount('legacy-profile', {}), /second open failed/);
  assert.deepEqual(api.calls.map(call => call.endpoint), [
    '/browser/open', '/browser/detail', '/browser/proxy/update', '/browser/open',
  ]);
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
