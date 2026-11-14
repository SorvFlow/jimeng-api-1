import _ from "lodash";
import fs from "fs-extra";
import axios from "axios";

import APIException from "@/lib/exceptions/APIException.ts";

import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, parseRegionFromToken, getAssistantId, checkImageContent, RegionInfo } from "./core.ts";
import logger from "@/lib/logger.ts";
import { SmartPoller, PollingStatus } from "@/lib/smart-poller.ts";
import { DEFAULT_ASSISTANT_ID_CN, DEFAULT_ASSISTANT_ID_US, DEFAULT_ASSISTANT_ID_HK, DEFAULT_ASSISTANT_ID_JP, DEFAULT_ASSISTANT_ID_SG, DEFAULT_VIDEO_MODEL, DRAFT_VERSION, DRAFT_VERSION_OMNI, OMNI_BENEFIT_TYPE, OMNI_BENEFIT_TYPE_FAST, VIDEO_MODEL_MAP, VIDEO_MODEL_MAP_US, VIDEO_MODEL_MAP_ASIA } from "@/api/consts/common.ts";
import {
  getSeedance25Capabilities,
  SEEDANCE_25_FPS,
  SEEDANCE_25_MAX_REFERENCE_DURATION,
  SEEDANCE_25_T2V_DRAFT_VERSION,
  SEEDANCE_25_T2V_MIN_VERSION,
} from "@/api/consts/seedance25.ts";
import { uploadImageBuffer, ImageUploadResult } from "@/lib/image-uploader.ts";
import { uploadAudioBuffer, AudioUploadResult, uploadVideoBuffer, VideoUploadResult } from "@/lib/video-uploader.ts";
import { extractVideoUrl, fetchHighQualityVideoUrl } from "@/lib/image-utils.ts";
import { uploadAudioFromUrl, uploadVideoFromUrl } from "@/lib/video-uploader.ts";

export const DEFAULT_MODEL = DEFAULT_VIDEO_MODEL;

export function getModel(model: string, regionInfo: RegionInfo) {
  // 根据站点选择不同的模型映射
  let modelMap: Record<string, string>;
  if (regionInfo.isUS) {
    modelMap = VIDEO_MODEL_MAP_US;
  } else if (regionInfo.isHK || regionInfo.isJP || regionInfo.isSG || regionInfo.isVN) {
    modelMap = VIDEO_MODEL_MAP_ASIA;
  } else {
    modelMap = VIDEO_MODEL_MAP;
  }
  return modelMap[model] || modelMap[DEFAULT_MODEL] || VIDEO_MODEL_MAP[DEFAULT_MODEL];
}

export function getVideoBenefitType(
  model: string,
  resolution = "720p",
  hasInputVideo = false
): string {
  if (model.includes("dreamina_seedance_45_pro")) {
    // Captured standard types are keyed by output resolution and input-video presence.
    // The separate long_video variants exist, but their cutoff is unverified; do not guess it.
    return hasInputVideo
      ? `seedance_25_${resolution}_output`
      : `seedance_25_${resolution}_no_input_video_output`;
  }
  if (model.includes("dreamina_seedance_45_flash")) {
    return hasInputVideo
      ? `seedance_25_flash_${resolution}_output`
      : `seedance_25_flash_${resolution}_no_input_video`;
  }
  // veo3.1 模型 (需先于 veo3 检查)
  if (model.includes("veo3.1")) {
    return "generate_video_veo3.1";
  }
  // veo3 模型
  if (model.includes("veo3")) {
    return "generate_video_veo3";
  }
  // sora2 模型
  if (model.includes("sora2")) {
    return "generate_video_sora2";
  }
  if (model.includes("40_pro")) {
    return "dreamina_video_seedance_20_pro";
  }
  if (model.includes("40")) {
    return "dreamina_seedance_20_fast";
  }
  if (model.includes("3.5_pro")) {
    return "dreamina_video_seedance_15_pro";
  }
  if (model.includes("3.5")) {
    return "dreamina_video_seedance_15";
  }
  return "basic_video_operation_vgfm_v_three";
}

// 处理本地上传的文件
async function uploadImageFromFile(file: any, refreshToken: string, regionInfo: RegionInfo): Promise<ImageUploadResult> {
  try {
    logger.info(`开始从本地文件上传视频图片: ${file.originalFilename} (路径: ${file.filepath})`);
    const imageBuffer = await fs.readFile(file.filepath);
    return await uploadImageBuffer(imageBuffer, refreshToken, regionInfo);
  } catch (error: any) {
    logger.error(`从本地文件上传视频图片失败: ${error.message}`);
    throw error;
  }
}

// 处理来自URL的图片
async function uploadImageFromUrl(imageUrl: string, refreshToken: string, regionInfo: RegionInfo): Promise<ImageUploadResult> {
  try {
    logger.info(`开始从URL下载并上传视频图片: ${util.safeURLLabel(imageUrl)}`);
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      proxy: false,
    });
    if (imageResponse.status < 200 || imageResponse.status >= 300) {
      throw new Error(`下载图片失败: ${imageResponse.status}`);
    }
    const imageBuffer = imageResponse.data;
    return await uploadImageBuffer(imageBuffer, refreshToken, regionInfo);
  } catch (error: any) {
    logger.error(`从URL上传视频图片失败 (${util.safeURLLabel(imageUrl)}): ${error.code || error.response?.status || String(error.message).replaceAll(imageUrl, util.safeURLLabel(imageUrl))}`);
    throw new Error(`从URL上传视频图片失败: ${error.response?.status || error.code || String(error.message).replaceAll(imageUrl, util.safeURLLabel(imageUrl))}`);
  }
}

/**
 * 解析 omni_reference 模式的 prompt，将 @引用 拆解为 meta_list
 * 输入: "@image_file_1作为首帧，@image_file_2作为尾帧，运动动作模仿@video_file"
 * 输出: 交替的 text + material_ref 段
 */
