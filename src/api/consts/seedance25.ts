export const SEEDANCE_25_MODEL_CAPABILITIES = {
  "jimeng-video-seedance-2.5": {
    upstreamModel: "dreamina_seedance_45_pro",
    resolutions: ["480p", "720p", "1080p", "4k"],
    maxImages: 30,
    maxVideos: 10,
    maxAudios: 10,
    maxTotalMaterials: 50,
    maxBatchGenCount: 4,
  },
  "jimeng-video-seedance-2.5-flash": {
    upstreamModel: "dreamina_seedance_45_flash",
    resolutions: ["480p", "720p"],
    maxImages: 10,
    maxVideos: 5,
    maxAudios: 5,
    maxTotalMaterials: 20,
    maxBatchGenCount: 4,
  },
} as const;

export const SEEDANCE_25_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const SEEDANCE_25_MIN_DURATION = 4;
export const SEEDANCE_25_MAX_DURATION = 30;
export const SEEDANCE_25_MAX_REFERENCE_DURATION = 30.2;
export const SEEDANCE_25_FPS = 24;
export const SEEDANCE_25_T2V_DRAFT_VERSION = "3.3.39";
export const SEEDANCE_25_T2V_MIN_VERSION = "3.0.5";

export type Seedance25Model = keyof typeof SEEDANCE_25_MODEL_CAPABILITIES;

export interface Seedance25MediaCounts {
  images: number;
  videos: number;
  audios: number;
  total: number;
}

export function getSeedance25Capabilities(model: string) {
  return isSeedance25Model(model) ? SEEDANCE_25_MODEL_CAPABILITIES[model] : undefined;
}

export function isSeedance25Model(model: string): model is Seedance25Model {
  return Object.prototype.hasOwnProperty.call(SEEDANCE_25_MODEL_CAPABILITIES, model);
}

export function isSeedance25Resolution(model: string, resolution: string): boolean {
  const capabilities = getSeedance25Capabilities(model);
  return Boolean(capabilities?.resolutions.includes(resolution as any));
}

export function countSeedance25Media(
  body: Record<string, any>,
  files: Record<string, any> = {},
  filePaths: string[] = []
): Seedance25MediaCounts {
  const fields = new Set([...Object.keys(body), ...Object.keys(files)]);
  const count = (type: "image" | "video" | "audio") => [...fields].filter((field) => {
    if (!new RegExp(`^${type}_file(?:_\\d+)?$`).test(field)) return false;
    return Boolean(files[field]) || (typeof body[field] === "string" && /^https?:\/\//i.test(body[field]));
  }).length;
  const images = count("image") + filePaths.length;
  const videos = count("video");
  const audios = count("audio");

  return { images, videos, audios, total: images + videos + audios };
}

export function getSeedance25MediaLimitError(
  model: string,
  counts: Seedance25MediaCounts
): string | undefined {
  const limits = getSeedance25Capabilities(model);
  if (!limits) return undefined;
  if (counts.images > limits.maxImages) return `最多支持 ${limits.maxImages} 张参考图片`;
  if (counts.videos > limits.maxVideos) return `最多支持 ${limits.maxVideos} 个参考视频`;
  if (counts.audios > limits.maxAudios) return `最多支持 ${limits.maxAudios} 个参考音频`;
  if (counts.total > limits.maxTotalMaterials) return `参考素材总数不能超过 ${limits.maxTotalMaterials} 个`;
}
