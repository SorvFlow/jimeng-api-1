const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function loadDashboardScript({ fetch }) {
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source, 'dashboard script should exist');

  const timers = [];
  let timerId = 0;
  const elements = new Map([['accounts-table', { innerHTML: '' }]]);
  const context = {
    console,
    fetch,
    location: { origin: 'http://test.local' },
    setTimeout(callback, delay) {
      const timer = { id: ++timerId, callback, due: delay };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, classList: { add() {}, remove() {} }, value: '', textContent: '' });
        return elements.get(id);
      },
      querySelectorAll() { return []; },
      querySelector() { return { dataset: { tab: 'accounts' } }; },
    },
    AbortController,
    URL,
    console,
  };
  vm.runInNewContext(`${source.replace(/checkAuth\(\);\s*$/, '')}\n;globalThis.__test = { loadAccounts, scheduleAccountsRefresh };`, context);
  return {
    ...context,
    table: elements.get('accounts-table'),
    async advance(ms) {
      const due = timers.filter((timer) => timer.due <= ms);
      timers.splice(0, timers.length, ...timers.filter((timer) => timer.due > ms).map((timer) => ({ ...timer, due: timer.due - ms })));
      for (const timer of due) timer.callback();
      // The fetch mock and loadAccounts each add an await boundary before
      // scheduling the next poll. Flush a few turns so this helper observes
      // the same steady state as a browser event loop.
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
    loadAccounts: context.__test.loadAccounts,
  };
}

test('账号登录状态超过45秒仍持续查询，且账号查询请求不重叠', async () => {
  const states = Array.from({ length: 10 }, (_, index) => [{
    id: 1, name: 'demo', login_status: 'logging_in', status: 'unknown',
    login_progress_stage: index === 0 ? 'filling_form' : 'waiting_login',
    login_progress_percent: index === 0 ? 42 : 68,
    login_progress_message: index === 0 ? '正在填写邮箱' : '等待 Dreamina 返回登录结果',
    login_progress_blocker: index === 0 ? '等待邮箱验证码' : '',
    login_progress_updated_at: '2026-11-14 12:00:00',
  }]);
  states.push([{ id: 1, name: 'demo', login_status: 'ok', status: 'active', login_progress_stage: 'success', login_progress_percent: 100, login_progress_message: '登录态已确认', login_progress_updated_at: '2026-11-14 12:01:00' }]);
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const dashboard = loadDashboardScript({
    fetch: async (url) => {
      assert.equal(url, '/dashboard/accounts');
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, async json() { return states.shift() || states.at(-1); } };
    },
  });

  await dashboard.loadAccounts();
  assert.match(dashboard.table.innerHTML, /阶段：填写登录表单/);
  assert.match(dashboard.table.innerHTML, /42%/);
  assert.match(dashboard.table.innerHTML, /卡点：等待邮箱验证码/);
  assert.match(dashboard.table.innerHTML, /继续检测/);
  assert.match(dashboard.table.innerHTML, /打开页面/);
  assert.match(dashboard.table.innerHTML, /复制诊断/);
  for (let i = 0; i < 10; i++) await dashboard.advance(5000);

  assert.equal(calls, 11, 'the final state should be observed after 50 seconds');
  assert.equal(maxInFlight, 1, 'account list requests must be single-flight');
  assert.match(dashboard.table.innerHTML, /已登录/);
  assert.doesNotMatch(dashboard.table.innerHTML, /登录中/);
});
test('需人工验证时保留继续检测入口，避免重复启动登录任务', async () => {
  const dashboard = loadDashboardScript({
    fetch: async () => ({
      ok: true,
      async json() {
        return [{
          id: 2, name: 'verify-demo', login_status: 'need_2fa', status: 'unknown',
          login_progress_stage: 'waiting_verification', login_progress_percent: 70,
          login_progress_message: '等待验证码或二次验证', login_progress_blocker: '请在 BitBrowser 中完成验证码',
          login_progress_updated_at: '2026-11-14 12:00:00',
        }];
      },
    }),
  });

  await dashboard.loadAccounts();
  assert.match(dashboard.table.innerHTML, /继续检测/);
  assert.doesNotMatch(dashboard.table.innerHTML, /重新登录/);
  assert.match(dashboard.table.innerHTML, /等待验证码或二次验证/);
});

test('登录期间账号查询短暂失败后继续轮询并显示最终结果', async () => {
  let calls = 0;
  const dashboard = loadDashboardScript({
    fetch: async () => {
      calls += 1;
      if (calls === 2) return { ok: false, status: 503 };
      return {
        ok: true,
        async json() {
          return [{
            id: 3, name: 'retry-demo', status: 'unknown',
            login_status: calls < 3 ? 'logging_in' : 'ok',
            login_progress_stage: calls < 3 ? 'waiting_login' : 'completed',
            login_progress_percent: calls < 3 ? 70 : 100,
          }];
        },
      };
    },
  });

  await dashboard.loadAccounts();
  await dashboard.advance(5000);
  assert.equal(calls, 2);
  assert.match(dashboard.table.innerHTML, /登录中/);

  await dashboard.advance(5000);
  assert.equal(calls, 3, 'a transient HTTP failure must not stop login polling');
  assert.match(dashboard.table.innerHTML, /已登录/);
  assert.doesNotMatch(dashboard.table.innerHTML, /登录中/);

  await dashboard.advance(5000);
  assert.equal(calls, 3, 'polling should stop once the final state is known');
});

test('刷新按钮与登录轮询同时触发时合并账号查询', async () => {
  let calls = 0;
  let resolveFirst;
  const dashboard = loadDashboardScript({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return {
        ok: true,
        async json() { return [{ id: 4, name: 'single-flight', login_status: 'ok', status: 'active' }]; },
      };
    },
  });

  const polling = dashboard.loadAccounts();
  const manualRefresh = dashboard.loadAccounts();
  assert.equal(calls, 1, 'parallel refresh requests should share the active fetch');
  resolveFirst({
    ok: true,
    async json() { return [{ id: 4, name: 'single-flight', login_status: 'logging_in', status: 'unknown' }]; },
  });
  await Promise.all([polling, manualRefresh]);
  await dashboard.advance(0);
  assert.equal(calls, 2, 'one deferred refresh should observe any updates after the in-flight response');
  assert.match(dashboard.table.innerHTML, /已登录/);
});

test('登录期间账号查询挂起时超时释放请求并恢复后续轮询', async () => {
  let calls = 0;
  let hangingSignal;
  const dashboard = loadDashboardScript({
    fetch: async (_url, options) => {
      calls += 1;
      if (calls === 2) {
        hangingSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('account request timed out');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return {
        ok: true,
        async json() {
          return [{ id: 5, name: 'timeout-retry', login_status: calls === 1 ? 'logging_in' : 'ok', status: 'active' }];
        },
      };
    },
  });

  await dashboard.loadAccounts();
  await dashboard.advance(5000);
  assert.equal(calls, 2);
  assert.equal(hangingSignal.aborted, false);
  assert.match(dashboard.table.innerHTML, /登录中/);

  await dashboard.advance(15000);
  assert.equal(hangingSignal.aborted, true, 'the hanging GET must have a bounded lifetime');
  await dashboard.advance(5000);
  assert.equal(calls, 3, 'polling must recover after the timed-out GET releases the single-flight lock');
  assert.match(dashboard.table.innerHTML, /已登录/);
  assert.doesNotMatch(dashboard.table.innerHTML, /登录中/);
});