function parseOmniPrompt(prompt: string, materialRegistry: Map<string, any>): any[] {
  // 收集所有可识别的引用名（字段名 + 原始文件名），转义正则特殊字符
  const refNames = [...materialRegistry.keys()]
    .sort((a, b) => b.length - a.length) // 长名优先匹配
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (refNames.length === 0) {
    return [{ meta_type: "text", text: prompt }];
  }

  const pattern = new RegExp(`@(${refNames.join('|')})`, 'g');
  const meta_list: any[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(prompt)) !== null) {
    // 文本段
    if (match.index > lastIndex) {
      const textSegment = prompt.slice(lastIndex, match.index);
      if (textSegment) {
        meta_list.push({ meta_type: "text", text: textSegment });
      }
    }
    // 引用段
    const refName = match[1];
    const entry = materialRegistry.get(refName);
    if (entry) {
      meta_list.push({
        meta_type: entry.type,
        text: "",
        material_ref: { material_idx: entry.idx },
      });
    }
    lastIndex = pattern.lastIndex;
  }

  // 尾部文本
  if (lastIndex < prompt.length) {
    meta_list.push({ meta_type: "text", text: prompt.slice(lastIndex) });
  }

  // 如果没有任何 @ 引用，把整个 prompt 作为文本段
  if (meta_list.length === 0) {
    meta_list.push({ meta_type: "text", text: prompt });
  }

  return meta_list;
}


/**
 * 生成视频
 *
 * @param _model 模型名称
 * @param prompt 提示词
 * @param options 选项
 * @param refreshToken 刷新令牌
 * @returns 视频URL
 */
