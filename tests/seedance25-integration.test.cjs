const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

test('真实 HTTP 路由列出新旧模型，并在选择账号前拒绝无效 Seedance 2.5 参数', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jimeng-seedance25-api-'));
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['dist/index.js'], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, DB_PATH: path.join(dir, 'jimeng.db'), SERVER_HOST: '127.0.0.1', SERVER_PORT: String(port), SERVER_ENV: 'dev' },
  });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
      server.kill('SIGTERM');
      try { await exited; } finally { clearTimeout(timer); }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null || server.signalCode !== null) break;
    try { if ((await fetch(`${base}/ping`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, '测试服务未启动');
  const models = (await (await fetch(`${base}/v1/models`)).json()).data;
  for (const id of ['jimeng-video-seedance-2.5', 'jimeng-video-seedance-2.5-flash', 'jimeng-video-seedance-2.0-fast']) {
    assert.equal(models.filter(m => m.id === id).length, 1);
  }
  for (const model of ['jimeng-video-seedance-2.5', 'jimeng-video-seedance-2.5-flash']) {
    const found = models.find(m => m.id === model);
    assert.match(found.description, /US\/ASIA/);
    const cases = [{ duration: 31 }, { duration: 3 }, { ratio: '2:1' }, { seed: -1 }, { seed: 4294967296 }, { n: 5 }];
    for (const invalid of cases) {
      const response = await fetch(`${base}/v1/videos/generations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-not-a-token' },
        body: JSON.stringify({ model, prompt: '本地参数校验测试', ...invalid }),
      });
      const body = await response.json();
      assert.ok(body.code < 0, `${model} ${JSON.stringify(invalid)} 应被拒绝`);
      assert.ok(body.data == null);
    }
  }
});
