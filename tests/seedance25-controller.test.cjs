const assert = require('node:assert/strict');
const { test } = require('node:test');
const loader = require('./helpers/load-ts.cjs');

const pro = 'jimeng-video-seedance-2.5';
const flash = `${pro}-flash`;
const parseRegion = token => ({ isInternational: token.startsWith('sg-'), isSG: token.startsWith('sg-'), isCN: !token.startsWith('sg-') });

function setup({ videoDuration = 4, audioDuration = 4, failImage } = {}) {
  let id = 0;
  const calls = [];
  const uploads = [];
  const captured = new Error('captured-generation');
  const imageUpload = async buffer => {
    const value = buffer.toString();
    if (value.includes(failImage || '\0')) throw new Error('图片上传测试失败');
    uploads.push(value);
    return { uri: `image:${value}`, width: 600, height: 600, format: 'jpeg' };
  };
  const video = async () => ({ vid: 'video-id', uri: 'video-uri', videoMeta: { width: 1280, height: 720, duration: videoDuration, format: 'mp4' } });
  const audio = async () => ({ vid: 'audio-id', duration: audioDuration, format: 'mp3' });
  const core = {
    parseRegionFromToken: parseRegion, getCredit: async () => ({ totalCredit: 1000 }), receiveCredit: async () => {},
    getAssistantId: () => 513641, checkImageContent: async () => {},
    request: async (...args) => { calls.push(args); throw captured; },
  };
  const load = loader({
    './core.ts': core,
    '@/lib/util.ts': { uuid: () => `uuid-${++id}`, safeURLLabel: url => url.split('?')[0] },
    '@/lib/logger.ts': { info() {}, warn() {}, error() {}, debug() {} },
    '@/lib/image-uploader.ts': { uploadImageBuffer: imageUpload },
    '@/lib/video-uploader.ts': { uploadVideoBuffer: video, uploadVideoFromUrl: video, uploadAudioBuffer: audio, uploadAudioFromUrl: audio },
    '@/lib/image-utils.ts': {}, '@/lib/smart-poller.ts': {},
    'fs-extra': { readFile: async filename => Buffer.from(filename) },
    axios: { get: async url => ({ status: 200, data: Buffer.from(url) }) },
  });
  const api = load('@/api/controllers/videos.ts');
  async function payload(model, prompt = '测试提示词', options = {}, token = 'sg-test') {
    await assert.rejects(api.generateVideo(model, prompt, options, token), error => error === captured);
    const request = calls.at(-1)[3];
    const draft = JSON.parse(request.data.draft_content);
    const params = draft.component_list[0].abilities.gen_video.text_to_video_params;
    return { request, draft, params, input: params.video_gen_inputs[0], metrics: JSON.parse(request.data.metrics_extra) };
  }
  return { api, payload, calls, uploads };
}

test('两模型文生 payload 保留 30 秒、seed=0、分辨率与独立的草稿版本', async () => {
  for (const model of [pro, flash]) {
    const { payload } = setup();
    const p = await payload(model, '文字'.repeat(3000), { duration: 30, resolution: '480p', ratio: '21:9', seed: 0 });
    assert.equal(p.input.duration_ms, 30000);
    assert.equal(p.input.fps, 24);
    assert.equal(p.input.resolution, '480p');
    assert.equal(p.params.video_aspect_ratio, '21:9');
    assert.equal(p.params.seed, 0);
    assert.equal(p.metrics.isDefaultSeed, 0);
    assert.equal(p.draft.version, '3.3.39');
    assert.equal(p.draft.min_version, '3.0.5');
    assert.deepEqual(p.draft.min_features, ['AIGC_Video_Seedance25ResultAction']);
    assert.equal(p.params.model_req_key, model === pro ? 'dreamina_seedance_45_pro' : 'dreamina_seedance_45_flash');
    assert.equal(p.input.unified_edit_input, undefined);
    assert.ok(!JSON.stringify(p).includes('long_video'));
    assert.equal(p.request.data.extend.m_video_commerce_info.benefit_type,
      model === pro ? 'seedance_25_480p_no_input_video_output' : 'seedance_25_flash_480p_no_input_video');
  }
});

test('首尾帧混合 URL/文件时按编号排序，尾帧失败不降为首帧请求', async () => {
  const { payload, uploads } = setup();
  const options = { files: { image_file_2: { filepath: 'last-local.jpg' } }, httpRequest: { body: { image_file_1: 'https://oss.test/first.jpg' } } };
  const p = await payload(pro, '', options);
  assert.deepEqual(uploads, ['https://oss.test/first.jpg', 'last-local.jpg']);
  assert.equal(p.input.first_frame_image.image_uri, 'image:https://oss.test/first.jpg');
  assert.equal(p.input.end_frame_image.image_uri, 'image:last-local.jpg');
  const failed = setup({ failImage: 'last-local' });
  await assert.rejects(failed.api.generateVideo(pro, '', options, 'sg-test'), /第 2 个参考图片/);
  assert.equal(failed.calls.length, 0);
});

