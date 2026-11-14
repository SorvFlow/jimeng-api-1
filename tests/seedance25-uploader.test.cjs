const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { transformSync } = require('esbuild');

const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/lib/video-uploader.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node18',
}).code;

// 运行真实上传流程，仅替换远程服务。这里验证协议构造，不表示上游已实测成功。
function uploader(meta = {}, downloadError) {
  const requests = [];
  const logs = [];
  const axios = async (config) => {
    requests.push(config);
    if (config.url.includes('Action=ApplyUploadInner')) return {
      status: 200, data: { Result: { InnerUploadAddress: { UploadNodes: [{
        UploadHost: 'upload.example.test', Vid: 'asset-test', SessionKey: 'test-session',
        StoreInfos: [{ StoreUri: 'asset/path', Auth: 'test-auth' }],
      }] } } },
    };
    if (config.url.includes('/upload/v1/')) return { status: 200, data: { code: 2000 } };
    if (config.url.includes('Action=CommitUploadInner')) return {
      status: 200, data: { Result: { Results: [{ Vid: 'asset-test', ...meta }] } },
    };
    throw new Error('意外的 HTTP 请求');
  };
  axios.get = async (url, config) => {
    requests.push({ url, ...config, method: 'download' });
    if (downloadError) throw downloadError;
    return { status: 200, data: Buffer.from('test-only-media') };
  };
  const stubs = {
    axios,
    '@/api/controllers/core.ts': { request: async (...args) => {
      requests.push({ method: 'token', args });
      return { access_key_id: 'test-key', secret_access_key: 'test-secret', session_token: 'test-token', space_name: 'dreamina' };
    } },
    '@/lib/region-utils.ts': { RegionUtils: {
      getAWSRegion: () => 'ap-southeast-1', getOrigin: () => 'https://dreamina.capcut.com',
      getRefererPath: () => 'https://dreamina.capcut.com/',
    } },
    '@/lib/aws-signature.ts': { createSignature: () => 'test-signature' },
    '@/lib/logger.ts': { info: (...x) => logs.push(x.join(' ')), error: (...x) => logs.push(x.join(' ')) },
    '@/lib/util.ts': { calculateCRC32: () => '12345678', safeURLLabel: (value) => {
      const u = new URL(value); return `${u.protocol}//${u.host}${u.pathname}`;
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, Buffer, URL,
    require: (id) => Object.hasOwn(stubs, id) ? stubs[id] : require(id),
  });
  return { ...module.exports, requests, logs };
}

const region = { isInternational: true };

test('视频上传保留 2.0 的 15 秒限制，2.5 可传 30.2 秒上限', async () => {
  const { uploadVideoBuffer, requests } = uploader({ VideoMeta: { Duration: 30.2, Width: 1280, Height: 720 } });
  await assert.rejects(uploadVideoBuffer(Buffer.from('video'), 'test-token', region), /最大 15s/);
  const result = await uploadVideoBuffer(Buffer.from('video'), 'test-token', region, 30.2);
  assert.equal(result.videoMeta.duration, 30.2);
  assert.equal(result.vid, 'asset-test');
  assert.ok(requests.some(r => r.url?.includes('FileType=video')));
});

test('视频时长规范化并拒绝超过 2.5 上限或无效元数据', async () => {
  const numeric = uploader({ VideoMeta: { Duration: '4.2' } });
  assert.equal((await numeric.uploadVideoBuffer(Buffer.from('video'), 'test-token', region, 30.2)).videoMeta.duration, 4.2);
  for (const duration of [30.201, 'bad', -1]) {
    const api = uploader({ VideoMeta: { Duration: duration } });
    await assert.rejects(api.uploadVideoBuffer(Buffer.from('video'), 'test-token', region, 30.2), /时长/);
  }
});

test('音频复用签名上传提交链路并以秒返回元数据', async () => {
  for (const meta of [{ Duration: 5 }, { Duration: '5' }, { DurationMs: 5000 }]) {
    const api = uploader({ AudioMeta: { ...meta, Format: 'mp3', Uri: 'audio/path' } });
    const result = await api.uploadAudioBuffer(Buffer.from('audio'), 'test-token', region);
    assert.equal(result.duration, 5);
    assert.equal(result.vid, 'asset-test');
    assert.equal(result.format, 'mp3');
    assert.equal(api.requests[0].args[3].data.scene, 1);
    assert.ok(api.requests[1].url.includes('FileType=audio'));
    assert.equal(api.requests[2].headers['Content-CRC32'], '12345678');
    assert.equal(JSON.parse(api.requests[3].data).SessionKey, 'test-session');
  }
});

test('缺少音频元数据时不伪造可用时长', async () => {
  for (const meta of [{}, { AudioMeta: { Duration: 0 } }, { AudioMeta: { Duration: 'bad' } }]) {
    const api = uploader(meta);
    await assert.rejects(api.uploadAudioBuffer(Buffer.from('audio'), 'test-token', region), /AudioMeta.Duration/);
  }
});

test('空音频和超限文件在申请上传令牌前被拒绝', async () => {
  const api = uploader();
  for (const buffer of [Buffer.alloc(0), Buffer.alloc(15 * 1024 * 1024 + 1)]) {
    await assert.rejects(api.uploadAudioBuffer(buffer, 'test-token', region), /15 MiB/);
  }
  assert.equal(api.requests.length, 0);
});

test('OSS 音频 URL 先下载再上传，下载限制 15 MiB 且日志省略签名参数', async () => {
  const api = uploader({ AudioMeta: { Duration: 4 } });
  await api.uploadAudioFromUrl('https://oss.example.test/clip.mp3?Signature=private-value', 'test-token', region);
  assert.equal(api.requests[0].method, 'download');
  assert.equal(api.requests[0].maxContentLength, 15 * 1024 * 1024);
  assert.ok(api.requests.some(r => r.url?.includes('FileType=audio')));
  assert.ok(!api.logs.join('\n').includes('private-value'));
});

test('OSS 下载失败返回可诊断错误且不泄漏签名 URL', async () => {
  const error = Object.assign(new Error('request https://oss.example.test/a?Signature=private-value'), { code: 'ERR_BAD_REQUEST' });
  const api = uploader({}, error);
  await assert.rejects(api.uploadAudioFromUrl('https://oss.example.test/a?Signature=private-value', 'test-token', region), /ERR_BAD_REQUEST/);
  assert.ok(!api.logs.join('\n').includes('private-value'));
  assert.equal(api.requests.length, 1);
});

test('不含错误码的下载异常同样隐藏原始 OSS 签名', async () => {
  const url = 'https://oss.example.test/a?Signature=private-value';
  const api = uploader({}, new Error(`下载失败 ${url}`));
  await assert.rejects(api.uploadAudioFromUrl(url, 'test-token', region), error => {
    assert.ok(!error.message.includes('private-value'));
    assert.match(error.message, /下载失败/);
    return true;
  });
  assert.ok(!api.logs.join('\n').includes('private-value'));
});
