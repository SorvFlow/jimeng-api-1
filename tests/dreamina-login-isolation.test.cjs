const assert = require('node:assert/strict');
const { test } = require('node:test');
const loader = require('./helpers/load-ts.cjs');

function setup(overrides = {}) {
  const calls = { open: [], openAccounts: [], check: [], discovery: [], token: [], cookie: [], runtime: [], status: [], progress: [] };
  const account = {
    id: 9, name: 'manual-test', region: 'sg', login_username: 'manual@example.com',
    bitbrowser_profile_id: 'profile-9', bitbrowser_window_id: 'profile-9',
    cdp_port: 31009, cdp_ws_url: 'ws://127.0.0.1:31009/devtools/page/old',
    user_agent: 'saved-test-UA',
    ...overrides.account,
  };
  const db = {
    validateSession: () => 1,
    getAccountById: () => account,
    updateAccountLoginStatus: (...args) => calls.status.push(args),
    updateAccountLoginProgress: (...args) => calls.progress.push(args),
    updateAccountBitBrowserRuntime: (...args) => calls.runtime.push(args),
    updateAccountTokenAndCookie: (...args) => calls.token.push(args),
    updateAccountCookie: (...args) => calls.cookie.push(args),
  };
  class FakeBitBrowserClient {
    async openForAccount(id, account, onProgress) {
      calls.openAccounts.push(account);
      if (overrides.repairProgress) await onProgress?.('正在修复 BitBrowser 旧版无代理 Profile 配置');
      return this.open(id);
    }
    async open(id) {
      calls.open.push(id);
      if (overrides.openError) throw new Error(overrides.openError);
      return overrides.opened || { cdpPort: 32009 };
    }
  }
  const load = loader({
    '@/lib/database.ts': db,
    '@/lib/logger.ts': { info() {}, warn() {}, error() {}, debug() {} },
    '@/api/controllers/core.ts': {},
    '@/lib/account-keeper.ts': {},
    '@/lib/bitbrowser.ts': {
      __esModule: true, default: FakeBitBrowserClient,
      async discoverRunningDreaminaContext(...args) {
        calls.discovery.push(args);
        return { cdpPort: 39999, profileId: 'someone-else', pageWsUrl: 'ws://elsewhere' };
      },
      async checkDreaminaLoginByCdp(...args) {
        calls.check.push(args);
        const errors = overrides.checkErrors || [];
        if (errors.length) throw new Error(errors.shift());
        if (overrides.checkError) throw new Error(overrides.checkError);
        return overrides.result || {
          status: 'ok', cdpPort: args[0],
          cdpWsUrl: `ws://127.0.0.1:${args[0]}/devtools/page/current`,
          cookies: 'sessionid=manual-session; csrftoken=csrf', userAgent: 'current-test-UA',
        };
      },
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
  }, { process: { ...process, env: { ...process.env, DREAMINA_CDP_PORT: '39999' } } });
  const routes = load('@/api/routes/dashboard.ts').default.post;
  const route = routes['/accounts/bitbrowser/check-login'];
  return {
    calls, account,
    check: () => route({ body: { id: account.id }, headers: { cookie: 'session=test-session' } }),
    open: () => routes['/accounts/bitbrowser/open']({ body: { id: account.id }, headers: { cookie: 'session=test-session' } }),
  };
}

test('手动检测复用账号保存的 CDP，保存登录结果，不启动其他窗口', async () => {
  const api = setup();
  const response = await api.check();
  assert.equal(response.success, true);
  assert.deepEqual(api.calls.open, [], '检测正常 CDP 时不应启动 Profile');
  assert.deepEqual(api.calls.check, [[31009, 'ws://127.0.0.1:31009/devtools/page/old']]);
  assert.equal(api.calls.discovery.length, 0);
  assert.deepEqual(api.calls.token, [[9, 'sg-manual-session', 'sessionid=manual-session; csrftoken=csrf']]);
  assert.equal(api.calls.runtime[0][1].cdp_port, 31009);
  assert.equal(api.calls.runtime[0][1].bitbrowser_window_id, 'profile-9');
  assert.deepEqual(api.calls.status.at(-1), [9, 'ok', '']);
});

test('绑定窗口不可用时明确报错，不回退保存端口或其他账号窗口', async () => {
  const api = setup({ checkError: 'saved CDP unavailable', openError: 'profile unavailable' });
  const response = await api.check();
  assert.equal(response.statusCode, 500);
  assert.match(response.body.error, /绑定账号窗口.*profile unavailable/);
  assert.match(response.body.error, /CDP 端口/);
  assert.equal(api.calls.discovery.length, 0);
  assert.equal(api.calls.check.length, 1);
  assert.equal(api.calls.token.length, 0);
  assert.equal(api.calls.status.at(-1)[1], 'failed');
});

test('绑定 Profile 缺少动态代理提取 URL 时提示修复 Profile，不误报为 CDP 网络故障', async () => {
  const api = setup({ checkError: '请填写提取URL: dynamicIpUrl', openError: '请填写提取URL: dynamicIpUrl' });
  const response = await api.check();
  assert.equal(response.statusCode, 500);
  assert.match(response.body.error, /代理配置不完整.*dynamicIpUrl/);
  assert.match(response.body.error, /改为直连\/静态代理/);
  assert.doesNotMatch(response.body.error, /CDP 端口可从 API 服务器访问/);
  assert.equal(api.calls.status.at(-1)[1], 'failed');
});

test('打开绑定 Profile 遇到 dynamicIpUrl 时报告代理配置卡点', async () => {
  const api = setup({ openError: '请填写提取URL: dynamicIpUrl' });
  const response = await api.open();
  assert.equal(response.statusCode, 500);
  assert.match(response.body.error, /打开 BitBrowser失败：BitBrowser Profile 代理配置不完整/);
  assert.doesNotMatch(response.body.error, /CDP 端口可从 API 服务器访问/);
  assert.deepEqual(api.calls.status.at(-1), [9, 'failed', response.body.error]);
});

test('手动打开和检测均传入本账号代理上下文，并显示旧配置修复进度', async () => {
  for (const action of ['open', 'check']) {
    const api = setup({
      account: { proxy_url: 'http://127.0.0.1:8080', cdp_port: 0 },
      repairProgress: true,
    });
    const response = await api[action]();
    assert.equal(response.success, true);
    assert.equal(api.calls.openAccounts[0], api.account);
    assert.ok(api.calls.progress.some(([id, message]) => id === 9 && /修复.*旧版无代理/.test(message)));
    if (action === 'open') {
      assert.equal(api.calls.status.at(-1)[1], 'need_2fa');
      assert.match(api.calls.status.at(-1)[2], /已修复.*窗口已打开.*检测/);
    }
  }
});

test('只有账号专属 CDP 时只检测其保存端口，忽略全局端口', async () => {
  const api = setup({ account: { bitbrowser_profile_id: '', bitbrowser_window_id: '' } });
  const response = await api.check();
  assert.equal(response.success, true);
  assert.deepEqual(api.calls.check, [[31009, 'ws://127.0.0.1:31009/devtools/page/old']]);
  assert.equal(api.calls.open.length, 0);
  assert.equal(api.calls.discovery.length, 0);
});

test('没有绑定窗口和账号 CDP 时要求绑定，不把全局端口当作该账号', async () => {
  const api = setup({ account: { bitbrowser_profile_id: '', bitbrowser_window_id: '', cdp_port: 0, cdp_ws_url: '' } });
  const response = await api.check();
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /绑定 Profile/);
  assert.equal(api.calls.discovery.length, 0);
  assert.equal(api.calls.open.length, 0);
  assert.equal(api.calls.check.length, 0);
  assert.equal(api.calls.token.length, 0);
});