export async function generateVideo(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "720p",
    duration = 5,
    filePaths = [],
    files = {},
    httpRequest,
    functionMode = "first_last_frames",
    seed,
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any;
    httpRequest?: any;
    functionMode?: string;
    seed?: number;
  },
  refreshToken: string
) {
  // 检测区域
  const regionInfo = parseRegionFromToken(refreshToken);
  const { isInternational } = regionInfo;

  logger.info(`视频生成区域检测: isInternational=${isInternational}`);

  const model = getModel(_model, regionInfo);
  const seedance25Capabilities = getSeedance25Capabilities(_model);
  const isSeedance25 = Boolean(seedance25Capabilities);
  if (isSeedance25 && !isInternational) {
    throw new APIException(EX.API_REQUEST_FAILED, "Seedance 2.5 模型仅支持 Dreamina 国际站账号");
  }
  const isVeo3 = model.includes("veo3");
  const isSora2 = model.includes("sora2");
  const is35Pro = model.includes("3.5_pro");
  const is40Pro = model.includes("40_pro");
  const is40 = model.includes("40") && !model.includes("40_pro");
  // 只有 video-3.0 和 video-3.0-fast 支持 resolution 参数（3.0-pro 和 3.5-pro 不支持）
  const supportsResolution = isSeedance25 || ((model.includes("vgfm_3.0") || model.includes("vgfm_3.0_fast")) && !model.includes("_pro"));

  // 将秒转换为毫秒
  // veo3 模型固定 8 秒
  // sora2 模型支持 4秒、8秒、12秒，默认4秒
  // 3.5-pro 模型支持 5秒、10秒、12秒，默认5秒
  // 4.0-pro (seedance 2.0) 和 4.0 (seedance 2.0-fast) 模型支持 4~15秒，默认5秒
  // 其他模型支持 5秒、10秒，默认5秒
  let durationMs: number;
  let actualDuration: number;
  if (isVeo3) {
    durationMs = 8000;
    actualDuration = 8;
  } else if (isSora2) {
    if (duration === 12) {
      durationMs = 12000;
      actualDuration = 12;
    } else if (duration === 8) {
      durationMs = 8000;
      actualDuration = 8;
    } else {
      durationMs = 4000;
      actualDuration = 4;
    }
  } else if (isSeedance25) {
    if (!Number.isInteger(duration) || duration < 4 || duration > 30) {
      throw new APIException(EX.API_REQUEST_FAILED, "Seedance 2.5 模型支持 4~30 秒整数时长");
    }
    actualDuration = duration;
    durationMs = actualDuration * 1000;
  } else if (is40Pro || is40) {
    // seedance 2.0 和 2.0-fast: 支持 4~15 秒，clamp 到有效范围，默认 5 秒
    actualDuration = Math.max(4, Math.min(15, duration));
    durationMs = actualDuration * 1000;
  } else if (is35Pro) {
    if (duration === 12) {
      durationMs = 12000;
      actualDuration = 12;
    } else if (duration === 10) {
      durationMs = 10000;
      actualDuration = 10;
    } else {
      durationMs = 5000;
      actualDuration = 5;
    }
  } else {
    durationMs = duration === 10 ? 10000 : 5000;
    actualDuration = duration === 10 ? 10 : 5;
  }

  logger.info(`使用模型: ${_model} 映射模型: ${model} 比例: ${ratio} 分辨率: ${supportsResolution ? resolution : '不支持'} 时长: ${actualDuration}s`);

  // 检查积分
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0) {
    logger.info("积分为 0，尝试收取今日积分...");
    try {
      await receiveCredit(refreshToken);
    } catch (receiveError) {
      logger.warn(`收取积分失败: ${receiveError.message}. 这可能是因为: 1) 今日已收取过积分, 2) 账户受到风控限制, 3) 需要在官网手动收取首次积分`);
      throw new APIException(EX.API_VIDEO_GENERATION_FAILED,
        `积分不足且无法自动收取。请访问即梦官网手动收取首次积分，或检查账户状态。`);
    }
  }

  const isOmniMode = functionMode === "omni_reference";
  const seedance25RefFields = Object.keys(files || {}).concat(Object.keys(httpRequest?.body || {}))
    .filter((field) => /^(image|video|audio)_file(?:_\d+)?$/.test(field))
    .some((field) => files?.[field] || (typeof httpRequest?.body?.[field] === "string" && /^https?:\/\//i.test(httpRequest.body[field])));
  const hasSeedance25References = Boolean(seedance25RefFields || filePaths.length > 0);
  if (isSeedance25) {
    const hasVideoOrAudioReferences = [...Object.keys(files || {}), ...Object.keys(httpRequest?.body || {})]
      .some((field) => /^(video|audio)_file(?:_\d+)?$/.test(field)
        && (files?.[field] || (typeof httpRequest?.body?.[field] === "string" && /^https?:\/\//i.test(httpRequest.body[field]))));
    if (!isOmniMode && hasVideoOrAudioReferences) {
      throw new APIException(EX.API_REQUEST_FAILED, "视频和音频参考需要设置 functionMode=omni_reference");
    }
    if (!isOmniMode) {
      const imageCount = new Set([...Object.keys(files || {}), ...Object.keys(httpRequest?.body || {})]
        .filter((field) => /^image_file(?:_\d+)?$/.test(field))
        .filter((field) => files?.[field] || (typeof httpRequest?.body?.[field] === "string" && /^https?:\/\//i.test(httpRequest.body[field]))))
        .size + filePaths.length;
      if (imageCount > 2) {
        throw new APIException(EX.API_REQUEST_FAILED, "Seedance 2.5 首尾帧模式最多支持2张参考图片");
      }
    }
    if (!hasSeedance25References && !prompt.trim()) {
      throw new APIException(EX.API_REQUEST_FAILED, "Seedance 2.5 文生视频需要非空 prompt");
    }
    if (prompt.length > 15000) throw new APIException(EX.API_REQUEST_FAILED, "Seedance 2.5 prompt 最多 15000 个字符");
  }

  // omni_reference supports the existing Seedance 2.x paths and Seedance 2.5.
  if (isOmniMode && !is40Pro && !is40 && !isSeedance25) {
    throw new APIException(EX.API_REQUEST_FAILED,
      `omni_reference 模式仅支持 jimeng-video-seedance-2.0 和 jimeng-video-seedance-2.0-fast 模型`);
  }

  let requestData: any;

  if (isOmniMode && (!isSeedance25 || hasSeedance25References)) {
    // ========== omni_reference 分支 ==========
    logger.info(`进入 omni_reference 全能模式`);

    // 素材注册表: fieldName → { idx, type, uploadResult }
    interface MaterialEntry {
      idx: number;
      type: "image" | "video" | "audio";
      fieldName: string;
      originalFilename: string;
      imageUri?: string;
      imageWidth?: number;
      imageHeight?: number;
      imageFormat?: string;
      videoResult?: VideoUploadResult;
      audioResult?: AudioUploadResult;
    }
    const materialRegistry: Map<string, MaterialEntry> = new Map();
    let materialIdx = 0;
    const maxImages = seedance25Capabilities?.maxImages || 9;
    const maxVideos = seedance25Capabilities?.maxVideos || 3;
    const maxAudios = seedance25Capabilities?.maxAudios || 0;

    // canonical key 集合，防止 originalFilename 覆盖
    const canonicalKeys = new Set<string>();
    for (const type of ["image", "video", "audio"]) canonicalKeys.add(`${type}_file`);
    for (let i = 1; i <= maxImages; i++) canonicalKeys.add(`image_file_${i}`);
    for (let i = 1; i <= maxVideos; i++) canonicalKeys.add(`video_file_${i}`);
    for (let i = 1; i <= maxAudios; i++) canonicalKeys.add(`audio_file_${i}`);

    // 安全注册别名：originalFilename 不与 canonical key 冲突时才注册
    function registerAlias(filename: string, entry: MaterialEntry) {
      if (!canonicalKeys.has(filename) && !materialRegistry.has(filename)) {
        materialRegistry.set(filename, entry);
      }
    }

    const mediaFields = (type: "image" | "video" | "audio", limit: number) => {
      if (!limit) return [];
      const names = new Set([...Object.keys(files || {}), ...Object.keys(httpRequest?.body || {})]);
      return [...names].filter((fieldName) => {
        if (!new RegExp(`^${type}_file(?:_\\d+)?$`).test(fieldName)) return false;
        const suffix = fieldName.match(/_(\d+)$/)?.[1];
        if (suffix && Number(suffix) > limit) return false;
        return Boolean(files?.[fieldName]) || (typeof httpRequest?.body?.[fieldName] === "string" && /^https?:\/\//i.test(httpRequest.body[fieldName]));
      }).sort((a, b) => {
        const aIndex = Number(a.match(/_(\d+)$/)?.[1] || 0);
        const bIndex = Number(b.match(/_(\d+)$/)?.[1] || 0);
        return aIndex - bIndex;
      });
    };
    const imageFields = mediaFields("image", maxImages);
    const videoFields = mediaFields("video", maxVideos);
    const audioFields = mediaFields("audio", maxAudios);

    // 检查是否有素材
    const hasFilePaths = filePaths && filePaths.length > 0;
    if (imageFields.length === 0 && videoFields.length === 0 && audioFields.length === 0 && !hasFilePaths) {
      throw new APIException(EX.API_REQUEST_FAILED,
        `omni_reference 模式需要至少上传一个图片、视频或音频素材，或提供 OSS URL`);
    }

    let totalVideoDuration = 0; // 累计视频时长
    let totalAudioDuration = 0;

    // 串行上传图片素材
    for (const fieldName of imageFields) {
      const imageFile = files?.[fieldName];
      const imageUrlField = httpRequest?.body?.[fieldName];

      try {
        logger.info(`[omni] 上传 ${fieldName}`);
        let imgResult: ImageUploadResult;

        if (imageFile) {
          // 本地文件上传
          const buf = await fs.readFile(imageFile.filepath);
          imgResult = await uploadImageBuffer(buf, refreshToken, regionInfo);
          await checkImageContent(imgResult.uri, refreshToken, regionInfo);
          const entry: MaterialEntry = {
            idx: materialIdx++,
            type: "image",
            fieldName,
            originalFilename: imageFile.originalFilename,
            imageUri: imgResult.uri,
            imageWidth: imgResult.width,
            imageHeight: imgResult.height,
            imageFormat: imgResult.format,
          };
          materialRegistry.set(fieldName, entry);
          registerAlias(imageFile.originalFilename, entry);
          logger.info(`[omni] ${fieldName} 上传成功: ${imgResult.uri} (${imgResult.width}x${imgResult.height})`);
        } else if (imageUrlField && typeof imageUrlField === 'string' && imageUrlField.startsWith('http')) {
          // URL上传
          imgResult = await uploadImageFromUrl(imageUrlField, refreshToken, regionInfo);
          await checkImageContent(imgResult.uri, refreshToken, regionInfo);
          const entry: MaterialEntry = {
            idx: materialIdx++,
            type: "image",
            fieldName,
            originalFilename: imageUrlField,
            imageUri: imgResult.uri,
            imageWidth: imgResult.width,
            imageHeight: imgResult.height,
            imageFormat: imgResult.format,
          };
          materialRegistry.set(fieldName, entry);
          logger.info(`[omni] ${fieldName} URL上传成功: ${imgResult.uri} (${imgResult.width}x${imgResult.height})`);
        }
      } catch (error: any) {
        throw new APIException(EX.API_REQUEST_FAILED, `${fieldName} 处理失败: ${error.message}`);
      }
    }

    // 通过 filePaths 数组补充未被占用的图片槽位
    if (filePaths && filePaths.length > 0) {
      let slotIndex = 1;
      for (const url of filePaths) {
        // 找到第一个未被占用的槽位
        while (slotIndex <= maxImages && materialRegistry.has(`image_file_${slotIndex}`)) {
          slotIndex++;
        }
        if (slotIndex > maxImages) break; // 已达到最大数量

        const fieldName = `image_file_${slotIndex}`;
        try {
          logger.info(`[omni] 从URL上传 ${fieldName}`);
          const imgResult = await uploadImageFromUrl(url, refreshToken, regionInfo);
          await checkImageContent(imgResult.uri, refreshToken, regionInfo);
          const entry: MaterialEntry = {
            idx: materialIdx++,
            type: "image",
            fieldName,
            originalFilename: url,
            imageUri: imgResult.uri,
            imageWidth: imgResult.width,
            imageHeight: imgResult.height,
            imageFormat: imgResult.format,
          };
          materialRegistry.set(fieldName, entry);
          logger.info(`[omni] ${fieldName} URL上传成功: ${imgResult.uri} (${imgResult.width}x${imgResult.height})`);
        } catch (error: any) {
          throw new APIException(EX.API_REQUEST_FAILED, `${fieldName} URL图片处理失败: ${error.message}`);
        }
        slotIndex++;
      }
    }

    // 串行上传视频素材
    for (const fieldName of videoFields) {
      const videoFile = files?.[fieldName];
      const videoUrlField = httpRequest?.body?.[fieldName];

      try {
        logger.info(`[omni] 上传 ${fieldName}`);
        let vResult: VideoUploadResult;

        if (videoFile) {
          // 本地文件上传
          const buf = await fs.readFile(videoFile.filepath);
          if (isSeedance25 && buf.byteLength > 200 * 1024 * 1024) throw new Error("参考视频不能超过 200 MiB");
          vResult = await uploadVideoBuffer(buf, refreshToken, regionInfo, isSeedance25 ? SEEDANCE_25_MAX_REFERENCE_DURATION : 15);
          totalVideoDuration += vResult.videoMeta.duration;
          const entry: MaterialEntry = {
            idx: materialIdx++,
            type: "video",
            fieldName,
            originalFilename: videoFile.originalFilename,
            videoResult: vResult
          };
          materialRegistry.set(fieldName, entry);
          registerAlias(videoFile.originalFilename, entry);
          logger.info(`[omni] ${fieldName} 上传成功: vid=${vResult.vid}, ${vResult.videoMeta.width}x${vResult.videoMeta.height}, ${vResult.videoMeta.duration}s`);
        } else if (videoUrlField && typeof videoUrlField === 'string' && videoUrlField.startsWith('http')) {
          // URL上传
          vResult = await uploadVideoFromUrl(videoUrlField, refreshToken, regionInfo, isSeedance25 ? SEEDANCE_25_MAX_REFERENCE_DURATION : 15);
          totalVideoDuration += vResult.videoMeta.duration;
          const entry: MaterialEntry = {
            idx: materialIdx++,
            type: "video",
            fieldName,
            originalFilename: videoUrlField,
            videoResult: vResult
          };
          materialRegistry.set(fieldName, entry);
          logger.info(`[omni] ${fieldName} URL上传成功: vid=${vResult.vid}, ${vResult.videoMeta.width}x${vResult.videoMeta.height}, ${vResult.videoMeta.duration}s`);
        }
        if (isSeedance25 && (!vResult || !Number.isFinite(vResult.videoMeta.duration) || vResult.videoMeta.duration < 1.8 || vResult.videoMeta.duration > SEEDANCE_25_MAX_REFERENCE_DURATION)) {
          throw new Error(`参考视频时长需为 1.8~${SEEDANCE_25_MAX_REFERENCE_DURATION} 秒`);
        }
      } catch (error: any) {
        throw new APIException(EX.API_REQUEST_FAILED, `${fieldName} 处理失败: ${error.message}`);
      }
    }

    for (const fieldName of audioFields) {
      const audioFile = files?.[fieldName];
      const audioUrlField = httpRequest?.body?.[fieldName];

      try {
        logger.info(`[omni] 上传 ${fieldName}`);
        let audioResult: AudioUploadResult;
        if (audioFile) {
          const buf = await fs.readFile(audioFile.filepath);
          if (buf.byteLength > 15 * 1024 * 1024) throw new Error("参考音频不能超过 15 MiB");
          audioResult = await uploadAudioBuffer(buf, refreshToken, regionInfo);
        } else if (typeof audioUrlField === "string" && /^https?:\/\//i.test(audioUrlField)) {
          audioResult = await uploadAudioFromUrl(audioUrlField, refreshToken, regionInfo);
        } else {
          continue;
        }
        if (!Number.isFinite(audioResult.duration) || audioResult.duration < 1.8 || audioResult.duration > SEEDANCE_25_MAX_REFERENCE_DURATION) {
          throw new Error(`参考音频时长需为 1.8~${SEEDANCE_25_MAX_REFERENCE_DURATION} 秒`);
        }
        totalAudioDuration += audioResult.duration;
        const entry: MaterialEntry = {
          idx: materialIdx++,
          type: "audio",
          fieldName,
          originalFilename: audioFile?.originalFilename || fieldName,
          audioResult,
        };
        materialRegistry.set(fieldName, entry);
        if (audioFile?.originalFilename) registerAlias(audioFile.originalFilename, entry);
        logger.info(`[omni] ${fieldName} 上传成功: vid=${audioResult.vid}, ${audioResult.duration}s, ${audioResult.format}`);
      } catch (error: any) {
        throw new APIException(EX.API_REQUEST_FAILED, `${fieldName} 处理失败: ${error.message}`);
      }
    }

    // 验证视频总时长
    const MAX_TOTAL_VIDEO_DURATION = isSeedance25 ? SEEDANCE_25_MAX_REFERENCE_DURATION : 15;
    if (!Number.isFinite(totalVideoDuration)) {
      throw new APIException(EX.API_REQUEST_FAILED,
        `视频时长数据异常，请检查视频文件`);
    }
    if (totalVideoDuration > MAX_TOTAL_VIDEO_DURATION) {
      throw new APIException(EX.API_REQUEST_FAILED,
        `视频总时长 ${totalVideoDuration.toFixed(2)}s 超过限制 (最大 ${MAX_TOTAL_VIDEO_DURATION}s)`);
    }

    if (isSeedance25 && totalAudioDuration > SEEDANCE_25_MAX_REFERENCE_DURATION) {
      throw new APIException(EX.API_REQUEST_FAILED,
        `音频总时长 ${totalAudioDuration.toFixed(2)}s 超过限制 (最大 ${SEEDANCE_25_MAX_REFERENCE_DURATION}s)`);
    }

    logger.info(`[omni] 视频总时长: ${totalVideoDuration.toFixed(2)}s`);

    // 构建 material_list（按注册顺序）
    const orderedEntries = [...new Map([...materialRegistry].filter(([k, v]) => k === v.fieldName)).values()]
      .sort((a, b) => a.idx - b.idx);

    const material_list: any[] = [];
    const materialTypes: number[] = [];

    for (const entry of orderedEntries) {
      if (entry.type === "image") {
        material_list.push({
          type: "",
          id: util.uuid(),
          material_type: "image",
          image_info: {
            type: "image",
            id: util.uuid(),
            source_from: "upload",
            platform_type: 1,
            name: "",
            image_uri: entry.imageUri,
            width: entry.imageWidth || 0,
            height: entry.imageHeight || 0,
            format: entry.imageFormat || "",
            uri: entry.imageUri,
          },
        });
        materialTypes.push(1);
      } else if (entry.type === "video") {
        const vm = entry.videoResult!;
        material_list.push({
          type: "",
          id: util.uuid(),
          material_type: "video",
          video_info: {
            type: "video",
            id: util.uuid(),
            source_from: "upload",
            name: "",
            vid: vm.vid,
            fps: 0,
            width: vm.videoMeta.width,
            height: vm.videoMeta.height,
            duration: Math.round(vm.videoMeta.duration * 1000),
          },
        });
        materialTypes.push(2);
      } else {
        const am = entry.audioResult!;
        material_list.push({
          type: "",
          id: util.uuid(),
          material_type: "audio",
          audio_info: {
            type: "audio",
            id: util.uuid(),
            source_from: "upload",
            name: "",
            vid: am.vid,
            duration: Math.round(am.duration * 1000),
          },
        });
        materialTypes.push(3);
      }
    }

    // 解析 prompt → meta_list
    const meta_list = parseOmniPrompt(prompt, materialRegistry);

    logger.info(`[omni] material_list: ${material_list.length} 项, meta_list: ${meta_list.length} 项, materialTypes: [${materialTypes}]`);

    // 构建 omni payload
    const componentId = util.uuid();
    const submitId = util.uuid();

    const sceneOption = {
      type: "video",
      scene: "BasicVideoGenerateButton",
      ...(isSeedance25 ? { resolution } : {}),
      modelReqKey: model,
      videoDuration: actualDuration,
      materialTypes,
      reportParams: {
        enterSource: "generate",
        vipSource: "generate",
        extraVipFunctionKey: isSeedance25 ? `${model}-${resolution}` : model,
        useVipFunctionDetailsReporterHoc: true,
      },
    };

    const metricsExtra = JSON.stringify({
      position: "page_bottom_box",
      isDefaultSeed: isSeedance25 && seed !== undefined ? 0 : 1,
      originSubmitId: submitId,
      isRegenerate: false,
      enterFrom: "click",
      functionMode: "omni_reference",
      ...(isSeedance25 && seed !== undefined ? { seed } : {}),
      sceneOptions: JSON.stringify([sceneOption]),
    });

    // 根据模型选择 benefit_type
    const hasInputVideo = orderedEntries.some((entry) => entry.type === "video");
    const omniBenefitType = isSeedance25
      ? getVideoBenefitType(model, resolution, hasInputVideo)
      : is40 ? OMNI_BENEFIT_TYPE_FAST : OMNI_BENEFIT_TYPE;

    requestData = {
      params: {
        aigc_features: "app_lip_sync",
        web_version: "7.5.0",
        da_version: DRAFT_VERSION_OMNI,
      },
      data: {
        extend: {
          root_model: model,
          m_video_commerce_info: {
            benefit_type: omniBenefitType,
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc",
          },
          m_video_commerce_info_list: [{
            benefit_type: omniBenefitType,
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc",
          }],
        },
        submit_id: submitId,
        metrics_extra: metricsExtra,
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: DRAFT_VERSION_OMNI,
          min_features: ["AIGC_Video_UnifiedEdit"],
          is_from_tsn: true,
          version: DRAFT_VERSION_OMNI,
          main_component_id: componentId,
          component_list: [{
            type: "video_base_component",
            id: componentId,
            min_version: "1.0.0",
            aigc_mode: "workbench",
            metadata: {
              type: "",
              id: util.uuid(),
              created_platform: 3,
              created_platform_version: "",
              created_time_in_ms: Date.now().toString(),
              created_did: "",
            },
            generate_type: "gen_video",
            abilities: {
              type: "",
              id: util.uuid(),
              gen_video: {
                id: util.uuid(),
                type: "",
                text_to_video_params: {
                  type: "",
                  id: util.uuid(),
                  video_gen_inputs: [{
                    type: "",
                    id: util.uuid(),
                    min_version: DRAFT_VERSION_OMNI,
                    prompt: "",
                    video_mode: 2,
                    fps: 24,
                    duration_ms: durationMs,
                    ...(isSeedance25 ? { resolution } : {}),
                    unified_edit_input: {
                      type: "",
                      id: util.uuid(),
                      material_list,
                      meta_list,
                    },
                    idip_meta_list: [],
                  }],
                  video_aspect_ratio: ratio,
                  seed: seed ?? Math.floor(Math.random() * 4294967296),
                  model_req_key: model,
                  priority: 0,
                },
                video_task_extra: metricsExtra,
              },
            },
            process_type: 1,
          }],
        }),
        http_common_info: {
          aid: getAssistantId(regionInfo),
        },
      },
    };
  } else {
    // ========== first_last_frames 分支（原有逻辑） ==========
    let first_frame_image = undefined;
    let end_frame_image = undefined;
    let uploadIDs: string[] = [];
    // 优先处理本地上传的文件
    const uploadedFiles = _.values(files);
    if (isSeedance25) {
      // 同一字段的文件优先于 URL；不同字段按编号排序，保证首尾帧顺序。
      const imageFields = [...new Set([...Object.keys(files || {}), ...Object.keys(httpRequest?.body || {})])]
        .filter(name => /^image_file(?:_\d+)?$/.test(name))
        .sort((a, b) => Number(a.match(/_(\d+)$/)?.[1] || 0) - Number(b.match(/_(\d+)$/)?.[1] || 0));
      const images = imageFields.map(name => files?.[name] || httpRequest.body[name]).concat(filePaths);
      for (const [index, image] of images.entries()) {
        try {
          const result = typeof image === "string"
            ? await uploadImageFromUrl(image, refreshToken, regionInfo)
            : await uploadImageFromFile(image, refreshToken, regionInfo);
          await checkImageContent(result.uri, refreshToken, regionInfo);
          uploadIDs.push(result.uri);
        } catch (error: any) {
          throw new APIException(EX.API_REQUEST_FAILED, `第 ${index + 1} 个参考图片处理失败: ${error.message}`);
        }
      }
    } else if (uploadedFiles && uploadedFiles.length > 0) {
      logger.info(`检测到 ${uploadedFiles.length} 个本地上传文件，优先处理`);
      for (let i = 0; i < uploadedFiles.length; i++) {
        const file = uploadedFiles[i];
        if (!file) continue;
        try {
          logger.info(`开始上传第 ${i + 1} 张本地图片: ${file.originalFilename}`);
          const imgResult = await uploadImageFromFile(file, refreshToken, regionInfo);
          if (imgResult) {
            await checkImageContent(imgResult.uri, refreshToken, regionInfo);
            uploadIDs.push(imgResult.uri);
            logger.info(`第 ${i + 1} 张本地图片上传成功: ${imgResult.uri}`);
          } else {
            logger.error(`第 ${i + 1} 张本地图片上传失败: 未获取到 image_uri`);
          }
        } catch (error: any) {
          logger.error(`第 ${i + 1} 张本地图片上传失败: ${error.message}`);
          if (i === 0) {
            throw new APIException(EX.API_REQUEST_FAILED, `首帧图片上传失败: ${error.message}`);
          }
        }
      }
    } else if (filePaths && filePaths.length > 0) {
      logger.info(`未检测到本地上传文件，处理 ${filePaths.length} 个图片URL`);
      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        if (!filePath) {
          logger.warn(`第 ${i + 1} 个图片URL为空，跳过`);
          continue;
        }
        try {
          logger.info(`开始上传第 ${i + 1} 个URL图片`);
          const imgResult = await uploadImageFromUrl(filePath, refreshToken, regionInfo);
          if (imgResult) {
            await checkImageContent(imgResult.uri, refreshToken, regionInfo);
            uploadIDs.push(imgResult.uri);
            logger.info(`第 ${i + 1} 个URL图片上传成功: ${imgResult.uri}`);
          } else {
            logger.error(`第 ${i + 1} 个URL图片上传失败: 未获取到 image_uri`);
          }
        } catch (error: any) {
          logger.error(`第 ${i + 1} 个URL图片上传失败: ${error.message}`);
          if (i === 0) {
            throw new APIException(EX.API_REQUEST_FAILED, `首帧图片上传失败: ${error.message}`);
          }
        }
      }
    } else {
      logger.info(`未提供图片文件或URL，将进行纯文本视频生成`);
    }

    if (uploadIDs.length > 0) {
      logger.info(`图片上传完成，共成功 ${uploadIDs.length} 张`);
      if (uploadIDs[0]) {
        first_frame_image = {
          format: "", height: 0, id: util.uuid(), image_uri: uploadIDs[0],
          name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[0], width: 0,
        };
        logger.info(`设置首帧图片: ${uploadIDs[0]}`);
      }
      if (uploadIDs[1]) {
        end_frame_image = {
          format: "", height: 0, id: util.uuid(), image_uri: uploadIDs[1],
          name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[1], width: 0,
        };
        logger.info(`设置尾帧图片: ${uploadIDs[1]}`);
      }
    }

    const componentId = util.uuid();
    const originSubmitId = util.uuid();
    const flFunctionMode = isSeedance25 && uploadIDs.length === 0 ? "t2v" : "first_last_frames";

    const sceneOption = {
      type: "video",
      scene: "BasicVideoGenerateButton",
      ...(supportsResolution ? { resolution } : {}),
      modelReqKey: model,
      videoDuration: actualDuration,
      materialTypes: [] as number[],
      reportParams: {
        enterSource: "generate",
        vipSource: "generate",
        extraVipFunctionKey: supportsResolution ? `${model}-${resolution}` : model,
        useVipFunctionDetailsReporterHoc: true,
      },
    };

    const metricsExtra = JSON.stringify({
      promptSource: "custom",
      isDefaultSeed: isSeedance25 && seed !== undefined ? 0 : 1,
      originSubmitId,
      isRegenerate: false,
      enterFrom: "use_bgimage_prompt",
      position: "page_bottom_box",
      functionMode: flFunctionMode,
      sceneOptions: JSON.stringify([sceneOption]),
    });

    const hasImageInput = uploadIDs.length > 0;
    if (!isSeedance25 && hasImageInput && ratio !== "1:1") {
      logger.warn(`图生视频模式下，ratio参数将被忽略（由输入图片的实际比例决定），但resolution参数仍然有效`);
    }

    logger.info(`视频生成模式: ${uploadIDs.length}张图片 (首帧: ${!!first_frame_image}, 尾帧: ${!!end_frame_image}), resolution: ${resolution}`);

    requestData = {
      params: {
        aigc_features: "app_lip_sync",
        web_version: "7.5.0",
        da_version: isSeedance25 ? SEEDANCE_25_T2V_DRAFT_VERSION : DRAFT_VERSION,
      },
      data: {
        extend: {
          root_model: model,
          m_video_commerce_info: {
            benefit_type: getVideoBenefitType(model, resolution, false),
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc",
          },
          m_video_commerce_info_list: [{
            benefit_type: getVideoBenefitType(model, resolution, false),
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc",
          }],
        },
        submit_id: util.uuid(),
        metrics_extra: metricsExtra,
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: isSeedance25 ? SEEDANCE_25_T2V_MIN_VERSION : "3.0.5",
          min_features: isSeedance25 ? ["AIGC_Video_Seedance25ResultAction"] : [],
          is_from_tsn: true,
          version: isSeedance25 ? SEEDANCE_25_T2V_DRAFT_VERSION : DRAFT_VERSION,
          main_component_id: componentId,
          component_list: [{
            type: "video_base_component",
            id: componentId,
            min_version: "1.0.0",
            aigc_mode: "workbench",
            metadata: {
              type: "",
              id: util.uuid(),
              created_platform: 3,
              created_platform_version: "",
              created_time_in_ms: Date.now().toString(),
              created_did: "",
            },
            generate_type: "gen_video",
            abilities: {
              type: "",
              id: util.uuid(),
              gen_video: {
                id: util.uuid(),
                type: "",
                text_to_video_params: {
                  type: "",
                  id: util.uuid(),
                  video_gen_inputs: [{
                    type: "",
                    id: util.uuid(),
                    min_version: isSeedance25 ? SEEDANCE_25_T2V_MIN_VERSION : "3.0.5",
                    prompt,
                    video_mode: 2,
                    fps: isSeedance25 ? SEEDANCE_25_FPS : 24,
                    duration_ms: durationMs,
                    ...(supportsResolution ? { resolution } : {}),
                    first_frame_image,
                    end_frame_image,
                    idip_meta_list: [],
                  }],
                  video_aspect_ratio: ratio,
                  seed: seed ?? Math.floor(Math.random() * 4294967296),
                  model_req_key: model,
                  priority: 0,
                },
                video_task_extra: metricsExtra,
              },
            },
            process_type: 1,
          }],
        }),
        http_common_info: {
          aid: getAssistantId(regionInfo),
        },
      },
    };
  }

  // 发送请求
  const videoReferer = regionInfo.isCN
    ? "https://jimeng.jianying.com/ai-tool/generate?type=video"
    : "https://dreamina.capcut.com/ai-tool/generate?type=video";
  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      ...requestData,
      headers: { Referer: videoReferer },
    }
  );

  const historyId = aigc_data.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`视频生成任务已提交，history_id: ${historyId}，等待生成完成...`);

  // 首次查询前等待，让服务器有时间处理请求
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // 使用 SmartPoller 进行智能轮询
  const maxPollCount = 900; // 增加轮询次数，支持更长的生成时间
  let pollAttempts = 0;

  const poller = new SmartPoller({
    maxPollCount,
    pollInterval: 20000, // 20秒基础间隔
    expectedItemCount: 1,
    type: 'video',
    timeoutSeconds: 3600 // 60分钟超时
  });

  const { result: pollingResult, data: finalHistoryData } = await poller.poll(async () => {
    pollAttempts++;

    // 使用标准API请求方式
    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
      },
    });

    // 检查响应中是否有该 history_id 的数据
    // 由于 API 存在最终一致性，早期轮询可能暂时获取不到记录，返回处理中状态继续轮询
    if (!result[historyId]) {
      logger.warn(`API未返回历史记录 (轮询第${pollAttempts}次)，historyId: ${historyId}，继续等待...`);
      return {
        status: {
          status: 20, // PROCESSING
          itemCount: 0,
          historyId
        } as PollingStatus,
        data: { status: 20, item_list: [] }
      };
    }

    const historyData = result[historyId];

    const currentStatus = historyData.status;
    const currentFailCode = historyData.fail_code;
    const currentItemList = historyData.item_list || [];
    const finishTime = historyData.task?.finish_time || 0;

    // 记录详细信息
    if (currentItemList.length > 0) {
      const tempVideoUrl = currentItemList[0]?.common_attr?.transcoded_video?.origin?.video_url ||
                          currentItemList[0]?.video?.transcoded_video?.origin?.video_url ||
                          currentItemList[0]?.video?.play_url ||
                          currentItemList[0]?.video?.download_url ||
                          currentItemList[0]?.video?.url;
      if (tempVideoUrl) {
        logger.info(`检测到视频URL: ${tempVideoUrl}`);
      }
    }

    return {
      status: {
        status: currentStatus,
        failCode: currentFailCode,
        itemCount: currentItemList.length,
        finishTime,
        historyId
      } as PollingStatus,
      data: historyData
    };
  }, historyId);

  const item_list = finalHistoryData.item_list || [];

  // 尝试通过 get_local_item_list 获取高质量视频下载URL
  const itemId = item_list?.[0]?.item_id
    || item_list?.[0]?.id
    || item_list?.[0]?.local_item_id
    || item_list?.[0]?.common_attr?.id;

  if (itemId) {
    try {
      const hqVideoUrl = await fetchHighQualityVideoUrl(String(itemId), refreshToken);
      if (hqVideoUrl) {
        logger.info(`视频生成成功（高质量），URL: ${hqVideoUrl}，总耗时: ${pollingResult.elapsedTime}秒`);
        return hqVideoUrl;
      }
    } catch (error) {
      logger.warn(`获取高质量视频URL失败，将使用预览URL作为回退: ${error.message}`);
    }
  } else {
    logger.warn(`未能从item_list中提取item_id，将使用预览URL。item_list[0]键: ${item_list?.[0] ? Object.keys(item_list[0]).join(', ') : '无'}`);
  }

  // 回退：提取预览视频URL
  let fallbackVideoUrl = item_list?.[0] ? extractVideoUrl(item_list[0]) : null;

  // 如果无法获取视频URL，抛出异常
  if (!fallbackVideoUrl) {
    logger.error(`未能获取视频URL，item_list: ${JSON.stringify(item_list)}`);
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "未能获取视频URL，请稍后查看");
  }

  logger.info(`视频生成成功，URL: ${fallbackVideoUrl}，总耗时: ${pollingResult.elapsedTime}秒`);
  return fallbackVideoUrl;
}

