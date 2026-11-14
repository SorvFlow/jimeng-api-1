# Seedance 2.5 接入自测记录

日期：2026-11-14

## 结果

本地构建、TypeScript 类型检查和自动化测试通过。自动化测试覆盖模型映射、请求参数、两种草稿结构、参考素材上传与引用、OSS URL 脱敏、批量部分失败、国际账号筛选，以及 Seedance 2.0 Fast 的回归行为。

```text
npm run type-check 通过
npm test            通过（build + 28 项测试）
```

测试使用临时 SQLite 数据库和本地 HTTP 服务验证 API 路由；模型请求、图片/视频/音频上传及 Dreamina 响应用 mock 隔离。测试不会访问用户账号或消耗 Dreamina 积分。

## CLI 能力查询

Dreamina Canvas CLI `1.3.0` 查询确认：

- Pro：`dreamina_seedance_45_pro`；Flash：`dreamina_seedance_45_flash`。
- 两款均支持 `t2v`、`first_last_frame`、`m2v`；时长为 4–30 秒，固定 24 fps，单次批量上限为 4。
- `m2v` 可混合图片、视频和音频参考；音视频单项时长上限为 30.2 秒。
- 所有模式均禁止 `is_long_video`。
- 该账号草稿报价：Pro 一条最高 48 credits、Flash 一条最高 28 credits，合计最高 76 credits。报价只是上限，不是实际扣费。

CLI 草稿均已保存并成功报价，但没有运行生成。服务端要求明确确认积分 ceiling；未确认前不能提交。因此 CLI 结果证明模型可发现、参数可保存和报价可读，不能证明真实视频生成成功。

## 尚未通过真实账号验证

- 本项目生成 payload 尚未对 Dreamina 上游完成真实任务闭环。
- 音频上传复用现有 VOD 上传签名流程的音频分支，当前只有 mock 覆盖；缺少真实账号上传与 mixed-reference 成功结果。
- Pro `4k` 受账号权益或上游配置影响；长视频收费键的适用阈值未知，代码没有推测或启用。
- 用户抓包中可见的图片尺寸、帧率范围、费用配置与 CLI 规格存在差异，详情见[模型与参数说明](seedance-2.5-models.md)。
- 本地参数校验不能代替 Dreamina 对素材编码、尺寸、地区和账号权益的最终判断。
