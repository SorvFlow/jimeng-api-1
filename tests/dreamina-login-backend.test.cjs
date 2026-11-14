const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const loader = require('./helpers/load-ts.cjs');

async function flush() {
  // The dashboard route deliberately starts a detached async task. Give its
  // promise chain a few turns without introducing a timing-dependent sleep.
  for (let i = 0; i < 8; i++) await delay(0);
}

function setup({ login }) {
  const calls = { status: [], runtime: [], token: [], cookie: [], progress: [], login: [] };
  const account = {
    id: 7,
    name: 'Dreamina test',
    login_username: 'user@example.com',
    login_password: 'encrypted-password',
    bitbrowser_profile_id: 'profile-7',
    proxy_url: 'http://127.0.0.1:8080',
    region: 'sg',
  };
  const db = {
    validateSession: session => session === 'session-1' ? 1 : null,
    getAccountById: id => Number(id) === account.id ? account : null,
    decryptSecret: value => value === account.login_password ? 'plain-password' : value,
    updateAccountLoginStatus: (...args) => calls.status.push(args),
    updateAccountLoginProgress: (...args) => calls.progress.push(args),
    updateAccountBitBrowserRuntime: (...args) => calls.runtime.push(args),
    updateAccountTokenAndCookie: (...args) => calls.token.push(args),
    updateAccountCookie: (...args) => calls.cookie.push(args),
  };
  class FakeBitBrowserClient {}
  const loginStub = async options => {
    calls.login.push(options);
    return login(options);
  };
  const load = loader({
    '@/lib/database.ts': db,
    '@/lib/logger.ts': { info() {}, warn() {}, error() {}, debug() {} },
    '@/api/controllers/core.ts': { getCredit() {}, request() {} },
    '@/lib/account-keeper.ts': { triggerHealthCheck() {}, triggerCreditsSync() {} },
    '@/lib/bitbrowser.ts': {
      __esModule: true,
      default: FakeBitBrowserClient,
      BitBrowserClient: FakeBitBrowserClient,
      discoverRunningDreaminaContext: async () => null,
      checkDreaminaLoginByCdp: async () => ({ status: 'failed' }),
      loginDreaminaViaBitBrowser: loginStub,
    },
    '@/lib/request/Request.ts': class Request {},
    '@/lib/response/Response.ts': class Response {
      constructor(body, options = {}) { this.body = body; this.statusCode = options.statusCode; }
    },
    '@/lib/exceptions/Exception.ts': class Exception extends Error {
      setHTTPStatusCode() { return this; }
    },
    '@/lib/consts/exceptions.ts': { SYSTEM_UNAUTHORIZED: [-1, 'unauthorized'] },
    '@/lib/http-status-codes.ts': { UNAUTHORIZED: 401 },
  });
  const route = load('@/api/routes/dashboard.ts').default.post['/accounts/bitbrowser/login'];
  const request = () => ({
    body: { id: account.id },
    headers: { cookie: 'session=session-1' },
  });
  return { calls, route, request, account };
}

