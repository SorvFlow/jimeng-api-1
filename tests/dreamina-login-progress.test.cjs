const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const loader = require('./helpers/load-ts.cjs');

// Use an isolated SQLite file so the migration assertions never touch a
// developer's normal account database. The database module keeps one handle
// open for the lifetime of the process, so cleanup is intentionally deferred
// until the test process exits.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-login-progress-'));
const dbPath = path.join(tempDir, 'jimeng.db');
process.env.DB_PATH = dbPath;
process.env.ACCOUNT_SECRET = 'test-login-progress-secret';

const db = loader()('@/lib/database.ts');

function account(id) {
  return db.getAccounts().find(row => row.id === id);
}

test('账号表启动迁移后暴露完整登录进度字段', () => {
  const id = db.importLoginAccount({
    name: 'progress-test',
    username: 'progress@example.com',
    password: 'password',
    region: 'sg',
  });
  const row = account(id);

  assert.ok(row, '导入的账号应出现在账号列表');
  assert.equal(row.login_status, 'pending');
  assert.equal(row.login_progress_stage, 'idle');
  assert.equal(row.login_progress_percent, 0);
  assert.equal(row.login_progress_message, '');
  assert.equal(row.login_progress_blocker, '');
  assert.equal(row.login_progress_updated_at, null);
});

test('登录进度消息会映射阶段、百分比和人工阻塞原因', () => {
  const id = db.importLoginAccount({
    name: 'progress-mapping-test',
    username: 'mapping@example.com',
    password: 'password',
  });

  db.updateAccountLoginProgress(id, '正在打开 BitBrowser');
  let row = account(id);
  assert.equal(row.login_status, 'logging_in');
  assert.equal(row.login_progress_stage, 'opening_browser');
  assert.equal(row.login_progress_percent, 10);
  assert.equal(row.login_progress_message, '正在打开 BitBrowser');
  assert.equal(row.login_progress_blocker, '');
  assert.ok(row.login_progress_updated_at);

  db.updateAccountLoginProgress(id, '请完成验证码验证');
  row = account(id);
  assert.equal(row.login_progress_stage, 'waiting_verification');
  assert.equal(row.login_progress_percent, 70);
  assert.equal(row.login_progress_blocker, '请完成验证码验证');
});

test('浏览器登录阶段按具体消息映射，避免打开 Dreamina 被误判为打开 BitBrowser', () => {
  const id = db.importLoginAccount({
    name: 'progress-specific-stage-test',
    username: 'specific-stage@example.com',
    password: 'password',
  });

  db.updateAccountLoginProgress(id, '正在连接 CDP');
  let row = account(id);
  assert.equal(row.login_progress_stage, 'connecting_cdp');
  assert.equal(row.login_progress_percent, 20);

  db.updateAccountLoginProgress(id, '正在打开 Dreamina');
  row = account(id);
  assert.equal(row.login_progress_stage, 'navigating');
  assert.equal(row.login_progress_percent, 30);

  db.updateAccountLoginProgress(id, '正在保存登录状态');
  row = account(id);
  assert.equal(row.login_progress_stage, 'checking_session');
  assert.equal(row.login_progress_percent, 85);
});

test('终态状态会同步登录进度，need_2fa 保留提示信息', () => {
  const id = db.importLoginAccount({
    name: 'progress-final-test',
    username: 'final@example.com',
    password: 'password',
  });

  db.updateAccountLoginStatus(id, 'need_2fa', '等待邮箱验证码');
  let row = account(id);
  assert.equal(row.login_status, 'need_2fa');
  assert.equal(row.login_progress_stage, 'waiting_verification');
  assert.equal(row.login_progress_percent, 70);
  assert.equal(row.login_progress_message, '等待邮箱验证码');
  assert.equal(row.login_progress_blocker, '等待邮箱验证码');

  db.updateAccountLoginStatus(id, 'ok');
  row = account(id);
  assert.equal(row.login_status, 'ok');
  assert.equal(row.login_progress_stage, 'completed');
  assert.equal(row.login_progress_percent, 100);
  assert.equal(row.login_progress_message, '登录已确认');
  assert.equal(row.login_progress_blocker, '');
});

after(() => {
  // better-sqlite3 owns an open handle here; remove only the temporary WAL
  // artifacts that can be deleted safely on this platform.
  for (const file of ['jimeng.db-wal', 'jimeng.db-shm']) {
    try { fs.rmSync(path.join(tempDir, file), { force: true }); } catch {}
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