test('图片/视频/音频混合引用使用平台素材标识及毫秒时长，按输入视频选择计费键', async () => {
  for (const model of [pro, flash]) {
    const { payload } = setup();
    const p = await payload(model, '@image_file_1角色 @video_file_1动作 @audio_file_1节奏', {
      functionMode: 'omni_reference', seed: 4294967295,
      httpRequest: { body: { image_file_1: 'https://oss.test/ref.jpg', video_file_1: 'https://oss.test/ref.mp4', audio_file_1: 'https://oss.test/ref.mp3' } },
    });
    const edit = p.input.unified_edit_input;
    assert.equal(p.draft.version, '3.3.9');
    assert.deepEqual(p.draft.min_features, ['AIGC_Video_UnifiedEdit']);
    assert.deepEqual(edit.material_list.map(x => x.material_type), ['image', 'video', 'audio']);
    assert.equal(edit.material_list[1].video_info.vid, 'video-id');
    assert.equal(edit.material_list[2].audio_info.vid, 'audio-id');
    assert.equal(edit.material_list[2].audio_info.duration, 4000);
    assert.deepEqual(edit.meta_list.filter(x => x.material_ref).map(x => x.material_ref.material_idx), [0, 1, 2]);
    assert.equal(p.params.seed, 4294967295);
    assert.equal(p.metrics.isDefaultSeed, 0);
    assert.equal(p.request.data.extend.m_video_commerce_info.benefit_type,
      model === pro ? 'seedance_25_720p_output' : 'seedance_25_flash_720p_output');
  }
});

test('无参考素材的 omni 模式落到文生，随机 seed 保留默认标志', async () => {
  const p = await setup().payload(flash, '测试', { functionMode: 'omni_reference' });
  assert.equal(p.input.unified_edit_input, undefined);
  assert.equal(p.metrics.isDefaultSeed, 1);
  assert.ok(Number.isInteger(p.params.seed) && p.params.seed >= 0 && p.params.seed <= 4294967295);
});

test('输入视频、音频各自的单项/累计时长超限时不提交生成', async () => {
  for (const type of ['video', 'audio']) {
    for (const [duration, count, fail] of [[1.7, 1, true], [30.2, 1, false], [30.201, 1, true], [15.2, 2, true], [15.1, 2, false]]) {
      const api = setup({ [`${type}Duration`]: duration });
      const body = Object.fromEntries(Array.from({ length: count }, (_, i) => [`${type}_file_${i + 1}`, 'https://oss.test/reference']));
      const options = { functionMode: 'omni_reference', httpRequest: { body } };
      if (fail) {
        await assert.rejects(api.api.generateVideo(pro, '', options, 'sg-test'), /时长/);
        assert.equal(api.calls.length, 0);
      } else await api.payload(pro, '', options);
    }
  }
});

test('Seedance 2.0 Fast 保留原模型、15 秒上限、草稿与素材结构', async () => {
  const p = await setup().payload('jimeng-video-seedance-2.0-fast', '@image_file_1参考', {
    duration: 30, functionMode: 'omni_reference', httpRequest: { body: { image_file_1: 'https://oss.test/ref.jpg' } },
  }, 'cn-test');
  assert.equal(p.input.duration_ms, 15000);
  assert.equal(p.input.resolution, undefined);
  assert.ok(p.params.model_req_key.includes('40'));
  assert.equal(p.draft.version, '3.3.9');
  assert.equal(p.input.unified_edit_input.material_list.length, 1);
});

test('2.5 国内账号与无素材空 prompt 在提交前拒绝', async () => {
  const api = setup();
  await assert.rejects(api.api.generateVideo(pro, '测试', {}, 'cn-test'), /国际站/);
  await assert.rejects(api.api.generateVideo(pro, '', {}, 'sg-test'), /非空 prompt/);
  assert.equal(api.calls.length, 0);
});

test('控制器直调拒绝首尾模式中的视频/音频参考和第三张图片', async () => {
  const api = setup();
  await assert.rejects(api.api.generateVideo(pro, '', {
    httpRequest: { body: { video_file_1: 'https://oss.test/ref.mp4' } },
  }, 'sg-test'), /需要设置 functionMode=omni_reference/);
  await assert.rejects(api.api.generateVideo(pro, '', {
    httpRequest: { body: { audio_file_1: 'https://oss.test/ref.mp3' } },
  }, 'sg-test'), /需要设置 functionMode=omni_reference/);
  await assert.rejects(api.api.generateVideo(pro, '参考图', {
    httpRequest: { body: { image_file_1: 'https://oss.test/1.jpg', image_file_2: 'https://oss.test/2.jpg' } },
    filePaths: ['https://oss.test/3.jpg'],
  }, 'sg-test'), /最多支持2张/);
  assert.equal(api.calls.length, 0);
});
