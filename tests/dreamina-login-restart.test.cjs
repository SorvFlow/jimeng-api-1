const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const loader = require('./helpers/load-ts.cjs');

test('服务重启释放残留登录中状态，保留已保存会话及其他账号状态', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-login-restart-'));
  const env = { ...process.env, DB_PATH: path.join(directory, 'jimeng.db'), ACCOUNT_SECRET: 'restart-test-secret' };
  const globals = { process: { ...process, env } };
  try {
    const before = loader({}, globals)('@/lib/database.ts');
    const interrupted = before.importLoginAccount({ name: 'interrupted', username: 'interrupted@example.com', password: 'password', region: 'sg' });
    before.updateAccountTokenAndCookie(interrupted, 'sg-saved-session', 'sessionid=saved-session');
    before.updateAccountLoginProgress(interrupted, '正在填写邮箱');
    const waiting = before.importLoginAccount({ name: 'waiting', username: 'waiting@example.com', password: 'password' });
    before.updateAccountLoginStatus(waiting, 'need_2fa', '等待人工验证');
    const pending = before.importLoginAccount({ name: 'pending', username: 'pending@example.com', password: 'password' });

    // Reloading the module creates a new process-local task state against the
    // same database, matching a container restart without touching user data.
    const after = loader({}, globals)('@/lib/database.ts');
    const restored = after.getAccountById(interrupted);
    assert.equal(restored.login_status, 'failed');
    assert.equal(restored.login_progress_stage, 'failed');
    assert.match(restored.last_login_error, /服务已重启.*检测.*重新登录/);
    assert.equal(restored.login_progress_message, restored.last_login_error);
    assert.equal(restored.login_progress_blocker, restored.last_login_error);
    assert.ok(restored.login_progress_updated_at);
    assert.equal(restored.token, 'sg-saved-session');
    assert.equal(restored.cookie, 'sessionid=saved-session');
    assert.equal(restored.status, 'active');
    assert.equal(after.getAccountById(waiting).login_status, 'need_2fa');
    assert.equal(after.getAccountById(pending).login_status, 'pending');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
