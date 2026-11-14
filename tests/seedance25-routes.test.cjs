const assert = require('node:assert/strict');
const { test } = require('node:test');
const _ = require('lodash');
const loader = require('./helpers/load-ts.cjs');

const pro = 'jimeng-video-seedance-2.5';
const flash = `${pro}-flash`;

function setup({ failAt, selectFailAt, b64Fail, tokens = ['cn-test', 'sg-test'] } = {}) {
  const generations = [];
  const selections = [];
  const media = [];
  const load = loader({
    '@/api/controllers/core.ts': {
      tokenSplit: () => tokens,
      parseRegionFromToken: token => ({ isInternational: /(?:^|@)(?:us|hk|jp|sg|vn)-/.test(token) }),
    },
    '@/api/controllers/videos.ts': {
      DEFAULT_MODEL: 'jimeng-video-3.5-pro',
      generateVideo: async (...args) => {
        generations.push(args);
        if (generations.length === failAt) throw Object.assign(new Error('测试生成失败'), { errcode: -2000 });
        return `https://result.test/${generations.length}.mp4`;
      },
    },
    '@/lib/util.ts': { unixTimestamp: () => 12345, fetchFileBASE64: async () => {
      if (b64Fail) throw new Error('测试转换失败');
      return 'dGVzdA==';
    } },
    '@/lib/database.ts': { recordCall() {}, saveMedia: (...args) => media.push(args) },
    '@/lib/load-balancer.ts': { estimateCredits: () => 10, selectToken: async (...args) => {
      selections.push(args);
      if (selections.length === selectFailAt) throw new Error('测试账号不可用');
      return { token: args[0][0], proxyToken: args[0][0] };
    } },
  });
  const route = load('@/api/routes/videos.ts').default.post['/generations'];
  async function run(body = {}, files = {}, multipart = false) {
    const request = {
      body: { model: pro, prompt: '测试', ...body }, files,
      headers: { authorization: 'Bearer test', 'content-type': multipart ? 'multipart/form-data' : 'application/json' },
      logDetails: {}, setLogAccount() {},
      validate(key, fn) { if (!fn(_.get(this, key))) throw new Error(`invalid ${key}`); return this; },
    };
    return { response: await route(request), request };
  }
  return { run, generations, selections, media, load };
}

test('两款模型允许全部有效画幅、分辨率以及 4/30 秒边界', async () => {
  for (const model of [pro, flash]) {
    const api = setup();
    const capabilities = api.load('@/api/consts/seedance25.ts').getSeedance25Capabilities(model);
    for (const ratio of ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']) {
      for (const resolution of capabilities.resolutions) {
        for (const duration of [4, 30]) {
          await api.run({ model, ratio, resolution, duration });
          const opts = api.generations.at(-1)[2];
          assert.equal(opts.ratio, ratio); assert.equal(opts.resolution, resolution); assert.equal(opts.duration, duration);
        }
      }
    }
  }
});

test('非法范围、字段和类型在任何账号/生成请求之前拒绝', async () => {
  const invalid = [
    { duration: 3 }, { duration: 31 }, { duration: 4.5 }, { duration: '5' },
    { ratio: '2:1' }, { model: flash, resolution: '1080p' }, { model: flash, resolution: '4k' },
    { seed: -1 }, { seed: 4294967296 }, { seed: 1.5 }, { seed: '1' }, { seed: null },
    { n: 0 }, { n: 5 }, { n: 1.5 }, { n: '2' },
    { prompt: 'x'.repeat(15001) }, { prompt: '' }, { prompt: undefined },
    { file_paths: ['file:///private/file.jpg'] }, { image_file_1: 'not-a-url' },
    { image_file_0: 'https://test/a' }, { image_file_01: 'https://test/a' }, { image_file_wrong: 'https://test/a' },
    { functionMode: 'first_last_frames', audio_file_1: 'https://test/a' },
    { is_long_video: true }, { fps: 30 }, { count: 2 }, { response_format: 'bogus' },
  ];
  for (const body of invalid) {
    const api = setup();
    await assert.rejects(api.run(body));
    assert.equal(api.selections.length, 0, JSON.stringify(body));
    assert.equal(api.generations.length, 0);
  }
});

