import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { parseRegionFromToken, tokenSplit } from '@/api/controllers/core.ts';
import {
    countSeedance25Media,
    getSeedance25Capabilities,
    getSeedance25MediaLimitError,
    isSeedance25Resolution,
    SEEDANCE_25_MAX_DURATION,
    SEEDANCE_25_MIN_DURATION,
    SEEDANCE_25_RATIOS,
} from '@/api/consts/seedance25.ts';
import { generateVideo, DEFAULT_MODEL } from '@/api/controllers/videos.ts';
import util from '@/lib/util.ts';
import db from '@/lib/database.ts';
import { selectToken, estimateCredits } from '@/lib/load-balancer.ts';

export default {

    prefix: '/v1/videos',

    post: {

        '/generations': async (request: Request) => {
            const contentType = request.headers['content-type'] || '';
            const isMultiPart = contentType.startsWith('multipart/form-data');
            const modelName = request.body.model || DEFAULT_MODEL;
            const seedance25Capabilities = getSeedance25Capabilities(modelName);
            const seedInput = request.body.seed;
            const nInput = request.body.n;
            let normalizedSeed = seedInput;
            let normalizedN = nInput;
            if (isMultiPart && typeof seedInput === 'string') {
                if (!/^\d+$/.test(seedInput.trim())) throw new Error('seed 必须是 0 到 4294967295 的整数');
                normalizedSeed = Number(seedInput);
            }
            if (isMultiPart && typeof nInput === 'string') {
                if (!/^\d+$/.test(nInput.trim())) throw new Error('n 必须是 1 到 4 的整数');
                normalizedN = Number(nInput);
            }
            const generationCount = _.isUndefined(normalizedN) ? 1 : normalizedN;
            const maxFilePaths = seedance25Capabilities && request.body.functionMode === 'omni_reference'
                ? seedance25Capabilities.maxImages
                : 2;

            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', v => seedance25Capabilities ? (_.isUndefined(v) || _.isString(v)) : _.isString(v))
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.functionMode', v => _.isUndefined(v) || (_.isString(v) && ['first_last_frames', 'omni_reference'].includes(v)))
                .validate('body.seed', v => _.isUndefined(v) || (_.isFinite(normalizedSeed) && Number.isInteger(normalizedSeed) && normalizedSeed >= 0 && normalizedSeed <= 4294967295))
                .validate('body.n', v => _.isUndefined(v) || (_.isFinite(generationCount) && Number.isInteger(generationCount) && generationCount >= 1 && generationCount <= (seedance25Capabilities?.maxBatchGenCount || 1)))
                .validate('body.response_format', v => _.isUndefined(v) || _.isString(v))
                .validate('headers.authorization', _.isString);

            if (!_.isUndefined(nInput) && !seedance25Capabilities) {
                throw new Error('n 参数仅支持 Seedance 2.5 Pro/Flash');
            }

            const functionMode = request.body.functionMode || 'first_last_frames';
            const isOmniMode = functionMode === 'omni_reference';

            // 验证 duration（根据模型）
            if (!_.isUndefined(request.body.duration)) {
                let durationValue: number;
                if (isMultiPart && typeof request.body.duration === 'string') {
                    durationValue = parseInt(request.body.duration, 10);
                    // 严格检查 parseInt 结果
                    if (!Number.isInteger(durationValue) || request.body.duration.trim() !== String(durationValue)) {
                        throw new Error(`duration 必须是整数，当前值: ${request.body.duration}`);
                    }
                } else if (_.isFinite(request.body.duration)) {
                    durationValue = request.body.duration as number;
                    if (!Number.isInteger(durationValue)) {
                        throw new Error(`duration 必须是整数，当前值: ${durationValue}`);
                    }
                } else {
                    throw new Error(`duration 参数格式错误`);
                }

                // 根据模型验证 duration 有效值
                let validDurations: number[] = [];
                let errorMessage = '';

                if (seedance25Capabilities) {
                    if (durationValue < SEEDANCE_25_MIN_DURATION || durationValue > SEEDANCE_25_MAX_DURATION) {
                        throw new Error(`Seedance 2.5 模型支持 ${SEEDANCE_25_MIN_DURATION}~${SEEDANCE_25_MAX_DURATION} 秒整数时长`);
                    }
                } else if (modelName.includes('veo3.1') || modelName.includes('veo3')) {
                    validDurations = [8];
                    errorMessage = 'veo3 模型仅支持 8 秒时长';
                } else if (modelName.includes('sora2')) {
                    validDurations = [4, 8, 12];
                    errorMessage = 'sora2 模型仅支持 4、8、12 秒时长';
                } else if (modelName.includes('3.5-pro') || modelName.includes('3.5_pro')) {
                    validDurations = [5, 10, 12];
                    errorMessage = '3.5-pro 模型仅支持 5、10、12 秒时长';
                } else if (modelName.includes('seedance-2.0') || modelName.includes('40_pro') || modelName.includes('40-pro') || modelName.includes('seedance-2.0-fast')) {
                    // seedance 2.0 和 2.0-fast 支持 4~15 秒任意整数
                    if (durationValue < 4 || durationValue > 15) {
                        throw new Error(`seedance 2.0/2.0-fast 模型支持 4~15 秒时长，当前值: ${durationValue}`);
                    }
                } else {
                    // 其他模型支持 5 或 10 秒
                    validDurations = [5, 10];
                    errorMessage = '该模型仅支持 5、10 秒时长';
                }

                // 检查是否在有效值列表中
                if (validDurations.length > 0 && !validDurations.includes(durationValue)) {
                    throw new Error(`${errorMessage}，当前值: ${durationValue}`);
                }
            }

            // 验证 file_paths 和 filePaths
            request
                .validate('body.file_paths', v => _.isUndefined(v) || (_.isArray(v) && v.length <= maxFilePaths))
                .validate('body.filePaths', v => _.isUndefined(v) || (_.isArray(v) && v.length <= maxFilePaths));

            if (seedance25Capabilities) {
                for (const unsupported of ['is_long_video', 'fps', 'count', 'meta_list']) {
                    if (request.body[unsupported] !== undefined) throw new Error(`${unsupported} 不支持直接传入，请使用文档中的 API 参数`);
                }
                if (request.body.response_format !== undefined && !['url', 'b64_json'].includes(request.body.response_format)) throw new Error('response_format 仅支持 url 或 b64_json');
                const prompt = request.body.prompt || '';
                if (prompt.length > 15000) throw new Error('Seedance 2.5 prompt 最多 15000 个字符');
                const ratio = request.body.ratio || '1:1';
                const resolution = request.body.resolution || '720p';
                if (!(SEEDANCE_25_RATIOS as readonly string[]).includes(ratio)) {
                    throw new Error(`Seedance 2.5 不支持比例 "${ratio}"。支持的比例: ${SEEDANCE_25_RATIOS.join(', ')}`);
                }
                if (!isSeedance25Resolution(modelName, resolution)) {
                    throw new Error(`模型 ${modelName} 不支持分辨率 "${resolution}"。支持的分辨率: ${seedance25Capabilities.resolutions.join(', ')}`);
                }

                const maxByType = {
                    image: seedance25Capabilities.maxImages,
                    video: seedance25Capabilities.maxVideos,
                    audio: seedance25Capabilities.maxAudios,
                };
                const mediaFields = new Set([...Object.keys(request.body), ...Object.keys(request.files || {})]);
                for (const fieldName of mediaFields) {
                    const match = fieldName.match(/^(image|video|audio)_file(?:_(\d+))?$/);
                    if (!match) {
                        if (/^(image|video|audio)_file/.test(fieldName) || request.files?.[fieldName]) throw new Error(`不支持的素材字段 ${fieldName}`);
                        continue;
                    }
                    if (match[2] && String(Number(match[2])) !== match[2]) throw new Error(`素材字段编号不规范: ${fieldName}`);
                    if (Array.isArray(request.files?.[fieldName])) throw new Error(`${fieldName} 只能对应一个文件，请使用不同编号`);
                    const index = match[2] ? Number(match[2]) : 1;
                    if (index < 1 || index > maxByType[match[1] as keyof typeof maxByType]) {
                        throw new Error(`${fieldName} 超出该模型的素材字段范围`);
                    }
                    if (!request.files?.[fieldName] && !(typeof request.body[fieldName] === 'string' && /^https?:\/\//i.test(request.body[fieldName]))) {
                        throw new Error(`${fieldName} 必须是 multipart 文件或 HTTP(S) OSS URL`);
                    }
                }
                for (const paths of [request.body.filePaths, request.body.file_paths]) {
                    if (Array.isArray(paths) && paths.some((url) => typeof url !== 'string' || !/^https?:\/\//i.test(url))) {
                        throw new Error('file_paths/filePaths 中的每一项都必须是 HTTP(S) 图片 URL');
                    }
                }

                const filePaths = Array.isArray(request.body.filePaths) && request.body.filePaths.length
                    ? request.body.filePaths
                    : Array.isArray(request.body.file_paths) ? request.body.file_paths : [];
                const counts = countSeedance25Media(request.body, request.files || {}, filePaths);
                const limitError = getSeedance25MediaLimitError(modelName, counts);
                if (limitError) throw new Error(limitError);

                if (!counts.total && !prompt.trim()) {
                    throw new Error('Seedance 2.5 文生视频需要非空 prompt');
                }
                if (!isOmniMode) {
                    if (counts.videos || counts.audios) throw new Error('首尾帧模式只支持图片；视频和音频参考请设置 functionMode=omni_reference');
                    if (counts.images > 2) throw new Error('首尾帧模式最多支持2张参考图片');
                }
            }

            if (isOmniMode) {
                const uploadedFiles = request.files || {};
                if (seedance25Capabilities) {
                    // Seedance 2.5 media and mode constraints are checked above.
                } else {
                    let imageCount = 0;
                    let videoCount = 0;
                    for (const fieldName of Object.keys(uploadedFiles)) {
                        if (fieldName.startsWith('image_file_')) imageCount++;
                        else if (fieldName.startsWith('video_file_')) videoCount++;
                    }
                    for (let i = 1; i <= 9; i++) {
                        const fieldName = `image_file_${i}`;
                        if (typeof request.body[fieldName] === 'string' && request.body[fieldName].startsWith('http')) imageCount++;
                    }
                    for (let i = 1; i <= 3; i++) {
                        const fieldName = `video_file_${i}`;
                        if (typeof request.body[fieldName] === 'string' && request.body[fieldName].startsWith('http')) videoCount++;
                    }
                    const totalCount = imageCount + videoCount;
                    if (imageCount > 9) throw new Error('全能模式最多上传9张图片');
                    if (videoCount > 3) throw new Error('全能模式最多上传3个视频');
                    if (totalCount > 12) throw new Error('全能模式图片+视频总数不超过12个');
                    if (totalCount === 0 && !((request.body.filePaths?.length > 0) || (request.body.file_paths?.length > 0))) {
                        throw new Error('全能模式至少需要上传1个素材文件(图片或视频)');
                    }
                }

            } else {
                // 普通模式验证逻辑（保持原有逻辑）
                const uploadedFiles = request.files ? _.values(request.files) : [];
                if (Object.keys(request.files || {}).some((name) => /^(video|audio)_file(?:_\d+)?$/.test(name))) {
                    throw new Error('参考视频和音频需要设置 functionMode=omni_reference');
                }
                if (!seedance25Capabilities && uploadedFiles.length > 2) {
                    throw new Error('最多只能上传2个图片文件');
                }
            }

            // refresh_token切分
            const eligible = seedance25Capabilities
                ? (token: string) => parseRegionFromToken(token).isInternational : undefined;
            const tokens = tokenSplit(request.headers.authorization, eligible).filter(token => !eligible || eligible(token));
            if (eligible && tokens.length === 0) throw new Error('Seedance 2.5 模型需要 Dreamina 国际站账号');

            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio = "1:1",
                resolution = "720p",
                duration = 5,
                file_paths = [],
                filePaths = [],
                response_format = "url"
            } = request.body;

            const estimatedCostPerVideo = estimateCredits('video', { model, resolution, duration });
            request.logDetails.estimatedCredits = estimatedCostPerVideo * generationCount;

            // 如果是 multipart/form-data，需要将字符串转换为数字
            const finalDuration = isMultiPart && typeof duration === 'string'
                ? parseInt(duration)
                : duration;

            // 兼容两种参数名格式：file_paths 和 filePaths
            const finalFilePaths = filePaths.length > 0 ? filePaths : file_paths;

            const data: Array<{ url?: string; b64_json?: string; revised_prompt: string }> = [];
            const errors: Array<{ index: number; code: unknown; message: string }> = [];

            for (let index = 0; index < generationCount; index++) {
                try {
                    const sel = await selectToken(tokens, estimatedCostPerVideo, 'highest');
                    if (index === 0) request.setLogAccount(sel.token);
                    const url = await generateVideo(
                        model,
                        prompt || '',
                        {
                            ratio,
                            resolution,
                            duration: finalDuration,
                            filePaths: finalFilePaths,
                            files: request.files,
                            httpRequest: request,
                            functionMode,
                            seed: normalizedSeed,
                        },
                        sel.proxyToken
                    );
                    try {
                        db.recordCall(sel.token, model, 0);
                        if (url) db.saveMedia('video', url, model, prompt || '', sel.token);
                    } catch (e) { /* 忽略数据库错误，不影响主流程 */ }
                    if (response_format === 'b64_json') {
                        try {
                            data.push({ b64_json: await util.fetchFileBASE64(url), revised_prompt: prompt || '' });
                        } catch (error: any) {
                            if (generationCount === 1) throw error;
                            data.push({ url, revised_prompt: prompt || '' });
                            errors.push({ index, code: error?.errcode ?? error?.code ?? null, message: '视频已生成，Base64 转换失败，已保留 URL' });
                            break;
                        }
                    } else {
                        data.push({ url, revised_prompt: prompt || '' });
                    }
                } catch (error: any) {
                    if (index === 0) throw error;
                    errors.push({
                        index,
                        code: error?.errcode ?? error?.code ?? null,
                        message: error?.message || '视频生成失败',
                    });
                    break;
                }
            }

            return {
                created: util.unixTimestamp(),
                data,
                ...(errors.length ? { errors } : {}),
            };
        }

    }

}
