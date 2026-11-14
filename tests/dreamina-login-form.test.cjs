const assert = require('node:assert/strict');
const { test } = require('node:test');
const loader = require('./helpers/load-ts.cjs');

const { classifyDreaminaCredentialFields } = loader({
  ws: class WebSocket {},
  axios: { create: () => ({}) },
  '@/lib/database.ts': { getSetting: (_key, fallback = '') => fallback },
  '@/lib/logger.ts': { info() {}, warn() {}, error() {}, debug() {} },
  '@/lib/browser-fetch.ts': {
    cdpCall: async () => ({}), getCdpHttpBase: () => '', getCdpTargets: async () => [],
    getGeneratePageWs: async () => '', rewriteCdpWsUrl: value => value,
  },
})('@/lib/bitbrowser.ts');

test('识别同页邮箱与密码表单', () => {
  const fields = [
    { type: 'email', name: 'username', placeholder: 'Enter email' },
    { type: 'password', name: 'password', placeholder: 'Enter password' },
  ];
  const result = classifyDreaminaCredentialFields(fields);
  assert.equal(fields[result.userIndex].name, 'username');
  assert.equal(fields[result.passwordIndex].name, 'password');
});

test('识别先填邮箱、后出现密码框的两步表单', () => {
  const emailStep = classifyDreaminaCredentialFields([
    { type: 'text', name: 'email', placeholder: 'Correo electrónico' },
  ]);
  assert.equal(emailStep.userIndex, 0);
  assert.equal(emailStep.passwordIndex, -1);

  const passwordStep = classifyDreaminaCredentialFields([
    { type: 'password', name: 'password', placeholder: 'Contraseña' },
  ]);
  assert.equal(passwordStep.userIndex, -1);
  assert.equal(passwordStep.passwordIndex, 0);
});

test('识别电话登录字段，并忽略不相关首页输入框', () => {
  const phoneLogin = classifyDreaminaCredentialFields([
    { type: 'tel', name: 'phone', placeholder: 'Phone number' },
    { type: 'password', name: 'pwd' },
  ]);
  assert.equal(phoneLogin.userIndex, 0);
  assert.equal(phoneLogin.passwordIndex, 1);

  const unrelated = classifyDreaminaCredentialFields([
    { type: 'search', name: 'search', placeholder: 'Search Dreamina' },
    { type: 'text', name: 'prompt', placeholder: 'Describe your idea' },
  ]);
  assert.equal(unrelated.userIndex, -1);
  assert.equal(unrelated.passwordIndex, -1);
});