test('登录任务立即返回 pending，窗口打开和阶段进度先落库，完成后保存会话', async () => {
  let resolveLogin;
  const loginPromise = new Promise(resolve => { resolveLogin = resolve; });
  const api = setup({
    login: async options => {
      options.onProgress?.('正在连接 BitBrowser');
      options.onOpened?.({ cdpPort: 19222, cdpWsUrl: undefined, userAgent: undefined });
      return loginPromise;
    },
  });

  const response = await api.route(api.request());
  assert.equal(response.success, true);
  assert.equal(response.pending, true);
  await flush();

  assert.deepEqual(api.calls.status[0], [7, 'logging_in', '登录任务已启动']);
  assert.ok(api.calls.login.length, 'detached login task should start');
  assert.equal(api.calls.login[0].proxyUrl, api.account.proxy_url, '自动登录必须传递账号代理上下文');
  assert.ok(api.calls.runtime.some(([id, runtime]) => id === 7 && runtime.cdp_port === 19222),
    'onOpened should persist the CDP port before login finishes');
  assert.ok(api.calls.progress.some(([id, message]) => id === 7 && message === '正在连接 BitBrowser'),
    'onProgress should expose the current phase in account progress');

  resolveLogin({
    status: 'ok', cdpPort: 19222, cdpWsUrl: 'ws://127.0.0.1:19222/devtools/page/7',
    userAgent: 'Dreamina test UA', cookies: 'sessionid=session-value; sid_tt=sid-value',
  });
  await flush();
  assert.ok(api.calls.runtime.some(([id, runtime]) => id === 7 && runtime.cdp_ws_url.includes('/devtools/page/7')));
  assert.deepEqual(api.calls.token.at(-1), [7, 'sg-session-value', 'sessionid=session-value; sid_tt=sid-value']);
  assert.deepEqual(api.calls.status.at(-1), [7, 'ok', '']);
});
test('登录异常会写入具体原因并释放防重锁，之后可以重试', async () => {
  let attempts = 0;
  const api = setup({
    login: async options => {
      attempts++;
      options.onProgress?.('正在打开 Dreamina');
      options.onOpened?.({ cdpPort: 19223 });
      if (attempts === 1) throw new Error('邮箱登录表单未出现');
      return { status: 'need_2fa', cdpPort: 19223, message: '等待验证码' };
    },
  });

  await api.route(api.request());
  await flush();
  assert.deepEqual(api.calls.status.at(-1), [7, 'failed', 'Dreamina 登录失败：邮箱登录表单未出现']);

  const retry = await api.route(api.request());
  assert.equal(retry.pending, true, 'completed task must be removed from loginTasks');
  await flush();
  assert.equal(attempts, 2);
  assert.deepEqual(api.calls.status.at(-1), [7, 'need_2fa', '等待验证码']);
});

test('自动登录遇到 dynamicIpUrl 时提示修复 Profile 代理配置', async () => {
  const api = setup({ login: async () => { throw new Error('请填写提取URL: dynamicIpUrl'); } });
  await api.route(api.request());
  await flush();

  const message = api.calls.status.at(-1)[2];
  assert.match(message, /代理配置不完整.*dynamicIpUrl/);
  assert.match(message, /改为直连\/静态代理/);
  assert.doesNotMatch(message, /CDP 端口可从 API 服务器访问/);
});

test('登录结果兼容不同 Dreamina 会话 Cookie 名称，并按优先级保存 token', async () => {
  const variants = [
    {
      name: 'sessionid_ss',
      cookies: 'sessionid_ss=ss-token; sid_tt=other-token',
      token: 'ss-token',
    },
    {
      name: 'sid_tt',
      cookies: 'sid_tt=sid-token; sid_guard=guard-token%7C1%7C2',
      token: 'sid-token',
    },
    {
      name: 'sid_guard',
      cookies: 'sid_guard=guard-token%7C1%7C2; csrftoken=csrf',
      token: 'guard-token',
    },
  ];

  for (const variant of variants) {
    const api = setup({
      login: async () => ({
        status: 'ok',
        cdpPort: 19224,
        cookies: variant.cookies,
      }),
    });

    await api.route(api.request());
    await flush();

    assert.deepEqual(
      api.calls.token.at(-1),
      [7, `sg-${variant.token}`, variant.cookies],
      `${variant.name} should be extracted as the account token`,
    );
    assert.equal(api.calls.cookie.length, 0, `${variant.name} should use token-and-cookie persistence`);
    assert.deepEqual(api.calls.status.at(-1), [7, 'ok', '']);
  }
});

test('空 Cookie 不写入空 token，也不会覆盖现有会话字段', async () => {
  const api = setup({
    login: async () => ({
      status: 'need_2fa',
      cdpPort: 19225,
      message: '等待验证码',
      cookies: '',
    }),
  });

  await api.route(api.request());
  await flush();

  assert.equal(api.calls.token.length, 0, 'empty Cookie must not create an empty token');
  assert.equal(api.calls.cookie.length, 0, 'empty Cookie must not overwrite the saved Cookie header');
  assert.deepEqual(api.calls.status.at(-1), [7, 'need_2fa', '等待验证码']);
});
