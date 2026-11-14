const assert = require('node:assert/strict');
const { test } = require('node:test');
const loader = require('./helpers/load-ts.cjs');

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }
  removeEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    this.listeners.set(name, handlers.filter(item => item !== handler));
  }
  close() {}
}

class LifecycleWebSocket {
  static behavior = 'close';
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = new Map();
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }
  removeEventListener(name, handler) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== handler));
  }
  emit(name, value) {
    for (const handler of [...(this.listeners.get(name) || [])]) handler(value);
  }
  send() {
    if (LifecycleWebSocket.behavior === 'close') queueMicrotask(() => {
      this.readyState = 3;
      this.emit('close');
    });
    else if (LifecycleWebSocket.behavior === 'error') queueMicrotask(() => this.emit('error'));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close'));
  }
}

function loadBitbrowser({ targets, snapshot, cookies, getAllCookiesError = false } = {}) {
  const calls = [];
  const load = loader({
    ws: FakeWebSocket,
    axios: { create: () => ({}) },
    '@/lib/database.ts': { getSetting: (_key, fallback = '') => fallback },
    '@/lib/logger.ts': { info() {}, warn() {}, error() {}, debug() {} },
    '@/lib/browser-fetch.ts': {
      cdpCall: async (_ws, method) => {
        calls.push(method);
        if (method === 'Runtime.evaluate') {
          return { result: { value: JSON.stringify(snapshot || {
            url: 'https://dreamina.capcut.com/ai-tool/home',
            title: 'Dreamina', text: '', cookies: '', ua: 'test UA',
          }) } };
        }
        if (method === 'Network.getAllCookies') {
          if (getAllCookiesError) throw new Error('Network.getAllCookies unavailable');
          return { cookies: cookies || [] };
        }
        return {};
      },
      getCdpTargets: async () => targets || [{
        type: 'page',
        url: 'https://dreamina.capcut.com/ai-tool/home',
        webSocketDebuggerUrl: 'ws://127.0.0.1:64896/devtools/page/dreamina',
      }],
      rewriteCdpWsUrl: (url, port) => String(url).replace(/:\d+\//, `:${port}/`),
      getCdpHttpBase: () => 'http://127.0.0.1:64896',
      getGeneratePageWs: async () => 'ws://127.0.0.1:64896/devtools/page/dreamina',
    },
  });
  return { api: load('@/lib/bitbrowser.ts'), calls };
}

function loadBrowserFetch({ settings = {}, fetch, ws } = {}) {
  const db = { getSetting: (key, fallback = '') => Object.hasOwn(settings, key) ? settings[key] : fallback };
  const stubs = {
    '@/lib/database.ts': db,
    '@/lib/logger.ts': { info() {}, warn() {}, error() {}, debug() {} },
  };
  if (ws) stubs.ws = ws;
  const load = loader(stubs, { fetch, AbortController });
  return load('@/lib/browser-fetch.ts');
}

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test('账号端口优先覆盖自动发现的旧 CDP 端口，未传端口保留旧地址', async () => {
  await withEnv({ DREAMINA_CDP_BASE: undefined, DREAMINA_CDP_PORT: undefined, DREAMINA_CDP_HOST: undefined, BITBROWSER_API_BASE: undefined }, () => {
    const api = loadBrowserFetch({ settings: { dreamina_cdp_base: 'https://10.0.0.2:64896/proxy' } });
    assert.equal(api.getCdpHttpBase('65001'), 'https://10.0.0.2:65001/proxy');
    assert.equal(api.getCdpHttpBase(), 'https://10.0.0.2:64896/proxy');
  });
});

test('显式 CDP 基址和 BitBrowser API 主机推导保持有效', async () => {
  await withEnv({ DREAMINA_CDP_BASE: 'https://cdp.example.test:7443/root/', DREAMINA_CDP_HOST: undefined, BITBROWSER_API_BASE: undefined }, () => {
    const api = loadBrowserFetch();
    assert.equal(api.getCdpHttpBase('65001'), 'https://cdp.example.test:7443/root');
  });
  await withEnv({ DREAMINA_CDP_BASE: undefined, DREAMINA_CDP_HOST: undefined, BITBROWSER_API_BASE: 'https://bitbrowser.example.test:54345' }, () => {
    const api = loadBrowserFetch();
    assert.equal(api.getCdpHttpBase('65001'), 'https://bitbrowser.example.test:65001');
  });
});

test('getCdpTargets 读取数组并对 HTTP、JSON、响应形状给出诊断', async () => {
  const calls = [];
  const api = loadBrowserFetch({
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => '[{"type":"page"}]' };
    },
  });
  assert.equal(JSON.stringify(await api.getCdpTargets('65002')), JSON.stringify([{ type: 'page' }]));
  assert.equal(calls[0], 'http://127.0.0.1:65002/json/list');

  for (const response of [
    { ok: false, status: 502, text: async () => 'bad gateway' },
    { ok: true, status: 200, text: async () => 'not-json' },
    { ok: true, status: 200, text: async () => '{"page":[]}' },
  ]) {
    const failing = loadBrowserFetch({ fetch: async () => response });
    await assert.rejects(failing.getCdpTargets('65002'), /CDP target response|CDP target request HTTP/);
  }
});

test('getCdpTargets 对卡住的 CDP 请求强制超时，并支持调用方中止', async () => {
  const timeoutApi = loadBrowserFetch({
    fetch: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
    }),
  });
  await assert.rejects(timeoutApi.getCdpTargets('65003', 10), /timeout after 10ms/);

  const controller = new AbortController();
  const abortApi = loadBrowserFetch({
    fetch: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted by caller')), { once: true });
    }),
  });
  const pending = abortApi.getCdpTargets('65004', 1000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /request aborted/);
});

