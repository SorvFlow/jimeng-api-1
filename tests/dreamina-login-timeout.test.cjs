const assert = require('node:assert/strict');
const { test } = require('node:test');
const loader = require('./helpers/load-ts.cjs');

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.instances.length > 1) queueMicrotask(() => this.onopen?.());
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  removeEventListener(name, handler) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== handler));
  }

  on(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
    return this;
  }

  once(name, handler) {
    const wrapped = (...args) => {
      this.removeListener(name, wrapped);
      handler(...args);
    };
    return this.on(name, wrapped);
  }

  removeListener(name, handler) {
    this.removeEventListener(name, handler);
    return this;
  }

  close() {
    this.readyState = 3;
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

test('automation timeout prevents late progress, page refresh and opened callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  FakeWebSocket.instances = [];

  const startTime = Date.now();
  const calls = { targets: 0, cdp: [], progress: [], opened: [] };
  const target = url => ({
    type: 'page',
    url,
    webSocketDebuggerUrl: 'ws://127.0.0.1:64896/devtools/page/dreamina',
  });
  const load = loader({
    ws: FakeWebSocket,
    axios: {
      create: () => ({
        post: async path => path === '/browser/open'
          ? { data: { success: true, data: { http: 'http://127.0.0.1:64896' } } }
          : { data: { success: true, data: {} } },
      }),
    },
    '@/lib/database.ts': { getSetting: (_key, fallback = '') => fallback },
    '@/lib/logger.ts': { info() {}, warn() {}, error() {}, debug() {} },
    '@/lib/browser-fetch.ts': {
      cdpCall: async (_ws, method, params = {}) => {
        calls.cdp.push(method);
        if (method === 'Runtime.evaluate' && String(params.expression).includes('ready: document.readyState')) {
          return { result: { value: { ready: 'complete', hasBody: true, textLength: 100, controls: 1 } } };
        }
        if (method === 'Runtime.evaluate' && String(params.expression).includes('JSON.stringify({')) {
          return { result: { value: JSON.stringify({
            url: 'https://dreamina.capcut.com/ai-tool/home',
            title: 'Dreamina', text: '', cookies: '', ua: 'test UA',
          }) } };
        }
        if (method === 'Runtime.evaluate' && String(params.expression).includes('querySelectorAll(\'input\')')) {
          return { result: { value: true } };
        }
        if (method === 'Runtime.evaluate' && String(params.expression).includes('(async()=>')) {
          return { result: { value: {
            hasUser: true, hasPass: true, userSet: true, passSet: true, submitted: true,
            trace: ['filled-email', 'filled-password', 'submitted-password-step:Continue'],
          } } };
        }
        if (method === 'Runtime.evaluate') {
          return { result: { value: JSON.stringify({
            url: 'https://dreamina.capcut.com/ai-tool/home',
            title: 'Dreamina', text: '', cookies: '', ua: 'test UA',
          }) } };
        }
        if (method === 'Network.getAllCookies') return { cookies: [] };
        return {};
      },
      getCdpTargets: async () => {
        calls.targets++;
        const url = Date.now() >= startTime + 120000
          ? 'https://dreamina.capcut.com/ai-tool/login'
          : 'https://dreamina.capcut.com/ai-tool/home';
        return [target(url)];
      },
      rewriteCdpWsUrl: (url, port) => String(url).replace(/:\d+\//, `:${port}/`),
      getCdpHttpBase: () => 'http://127.0.0.1:64896',
      getGeneratePageWs: async () => 'ws://127.0.0.1:64896/devtools/page/dreamina',
    },
  });
  const api = load('@/lib/bitbrowser.ts');

  const previousSettleMs = process.env.DREAMINA_LOGIN_SETTLE_MS;
  process.env.DREAMINA_LOGIN_SETTLE_MS = '150000';
  t.after(() => {
    if (previousSettleMs === undefined) delete process.env.DREAMINA_LOGIN_SETTLE_MS;
    else process.env.DREAMINA_LOGIN_SETTLE_MS = previousSettleMs;
  });

  const pending = api.loginDreaminaViaBitBrowser({
    bitbrowserProfileId: 'profile-1',
    username: 'user@example.com',
    password: 'secret',
    onProgress: message => calls.progress.push(message),
    onOpened: runtime => calls.opened.push(runtime),
  });
  await flushMicrotasks();
  const automationSocket = FakeWebSocket.instances[0];
  assert.ok(automationSocket, 'automation CDP socket should be created');
  automationSocket.onopen();
  for (let i = 0; i < 100 && !calls.progress.includes('等待验证码或二次验证'); i++) {
    t.mock.timers.tick(100);
    await flushMicrotasks();
  }
  assert.ok(calls.progress.includes('等待验证码或二次验证'), `flow should enter the settle wait: ${JSON.stringify({ progress: calls.progress, cdp: calls.cdp, targets: calls.targets })}`);
  await flushMicrotasks();

  t.mock.timers.tick(Math.max(0, startTime + 120000 - Date.now()));
  await assert.rejects(pending, /Dreamina login automation timeout/);
  const progressAtTimeout = [...calls.progress];
  const targetScansAtTimeout = calls.targets;
  const openedCallbacksAtTimeout = calls.opened.length;
  const cdpCallsAtTimeout = [...calls.cdp];

  t.mock.timers.tick(30300);
  await flushMicrotasks();

  assert.deepEqual(calls.progress, progressAtTimeout, 'late automation must not report more progress');
  assert.ok(!calls.progress.includes('正在保存登录状态'), 'timed-out automation must not report a save stage');
  assert.equal(calls.targets, targetScansAtTimeout, 'timed-out automation must not rediscover or refresh the page');
  assert.equal(calls.opened.length, openedCallbacksAtTimeout, 'timed-out automation must not publish a new page runtime');
  assert.deepEqual(calls.cdp, cdpCallsAtTimeout, 'timed-out automation must not issue more CDP commands');
  assert.equal(automationSocket.readyState, 3, 'timeout should close the automation socket');
});
