# 项目长期笔记

## 两套前端，互不共享

| | DSH 插件界面 | Windows 安装包界面 |
|---|---|---|
| 源码 | `client.js`（根目录，单文件） | `packages/standalone/frontend/*.tsx` |
| 运行位置 | DSH 宿主内嵌 | 独立服务的网页管理台 |
| 构建 | 无（直接作为插件资源） | `scripts/build-standalone-ui.mjs` → `packages/standalone/web/` |
| 进安装包 | 否 | 是（`prepare-desktop.mjs` 复制 `web/` 到 `resources/service`） |

- 页面集不同：插件有 `free` / `picks`（推荐项目）；独立端是 `overview` / `models` /
  `usage` / `channels` / `eac` / `settings` / `connection` / `sponsor`，没有 picks。
- 上游改动只有**同时落在 `packages/standalone/frontend/`** 时才会进入安装包
  （例：`d865684`、`d187bf1` 两边都改）；只改 `client.js` 的插件专属改动
  （例：`fbec3ae` 移除低性能模式、`5f42c0e` 换赞助 Logo）不会同步到 Windows 界面。
- `build-windows` 会重跑 `build:standalone-ui`，所以 frontend 的改动在出安装包时
  自动带上；client.js 的改动需要人工移植。

## 发版约定

- **2026-10-23 起不再自动跟上游**：`.github/workflows/auto-release.yml` 已改名
  `release.yml`，只留 `workflow_dispatch`，不再 curl 上游版本、不再
  `git merge upstream/main`、没有 cron。原因是上游会删账号渠道
  （#555/#577/#585 把 13 个砍到 10 个），无人值守合并等于让上游覆盖本地恢复。
- 发版 = 先改根 `package.json` 的 version，再手动跑 `release.yml`；它按本地版本
  对齐 `packages/desktop-electron` 与 `packages/standalone`、推 main、打
  `v<版本>` 标签、触发 `build-windows`。
- 渠道数量有测试兜底：`standalone-channels-test` / `channel-pack-test` 都断言
  13 个渠道，误合并上游删渠道会直接红灯。
- `v2.5.7` 同名 tag 已分叉：上游 origin → `d857f8e`，chensee/本地 → `ff3ac92`。
- **2026-10-23 fork 改用自有签名密钥**：上游私钥不可得，从上游 Ed25519 公钥切换到
  自有对。`src/updater.js` 的 `PINNED_MANIFEST_PUBLIC_KEY` =
  `MCowBQYDK2VwAyEAS1AE/bpNsHr9IFYPkhpTVRAy4uoACW3+V4OmX0LGRXM=`。
  私钥 PEM 在 `C:\Users\abc55\.ofm\release-key.pem`（仓库外，未进版本库），且**必须配
  仓库 Secret `RELEASE_MANIFEST_PRIVATE_KEY`** 才能让 `release-sign` 在未来改动文件后
  自动重签（`OFM_RELEASE_PUSH_TOKEN` 是否就绪未知，需一并确认）。
- ⚠️ 换密钥的代价：旧安装包（2.5.8 / 2.5.9 / 旧 2.5.9-fix）内嵌旧公钥，应用内升级
  对清单校验失败，须手动重装带新公钥的 2.5.9-fix 安装包（build-windows @`60c4543`
  已重建，Release 资产 updated 02:11:41Z）。

## Qoder 两版的可用性差异（2026-10-23 实测）

用真实凭据跑加密端点（`agent_chat_generation`）逐模型探测的结果：

- **国际版 `qoder`（`api2.qoder.sh`）基本不可用**：`qfmodel` 恒排队
  （`10605`，`queueType:p3`、`serviceAvailable:false`、`retryAfterSeconds:30`）；
  `qmodel` / `auto` / `dmodel` 回 **`code 112`**（带 `pricingUrl`，= 需付费/无额度）。
  只有 `qmodel_38max` 偶有响应。
- **中国版 `qodercn`（`gateway.qoder.com.cn`）全部正常**：`qfmodel` / `dfmodel` /
  `qmodel_38max` 都能正常出流（HTTP 200，`choices`）。
- **不是网络问题**：直连/代理下四个域名 TCP+TLS 都在 100~600ms 内完成，
  零凭据 POST 也稳定回 `101 Signature invalid`（说明链路通）。
  `qoder-product.ts` 里那句「国际版恒定 `NGHTTP2_INTERNAL_ERROR`」是**旧结论**，
  本机已不复现。

⚠️ 排查 Qoder「连不上」时**先分清是排队还是额度**：`10605`=排队（代码会自等 30s，
最多 30 分钟），`112`=额度/付费墙（代码**没有**处理，会当普通错误抛出），
`110`=当日额度用尽（已有切账号逻辑）。用户感知的「连不上」多半是排队等待。

## 环境备注

- 写探针脚本用 `packages/standalone/node_modules/esbuild`（根 node_modules 没有 esbuild）：
  `node <...>/esbuild/bin/esbuild probe.ts --bundle --platform=node --format=esm --outfile=probe.mjs --external:node:*`
- ⚠️ `qoder-wasm.ts` 的 `WASM_PATH` 按 `import.meta.url` 解析，打包产物必须和
  `qoder-auth-wasm.wasm` 同目录才跑得起来（用完记得删，它是**受版本控制**的文件）。
- 加密端点是 SSE：**响应体永不结束**，`await r.text()` 会挂到超时；
  必须 `reader.read()` 只取首块再 `cancel()`。
