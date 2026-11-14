# BitBrowser 无代理账号 dynamicIpUrl 错误排查与修复

## 根因和上游对照

已通过远程 `git ls-remote` 核实，WanInter/jimeng-api 的 HEAD 为
`23ebf571b4d1c8a11cacbda0488cf84a01466e78`，与本地原始基线一致。

原仓库 `src/lib/bitbrowser.ts` 的 `parseProxyUrl()` 在账号没有配置代理时返回：

```json
{ "proxyMethod": 3, "proxyType": "noproxy" }
```

根据 [BitBrowser 官方浏览器接口文档](https://doc.bitbrowser.cn/api-jie-kou-wen-dang/liu-lan-qi-jie-kou)，
`proxyMethod: 2` 表示自定义代理，`3` 表示提取 IP；直连应使用 `2 + noproxy`。
提取 IP 模式缺少 `dynamicIpUrl` 时，BitBrowser 会拒绝创建或打开窗口。

错误链路如下：

```text
账号未配置代理
→ 原版以 proxyMethod=3 创建 Profile
→ BitBrowser 校验动态提取 URL
→ 请填写提取URL: dynamicIpUrl
→ 窗口打开失败，无法获取 CDP 端口
```

该错误发生在 Dreamina 页面加载和登录检测之前。CDP 端口显示“未知”是结果。
容器 `/ping` 返回 `pong` 只说明服务已启动，不能证明账号窗口可以打开。

`1190078` 曾在新建 Profile 遇到该错误时省略代理字段重试，但没有纠正已有 Profile，
也没有按官方参数明确设置直连，因此本次移除这条创建重试路径。

## 本次处理

1. 新建直连 Profile 首次提交 `proxyMethod: 2, proxyType: 'noproxy'`。
2. 打开窗口正常时沿用原流程，不额外读取或更新配置。
3. 打开明确报 `dynamicIpUrl`，且账号没有配置 `proxy_url` 时，调用
   `POST /browser/detail` 读取该账号绑定的 Profile。
4. 只有详情同时满足以下条件，才自动修复一次：
   - ID 与绑定的 Profile 一致，备注以 `auto-created by jimeng-api` 开头。
   - 代理配置为旧错误组合 `proxyMethod=3, proxyType=noproxy`。
   - 没有代理主机、有效端口、代理账号密码、动态提取 URL 或全局代理配置。
5. 使用官方代理专用接口修改该 Profile，然后重新打开一次：

   ```http
   POST /browser/proxy/update
   Content-Type: application/json
   ```

   ```json
   {
     "ids": ["绑定的 Profile ID"],
     "ipCheckService": "ip-api",
     "proxyMethod": 2,
     "proxyType": "noproxy"
   }
   ```

`ipCheckService` 优先保留原值，没有设置时使用官方默认值 `ip-api`。
修复仅提交代理字段，保留同一个 Profile、Cookie 和指纹。此过程不会调用全量
`/browser/update`，也不会删除或重新创建窗口。

“打开窗口”“登录/修复”“检测登录状态”三个入口均接入该逻辑。
自动修复时进度会显示“正在修复 BitBrowser 旧版无代理 Profile 配置”。
仅“打开窗口”触发修复时，成功后显示“代理配置已修复，窗口已打开”，
并进入等待手动登录/检测状态，避免进度一直停在修复中。

账号或 Profile 中存在真实代理配置、Profile 为手动创建、无法读取详情，
或者专用更新接口失败时，系统停止自动修复，并显示代理配置卡点。
此时应在 BitBrowser 中核对直连、静态代理或动态提取 URL 设置。

## 升级后的验证

1. 确认运行容器的镜像 ID 与此次构建的镜像 ID 一致。
2. 在账号页对原失败账号点击“登录/修复”。
3. 观察进度是否经过旧配置修复、打开窗口、连接 CDP、打开 Dreamina。
4. 如需验证码，在该账号窗口完成后点击“检测”。
5. 确认账号登录状态为成功，且记录了新的 CDP 端口。

本地回归覆盖官方请求参数、旧配置修复、真实代理保护、修复失败停止、重试次数和三条入口。
测试通过不能替代上述 Windows BitBrowser 的实际验证。
