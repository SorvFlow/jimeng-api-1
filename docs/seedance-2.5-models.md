# Dreamina Seedance 2.5 模型与参数

本文汇总官方 Dreamina Canvas CLI 1.3.0 模型目录、已提供的网页端抓包，以及本项目 `/v1/videos/generations` 当前实现。不同来源不一致的地方单独列出；抓包或模型目录不能代替一次成功生成，未验证项不作为确定结论。

本地验证范围和未验证项见[接入自测记录](seedance-2.5-validation.md)。

## 模型

| 本项目模型名 | Dreamina 模型键 | 站点 | 分辨率 |
| --- | --- | --- | --- |
| `jimeng-video-seedance-2.5` | `dreamina_seedance_45_pro` | 本项目映射至 US 与亚洲国际站 | `480p`、`720p`、`1080p`；`4k` 见下方差异说明 |
| `jimeng-video-seedance-2.5-flash` | `dreamina_seedance_45_flash` | Dreamina 国际站（US 与亚洲站） | `480p`、`720p` |

官方 CLI 规格列出三类视频模式：

| 官方 CLI 模式 | 用途 | 本项目接口映射 |
| --- | --- | --- |
| `t2v` | 纯文生视频，不需要参考素材 | 无参考素材时走文生视频 payload |
| `first_last_frame` | 一张首帧图，或首帧图加尾帧图 | `functionMode=first_last_frames` |
| `m2v` | 图片、视频、音频混合参考 | `functionMode=omni_reference` |

纯文生的上游 CLI 规格要求非空 prompt；首尾帧与混合参考模式可省略 prompt 或传空字符串。混合参考如需在文字中定位素材，使用 `@image_file_1`、`@video_file_1`、`@audio_file_1` 等字段名。本项目模型键映射到 US 和亚洲国际站，但不代表每个账号或地区均获上游授权；尚未逐地区验证。

## 请求参数

| 字段 | 类型 | 默认值 | 支持值或含义 |
| --- | --- | --- | --- |
| `model` | string | `jimeng-video-3.5-pro` | 使用上表中的两个 Seedance 2.5 模型名之一 |
| `prompt` | string | 文生必填；参考模式可选 | 最多 15,000 字符。纯文生需非空；首尾帧/混合参考可省略或传空字符串。混合参考可用 `@image_file_1`、`@video_file_1`、`@audio_file_1` 引用素材 |
| `ratio` | string | `1:1` | `21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16`。Seedance 2.5 请求会传递此参数；图像输入对最终裁切/画幅的影响尚未通过成功生成验证 |
| `resolution` | string | `720p` | Pro: `480p`、`720p`、`1080p`；`4k` 见下方差异说明。Flash: `480p`、`720p` |
| `duration` | integer，秒 | `5` | `4` 到 `30`，每次递增 1 秒 |
| `functionMode` | string | `first_last_frames` | `first_last_frames` 用于最多两张参考图；`omni_reference` 用于混合参考。Seedance 2.5 无参考素材时按文生视频处理 |
| `seed` | uint32 | 随机值 | 可选，范围 `0` 到 `4294967295`。抓包任务输入含此字段；官方 CLI 模型参数没有对应命令行选项 |
| `n` | integer | `1` | 本项目在一次 HTTP 请求内串行独立生成 `1` 到 `4` 项；仅支持 Seedance 2.5 Pro/Flash。每项都会重新选择账号并重新上传参考素材，各自计费 |
| `response_format` | string | `url` | `url` 或 `b64_json` |

上游输入中帧率固定为 `24 fps`，没有单独的帧率参数。CLI 模型规格中的 `maxBatchGenCount` 为 4；本项目将其实现为本地串行多次请求，不代表上游单次批量提交。后续项失败时会保留已完成的 `data`，并附 `errors` 数组（`index` 从 0 开始）；失败即停止批次。首项失败仍按标准错误响应返回。`b64_json` 转换在后续项失败时会保留该项已生成的 URL 并记录错误。CLI 的全部 Seedance 2.5 模式均将 `is_long_video` 标记为 `forbidden`。这与常规时长选项 `4`~`30` 秒是不同配置，不能依据生成秒数推断长视频权益或收费阈值。

## 参考素材

混合参考至少需要一种素材。各类素材字段如下：

| 字段 | 输入 | Pro 上限 | Flash 上限 |
| --- | --- | ---: | ---: |
| `image_file_1` ... `image_file_N` | multipart 文件或 HTTP(S) URL | 30 张 | 10 张 |
| `video_file_1` ... `video_file_N` | multipart 文件或 HTTP(S) URL | 10 个 | 5 个 |
| `audio_file_1` ... `audio_file_N` | multipart 文件或 HTTP(S) URL | 10 个 | 5 个 |

