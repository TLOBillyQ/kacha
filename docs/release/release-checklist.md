# 发布验收清单（v2 Tauri 客户端）

分发与 updater 决策见 `docs/adr/0007-gitea-release-as-sole-distribution-channel.md`、
`docs/adr/0017-tauri-official-updater-for-desktop-updates.md`。
Gitea Release（tag `v<版本>`）包含 Windows 安装器及签名、`updater-win-x64.json`、
macOS 首次安装 zip、`.app.tar.gz` 及签名、`updater-macos-arm64.json`、`SHA256SUMS`。
执行人逐条勾选，并在末尾「记录」表中留痕。

首次 updater 迁移操作见 [用户指南](auto-update-user-guide.md)，#14 已验证事实与待补证据见
[Windows 验收记录](auto-update-windows-acceptance.md)。当前迁移目标待首个带 updater 签名的正式版发布。
本清单不授予真实上传发布权限；本次文档切片不执行真实发布，也不关闭 Issue。

## 1. 定版本

- [ ] 在 `client/src-tauri/Cargo.toml` 的 `[package] version` bump 版本号（唯一来源）。
      `tauri.conf.json` 若写了 `version`，必须同步为相同值，否则构建/发布脚本直接报错；
      `client/package.json` 的 `version` 建议一并同步。
- [ ] `cargo` 更新 `Cargo.lock` 中本包版本（跑一次下面的 `cargo test` 即可），一起提交。
- [ ] 版本提交已合入 `main`，两台构建机都检出同一提交（记录 `git rev-parse HEAD`）。

## 2. 自动化检查

    cd client
    npm ci
    npm test
    npx tsc --noEmit
    cargo test --manifest-path src-tauri/Cargo.toml
    cd ..
    python3 -m unittest discover -s packaging/tests

- [ ] 以上命令全部通过（Windows 上 `python3` 换成 `python` 或 `py -3`，需 Python 3.11+）。

## 3. 构建（每台目标机器各一次）

Tauri 不能交叉构建，Windows 包在 Windows x64 机器上构建，macOS 包在 Apple Silicon Mac 上构建：

    # 先提供两端共享的无密码 updater 私钥（见 packaging/README.md），不要打印其内容
    python3 packaging/build_release.py                # 默认先在 client/ 下 npm ci
    python3 packaging/build_release.py --skip-npm-ci  # 已装好依赖时

- [ ] 构建前 `release/` 中没有旧版本发布产物（脚本会拒绝）。
- [ ] Windows：`release/kacha-<版本>-win-x64-setup.exe` 与 `.sig` 齐全；安装范围是当前用户。
- [ ] macOS：`codesign --verify --deep --strict` 通过；`release/kacha-<版本>-macos-arm64.zip`
      由 `ditto` 生成，updater 更新包 `.app.tar.gz` 与 `.sig` 齐全。
- [ ] `release/SHA256SUMS` 列出本机发布材料；平台描述由发布脚本生成，不手工维护。

## 4. 发布说明

- [ ] 复制 `docs/release/release-notes-template.md` 为 `docs/release/release-notes-<版本>.md`，
      替换 `{{版本}}`、填写本版变化，删除模板头部注释；随版本提交合入。
- [ ] 内容包含：下载表、SHA256 校验命令、WebView2 说明与官方链接、
      SmartScreen「更多信息 → 仍要运行」、macOS Gatekeeper 放行方式、打开画板方式（不登记双击关联）、
      数据位置与诊断导出入口。
- [ ] 内容区分 updater 签名与操作系统代码签名，说明 HTTP 仅用于可信内网或 VPN、
      首次迁移、用户主动更新重启、队列 / 保存保护、手动安装与旧版手动恢复，以及 macOS 未验收范围。

## 5. 发布（每台构建机各一次）

    export GITEA_TOKEN=***            # Windows PowerShell：$env:GITEA_TOKEN = "***"
    python3 packaging/publish_release.py

- [ ] 脚本本地核对通过（SHA256SUMS 一致、无其他版本压缩包、发布说明存在）后才上传。
- [ ] 第二台机器发布后，同一 Release 下双端发布集合齐全且无重复。
- [ ] 重复执行只替换本端附件：先撤下本端旧描述，附件与校验文件替换完成后重新发布本端描述。

## 6. 下载核对

在一台干净的机器上从 Gitea Release 页面下载全部附件：

- [ ] Windows：`Get-FileHash -Algorithm SHA256 -Path .\kacha-<版本>-win-x64-setup.exe` 与 `SHA256SUMS` 一致。
- [ ] macOS：`shasum -a 256 -c SHA256SUMS --ignore-missing` 显示 `OK`。
- [ ] `SHA256SUMS` 同时包含两个平台的全部发布产物条目。
- [ ] Release 正文与 `release-notes-<版本>.md` 一致。