test('绑定窗口未登录时明确提示手动登录，且不以无会话 Cookie 覆盖已保存 Cookie', async () => {
  const api = setup({ result: { status: 'failed', cookies: 'csrftoken=new-csrf', cdpPort: 32009 } });
  const response = await api.check();
  assert.equal(response.success, false);
  assert.match(response.message, /绑定窗口.*完成登录/);
  assert.equal(api.calls.token.length, 0);
  assert.equal(api.calls.cookie.length, 0);
  assert.equal(api.calls.status.at(-1)[1], 'failed');
});

test('绑定窗口需人工验证时保留上游明确原因和旧会话', async () => {
  const api = setup({ result: { status: 'need_2fa', message: '请完成邮箱验证码', cdpPort: 32009 } });
  const response = await api.check();
  assert.equal(response.success, false);
  assert.equal(response.message, '请完成邮箱验证码');
  assert.deepEqual(api.calls.status.at(-1), [9, 'need_2fa', '请完成邮箱验证码']);
  assert.equal(api.calls.token.length, 0);
  assert.equal(api.calls.cookie.length, 0);
});

test('已保存 CDP 失效时只重新打开绑定 Profile 并更新其返回端口', async () => {
  const api = setup({
    checkErrors: ['saved CDP unavailable'],
    opened: { cdpPort: 32009, ws: 'ws://127.0.0.1:32009/devtools/browser/profile-9' },
  });
  const response = await api.check();
  assert.equal(response.success, true);
  assert.deepEqual(api.calls.open, ['profile-9']);
  assert.deepEqual(api.calls.check, [
    [31009, 'ws://127.0.0.1:31009/devtools/page/old'],
    [32009, undefined],
  ]);
  assert.equal(api.calls.runtime.at(-1)[1].cdp_port, 32009);
  assert.equal(api.calls.runtime.at(-1)[1].bitbrowser_window_id, 'profile-9');
});