/**
 * 从提示词中检测视频比例
 * 支持格式: 16:9, 16：9, 横屏, 竖屏 等
 */
function detectVideoAspectRatio(prompt: string): string {
  const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
  const ratioRegex = /(\d+)\s*[:：]\s*(\d+)/g;
  const matches = [...prompt.matchAll(ratioRegex)];

  for (const match of matches) {
    const key = `${match[1]}:${match[2]}`;
    if (VIDEO_ASPECT_RATIOS.includes(key)) {
      logger.info(`从提示词中检测到视频比例: ${key}`);
      return key;
    }
  }

  if (/横屏|横版|宽屏/.test(prompt)) {
    logger.info(`检测到横屏关键词 → 16:9`);
    return "16:9";
  }
  if (/竖屏|竖版|手机/.test(prompt)) {
    logger.info(`检测到竖屏关键词 → 9:16`);
    return "9:16";
  }
  if (/方形|正方/.test(prompt)) {
    logger.info(`检测到方形关键词 → 1:1`);
    return "1:1";
  }

  return "16:9"; // 默认
}

/**
 * 从提示词中检测视频时长
 * @returns 5 或 10，未检测到返回 null
 */
function detectVideoDuration(prompt: string): number | null {
  if (/10\s*[秒sS]/.test(prompt)) {
    logger.info(`从提示词中检测到时长: 10秒`);
    return 10;
  }
  if (/5\s*[秒sS]/.test(prompt)) {
    logger.info(`从提示词中检测到时长: 5秒`);
    return 5;
  }
  return null;
}