## 7. 冒烟测试

### Windows（Win10 21H2+ 与 Win11 各一台为佳）

- [ ] 安装器可按当前用户安装并可启动；SmartScreen 按发布说明「更多信息 → 仍要运行」可放行。
- [ ] 中文路径下运行正常；非管理员账户可运行。
- [ ] **WebView2 缺失提示**：在未装 WebView2 的机器（或卸载运行时的虚拟机）上启动，弹窗说明并给出
      <https://developer.microsoft.com/microsoft-edge/webview2/> 链接，不闪退、不白屏。
- [ ] **打开画板**：把 `.ugcboard.json` 拖到 exe 图标上可启动并打开该画板；应用运行时拖到窗口、
      或拖到 exe 图标上（转交已运行实例）都能打开。
- [ ] 文生图、图片编辑、画板保存/重新打开各跑通一次。
- [ ] 首次迁移：旧免安装版用户安装本版后，设置、API 密钥与最近画板仍在。
- [ ] 首次迁移保持同一系统凭据、应用数据目录与输出根目录，画板、任务目录及生成结果可用。
- [ ] 完整更新：记录已安装旧版到新版的真实端点、下载、用户点击、严格保存、安装及启动后版本；
      全部已打开画板、活动画板与界面状态恢复。下载完成及任务结束均不自动安装或重启。
- [ ] 排队、执行中、限流退避及读取参考图均阻止更新；准备期间禁止新任务与修改；
      画板或界面状态保存失败时不安装、不重启并恢复操作。
- [ ] 下载 / 签名校验失败不安装；安装 / 目录权限错误提供实际可获取的错误和手动下载入口，不自动提权。
      不能可靠触发或观察的结果注明证据限制，不勾选为通过。

### macOS（Apple Silicon）

以下是真机验收项目。本次 #14 明确不执行 macOS 真机安装、迁移与自动更新验收，
这些项目标注「未验收」，不列为本次完成条件。macOS 构建、发布分支与相关脚本测试继续保留；
将来执行真机验收时另行记录实际结果。

- [ ] 访达解压并拖入「应用程序」；右键「打开」或「隐私与安全性 → 仍要打开」可放行。
- [ ] `xattr -dr com.apple.quarantine "/Applications/Kacha.app"` 方式同样有效。
- [ ] **打开画板**：把 `.ugcboard.json` 拖到窗口可打开；拖到程序坞图标上时应用启动并打开该画板
      （走 `RunEvent::Opened`，前端就绪前到达的路径不丢）。
- [ ] 文生图、图片编辑、画板保存/重新打开各跑通一次。

### 双端

本次 #14 仅记录 Windows 实际结果；下列涉及 macOS 的真机项目同样标注「未验收」。

- [ ] **诊断导出**：「高级设置」底部「导出诊断包…」导出成功，导出文件含版本号与日志，
      搜索不到 API 密钥与认证头。
- [ ] 设置与日志位于应用数据目录，程序目录内没有写入任何文件。
- [ ] **检查更新**：「高级设置」点「检查更新」显示「已是最新版本」（本版已发布后）；断网时显示错误而非卡住；
      启动 3 秒后无新版时顶栏不出现「新版本」按钮。
- [ ] **生成尺寸**：任务节点收起时也能改分辨率档与宽高比；在 qwen 上手填 `5:2` 能提交，节点显示的像素与请求里的 `size` 一致；
      手填 `12:1` 失焦后变成 `8:1` 并提示范围，手填 `abc` 恢复原值；Seedream 上手填 `12:1` 后换到 qwen 显示「（不支持）」且不可运行；
      用一份 `custom` 为 null 的能力覆盖文件确认该模型只有下拉；带 `width` / `height` 的旧画板任务能打开、能运行。
- [ ] 性能与包体数字补记到 `docs/release/performance-macos.md`（首次发布或有明显变化时）。

## 8. 记录

自动测试与真机验证分别记录提交、命令、版本、产物及证据。既有基线为 Vitest 845、Rust 44、
packaging 33、浏览器 E2E 43；后续 worker 最新结果尚未核验，不将这些数量当作最新测试结果。

| 项目 | 值 |
| --- | --- |
| 发布版本 |  |
| 构建提交（git rev-parse HEAD） |  |
| 构建日期 |  |
| Windows 构建机 / 工具链版本 |  |
| macOS 构建机 / 工具链版本 |  |
| Gitea Release tag / 附件核对 | 待实际发布后填写 tag 与核对结果 |
| Win10 冒烟机器 |  |
| Win11 冒烟机器 |  |
| macOS 冒烟机器 |  |
| 发现的问题 |  |