test('cdpCall 在连接关闭和已关闭 socket 上都立即失败并清理监听器', async () => {
  const api = loadBrowserFetch();
  const listeners = new Map();
  const socket = {
    readyState: 1,
    addEventListener(name, handler) {
      const current = listeners.get(name) || [];
      current.push(handler);
      listeners.set(name, current);
    },
    removeEventListener(name, handler) {
      listeners.set(name, (listeners.get(name) || []).filter(item => item !== handler));
    },
    send() {},
    emit(name, value) {
      for (const handler of [...(listeners.get(name) || [])]) handler(value);
    },
  };
  const pending = api.cdpCall(socket, 'Runtime.evaluate', {}, 1000);
  socket.emit('close');
  await assert.rejects(pending, /CDP connection closed/);
  assert.equal((listeners.get('message') || []).length, 0);
  assert.equal((listeners.get('close') || []).length, 0);
  assert.equal((listeners.get('error') || []).length, 0);

  const closed = { ...socket, readyState: 3 };
  await assert.rejects(api.cdpCall(closed, 'Runtime.evaluate', {}, 1000), /not open/);
});

test('browserSignRequest 和 browserFetchJson 在 CDP 连接关闭时立即结束', async () => {
  const fetchTargets = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{ type: 'page', url: 'https://dreamina.capcut.com/ai-tool/generate', webSocketDebuggerUrl: 'ws://127.0.0.1:64896/devtools/page/dreamina' }]),
  });
  const api = loadBrowserFetch({ ws: LifecycleWebSocket, fetch: fetchTargets });
  await assert.rejects(
    api.browserSignRequest('https://dreamina.capcut.com/api/generate', { prompt: 'test' }, { cdpPort: '65009' }),
    /CDP connection closed|websocket closed/
  );
  await assert.rejects(
    api.browserFetchJson('https://dreamina.capcut.com/api/generate', { prompt: 'test' }, { cdpPort: '65010' }),
    /websocket closed/
  );
});

test('getGeneratePageWs 只选择 Dreamina 页面并重写为当前账号端口', async () => {
  const api = loadBrowserFetch({
    settings: { dreamina_cdp_base: 'http://127.0.0.1:64896' },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify([
      { type: 'page', url: 'https://example.test/', webSocketDebuggerUrl: 'ws://127.0.0.1:64896/devtools/page/other' },
      { type: 'page', url: 'https://dreamina.capcut.com/ai-tool/generate', webSocketDebuggerUrl: 'ws://127.0.0.1:64896/devtools/page/dreamina' },
    ]) }),
  });
  assert.equal(await api.getGeneratePageWs('65005'), 'ws://127.0.0.1:65005/devtools/page/dreamina');
});

test('checkDreaminaLoginByCdp 优先选择精确 Dreamina 首页 target，并保留有效 CapCut Cookie', async () => {
  const { api } = loadBitbrowser({
    targets: [
      { type: 'page', url: 'https://example.test/', webSocketDebuggerUrl: 'ws://127.0.0.1:64896/devtools/page/other' },
      { type: 'page', url: 'https://dreamina.capcut.com/ai-tool/home', webSocketDebuggerUrl: 'ws://127.0.0.1:64896/devtools/page/dreamina' },
    ],
    cookies: [
      { domain: '.dreamina.capcut.com', name: 'sessionid', value: 'live-token' },
      { domain: '.capcut.com', name: 'sid_guard', value: 'guard-token%7C1%7C2' },
      { domain: '.evil.example', name: 'sid_tt', value: 'must-not-leak' },
      { domain: '.capcut.com', name: 'sessionid_ss', value: '' },
      { domain: '.capcut.com', name: 'sid_tt', value: 'expired-token', expires: 1 },
    ],
  });

  const result = await api.checkDreaminaLoginByCdp(65006);
  assert.equal(result.status, 'ok');
  assert.equal(result.cdpWsUrl, 'ws://127.0.0.1:65006/devtools/page/dreamina');
  assert.match(result.cookies, /sessionid=live-token/);
  assert.match(result.cookies, /sid_guard=guard-token%7C1%7C2/);
  assert.doesNotMatch(result.cookies, /must-not-leak/);
  assert.doesNotMatch(result.cookies, /sessionid_ss=/);
  assert.doesNotMatch(result.cookies, /expired-token/);
});

test('checkDreaminaLoginByCdp 在 Network.getAllCookies 不可用时只从当前 Dreamina document.cookie 回退', async () => {
  const { api } = loadBitbrowser({
    getAllCookiesError: true,
    snapshot: {
      url: 'https://dreamina.capcut.com/ai-tool/home',
      title: 'Dreamina', text: '',
      cookies: 'sessionid=document-token; theme=dark', ua: 'test UA',
    },
  });

  const result = await api.checkDreaminaLoginByCdp(65007);
  assert.equal(result.status, 'ok');
  assert.equal(result.cookies, 'sessionid=document-token; theme=dark');
});

test('checkDreaminaLoginByCdp 不把非 CapCut 页面 document.cookie 当作 Dreamina 会话', async () => {
  const { api } = loadBitbrowser({
    getAllCookiesError: true,
    snapshot: {
      url: 'https://evil.example/login',
      title: 'Other site', text: '',
      cookies: 'sessionid=attacker-token', ua: 'test UA',
    },
  });

  const result = await api.checkDreaminaLoginByCdp(65008);
  assert.equal(result.status, 'failed');
  assert.equal(result.cookies, '');
});