总数上限：Pro 为 50 项；Flash 按每种素材的数量上限合计，最多 20 项。输入视频累计时长与输入音频累计时长分别最多 30.2 秒。网页端模型配置列出的格式为：图片 jpeg/png/webp/bmp/tiff/gif/heic/heif，视频 mp4/mov，音频 wav/mp3。官方 CLI 给出的单项限制为：视频 1.8–30.2 秒、200 MiB，视频宽高各 300–6000 像素；音频 1.8–30.2 秒、15 MiB；图片 50 MiB，宽高各 300–8192 像素。`first_last_frame` 的 CLI 规格没有声明图片最小宽高；`m2v` 模式则列出 300 像素的最小宽高。网页端模型配置与 CLI 的差异见下节。

本项目当前会校验生成时长（4–30 秒整数）、画幅、模型对应的分辨率、prompt 字符数、seed、各类素材数量，以及视频/音频的单项和累计时长。音频上传层会拒绝空文件和大于 15 MiB 的音频；`/v1/videos/generations` 的 multipart 和视频 URL 下载大小上限为 200 MiB。图片格式/尺寸、视频格式/尺寸/帧率、实际账号权益等不由该路由完整预校验，最终仍以 Dreamina 上游响应为准。

只有参考素材时，`prompt` 可省略或传空字符串；纯文生必须提供非空 `prompt`。首尾帧模式限两张图片，视频/音频参考必须设置 `functionMode=omni_reference`。HTTP 路由和生成控制器均会校验这些模式限制。2.5 模型会从国际账号中选择账号；绑定到国内账号的 API Key 会在生成前失败。聊天接口兼容现有调用，但需要完整控制 2.5 素材与参数时请使用 `/v1/videos/generations`。

`file_paths` / `filePaths` 是图片 URL 数组，不作为视频或音频的通用字段。视频与音频 URL 应分别放进 `video_file_N` 和 `audio_file_N`。

OSS URL 是素材来源地址，不是 Dreamina payload 所需的平台素材标识。服务端需要能访问该 URL，再按上传流程将素材传到 Dreamina，并在任务 payload 中放平台资源标识。URL 应能从运行 API 的服务器读取；使用预签名 URL 时，要把 query 参数视为凭证，分享日志或样例前先脱敏。音频上传目前按平台 VOD 协议实现，但真实账号端到端流程尚未验证。

## OSS URL 示例

首尾帧使用 `file_paths` 图片 URL 数组。该字段只接受图片；视频和音频需分别使用 `video_file_N` 与 `audio_file_N`。下面的 OSS 地址仅为格式示意，替换为服务器可访问且仍有效的对象 URL。

```json
{
  "model": "jimeng-video-seedance-2.5",
  "prompt": "从首帧开始，镜头平滑推进到尾帧",
  "functionMode": "first_last_frames",
  "file_paths": [
    "https://bucket.oss-region.aliyuncs.com/first.jpg?your-presigned-query",
    "https://bucket.oss-region.aliyuncs.com/last.jpg?your-presigned-query"
  ],
  "ratio": "16:9",
  "resolution": "720p",
  "duration": 8,
  "seed": 4150022505
}
```

混合参考的 JSON body 可以将 OSS URL 放在对应素材字段：

```json
{
  "model": "jimeng-video-seedance-2.5",
  "prompt": "以 @image_file_1 为角色参考，动作参考 @video_file_1，节奏参考 @audio_file_1",
  "functionMode": "omni_reference",
  "ratio": "16:9",
  "resolution": "720p",
  "duration": 8,
  "seed": 4150022505,
  "image_file_1": "https://bucket.oss-region.aliyuncs.com/reference.jpg?your-presigned-query",
  "video_file_1": "https://bucket.oss-region.aliyuncs.com/motion.mp4?your-presigned-query",
  "audio_file_1": "https://bucket.oss-region.aliyuncs.com/reference.mp3?your-presigned-query"
}
```

首尾帧图也可分别使用 `image_file_1` 与 `image_file_2` URL。Flash 使用相同的请求字段，将 `model` 改为 `jimeng-video-seedance-2.5-flash`，并将分辨率设为 `480p` 或 `720p`。示例里的签名 query 是占位内容，不能直接请求。

## 抓包与官方 CLI 差异