test('素材分类上限、总数、编号和 multipart 重复字段受校验', async () => {
  for (const [model, limits] of [[pro, [30, 10, 10]], [flash, [10, 5, 5]]]) {
    const refs = { model, functionMode: 'omni_reference', prompt: undefined };
    ['image', 'video', 'audio'].forEach((type, k) => {
      for (let i = 1; i <= limits[k]; i++) refs[`${type}_file_${i}`] = `https://oss.test/${type}${i}`;
    });
    assert.equal((await setup().run(refs)).response.data.length, 1);
    for (const type of ['image', 'video', 'audio']) {
      const api = setup();
      await assert.rejects(api.run({ ...refs, [`${type}_file`]: 'https://oss.test/extra' }), /最多|总数/);
      assert.equal(api.generations.length, 0);
    }
  }
  await assert.rejects(setup().run({}, { image_file_1: [{ filepath: 'a' }, { filepath: 'b' }] }), /一个文件/);
  await assert.rejects(setup().run({}, { attachment: { filepath: 'a' } }), /不支持/);
  await assert.rejects(setup().run({ image_file_1: 'https://test/1', image_file_2: 'https://test/2', file_paths: ['https://test/3'] }), /最多支持2/);
});

test('multipart 数字参数被正规化且同字段文件和 URL 不重复计数', async () => {
  const api = setup();
  await api.run({ duration: '30', seed: '4294967295', n: '1', image_file_1: 'https://oss.test/1' }, { image_file_1: { filepath: '1.jpg' } }, true);
  assert.equal(api.generations[0][2].duration, 30);
  assert.equal(api.generations[0][2].seed, 4294967295);
  await assert.rejects(api.run({ duration: '5oops' }, {}, true));
});

test('n=4 依次生成并保存媒体；seed=0传递且记录总预估', async () => {
  const api = setup();
  const { response, request } = await api.run({ n: 4, seed: 0 });
  assert.equal(response.data.length, 4);
  assert.equal(api.media.length, 4);
  assert.equal(request.logDetails.estimatedCredits, 40);
  assert.equal(api.generations[0][2].seed, 0);
  assert.ok(api.selections.every(s => s[1] === 10));
});

test('批量生成或账号选择中途失败时保留已成功视频并停止', async () => {
  for (const options of [{ failAt: 2 }, { selectFailAt: 2 }]) {
    const api = setup(options);
    const { response } = await api.run({ n: 4 });
    assert.equal(response.data.length, 1);
    assert.equal(response.errors[0].index, 1);
    assert.equal(api.selections.length, 2);
    if (options.failAt) assert.equal(response.errors[0].code, -2000);
  }
  await assert.rejects(setup({ failAt: 1 }).run({ n: 4 }), /测试生成失败/);
});

test('批量 Base64 转换失败返回当前 URL 并停止，单项仍保持原错误行为', async () => {
  const api = setup({ b64Fail: true });
  const { response } = await api.run({ n: 4, response_format: 'b64_json' });
  assert.equal(response.data[0].url, 'https://result.test/1.mp4');
  assert.equal(response.errors[0].index, 0);
  assert.equal(api.generations.length, 1);
  await assert.rejects(setup({ b64Fail: true }).run({ response_format: 'b64_json' }), /转换失败/);
});

test('2.5 混合账号池仅选国际账号，支持代理前缀且无国际账号时提前拒绝', async () => {
  const api = setup({ tokens: ['cn-test', 'http://proxy.test@sg-test'] });
  await api.run();
  assert.equal(api.selections[0][0].length, 1);
  assert.equal(api.generations[0][3], 'http://proxy.test@sg-test');
  const cn = setup({ tokens: ['cn-test'] });
  await assert.rejects(cn.run(), /国际站/);
  assert.equal(cn.selections.length, 0);
});

test('2.0 Fast 路由保留 4–15 秒和 9 图/3 视频上限', async () => {
  const api = setup();
  const model = 'jimeng-video-seedance-2.0-fast';
  await api.run({ model, duration: 15 });
  assert.equal(api.generations.length, 1);
  await assert.rejects(api.run({ model, duration: 30 }), /4~15/);
  await assert.rejects(api.run({ model, n: 2 }));
  const body = { model, functionMode: 'omni_reference' };
  for (let i = 1; i <= 9; i++) body[`image_file_${i}`] = 'https://oss.test/image';
  await api.run(body);
});