/**
 * 带自动降级重试的视频生成
 * 如果积分不足，自动降低分辨率和时长重试
 */
export async function generateVideoWithRetry(
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
  },
  refreshToken: string
): Promise<string> {
  // 智能比例检测
  let finalRatio = options.ratio || "16:9";
  if (finalRatio === "16:9" || !["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(finalRatio)) {
    const detected = detectVideoAspectRatio(prompt);
    if (detected) finalRatio = detected;
  }

  // 智能时长检测
  let finalDuration = options.duration || 10;
  const detectedDuration = detectVideoDuration(prompt);
  if (detectedDuration !== null && finalDuration === 10) {
    finalDuration = detectedDuration;
  }

  const resolutionLevels = ["1080p", "720p", "480p"];
  const durationLevels = [finalDuration, 5];

  let currentResIndex = Math.max(0, resolutionLevels.indexOf(options.resolution || "720p"));
  let currentDurIndex = 0;

  while (currentResIndex < resolutionLevels.length) {
    while (currentDurIndex < durationLevels.length) {
      try {
        const currentOptions = {
          ...options,
          ratio: finalRatio,
          resolution: resolutionLevels[currentResIndex],
          duration: durationLevels[currentDurIndex],
        };
        logger.info(`尝试生成视频，分辨率: ${currentOptions.resolution}，时长: ${currentOptions.duration}秒，比例: ${finalRatio}`);
        return await generateVideo(_model, prompt, currentOptions, refreshToken);
      } catch (error) {
        const isInsufficientCredits =
          error.code === EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS[0] ||
          (error.message &&
            (error.message.includes("积分不足") ||
              error.message.includes("2039") ||
              error.message.includes("1006")));

        if (!isInsufficientCredits) throw error;

        if (currentDurIndex < durationLevels.length - 1) {
          currentDurIndex++;
          logger.warn(`积分不足，自动降级到 ${durationLevels[currentDurIndex]}秒时长重试...`);
          continue;
        }

        if (currentResIndex < resolutionLevels.length - 1) {
          currentResIndex++;
          currentDurIndex = 0;
          logger.warn(`积分不足，自动降级到 ${resolutionLevels[currentResIndex]} 分辨率重试...`);
          break;
        }

        throw new APIException(
          EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS,
          "积分不足，已自动降至最低画质与时长仍然不足，请前往即梦官网 https://jimeng.jianying.com 充值积分"
        );
      }
    }
    currentDurIndex = 0;
  }

  throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "视频生成失败");
}