| 项目 | 网页端抓包/模型配置 | 官方 CLI 1.3.0 规格 | 当前处理口径 |
| --- | --- | --- | --- |
| Pro `4k` | 抓包/模型配置显示可选 `4k` | 普通分辨率参数枚举为 `480p`、`720p`、`1080p`，但 VIP 配置中另有 `4k` | 接口保留 `4k`；它受账号权益或上游开关控制，不能视为所有账号均可用 |
| 图片限制 | 抓包模型配置显示 30 MB、宽高 300–6000 px | `m2v` 显示 50 MiB、宽高 300–8192 px；`first_last_frame` 未声明最小宽高 | 两个来源不一致；本项目不预先校验完整图片尺寸与格式，需按真实账号上游结果确认 |
| 视频限制 | 抓包配置显示时长 1.8–30.2 秒、24–60 fps、200 MB | CLI 显示时长 1.8–30.2 秒、200 MiB、宽高 300–6000 px | 字节单位表述和尺寸信息有差别；本项目校验单段与累计时长，并限制 URL 下载大小 |
| `seed` | 抓包的任务输入中存在 32 位整数 `seed` | CLI 模型参数未列出 `seed` 选项 | 本项目 API 保留可选 `seed`，按 uint32 校验；它是上游能力，不是 CLI 已声明的参数 |
| Flash 混合素材总数 | 抓包模型配置显示最多 20 项 | CLI 的混合模式总数结构为最多 50 项，但图片、视频、音频分别最多 10、5、5 项 | 依据每类限制计算有效总数为 20 项 |
| 音频上传 | 抓包确认任务 payload 使用平台 `vid` 和毫秒时长 | CLI 模型目录确认支持音频参考，但没有公开底层上传握手字段 | 复用平台上传签名/提交流程的实现仍需账号端到端验证；OSS URL 本身不会直接作为 `vid` |
| 商业权益类型 | Pro 各分辨率配置含标准、长视频、无输入视频及长视频无输入视频项；Flash 的 480p/720p 配置含标准与无输入视频项 | 所有模式的 `is_long_video` 均为 `forbidden` | 已有 `5` 秒、`720p` 无输入视频请求样例使用对应 `no_input_video` 类型；该名称不代表没有图片或音频。输入视频场景、长视频门槛及实际扣费均未验证；配置中的 `amount=0` 不是扣费证据。音频未观察到独立计费维度 |
| prompt 规则 | 抓包的混合参考任务含文本段；模型配置未证明 prompt 必填 | `t2v` 必填，`first_last_frame` / `m2v` 可选 | 纯文生要求非空 prompt；参考模式允许省略或为空，限制在 HTTP 路由和控制器中一致执行 |
| 批量生成 | 样例任务未验证批量行为 | `maxBatchGenCount=4` | `n=1..4` 由本项目串行发起独立请求；非原生上游批量提交。部分失败保留已生成结果并返回 `errors` |
| 长视频权益 | Pro 商业配置中存在长视频 benefit 项 | 所有模式的 `is_long_video` 均为 `forbidden` | 两者不能互相推导；本项目没有启用长视频权益，时长阈值未知，也不根据秒数猜测收费分界 |
| 任务 draft 结构 | 纯文生视频抓包为 draft `3.3.39` / min `3.0.5`，含 `AIGC_Video_Seedance25ResultAction`；混合素材抓包为 `3.3.9`，含 `AIGC_Video_UnifiedEdit` | CLI 提供 `t2v`、`first_last_frame`、`m2v` 语义，不公开原始 draft JSON | 项目按模式分别构造原始 payload，必须通过真实任务验证 |

## 信息来源与验证状态

- 官方 CLI：Dreamina Canvas CLI `1.3.0`，于 2026-11-14 查询两款模型的完整参数和模式约束；当时当前账号画布为空，没有用 CLI 发起真实生成。
- 官方 CLI 草稿报价：分别为 Pro `maxCredits=48`、Flash `maxCredits=28`，总上限 `totalMaxCredits=76`，并要求确认。该结果对应两款各一条 `4` 秒、`480p`、`16:9` 纯文生草稿；它不是实际扣费，也不能外推为固定单价或其他参数组合的价格。
- 网页端：用户提供的 Dreamina 国际站请求与模型配置抓包。
- 上游任务输入中的两个模型键分别为 `dreamina_seedance_45_pro` 和 `dreamina_seedance_45_flash`；模型可用性最终由站点、账号权益及服务端准入决定。
- 本地草稿构造和构建已验证；CLI 只创建草稿并报价，没有执行生成或扣费。抓包样例中的任务仍处于处理中，不能证明最终生成成功。音频上传通过本地 mock 测试，但上游音频上传流程、4k/长视频权益及实际费用仍需真实生成任务补齐验证。
- 本地验证覆盖 HTTP 路由、请求参数校验、账号区域筛选、草稿 payload、首尾帧排序、批量部分成功、OSS 下载与媒体上传 mock；这些测试不证明 Dreamina 上游接受所有参数组合。账号真实任务未执行，因此音频上传协议、视频/音频混合素材的上游成功率、4k 权益和实际扣费仍待验证。
